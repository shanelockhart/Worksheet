import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'fx_sid';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest();

// Guest session token: v1.<id>.<expiry unix seconds>.<signature>. Issued only by the server.
export function issueSession(secret, nowMs = Date.now()) {
  const id = b64u(randomBytes(18));
  const exp = Math.floor(nowMs / 1000) + SESSION_MAX_AGE;
  const body = `v1.${id}.${exp}`;
  return { id, token: `${body}.${b64u(hmac(secret, body))}` };
}

export function verifySession(secret, token, nowMs = Date.now()) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [v, id, exp, sig] = parts;
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(id) || !/^\d{9,12}$/.test(exp)) return null;
  const expected = hmac(secret, `${v}.${id}.${exp}`);
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Number(exp) * 1000 < nowMs) return null;
  return { id };
}

// Expand an IP and reduce it to what identifies a network: IPv4 as-is, IPv6 to its /64.
export function networkKey(ip) {
  const raw = String(ip || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  const v4mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return v4mapped[1];
  if (!raw.includes(':')) return raw;
  let [head, tail = ''] = raw.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const missing = raw.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(missing, 0)).fill('0'), ...t].map((g) => g.padStart(4, '0'));
  return groups.slice(0, 4).join(':') + '::/64';
}

// Hash so raw IPs are never stored. Same secret as sessions; rotating SESSION_SECRET resets all IP buckets too.
export function hashNetwork(secret, ip) {
  return b64u(hmac(secret, `ip:${networkKey(ip)}`)).slice(0, 22);
}
