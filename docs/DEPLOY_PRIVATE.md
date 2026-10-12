# Private deployment and live test walkthrough

Goal: a private Netlify deploy of branch `rebrand/operators-logic-fitment-expert`, a hosted Supabase project, and a real end-to-end test. **You type every secret into Netlify, Supabase or your own `.env` file. Never paste a key into chat, a commit, an issue or a PR.** The test reports (`smoke-report.json`, `live-out/`) contain no secrets and are safe to share.

Time: about 30 minutes plus a few redeploys.

## 1. Supabase (database for the limits)

1. supabase.com > New project. Pick a region near you and a strong database password (store it in a password manager; this app does not use it).
2. SQL Editor > New query > paste the whole of `supabase/schema.sql` > Run. It should end with "Success".
3. Table Editor > `fx_usage` should exist and show **RLS enabled**.
4. Keys (Dashboard > Settings > API Keys; names have changed over time):
   - **Project URL**: `https://<ref>.supabase.co`
   - **Secret key** (`sb_secret_...`) or the legacy `service_role` key. Server only. Either style works; the app sends each in the format Supabase requires.
   Keep that tab open; you will copy from it straight into Netlify in step 3. Do not copy the publishable/anon key anywhere; this app does not use it.
5. Free projects pause after about a week of no activity; a paused project looks like an outage (the assistant refuses to answer). Unpause in the dashboard.

## 2. AI provider key

1. console.anthropic.com > API keys > create a key named `fitment-preview`.
2. In the same Console set a monthly **spend limit** for the workspace or organization (second safety net behind `DAILY_CAP`). Menu names vary; look for Limits / Billing.

## 3. Netlify (private)

1. app.netlify.com > Add new project > Import from Git > GitHub > `shanelockhart/Worksheet` (private repos work once you grant access).
2. Production branch: **`rebrand/operators-logic-fitment-expert`** (not `main`; `main` is the old public Pickaxe site). Build settings come from `netlify.toml` (publish `public`, functions `netlify/functions`); leave them. **Before the first deploy finishes, or immediately after, turn on protection (next step).**
3. Protection (so only you can open it). What is available depends on your plan ([Netlify docs](https://docs.netlify.com/manage/security/secure-access-to-sites/site-protection/)):
   - Credit-based Free/Personal: make the project **Private** (team-only).
   - Pro or credit-based Pro: **Password** protection (Project visibility / Visitor access).
   Write the password in a password manager. Do not reuse one.
4. Environment variables: Project configuration > Environment variables > Add a variable. Add these (type or paste the values here, nowhere else). Tick **Contains secret values** on the three secrets. If the Scopes option is offered, limit them to **Functions**.

   | Variable | Value | Secret |
   |---|---|---|
   | `AI_API_KEY` | key from step 2 | yes |
   | `SUPABASE_URL` | Project URL | no |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key | yes |
   | `SESSION_SECRET` | 64 random hex characters. Make one in a terminal: `openssl rand -hex 32` | yes |
   | `LIMIT_WINDOW_MINUTES` | `2` **temporarily**, so the window-expiry test takes minutes, not an hour | no |

   Defaults cover everything else (model `claude-haiku-5-5`, 5 questions, `DAILY_CAP` 500).
5. Deploys > Trigger deploy > Deploy project. Environment changes only reach functions on a **new** deploy; you will repeat this after every change below.
6. Open the site URL (log in or enter the password). Go to Assistant. It should read "5 of 5 questions left". If it says Unavailable, check Functions > `api` > logs: a line `missing configuration: <NAME>` names the variable that is not set (never its value).

## 4. Your local `.env` (for the scripts; git-ignored)

In the repo folder create `.env` with the same five values plus the site address (SESSION_SECRET can be any 32+ characters here):

```
AI_API_KEY=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SESSION_SECRET=...
LIVE_URL=https://<your-site>.netlify.app
```

## 5. Live tests (commands are short on purpose)

```
npm run smoke          # real model calls: replies, real token usage, estimated cost
npm run live:setup     # once: installs Playwright + Chromium
npm run live           # real UI flow on the deployed site
```

- `smoke` writes `smoke-report.json`. Replies marked REVIEW did not match a quick automatic check; read them.
- `live` opens a browser window (if the site is protected it waits while you log in or type the password, up to 5 minutes). It asks five real questions, confirms the sixth is blocked (in the UI and by a direct API call), refreshes, then waits for the 2-minute window and confirms a slot reopens and works. Results: `live-out/flow-report.json` and screenshots.
- If it says the allowance is not 5 of 5, the earlier run's rows are still counted (network caps). Wait out the window or run `truncate fx_usage;` in the Supabase SQL editor.

### Failure refund test
1. Netlify: set `AI_MODEL` to `not-a-real-model`. Trigger deploy.
2. `npm run live:errors`. Expect: clear error text, allowance stays 5 of 5, no provider detail in the message.

### Database outage test
1. Keep the bad `AI_MODEL`. Also set `SUPABASE_URL` to `https://example.invalid`. Trigger deploy.
2. `npm run live:outage`. Expect: "Unavailable", input disabled, direct request answered `503 unavailable`. Because the model is also broken, a provider error code (502) here would prove the AI had been called; `unavailable` proves it was not.
3. Netlify > Functions > `api` > logs should show `store fx_...: network` lines and no `provider error` lines.

### Restore
Set `AI_MODEL` back (or delete the variable), set `SUPABASE_URL` back, delete `LIMIT_WINDOW_MINUTES` (or set `60`), Trigger deploy, open the site once to confirm "5 of 5". Delete `.live-profile/` (browser profile used by the script).

## 6. After it passes
Merge PR #1 into `main`, then change Netlify's production branch to `main` (keep the protection until you decide to go public). If any key was ever pasted somewhere it should not be, rotate it in the provider's dashboard and update Netlify.
