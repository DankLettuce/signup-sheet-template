// Organizer password. Parents sign up with the class code; only the organizer (with ORGANIZER_PASSWORD) can change
// the list (add / rename / remove / reorder items, spots, event details, put back removed items) or download the
// backups. ORGANIZER_PASSWORD is a Pages secret (wrangler pages secret put ORGANIZER_PASSWORD), never in the repo
// or config. After the right password the server sets a separate, short-lived (12 h) HttpOnly cookie that is an
// HMAC signed with PASS_SECRET. Changing the password or PASS_SECRET signs every organizer out.
// Fail closed: without a PASS_SECRET of 32+ random bytes or an ORGANIZER_PASSWORD of 10+ characters, every
// organizer route answers 503 (setup needed). There is no default password.
import { secretOk, readCookie } from './gate.js';

const COOKIE = 'signup_org';
export const ORG_HOURS = 12;
export const ORG_PASSWORD_MIN = 10;
export const ORG_HELP = 'ORGANIZER_PASSWORD (10+ characters) and PASS_SECRET (32 random bytes) must be set: ' +
  'npx wrangler pages secret put ORGANIZER_PASSWORD --project-name <project_name>, then redeploy.';

export const orgStatus = env =>
  secretOk(env.PASS_SECRET) && typeof env.ORGANIZER_PASSWORD === 'string' && [...env.ORGANIZER_PASSWORD].length >= ORG_PASSWORD_MIN ? 'on' : 'setup';

// Which API routes are organizer-only.
export function isOrgRoute(method, path) {
  if (method === 'GET') return path === 'export.csv' || path === 'export.json';
  if (method === 'PUT' && path === 'settings') return true;
  if (method === 'POST' && path === 'items') return true;
  return /^items\/\d+(\/restore)?$/.test(path); // PUT / DELETE items/:id, POST items/:id/restore
}

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// The cookie MAC covers the expiry and (a MAC of) the password, so it can't be extended and a password change ends it.
const pwTag = env => hmac(env.PASS_SECRET, 'organizer-password:v1:' + env.ORGANIZER_PASSWORD);
const sign = async (env, exp) => hmac(env.PASS_SECRET, `organizer:v1:${exp}:${await pwTag(env)}`);

// Constant-time: both sides are HMACs of the same length.
export async function passwordMatches(env, typed) {
  if (orgStatus(env) !== 'on' || typeof typed !== 'string' || !typed || typed.length > 200) return false;
  return same(await hmac(env.PASS_SECRET, 'organizer-password:v1:' + typed), await pwTag(env));
}
export async function orgToken(env, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ORG_HOURS * 3600;
  return `o1.${exp}.${await sign(env, exp)}`;
}
// 'none' | 'ok' | 'bad' (forged, expired, or from before the password / secret changed)
export async function orgState(env, request, now = Date.now()) {
  const got = readCookie(request, COOKIE);
  if (got === null || got === '') return 'none';
  if (orgStatus(env) !== 'on') return 'bad';
  const m = /^o1\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(got);
  if (!m) return 'bad';
  const exp = Number(m[1]), t = Math.floor(now / 1000);
  if (exp <= t || exp > t + ORG_HOURS * 3600 + 60) return 'bad';
  return same(m[2], await sign(env, exp)) ? 'ok' : 'bad';
}
export const orgCookie = (token, secure) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${ORG_HOURS * 3600}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
export const clearOrgCookie = secure => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
