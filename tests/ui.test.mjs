// Browser tests for the chat UI (Playwright + headless Chromium) against the real handler, real Postgres and a mock provider.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../server/handler.mjs';
import { Pg, startRest, startProvider, baseEnv } from './helpers/harness.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS_DIR || join(root, 'tests/.out');
mkdirSync(SHOTS, { recursive: true });

let pg, rest, prov, site, browser, extraEnv = {};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

before(async () => {
  pg = new Pg(); await pg.start(54330);
  rest = await startRest(pg); prov = await startProvider();
  site = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const h = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v) h.set(k, String(v));
      const r = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: h, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) }), { ip: '203.0.113.9', env: baseEnv(rest, prov, extraEnv) });
      const out = {}; for (const [k, v] of r.headers) out[k] = v; const sc = r.headers.getSetCookie(); if (sc.length) out['set-cookie'] = sc;
      res.writeHead(r.status, out); return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const p = req.url.split('?')[0].split('#')[0]; const f = p === '/' ? '/index.html' : p;
    try { const b = readFileSync(join(root, 'public', f)); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r)); site.url = `http://127.0.0.1:${site.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' });
});
after(async () => { await browser?.close(); site?.close(); rest?.close(); prov?.close(); pg?.stop(); });
beforeEach(async () => { extraEnv = {}; await pg.reset(); await pg.setNow(null); prov.state.mode = 'ok'; prov.state.requests.length = 0; prov.state.delayMs = 0; prov.state.reply = 'From our database: lug pattern 6x139.7, center bore 78.1mm.\n\nUnverified: offset may differ by trim.\n\n- Confirm year and trim\n- Check brake clearance'; });

const VIEWS = { phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, desktop: { viewport: { width: 1280, height: 800 } } };
async function open(view, { clock = false } = {}) {
  const ctx = await browser.newContext(VIEWS[view]); const page = await ctx.newPage();
  const external = [];
  await page.route('**/*', (route) => { const u = route.request().url(); if (!u.startsWith(site.url)) { external.push(u); return route.abort(); } route.continue(); });
  page.external = external; page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  if (clock) await page.clock.install({ time: Date.now() });
  await page.goto(site.url + '/#/ai'); await page.waitForSelector('#chat-allowance-text');
  await page.waitForFunction(() => /left|No questions/.test(document.getElementById('chat-allowance-text').textContent));
  return { ctx, page };
}
const allow = (page) => page.locator('#chat-allowance-text').innerText();
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

for (const view of ['phone', 'desktop']) {
  describe(`chat UI (${view})`, () => {
    test('loads with allowance, no Pickaxe, no external chat requests, no iframes', async () => {
      const { ctx, page } = await open(view);
      assert.equal(await allow(page), '5 of 5 questions left');
      assert.equal(await page.locator('iframe').count(), 0);
      assert.ok(!(await page.content()).toLowerCase().includes('pickaxe'));
      assert.deepEqual(page.external.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u)), []);
      assert.deepEqual(page.errors, []);
      await shot(page, `chat-${view}-empty`); await ctx.close();
    });
    test('ask, labeled answer, count drops, survives reload', async () => {
      const { ctx, page } = await open(view);
      await page.fill('#chat-input', '2019 Silverado 1500 lug pattern?'); await page.click('#chat-send');
      await page.waitForSelector('.msg.bot .tag-db');
      assert.equal(await page.locator('.msg.bot .tag-unv').count(), 1);
      assert.equal(await page.locator('.msg.bot li').count(), 2);
      assert.equal(await allow(page), '4 of 5 questions left');
      await shot(page, `chat-${view}-answer`);
      await page.reload(); await page.waitForFunction(() => /left/.test(document.getElementById('chat-allowance-text').textContent));
      assert.equal(await allow(page), '4 of 5 questions left', 'refresh does not reset the limit');
      assert.equal(await page.locator('.msg.user').count(), 1, 'conversation restored for the tab');
      await ctx.close();
    });
    test('clearing cookies does not hand back a fresh allowance for the same network beyond the IP cap, and a new browser profile is a new guest (documented limit)', async () => {
      extraEnv = { IP_LIMIT_PER_WINDOW: '6' };
      const a = await open(view); for (let i = 0; i < 5; i++) { await a.page.fill('#chat-input', `q${i}`); await a.page.click('#chat-send'); await a.page.waitForFunction((n) => document.querySelectorAll('.msg.bot').length === n, i + 1); }
      assert.equal(await allow(a.page), '0 of 5 questions left'.replace('0 of 5 questions left', 'No questions left'));
      await a.ctx.cookies().then(() => a.ctx.clearCookies());
      await a.page.reload(); await a.page.waitForFunction(() => /left/.test(document.getElementById('chat-allowance-text').textContent));
      assert.equal(await allow(a.page), '1 of 5 questions left', 'new guest session, but the network cap (6) leaves one');
      await a.ctx.close();
    });
    test('exhausted: shows when the next question opens, disables input, then re-enables live', async () => {
      const { ctx, page } = await open(view, { clock: true });
      for (let i = 0; i < 5; i++) { await page.fill('#chat-input', `q${i}`); await page.click('#chat-send'); await page.waitForFunction((n) => document.querySelectorAll('.msg.bot').length === n, i + 1); }
      assert.equal(await allow(page), 'No questions left');
      const txt = await page.locator('#chat-notice').innerText();
      assert.match(txt, /used all 5 questions/); assert.match(txt, /available at \d{1,2}:\d{2}/); assert.match(txt, /in (5\d|60) min|in 1 h|in 59/);
      assert.equal(await page.locator('#chat-input').isDisabled(), true); assert.equal(await page.locator('#chat-send').isDisabled(), true);
      await shot(page, `chat-${view}-limit`);
      // live unlock without a reload: move the server clock and the browser clock past the unlock time
      await pg.setNow(new Date(Date.now() + 61 * 60000).toISOString());
      await page.clock.fastForward('01:01:00');
      await page.waitForFunction(() => /^\d of/.test(document.getElementById('chat-allowance-text').textContent), null, { timeout: 8000 });
      assert.equal(await allow(page), '5 of 5 questions left'); assert.equal(await page.locator('#chat-input').isDisabled(), false);
      await ctx.close();
    });
    test('provider failure: clear error, Try again, allowance unchanged', async () => {
      const { ctx, page } = await open(view); prov.state.mode = '500';
      await page.fill('#chat-input', 'will fail'); await page.click('#chat-send');
      await page.waitForSelector('.msg.err'); assert.match(await page.locator('.msg.err').innerText(), /not counted/);
      assert.equal(await allow(page), '5 of 5 questions left'); await shot(page, `chat-${view}-error`);
      prov.state.mode = 'ok'; await page.click('.msg.err .chat-retry'); await page.waitForSelector('.msg.bot');
      assert.equal(await allow(page), '4 of 5 questions left'); assert.equal(await page.locator('.msg.user').count(), 1, 'retry does not duplicate the question');
      await ctx.close();
    });
    test('offline shows a network message', async () => {
      const { ctx, page } = await open(view); await ctx.setOffline(true);
      await page.fill('#chat-input', 'x'); await page.click('#chat-send'); await page.waitForSelector('.msg.err');
      assert.match(await page.locator('.msg.err').innerText(), /Cannot reach/); await ctx.close();
    });
    test('length limit: counter, disabled send, nothing submitted', async () => {
      const { ctx, page } = await open(view); await page.fill('#chat-input', 'x'.repeat(601));
      assert.equal(await page.locator('#chat-send').isDisabled(), true); assert.equal(await page.locator('#chat-count').innerText(), '601 / 600');
      await page.fill('#chat-input', 'x'.repeat(600)); assert.equal(await page.locator('#chat-send').isDisabled(), false);
      await page.fill('#chat-input', ''); assert.equal(await page.locator('#chat-send').isDisabled(), true); await ctx.close();
    });
    test('model output is rendered as text, never as HTML', async () => {
      prov.state.reply = 'General guidance: <img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script> **bold**';
      const { ctx, page } = await open(view); await page.fill('#chat-input', 'xss'); await page.click('#chat-send'); await page.waitForSelector('.msg.bot .tag-gen');
      assert.equal(await page.evaluate(() => window.__pwned), undefined); assert.equal(await page.locator('.msg.bot img').count(), 0);
      assert.match(await page.locator('.msg.bot').innerText(), /<img src=x/); await ctx.close();
    });
    test('suggestion chip sends a question; New chat clears the conversation but not the allowance', async () => {
      const { ctx, page } = await open(view); await page.click('.chat-chip >> nth=0'); await page.waitForSelector('.msg.bot');
      await page.click('#chat-new'); assert.equal(await page.locator('.msg').count(), 0); assert.equal(await allow(page), '4 of 5 questions left'); await ctx.close();
    });
    test('Enter sends, Shift+Enter makes a newline', async () => {
      const { ctx, page } = await open(view); await page.fill('#chat-input', 'line1'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('line2');
      assert.equal(await page.inputValue('#chat-input'), 'line1\nline2'); await page.keyboard.press('Enter'); await page.waitForSelector('.msg.bot');
      assert.equal(await page.locator('.msg.user').innerText(), 'line1\nline2'); await ctx.close();
    });
    test('service unavailable (not configured) disables the chat with a clear message', async () => {
      extraEnv = { AI_API_KEY: '' }; const ctx = await browser.newContext(VIEWS[view]); const page = await ctx.newPage(); await page.goto(site.url + '/#/ai');
      await page.waitForFunction(() => document.getElementById('chat-allowance-text').textContent === 'Unavailable');
      assert.equal(await page.locator('#chat-input').isDisabled(), true); assert.match(await page.locator('#chat-notice').innerText(), /not available/); await ctx.close();
    });
  });
}

describe('mobile layout and keyboard', () => {
  test('no horizontal scroll; 16px input; 44px+ targets; form clears bottom nav', async () => {
    const { ctx, page } = await open('phone');
    const m = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect(), nav = r('.mobile-bottom-nav'), form = r('#chat-form');
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, fs: getComputedStyle(document.getElementById('chat-input')).fontSize, send: r('#chat-send'), input: r('#chat-input'), formBottom: form.bottom, navTop: nav.top, vh: innerHeight };
    });
    assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`); assert.equal(m.fs, '16px');
    assert.ok(m.send.width >= 44 && m.send.height >= 44, 'send target'); assert.ok(m.input.height >= 44);
    const after = await page.evaluate(() => ({ fb: document.getElementById('chat-form').getBoundingClientRect().bottom, nt: document.querySelector('.mobile-bottom-nav').getBoundingClientRect().top }));
    assert.ok(after.fb <= after.nt + 1, `form bottom ${after.fb} overlaps nav ${after.nt}`);
    for (const el of await page.$$('.chat-chip')) { const b = await el.boundingBox(); assert.ok(b.height >= 40 && b.x >= 0 && b.x + b.width <= 390, 'chip fits'); }
    await ctx.close();
  });
  test('with the on-screen keyboard open (viewport shrinks) the input stays visible and the log still scrolls', async () => {
    const { ctx, page } = await open('phone'); await page.fill('#chat-input', 'hello'); await page.click('#chat-send'); await page.waitForSelector('.msg.bot');
    await page.focus('#chat-input'); await page.setViewportSize({ width: 390, height: 420 }); await page.waitForTimeout(500);
    const v = await page.evaluate(() => { const i = document.getElementById('chat-input').getBoundingClientRect(); return { top: i.top, bottom: i.bottom, vh: innerHeight, log: document.getElementById('chat-log').getBoundingClientRect().height, sendBottom: document.getElementById('chat-send').getBoundingClientRect().bottom, navDisplay: getComputedStyle(document.querySelector('.mobile-bottom-nav')).display }; });
    assert.ok(v.top >= 0 && v.bottom <= v.vh && v.sendBottom <= v.vh, `input ${v.top}-${v.bottom} within ${v.vh}`); assert.equal(v.navDisplay, 'none', 'bottom nav hidden while typing'); assert.ok(v.log >= 80, `log height ${v.log}`);
    await shot(page, 'chat-phone-keyboard'); await ctx.close();
  });
  test('site navigation still works and the old assistant page redirects', async () => {
    const { ctx, page } = await open('phone');
    for (const [h, id] of [['#/fitment', 'fitment-page'], ['#/vendors', 'vendors-page'], ['#/', 'home-page'], ['#/ai', 'ai-page']]) { await page.evaluate((x) => (location.hash = x), h); await page.waitForTimeout(150); assert.ok(await page.locator('#' + id).evaluate((e) => e.classList.contains('active-page')), id); }
    await page.goto(site.url + '/fitment-ai.html'); await page.waitForURL(/#\/ai/); await page.waitForSelector('#chat-card'); await ctx.close();
  });
});
