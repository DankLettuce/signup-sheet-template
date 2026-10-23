// Visitor identity for rate limits + history. IPv4: the full address. IPv6: the /64
// (one home/phone usually owns a whole /64). Only a salted SHA-256 hash is stored.
// The salt is VISITOR_SALT if set, else PASS_SECRET (both Pages secrets; see visitorSalt). There is no
// built-in default salt: with neither secret set, the hash is unsalted (and the README says to set
// PASS_SECRET on every site). Set the salt once at setup and don't change it later (old history hashes
// would no longer match scripts/revert-visitor.mjs --ip lookups).
export const visitorSalt = env => (env && (env.VISITOR_SALT || env.PASS_SECRET)) || '';
export function visitorKey(ip) {
  ip = String(ip || '127.0.0.1').trim().toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}
export async function hashVisitor(key, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(salt || '') + ':' + key));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
