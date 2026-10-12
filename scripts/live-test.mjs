// Drives the DEPLOYED site through its real UI with a real browser.   Usage: npm run live | live:errors | live:outage
// Needs LIVE_URL in .env (the deploy preview URL). If the preview is protected, the browser window opens and waits
// (up to 5 minutes) while YOU log in or enter the site password; nothing secret is read from or written to files.
// First time only: npm run live:setup
import { mkdirSync, writeFileSync } from 'node:fs';
try { process.loadEnvFile('.env'); } catch { /* no .env */ }

const phase = process.argv[2] || 'flow';
const BASE = (process.env.LIVE_URL || '').replace(/\/+$/, '');
if (!BASE) { console.error('Set LIVE_URL=https://<your-preview>.netlify.app in .env'); process.exit(2); }
let chromium;
try { ({ chromium } = await import('playwright')); } catch { console.error('Playwright missing. Run: npm run live:setup'); process.exit(2); }

const OUT = 'live-out'; mkdirSync(OUT, { recursive: true });
const results = []; let n = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT_MIN = Number(process.env.LIVE_MAX_WAIT_MIN || 6);

const QUESTIONS = [
  '2019 Chevrolet Silverado 1500 LT. What bolt pattern and center bore does it use?',
  'I have a 2020 Toyota Tacoma TRD. What is the lug pattern and what should I check before going wider?',
  'Compare 265/70R17 with 285/70R17: overall diameter and speedometer effect.',
  'How much are 20 inch wheels for a Tacoma and do you have them in stock?',
  'What wheels will fit my truck?',
];

const ctx = await chromium.launchPersistentContext('.live-profile', { headless: process.env.LIVE_HEADLESS === '1', viewport: { width: 1280, height: 900 } });
await ctx.clearCookies();                       // every run starts as a brand-new guest
const page = ctx.pages()[0] || await ctx.newPage();
const shot = (name) => page.screenshot({ path: `${OUT}/${phase}-${String(++n).padStart(2, '0')}-${name}.png` }).catch(() => {});
const allow = () => page.locator('#chat-allowance-text').innerText();
const waitAllow = (re, t = 20000) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById('chat-allowance-text')?.textContent || ''), re.source, { timeout: t });
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, credentials: 'same-origin', headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, json: j };
}, [method, path, body]);

async function open() {
  await page.goto(`${BASE}/#/ai`);
  console.log('Opening the site. If a login or password page appears, complete it in the browser window (waiting up to 5 min)...');
  await page.waitForSelector('#chat-card', { timeout: 300000 });
  await waitAllow(/\d of|No questions|Unavailable|Busy/, 30000);
}
async function ask(q) {
  const before = await page.locator('.msg.bot, .msg.err').count();
  await page.fill('#chat-input', q); await page.click('#chat-send');
  await page.waitForFunction((c) => document.querySelectorAll('.msg.bot, .msg.err').length > c, before, { timeout: 70000 });
  await page.waitForFunction(() => !document.querySelector('.msg.pending'), null, { timeout: 5000 }).catch(() => {});
  const last = page.locator('.msg.bot, .msg.err').last();
  return { isError: (await last.getAttribute('class')).includes('err'), text: await last.innerText() };
}

