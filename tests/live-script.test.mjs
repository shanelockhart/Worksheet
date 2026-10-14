// Proves scripts/live-test.mjs itself works, by pointing it at a local stand-in for a deployment
// (real handler + real Postgres + mock AI provider). This is NOT a live deployment test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../server/handler.mjs';
import { Pg, startRest, startProvider, baseEnv } from './helpers/harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pg, rest, prov, site, extraEnv = {}, linked = false;
const MIME = { '.html': 'text/html; charset=utf-8' };

before(async () => {
  pg = new Pg(); await pg.start(54332); rest = await startRest(pg); prov = await startProvider();
  site = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const h = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v) h.set(k, String(v));
      const r = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: h, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) }), { ip: '203.0.113.9', env: baseEnv(rest, prov, extraEnv) });
      const out = {}; for (const [k, v] of r.headers) out[k] = v; const sc = r.headers.getSetCookie(); if (sc.length) out['set-cookie'] = sc;
      res.writeHead(r.status, out); return res.end(Buffer.from(await r.arrayBuffer()));
    }
    try { const f = req.url.split('?')[0].split('#')[0]; res.writeHead(200, { 'content-type': MIME[extname(f === '/' ? '.html' : f)] || 'text/html' }); res.end(readFileSync(join(root, 'public', f === '/' ? 'index.html' : f))); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  if (!existsSync(join(root, 'node_modules/playwright'))) { // use the playwright already on this machine
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(process.env.PLAYWRIGHT_MODULE_DIR || '/opt/npm-tools/node_modules/playwright', join(root, 'node_modules/playwright')); linked = true;
  }
});
after(() => { site?.close(); rest?.close(); prov?.close(); pg?.stop(); if (linked) rmSync(join(root, 'node_modules'), { recursive: true, force: true }); rmSync(join(root, '.live-profile'), { recursive: true, force: true }); rmSync(join(root, 'live-out'), { recursive: true, force: true }); });

function run(phase) {
  return new Promise((resolve) => {
    const p = spawn('node', ['scripts/live-test.mjs', phase], { cwd: root, env: { ...process.env, LIVE_URL: `http://127.0.0.1:${site.address().port}`, LIVE_HEADLESS: '1', PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('close', (code) => resolve({ code, out }));
  });
}

test('live script: flow (5 answers, 6th blocked, refresh, window expiry reopens one slot)', { timeout: 200000 }, async () => {
  await pg.reset(); await pg.setNow(null); extraEnv = { LIMIT_WINDOW_MINUTES: '1' }; prov.state.mode = 'ok';
  const r = await run('flow'); assert.equal(r.code, 0, r.out); assert.ok(!/FAIL/.test(r.out), r.out);
  assert.match(r.out, /after the window, at least one slot reopens/);
});
test('live script: errors phase (provider failing, allowance returned)', { timeout: 120000 }, async () => {
  await pg.reset(); extraEnv = {}; prov.state.mode = '404x';
  prov.state.mode = '500'; const r = await run('errors'); assert.equal(r.code, 0, r.out);
});
test('live script: outage phase (store down + provider failing => 503 unavailable, not a provider error)', { timeout: 120000 }, async () => {
  await pg.reset(); extraEnv = {}; prov.state.mode = '500'; prov.state.requests.length = 0; rest.state.down = true;
  const r = await run('outage'); assert.equal(r.code, 0, r.out); assert.equal(prov.state.requests.length, 0, 'provider never called while the store is down'); rest.state.down = false;
});
