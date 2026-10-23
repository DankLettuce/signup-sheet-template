// Optional class code. ON when the CLASS_CODE secret/variable is set (wrangler pages secret put CLASS_CODE),
// OFF when it is empty or missing. The organizer picks the code and sends it in the email with the link.
// Parents type it once; the server answers with an HttpOnly pass cookie (a hash of the code, never the code
// itself). Changing CLASS_CODE makes every old pass invalid, so everyone types the new code once.
const COOKIE = 'signup_pass';
const PASS_DAYS = 120;

// Codes are compared without case, spaces or dashes: "boo-123", "BOO 123" and "Boo123" all match "BOO123".
export const normCode = s => String(s ?? '').normalize('NFKC').toUpperCase().replace(/[\s\-_.]+/g, '');
export const gateActive = env => normCode(env.CLASS_CODE).length > 0;

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function gateToken(env) {
  if (!gateActive(env)) return null;
  return (await sha256hex(`class-code:v1:${env.VISITOR_SALT || 'signup'}:${normCode(env.CLASS_CODE)}`)).slice(0, 40);
}
// Constant-time compare of two equal-length hex strings.
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function codeMatches(env, typed) {
  const want = await gateToken(env);
  const got = await sha256hex(`class-code:v1:${env.VISITOR_SALT || 'signup'}:${normCode(typed)}`);
  return !!want && normCode(typed).length > 0 && same(want, got.slice(0, 40));
}
export function readCookie(request, name = COOKIE) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return null;
}
export async function hasPass(env, request) {
  const want = await gateToken(env);
  return !want || same(readCookie(request) || '', want);
}
export const passCookie = (token, secure) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${PASS_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
