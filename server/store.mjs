// Supabase PostgREST client for the rate-limit functions in supabase/schema.sql.
// Fails closed: if the store cannot be reached, callers get a StoreError and the question is NOT answered.

export class StoreError extends Error {}

// Legacy service_role keys are JWTs and go in both headers. New "sb_secret_..." keys are NOT JWTs:
// Supabase accepts them only in the apikey header, so sending them as a Bearer token would be rejected.
export function authHeaders(key) {
  return key.startsWith('sb_') ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
}

export async function rpc(cfg, fn, args, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(cfg.supabaseKey) },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new StoreError(`store ${fn}: ${e.name === 'AbortError' ? 'timeout' : 'network'}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new StoreError(`store ${fn}: HTTP ${res.status}`);
  try { return await res.json(); } catch { throw new StoreError(`store ${fn}: bad response`); }
}

// Verify a Supabase user access token server-side. Returns the user id or null.
export async function verifyUser(cfg, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: cfg.supabaseKey, authorization: `Bearer ${token}` }, // user JWT in Authorization; project key in apikey
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const u = await res.json();
    return typeof u?.id === 'string' && /^[0-9a-f-]{36}$/i.test(u.id) ? u.id : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