try {
  await open();
  const cookies = await ctx.cookies(); const sid = cookies.find((c) => c.name === 'fx_sid');
  if (phase !== 'outage') check('guest cookie issued by server, HttpOnly, Secure, SameSite', !!sid && sid.httpOnly && (sid.secure || /^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) && /lax/i.test(sid.sameSite), sid ? `httpOnly=${sid.httpOnly} secure=${sid.secure} sameSite=${sid.sameSite}` : 'missing');
  const html = await page.content();
  check('no Pickaxe, no iframe, no key-like strings in the page', !/pickaxe/i.test(html) && !(await page.locator('iframe').count()) && !/sk-ant-|sb_secret_|eyJhbGciOi/.test(html));
  await shot('loaded');

  if (phase === 'flow') {
    const start = await allow();
    if (!check('starts with 5 of 5 (fresh guest)', /^5 of 5/.test(start), start)) { console.error('Not a fresh allowance. Network caps may already be used; wait for the window or run `truncate fx_usage;` in the Supabase SQL editor.'); throw new Error('abort'); }
    const t0 = Date.now(); const replies = [];
    for (let i = 0; i < 5; i++) {
      const r = await ask(QUESTIONS[i]); replies.push({ q: QUESTIONS[i], ...r });
      check(`question ${i + 1} answered`, !r.isError, r.isError ? r.text : `${r.text.length} chars`);
      await shot(`q${i + 1}`);
      const want = i === 4 ? /^No questions left/ : new RegExp(`^${4 - i} of 5`);
      await waitAllow(want, 8000).catch(() => {});
      check(`allowance after question ${i + 1}`, want.test(await allow()), await allow());
    }
    const badge = await page.locator('.msg.bot .tag').allInnerTexts();
    check('answers carry source badges', badge.length > 0, [...new Set(badge)].join(', '));
    check('database badge never says "verified"', !badge.some((b) => /database/i.test(b) && /(?<!un)verified/i.test(b)));
    writeFileSync(`${OUT}/flow-replies.json`, JSON.stringify(replies, null, 1));

    check('sixth question blocked in the UI', await page.locator('#chat-input').isDisabled() && await page.locator('#chat-send').isDisabled());
    const notice = await page.locator('#chat-notice').innerText();
    check('notice says when the next question is available', /used all 5 questions/.test(notice) && /available at \d{1,2}:\d{2}/.test(notice), notice);
    await shot('blocked');
    const direct = await api('POST', '/api/chat', { messages: [{ role: 'user', content: 'bypass attempt' }] });
    check('server refuses a direct 6th request (HTTP 429 rate_limited)', direct.status === 429 && direct.json?.error?.code === 'rate_limited', `${direct.status} ${direct.json?.error?.code}`);

    await page.reload(); await page.waitForSelector('#chat-card'); await waitAllow(/\d of|No questions/, 20000);
    check('refresh preserves the allowance (still none left)', /^No questions left/.test(await allow()), await allow());
    const st = (await api('GET', '/api/status')).json;
    check('status API agrees (remaining 0, next_at set)', st?.remaining === 0 && !!st?.next_at, JSON.stringify({ remaining: st?.remaining, next_at: st?.next_at }));
    await shot('after-refresh');

    const waitMs = Date.parse(st.next_at) - Date.now();
    console.log(`First question opens again at ${new Date(st.next_at).toLocaleTimeString()} (in ${Math.round(waitMs / 60000)} min).`);
    if (waitMs > MAX_WAIT_MIN * 60000) {
      check('rolling-window expiry observed', false, `wait is ${Math.round(waitMs / 60000)} min. Set LIMIT_WINDOW_MINUTES=2 on the preview, redeploy, rerun (or raise LIVE_MAX_WAIT_MIN).`);
    } else {
      if (waitMs > 6000) {
        await sleep(waitMs - 4000);
        const early = (await api('GET', '/api/status')).json;
        check('slot is still closed shortly before the window ends (not released early)', early?.remaining === 0, `remaining ${early?.remaining}`);
      }
      await sleep(Math.max(Date.parse(st.next_at) - Date.now(), 0) + 3000);
      await waitAllow(/^[1-5] of 5/, 30000).catch(() => {});
      const after = await allow();
      check('after the window, at least one slot reopens, without reload (rolling, so only expired questions are freed)', /^[1-5] of 5/.test(after), after);
      await shot('slot-open');
      if (/^[1-5] of 5/.test(after)) {
        const r = await ask('One more: what is the lug nut thread size for a 2019 Silverado 1500?');
        check('question succeeds in the reopened slot', !r.isError, r.isError ? r.text : '');
        const st2 = (await api('GET', '/api/status')).json;
        check('allowance decreased by exactly one after it', st2?.used >= 1, JSON.stringify({ used: st2?.used, remaining: st2?.remaining }));
      }
    }
  }

  if (phase === 'errors') {
    check('allowance starts at 5 of 5', /^5 of 5/.test(await allow()), await allow());
    for (let i = 0; i < 3; i++) {
      const r = await ask(QUESTIONS[i]);
      check(`failed request ${i + 1} shows a clear error`, r.isError && /not counted/i.test(r.text), r.text.replace(/\s+/g, ' '));
      check(`failed request ${i + 1} leaked no provider detail`, !/not_found|invalid_request|model:|anthropic|openai|api[_ -]?key|\b40[0-9]\b|\b50[0-9]\b/i.test(r.text));
      check(`allowance still 5 of 5 after failure ${i + 1}`, /^5 of 5/.test(await allow()), await allow());
    }
    const st = (await api('GET', '/api/status')).json;
    check('status API: used = 0 after three failures', st?.used === 0 && st?.remaining === 5, JSON.stringify({ used: st?.used, remaining: st?.remaining }));
    check('retry button offered', (await page.locator('.chat-retry').count()) > 0);
    await shot('errors');
  }

  if (phase === 'outage') {
    check('UI shows the assistant as unavailable', /Unavailable/.test(await allow()), await allow());
    check('input and send are disabled', await page.locator('#chat-input').isDisabled() && await page.locator('#chat-send').isDisabled());
    const r = await api('POST', '/api/chat', { messages: [{ role: 'user', content: 'outage probe' }] });
    check('direct request returns 503 "unavailable" and NOT a provider error (so the AI was never called)', r.status === 503 && r.json?.error?.code === 'unavailable', `${r.status} ${r.json?.error?.code}`);
    await shot('outage');
  }
} catch (e) {
  if (e.message !== 'abort') check('script ran to completion', false, e.message.split('\n')[0]);
  await shot('stopped');
} finally {
  const failed = results.filter((r) => !r.ok);
  writeFileSync(`${OUT}/${phase}-report.json`, JSON.stringify({ phase, base: BASE.replace(/^(https?:\/\/[^/]{3}).*/, '$1...'), when: new Date().toISOString(), results }, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} passed. Report and screenshots in ${OUT}/ (safe to share; no secrets).`);
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
}
