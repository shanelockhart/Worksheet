import { randomUUID } from 'node:crypto';
import { loadConfig, missingConfig } from './config.mjs';
import { json, errorBody, parseCookies, serializeCookie } from './http.mjs';
import { COOKIE_NAME, SESSION_MAX_AGE, issueSession, verifySession, hashNetwork } from './session.mjs';
import { StoreError, verifyUser } from './store.mjs';
import * as rl from './ratelimit.mjs';
import { validateChat, ValidationError } from './validate.mjs';
import { buildSystemPrompt } from './prompt.mjs';
import { complete, ProviderError } from './providers.mjs';

const MSG = {
  rate_limited: 'You have used all your questions for now.',
  ip_limited: 'Too many questions have come from your network. Please try again later.',
  new_sessions: 'Too many new visitors from your network right now. Please try again later.',
  daily_cap: 'The assistant has reached its daily limit. It resets at the time shown.',
  unavailable: 'The assistant is temporarily unavailable. Your question was not counted. Please try again shortly.',
  not_configured: 'The assistant is not set up yet.',
  provider_busy: 'The AI service is busy. Your question was not counted. Please try again in a moment.',
  provider_timeout: 'The AI service took too long to answer. Your question was not counted. Please try again.',
  provider_failed: 'The AI service could not answer. Your question was not counted. Please try again.',
  provider_empty: 'The AI service returned no answer. Your question was not counted. Please try again.',
};
const SCOPE_CODE = { session: 'rate_limited', user: 'rate_limited', ip: 'ip_limited', new_session: 'new_sessions', global: 'daily_cap' };

function sameOrigin(request, cfg) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin) return origin === url.origin || cfg.allowedOrigins.includes(origin);
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

// Resolve who is asking. Returns { primary, setCookie } or a Response to return immediately.
async function identify(request, cfg, ipHash, { createIfMissing }) {
  const auth = request.headers.get('authorization') || '';
  if (cfg.authEnabled && /^Bearer /i.test(auth)) {
    const uid = await verifyUser(cfg, auth.slice(7).trim());
    if (!uid) return json(errorBody('unauthorized', 'Your sign-in is no longer valid.'), 401);
    return { primary: `u:${uid}`, kind: 'user' };
  }
  const cookies = parseCookies(request.headers.get('cookie'));
  const existing = verifySession(cfg.sessionSecret, cookies[COOKIE_NAME]);
  if (existing) return { primary: `g:${existing.id}`, kind: 'guest' };
  if (!createIfMissing) return { primary: null, kind: 'guest' };

  const ns = await rl.newSession(cfg, ipHash);
  if (!ns?.ok) return json({ ...errorBody('new_sessions', MSG.new_sessions, { retry_at: ns?.retry_at ?? null }) }, 429, { 'retry-after': '60' });
  const s = issueSession(cfg.sessionSecret);
  const secure = new URL(request.url).protocol === 'https:';
  return { primary: `g:${s.id}`, kind: 'guest', setCookie: serializeCookie(COOKIE_NAME, s.token, { maxAge: SESSION_MAX_AGE, secure }) };
}

const withCookie = (res, who) => {
  if (who?.setCookie) res.headers.append('set-cookie', who.setCookie);
  return res;
};

export async function handle(request, { ip, env }) {
  let cfg;
  try { cfg = loadConfig(env); } catch (e) {
    console.error('config error:', e.message);
    return json(errorBody('not_configured', MSG.not_configured), 503);
  }
  const missing = missingConfig(cfg);
  if (missing.length) {
    console.error('missing configuration:', missing.join(', '));
    return json(errorBody('not_configured', MSG.not_configured), 503);
  }

  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  const ipHash = hashNetwork(cfg.sessionSecret, ip);

  try {
    if (path === '/api/status' && request.method === 'GET') return await status(request, cfg, ipHash);
    if (path === '/api/chat' && request.method === 'POST') return await chat(request, cfg, ipHash);
    if (path === '/api/status' || path === '/api/chat') return json(errorBody('method_not_allowed', 'Method not allowed.'), 405, { allow: path === '/api/chat' ? 'POST' : 'GET' });
    return json(errorBody('not_found', 'Not found.'), 404);
  } catch (e) {
    if (e instanceof StoreError) {
      console.error(e.message);
      return json(errorBody('unavailable', MSG.unavailable), 503);
    }
    console.error('unhandled error:', e?.name, e?.message);
    return json(errorBody('server_error', MSG.unavailable), 500);
  }
}

