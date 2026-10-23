// Optional class code. ON when the CLASS_CODE secret is set (wrangler pages secret put CLASS_CODE),
// OFF when it is empty or missing. The organizer picks the code and sends it in the email with the link.
// Parents type it once; the server answers with an HttpOnly pass cookie.
//
// The pass is an HMAC-SHA256 signed with PASS_SECRET (at least 32 random bytes, a Pages secret that is never
// in the repo). Without the secret nobody can make a valid pass, even if they know the code's format or
// this source. There is NO built-in default: when CLASS_CODE is set and PASS_SECRET is missing or too short,
// the API refuses to serve (fail closed) with a setup error, see gateStatus().
// Changing CLASS_CODE or PASS_SECRET makes every old pass invalid, so everyone types the code once more.
const COOKIE = 'signup_pass';
const PASS_DAYS = 120;
const TOKEN_V = 'v2';
// 32 random bytes = 43 characters base64url / 44 base64 / 64 hex. The distinct-character check rejects
// obviously non-random fillers like "aaaa…" or a short word repeated.
export const SECRET_MIN_CHARS = 43;
export const SECRET_HELP = 'PASS_SECRET must be set to at least 32 random bytes when CLASS_CODE is set. ' +
  'Make one with: openssl rand -base64 32   then: npx wrangler pages secret put PASS_SECRET --project-name <project_name>   and redeploy.';

// Codes are compared without case, spaces or dashes: "boo-123", "BOO 123" and "Boo123" all match "BOO123".
export const normCode = s => String(s ?? '').normalize('NFKC').toUpperCase().replace(/[\s\-_.]+/g, '');
export const gateActive = env => normCode(env.CLASS_CODE).length > 0;

export function secretOk(secret) {
  if (typeof secret !== 'string') return false;
  const s = secret.trim();
  return s.length >= SECRET_MIN_CHARS && new Set(s).size >= 10;
}
// 'off' = no class code; 'on' = code + good secret; 'setup' = code set but PASS_SECRET missing/weak -> refuse.
export function gateStatus(env) {
  if (!gateActive(env)) return 'off';
  return secretOk(env.PASS_SECRET) ? 'on' : 'setup';
}

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
const sign = (env, code) => hmac(env.PASS_SECRET, `class-code:${TOKEN_V}:${normCode(code)}`);

// The pass cookie value for the current code, or null when the gate is off / not set up.
export async function gateToken(env) {
  if (gateStatus(env) !== 'on') return null;
  return `${TOKEN_V}.${await sign(env, env.CLASS_CODE)}`;
}
// Constant-time compare of two strings (length is not secret: every valid token has the same length).
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// Compare the typed code by HMAC too, so the comparison is constant-time and never touches the raw code.
export async function codeMatches(env, typed) {
  if (gateStatus(env) !== 'on' || normCode(typed).length === 0) return false;
  return same(await sign(env, env.CLASS_CODE), await sign(env, typed));
}
export function readCookie(request, name = COOKIE) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return null;
}
// 'none' = no pass cookie sent; 'ok' = valid pass; 'bad' = a cookie that is not a valid pass (forged, old, or
// from before the code/secret changed). The API counts 'bad' toward the same lockout as wrong codes.
export async function passState(env, request) {
  const got = readCookie(request);
  if (got === null || got === '') return 'none';
  const want = await gateToken(env);
  return want && same(got, want) ? 'ok' : 'bad';
}
export const passCookie = (token, secure) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${PASS_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
export const clearPassCookie = secure =>
  `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
