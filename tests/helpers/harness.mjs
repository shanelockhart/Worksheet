// Test harness: a REAL PostgreSQL server (each RPC is a separate psql connection, so concurrency is real),
// a PostgREST-style HTTP front for the rpc functions, a mock AI provider, and the app served over HTTP.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../../server/handler.mjs';

const PGBIN = '/usr/lib/postgresql/16/bin';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVICE_KEY = 'test-service-role-key-DO-NOT-LEAK';
export const AI_KEY = 'sk-test-ai-key-DO-NOT-LEAK';
export const SESSION_SECRET = 'x'.repeat(40);

const asPg = (cmd, args) => execFileSync('runuser', ['-u', 'postgres', '--', join(PGBIN, cmd), ...args], { stdio: 'pipe' });

// ---------- Postgres ----------
export class Pg {
  async start(port = 54329) {
    this.dir = mkdtempSync(join(tmpdir(), 'fx-pg-'));
    chmodSync(this.dir, 0o755);
    execFileSync('chown', ['postgres:postgres', this.dir]);
    this.data = join(this.dir, 'data');
    this.port = port;
    asPg('initdb', ['-D', this.data, '-A', 'trust', '-U', 'postgres']);
    asPg('pg_ctl', ['-D', this.data, '-o', `-p ${port} -k ${this.dir} -c listen_addresses=''  -c fsync=off`, '-l', join(this.dir, 'log'), '-w', 'start']);
    this.psqlArgs = ['-h', this.dir, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'];
    await this.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`);
    await this.exec(readFileSync(join(root, 'supabase/schema.sql'), 'utf8'));
  }
  run(sql) {
    return new Promise((resolve, reject) => {
      const p = spawn(join(PGBIN, 'psql'), [...this.psqlArgs, '-c', sql]);
      let out = '', err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `psql exit ${code}`))));
    });
  }
  exec(sql) { return this.run(sql); }
  async setNow(iso) {
    await this.exec(iso
      ? `create or replace function public.fx_now() returns timestamptz language sql stable as $$ select '${iso}'::timestamptz $$;`
      : `create or replace function public.fx_now() returns timestamptz language sql stable as $$ select now() $$;`);
  }
  reset() { return this.exec('truncate public.fx_usage restart identity'); }
  stop() {
    try { asPg('pg_ctl', ['-D', this.data, '-m', 'immediate', 'stop']); } catch { /* already stopped */ }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ---------- PostgREST-style front ----------
const SIG = {
  fx_status: [['p_subjects', 'text[]'], ['p_limits', 'int[]'], ['p_window_seconds', 'int'], ['p_daily_cap', 'int']],
  fx_reserve: [['p_reservation', 'uuid'], ['p_subjects', 'text[]'], ['p_limits', 'int[]'], ['p_window_seconds', 'int'], ['p_daily_cap', 'int']],
  fx_release: [['p_reservation', 'uuid']],
  fx_commit: [['p_reservation', 'uuid'], ['p_tokens_in', 'int'], ['p_tokens_out', 'int']],
  fx_new_session: [['p_subject', 'text'], ['p_limit', 'int'], ['p_window_seconds', 'int']],
};
const lit = (v, t) => {
  if (v === null || v === undefined) return `null::${t}`;
  if (t.endsWith('[]')) return `ARRAY[${v.map((x) => lit(x, t.slice(0, -2))).join(',')}]::${t}`;
  if (t === 'int') { if (!Number.isInteger(v)) throw new Error('bad int'); return `${v}::int`; }
  return `'${String(v).replaceAll("'", "''")}'::${t}`;
};

export function startRest(pg) {
  const state = { down: false, calls: [], authUsers: {}, delayMs: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    state.calls.push(`${req.method} ${req.url}`);
    if (state.down) { req.socket.destroy(); return; }
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/auth/v1/user') {
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      return state.authUsers[tok] ? send(200, { id: state.authUsers[tok] }) : send(401, { message: 'bad jwt' });
    }
    const m = req.url.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (!m || !SIG[m[1]]) return send(404, {});
    if (req.headers.apikey !== SERVICE_KEY || req.headers.authorization !== `Bearer ${SERVICE_KEY}`) return send(401, { message: 'bad key' });
    try {
      const a = JSON.parse(body);
      const call = SIG[m[1]].map(([n, t]) => `${n} := ${lit(a[n], t)}`).join(', ');
      const out = await pg.run(`select public.${m[1]}(${call})::text`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(out || 'null');
    } catch (e) { send(400, { message: e.message }); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

// ---------- Mock AI provider ----------
export function startProvider() {
  const state = { mode: 'ok', requests: [], reply: 'From our database (unsourced): lug pattern 6x139.7.', delayMs: 0, tokens: [1200, 80] };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    state.requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (state.mode === 'hang') return; // never answer
    if (state.mode === 'stall_body') { // send status + headers + a partial body, then go silent
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"content":[{"type":"te'); return;
    }
    if (state.mode === 'stall_headers_only') { res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }); res.flushHeaders(); return; }
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.mode === '429') return send(429, { error: { message: 'secret provider detail rate limit' } });
    if (state.mode === '500') return send(500, { error: { message: 'secret provider detail internal' } });
    if (state.mode === '401') return send(401, { error: { message: 'secret provider detail bad key' } });
    if (state.mode === 'badjson') { res.writeHead(200); return res.end('not json'); }
    const text = state.mode === 'empty' ? '' : state.reply;
    if (req.url.endsWith('/v1/messages')) {
      return send(200, { content: text ? [{ type: 'text', text }] : [], stop_reason: state.mode === 'truncated' ? 'max_tokens' : 'end_turn', usage: { input_tokens: state.tokens[0], output_tokens: state.tokens[1] } });
    }
    if (req.url.endsWith('/chat/completions')) {
      return send(200, { choices: [{ message: { content: text }, finish_reason: state.mode === 'truncated' ? 'length' : 'stop' }], usage: { prompt_tokens: state.tokens[0], completion_tokens: state.tokens[1] } });
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

// ---------- The app over HTTP ----------
export function startApp(getEnv) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = `http://${req.headers.host}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const response = await handle(request, { ip: req.headers['x-test-ip'] || '203.0.113.9', env: getEnv() });
    const out = {};
    for (const [k, v] of response.headers) out[k] = v;
    const setCookie = response.headers.getSetCookie?.() || [];
    if (setCookie.length) out['set-cookie'] = setCookie;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

export function baseEnv(rest, prov, extra = {}) {
  return {
    AI_API_KEY: AI_KEY, AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-haiku-5-5', AI_BASE_URL: prov.url,
    SUPABASE_URL: rest.url, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SESSION_SECRET,
    AI_TIMEOUT_MS: '3000', ...extra,
  };
}

// ---------- A tiny browser-like client (cookie jar) ----------
export class Client {
  constructor(base, ip = '203.0.113.9') { this.base = base; this.ip = ip; this.cookie = ''; }
  async req(method, path, { body, headers = {}, origin = this.base, cookie = true } = {}) {
    const h = { 'x-test-ip': this.ip, ...headers };
    if (origin) h.origin = origin;
    if (cookie && this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) this.cookie = c.split(';')[0];
    this.lastSetCookie = sc;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  }
  status() { return this.req('GET', '/api/status'); }
  ask(q, history = []) { return this.req('POST', '/api/chat', { body: { messages: [...history, { role: 'user', content: q }] } }); }
}
