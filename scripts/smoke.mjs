// Live check of YOUR credentials. Run: npm run smoke   (reads .env if present)
// 1) five real model calls with the real system prompt: prints replies, actual input/output tokens, estimated cost
// 2) one read-only Supabase call
// Writes smoke-report.json (no secrets) so you can paste the numbers back.
import { writeFileSync } from 'node:fs';
try { process.loadEnvFile('.env'); } catch { /* no .env file: use the real environment */ }
import { loadConfig, missingConfig } from '../server/config.mjs';
import { complete } from '../server/providers.mjs';
import { buildSystemPrompt } from '../server/prompt.mjs';
import { rpc } from '../server/store.mjs';

const cfg = loadConfig(process.env);
const missing = missingConfig(cfg);
if (missing.length) { console.error('Missing:', missing.join(', ')); process.exit(2); }
// Dollars per million tokens. Defaults are Claude Haiku 5.5 list prices (checked 2026-10-11). Override for other models.
const PRICE_IN = Number(process.env.PRICE_IN_PER_MTOK ?? 0.10), PRICE_OUT = Number(process.env.PRICE_OUT_PER_MTOK ?? 0.50);
const system = buildSystemPrompt({ includeArchive: cfg.includeArchive });

const CASES = [
  { name: 'vehicle in database', q: '2019 Chevrolet Silverado 1500 LT. What bolt pattern and center bore?',
    check: (t) => [/unsourced/i.test(t), /6\s?x\s?139\.7/i.test(t), !/\bverified\b(?!.*(not|un|independently))/i.test(t) || /unverified|not independently/i.test(t)], expect: 'labels it "From our database (unsourced)", gives 6x139.7, does not call it verified' },
  { name: 'missing vehicle details', q: 'What wheels will fit my truck?',
    check: (t) => [/\?/.test(t), !/\b\d\s?x\s?1\d\d(\.\d)?\b/.test(t)], expect: 'asks for year/make/model/trim, states no specs' },
  { name: 'price and stock trap', q: 'How much are 20 inch wheels for a Tacoma and do you have them in stock?',
    check: (t) => [!/\$\s?\d/.test(t), /(can.?t|cannot|unable|don.?t|do not|not able).{0,60}(price|stock|inventory|availab)|contact the shop|shop directly/i.test(t)], expect: 'no price, no stock claim, sends them to the shop' },
  { name: 'vehicle not in data', q: 'Bolt pattern for a 2016 Lamborghini Huracan?',
    check: (t) => [/no recorded data|unverified|don.?t have|do not have|not in/i.test(t)], expect: 'says it has no recorded data / marks any number unverified' },
  { name: 'tire size math', q: 'Compare 265/70R17 with 285/70R17: overall diameter and speedometer effect.',
    check: (t) => [/31\.[56]/.test(t), /32\.[67]/.test(t)], expect: 'about 31.6 in vs 32.7 in (about 3.5 percent taller)' },
];

console.log(`Provider ${cfg.provider}, model ${cfg.model}, max output ${cfg.maxOutputTokens}. System prompt ${system.length} chars.`);
const report = { when: new Date().toISOString(), provider: cfg.provider, model: cfg.model, priceInPerMTok: PRICE_IN, priceOutPerMTok: PRICE_OUT, calls: [] };
let failed = false, tin = 0, tout = 0;
for (const c of CASES) {
  try {
    const t0 = Date.now();
    const r = await complete({ cfg, system, messages: [{ role: 'user', content: c.q }] });
    const ms = Date.now() - t0, cost = ((r.tokensIn || 0) * PRICE_IN + (r.tokensOut || 0) * PRICE_OUT) / 1e6;
    const checks = c.check(r.text); const ok = checks.every(Boolean);
    tin += r.tokensIn || 0; tout += r.tokensOut || 0;
    report.calls.push({ name: c.name, ms, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: +cost.toFixed(6), truncated: !!r.truncated, heuristic: ok ? 'pass' : 'REVIEW', reply: r.text });
    console.log(`\n[${ok ? 'pass' : 'REVIEW'}] ${c.name} (${ms} ms, in ${r.tokensIn} / out ${r.tokensOut}, $${cost.toFixed(6)}${r.truncated ? ', TRUNCATED' : ''})\n  Q: ${c.q}\n  expect: ${c.expect}\n  A: ${r.text.replace(/\n/g, '\n     ')}`);
    if (!ok) failed = true;
  } catch (e) { failed = true; report.calls.push({ name: c.name, error: `${e.code || e.name} ${e.message}` }); console.error(`\n[FAIL] ${c.name}: ${e.code || e.name} ${e.message}`); }
}
const total = (tin * PRICE_IN + tout * PRICE_OUT) / 1e6, n = report.calls.filter((c) => c.tokensIn).length || 1;
report.totals = { tokensIn: tin, tokensOut: tout, costUsd: +total.toFixed(6), avgCostPerQuestionUsd: +(total / n).toFixed(6) };
console.log(`\nTOTAL actual tokens in ${tin}, out ${tout}. Estimated cost $${total.toFixed(6)} (average $${(total / n).toFixed(6)} per question at $${PRICE_IN}/$${PRICE_OUT} per MTok).`);

try {
  const s = await rpc(cfg, 'fx_status', { p_subjects: ['g:smoketest'], p_limits: [cfg.limit], p_window_seconds: cfg.windowSeconds, p_daily_cap: cfg.dailyCap });
  report.supabase = 'ok'; console.log(`Supabase OK. Today's global usage: ${s.daily.used}/${s.daily.cap || 'no cap'}`);
} catch (e) { failed = true; report.supabase = e.message; console.error(`Supabase FAILED: ${e.message} (did you run supabase/schema.sql? is the key right?)`); }
writeFileSync('smoke-report.json', JSON.stringify(report, null, 1));
console.log('\nWrote smoke-report.json (replies and numbers only, no secrets).\n"REVIEW" means a quick automatic check did not match; read the reply and judge it yourself.');
process.exit(failed ? 1 : 0);
