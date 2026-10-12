try { process.loadEnvFile('.env'); } catch { /* no .env file: use the real environment */ }
// Live check of your real credentials. Run: npm run smoke   (reads .env if present: node --env-file=.env scripts/smoke.mjs)
// 1) calls the AI provider with the real system prompt and prints the reply + token usage
// 2) calls the Supabase rate-limit functions (status only; consumes nothing)
import { loadConfig, missingConfig } from '../server/config.mjs';
import { complete } from '../server/providers.mjs';
import { buildSystemPrompt } from '../server/prompt.mjs';
import { rpc } from '../server/store.mjs';

const cfg = loadConfig(process.env);
const missing = missingConfig(cfg);
if (missing.length) { console.error('Missing:', missing.join(', ')); process.exit(2); }
let failed = false;

console.log(`Provider ${cfg.provider}, model ${cfg.model}`);
try {
  const t = Date.now();
  const r = await complete({ cfg, system: buildSystemPrompt({ includeArchive: cfg.includeArchive }), messages: [{ role: 'user', content: 'What bolt pattern and center bore does a 2019 Silverado 1500 use?' }] });
  console.log(`  OK in ${Date.now() - t} ms, tokens in/out: ${r.tokensIn}/${r.tokensOut}${r.truncated ? ' (TRUNCATED at max tokens)' : ''}\n  Reply: ${r.text.slice(0, 600)}`);
} catch (e) { failed = true; console.error(`  FAILED: ${e.code || e.name} ${e.message}`); }

try {
  const s = await rpc(cfg, 'fx_status', { p_subjects: ['g:smoketest'], p_limits: [cfg.limit], p_window_seconds: cfg.windowSeconds, p_daily_cap: cfg.dailyCap });
  console.log(`Supabase OK. Today's global usage: ${s.daily.used}/${s.daily.cap || 'no cap'}`);
} catch (e) { failed = true; console.error(`Supabase FAILED: ${e.message} (did you run supabase/schema.sql?)`); }
process.exit(failed ? 1 : 0);
