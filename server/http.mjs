export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorBody(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure }) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/api; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
