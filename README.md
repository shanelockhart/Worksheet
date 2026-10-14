# Fitment Expert by Operators Logic

Wheel and tire fitment reference (vehicle database, wheel vendor directory, service info) plus a built-in AI assistant.

```
public/                static site (index.html is the whole app, hash-routed)
netlify/functions/     /api/status and /api/chat (server-side, holds all secrets)
server/                config, sessions, rate limiting, provider adapters, prompt
supabase/schema.sql    persistent rate-limit storage (run once)
knowledge/             assistant instructions, glossary, site + archive fitment data
scripts/               sync-knowledge (runs at build), smoke (live credential check)
tests/                 API, rate-limit and browser tests
docs/CHAT_SETUP.md     setup, env vars, limits, costs, operations
```

Setup and operations: **[docs/CHAT_SETUP.md](docs/CHAT_SETUP.md)**. Private deploy and live-test walkthrough: **[docs/DEPLOY_PRIVATE.md](docs/DEPLOY_PRIVATE.md)**.

Run the tests (needs Node 22, PostgreSQL 16 binaries, and Playwright with Chromium):
`npm test` for API + rate-limit tests, `node --test tests/ui.test.mjs` for the browser tests.

Editing fitment data: change the `fitmentData` block in `public/index.html`; `npm run build` regenerates the assistant's knowledge from it.
