// Supabase PostgREST client for the rate-limit functions in supabase/schema.sql.
// Fails closed: if the store cannot be reached, callers get a StoreError and the question is NOT answered.

export class StoreError extends Error {}

export async function rpc(cfg, fn, args, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: cfg.supabaseKey,
        authorization: `Bearer ${cfg.supabaseKey}`,
      },
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
      headers: { apikey: cfg.supabaseKey, authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const u = await res.json();
    return typeof u?.id === 'string' && /^[0-9a-f-]{36}$/i.test(u.id) ? u.id : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
