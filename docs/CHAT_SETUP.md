# Fitment Expert chat: setup and operations

The assistant is our own chat UI (`#/ai` page) calling `/api/chat`, a Netlify Function. The function holds every secret, enforces limits in Supabase, and calls the AI provider. Nothing secret is in the browser or in GitHub.

## 1. Environment variables

Set in Netlify: Site configuration > Environment variables. Mark keys as **secret**. Never commit them (`.env` is git-ignored; `.env.example` lists everything).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AI_API_KEY` | yes (secret) | | Provider API key |
| `AI_PROVIDER` | no | `anthropic` | `anthropic`, or `openai` for any OpenAI-compatible chat-completions API |
| `AI_MODEL` | no | `claude-haiku-5-5` | Model id |
| `AI_BASE_URL` | no | provider default | Override for proxies or other OpenAI-compatible hosts |
| `AI_MAX_OUTPUT_TOKENS` | no | `700` | Hard cap on reply length |
| `AI_TIMEOUT_MS` | no | `25000` | Provider timeout (must stay under the 60 s function limit) |
| `AI_EFFORT` | no | empty | Anthropic `output_config.effort` (`low`/`medium`/`high`). Leave empty unless you know the model supports it |
| `SUPABASE_URL` | yes | | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes (secret) | | Server only. Bypasses RLS; never expose |
| `SESSION_SECRET` | yes (secret) | | 32+ random characters. Signs guest sessions, hashes IPs. Rotating it logs everyone out and resets all counters |
| `LIMIT_PER_WINDOW` | no | `5` | Questions per user per window |
| `LIMIT_WINDOW_MINUTES` | no | `60` | Rolling window |
| `IP_LIMIT_PER_WINDOW` | no | `20` | Questions per network per window, all sessions combined |
| `NEW_SESSIONS_PER_IP` | no | `10` | New guest sessions one network may create per window |
| `DAILY_CAP` | no | `500` | Global questions per UTC day. `0` disables (not recommended) |
| `MAX_INPUT_CHARS` | no | `600` | Max question length |
| `MAX_HISTORY_MESSAGES` | no | `6` | Earlier messages sent as context |
| `MAX_HISTORY_CHARS` | no | `3000` | Character budget for that context |
| `ALLOWED_ORIGINS` | no | same origin only | Extra origins allowed to call `/api/chat` |
| `AUTH_ENABLED` | no | `false` | Accept a Supabase user token (see "Signed-in users") |
| `KNOWLEDGE_INCLUDE_ARCHIVE` | no | `true` | Include the unverified archive (labeled "Unverified") in the model's knowledge |

## 2. One-time setup

1. **Supabase**: create a project, open SQL Editor, paste and run `supabase/schema.sql` (safe to re-run). Copy the project URL and the `service_role` key.
2. **AI provider**: create an API key with a spend limit set in the provider console (second line of defense behind `DAILY_CAP`).
3. **Netlify**: connect the repo (branch to deploy), keep the defaults from `netlify.toml` (publish `public/`, functions `netlify/functions`), add the variables above.
4. **Check credentials before going live**: locally `cp .env.example .env`, fill it in, run `npm run smoke`. It makes one real model call (prints reply and token counts) and one read-only Supabase call.
5. Open the site, go to Assistant, ask a question. "4 of 5 questions left" confirms the whole path.

## 3. How the limits work

- **Five per rolling 60 minutes, enforced on the server.** Every question writes one row per bucket (user/guest, network, global) to `fx_usage` in Supabase. A question counts if its row is newer than 60 minutes. A slot frees when the oldest counted question turns 60 minutes old, which is the time shown in the UI.
- **Refresh does not reset it.** The count lives in Supabase, keyed by a signed cookie, not in the page.
- **Atomic.** `fx_reserve` checks all limits and inserts under Postgres advisory locks, so parallel requests cannot exceed a limit (tested with 20 simultaneous requests against real Postgres: exactly 5 answered).
- **Failed provider calls do not count.** The question is reserved before the provider call and deleted if the call fails, times out, or returns nothing. The daily cap is given back too.
- **Fail closed.** If Supabase is unreachable the assistant answers nothing (503) rather than running unlimited.
- **Daily cap** `DAILY_CAP` counts answered questions across everyone per UTC day; the UI shows when it reopens.
- **Per-question cost bounds**: input capped at `MAX_INPUT_CHARS`, context at `MAX_HISTORY_*` (the server ignores whatever history the browser sends beyond that), output at `AI_MAX_OUTPUT_TOKENS`.

### Guest limits are not a guaranteed five-per-person limit

Guests have no identity, so the limit attaches to a signed session cookie plus a hashed network address. Anyone who clears cookies, uses a private window, or switches network gets a new guest allowance. The additional controls only bound the abuse: a network is capped at `IP_LIMIT_PER_WINDOW` questions and `NEW_SESSIONS_PER_IP` new sessions per hour, and the whole site at `DAILY_CAP` per day. Conversely, people behind one shared address (office, school, mobile carrier NAT) share the network cap and can lock each other out. Real per-person limits need sign-in.

### Signed-in users (optional, no sign-in screen yet)

With `AUTH_ENABLED=true`, a request carrying `Authorization: Bearer <Supabase access token>` is verified server-side against Supabase Auth and counted against that user id, so the allowance follows the person across devices. The site has no sign-in UI yet; adding one (Supabase Auth in the page, then sending the token) is the path to true per-user limits.

## 4. Cost

Pricing checked on the official Anthropic pricing page on 2026-10-11: **Claude Haiku 5.5 at $0.10 per million input tokens and $0.50 per million output tokens**. It was the cheapest capable option found (Gemini 3.1 Flash-Lite was $0.25 / $1.50). Prices change; recheck before relying on this.

The system prompt (instructions, glossary, database, archive) is about 5,300 tokens (about 3,000 without the archive). Worst case per question is about 7,500 input plus 700 output tokens, roughly **$0.0011**. At the default `DAILY_CAP=500` that is at most about **$0.55 per day** (about $17 a month) in the worst case. Token counts per question are stored in `fx_usage` so you can compare to real bills. These are estimates from character counts, not measured token usage with a live key.

To switch provider/model, change `AI_PROVIDER`, `AI_MODEL` (and `AI_BASE_URL` for non-default hosts). No code change.

## 5. What the assistant knows

Built from files in this repo by `scripts/sync-knowledge.mjs` (runs on every Netlify build):

| Tier | Source | How the assistant labels it |
|---|---|---|
| Database | `fitmentData` in `public/index.html` (30 vehicles) | "From our database:" |
| Unverified archive | `knowledge/fitment-history.json`: records recovered from git history (60 extra vehicles; 4 vehicles whose old records disagree on a value) | "Unverified:" |
| General | `knowledge/glossary.md` formulas and definitions | "General guidance:" |
| Vendor directory | `wheelVendorsData` (names and brands only, no phone numbers) | distributor directory, not inventory |

The Service Info page (internal claims procedure) is deliberately **not** given to the assistant. Rules (request missing vehicle details, never invent inventory/prices/compatibility, label certainty) are in `knowledge/instructions.md`. Edit that file and redeploy to change behavior.

### What was held only in Pickaxe (not recoverable from GitHub)

Neither repository contained the Pickaxe assistant's own configuration. Not in GitHub, and therefore not preserved unless you copy it over from the Pickaxe dashboard:

- The Pickaxe system prompt / instructions for "Shane's AI Fitment Specialist"
- Any documents or knowledge base uploaded to the Pickaxe tool
- Its model choice, greeting message, and example prompts
- Chat history and analytics

`knowledge/instructions.md` is a **new** rewrite based on your requirements, not a copy. To carry over anything from Pickaxe, paste its instructions into the end of `knowledge/instructions.md` and its documents into `knowledge/` (then extend `scripts/sync-knowledge.mjs` to include them). Review before shipping.

## 6. Privacy

Stored in Supabase: a random guest session id or user id, a keyed hash of the network address (raw IPs are not stored), timestamps, and token counts. Question and answer text are **not** stored by this app. The text of each question and the last few messages are sent to the AI provider, which has its own retention terms; review them and add a notice to the site if you require one. Rows older than 3 days are deleted automatically.

## 7. Operations

```sql
-- usage today (UTC)
select count(*) from fx_usage where scope = 'global' and created_at >= date_trunc('day', now() at time zone 'utc');
-- tokens today
select sum(tokens_in) tin, sum(tokens_out) tout from fx_usage where scope = 'global' and created_at >= current_date;
-- reset one person's allowance (find their rows by time) or everyone's:
truncate fx_usage;
```

- Raise or lower `DAILY_CAP` without redeploying code (change the variable, redeploy).
- Function logs show `provider error: <kind>` lines (no prompts, no keys). A burst of `busy`/`auth` means check the provider status or key.
- A function crash between reserving and releasing leaves one counted question until it ages out (rare; bounded by the 60-minute window).
- `fitment-ai.html` remains only as a redirect to `/#/ai` for old links.

## 8. Tested vs not tested

See the pull request. In short: server limits, the real Postgres functions, concurrency, failure refunds, validation, security checks and the browser UI on phone and desktop are covered by automated tests with a **mock** AI provider. A live call to Anthropic/OpenAI and to a hosted Supabase project has **not** been made from this environment (no credentials); `npm run smoke` does that with your keys.