async function status(request, cfg, ipHash) {
  const who = await identify(request, cfg, ipHash, { createIfMissing: true });
  if (who instanceof Response) return who;
  const p = rl.plan(cfg, who.primary, ipHash);
  const state = await rl.status(cfg, p);
  return withCookie(json({
    ok: true,
    ...rl.summarize(cfg, state),
    input_max_chars: cfg.maxInputChars,
    signed_in: who.kind === 'user',
  }), who);
}

async function chat(request, cfg, ipHash) {
  if (!sameOrigin(request, cfg)) return json(errorBody('forbidden', 'Request not allowed from this origin.'), 403);
  const ctype = request.headers.get('content-type') || '';
  if (!ctype.toLowerCase().includes('application/json')) return json(errorBody('bad_request', 'Expected JSON.'), 415);
  const text = await request.text();
  if (text.length > 60_000) return json(errorBody('bad_request', 'Request too large.'), 413);
  let body;
  try { body = JSON.parse(text); } catch { return json(errorBody('bad_request', 'Invalid JSON.'), 400); }

  let messages;
  try { messages = validateChat(body, cfg); } catch (e) {
    if (e instanceof ValidationError) return json(errorBody(e.code, e.message), 400);
    throw e;
  }

  const who = await identify(request, cfg, ipHash, { createIfMissing: true });
  if (who instanceof Response) return who;
  const p = rl.plan(cfg, who.primary, ipHash);

  const reservation = randomUUID();
  const r = await rl.reserve(cfg, reservation, p);
  if (!r?.ok) {
    const code = r?.reason === 'daily_cap' ? 'daily_cap' : SCOPE_CODE[r?.reason] || 'rate_limited';
    const summary = rl.summarize(cfg, r);
    const res = json({ ...errorBody(code, MSG[code], { retry_at: r?.retry_at ?? summary.next_at }), limit: summary }, 429, {
      'retry-after': String(Math.max(1, Math.ceil((new Date(r?.retry_at || Date.now() + 60000) - Date.now()) / 1000))),
    });
    return withCookie(res, who);
  }

  let result;
  try {
    result = await complete({ cfg, system: buildSystemPrompt({ includeArchive: cfg.includeArchive }), messages });
  } catch (e) {
    // Provider failed: give the question back before answering.
    let released = true;
    try { await rl.release(cfg, reservation); } catch (re) { released = false; console.error('release failed:', re.message); }
    const kind = e instanceof ProviderError ? e.code : 'network';
    console.error('provider error:', kind, e?.message);
    const code = kind === 'busy' ? 'provider_busy' : kind === 'timeout' ? 'provider_timeout' : kind === 'empty' ? 'provider_empty' : 'provider_failed';
    let limit = null;
    try { limit = rl.summarize(cfg, await rl.status(cfg, p)); } catch { /* ignore */ }
    const status = code === 'provider_busy' ? 503 : 502;
    return withCookie(json({ ...errorBody(code, MSG[code]), ...(released ? {} : { note: 'allowance_may_be_delayed' }), limit }, status), who);
  }

  try { await rl.commit(cfg, reservation, result.tokensIn, result.tokensOut); } catch (e) { console.error('commit failed:', e.message); }
  let limit;
  try { limit = rl.summarize(cfg, await rl.status(cfg, p)); } catch {
    limit = rl.summarize(cfg, r);
  }
  return withCookie(json({ ok: true, reply: result.text, truncated: !!result.truncated, limit }), who);
}
