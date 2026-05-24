# chat-bot — Chatwoot ↔ Claude/Codex bridge

A small Node service that powers Chatwoot's visitor chat **and** agent-side
AI features via the operator's Claude / Codex CLI subscriptions. No
per-token OpenAI billing.

## Three endpoints, one service

```
chat-bot.veebist.cloud
  ├─ POST /webhook                  ← Chatwoot Agent Bot webhook (visitor chat)
  ├─ POST /v1/chat/completions      ← OpenAI-compatible shim (Captain dashboard AI)
  ├─ POST /chat/completions         ← same handler (Chatwoot v4 calls both URL shapes)
  ├─ POST /api/chat                 ← generic bearer-authed endpoint for external tools
  └─ GET  /health                   ← provider state + semaphore depth + endpoint flags
```

## LLM providers — primary/secondary failover

```
┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ HTTP request    │ →  │ Semaphore (cap 6)│ →  │ FailoverProvider │
│ (any endpoint)  │    │ throttles all    │    │  primary: Claude │
│                 │    │ LLM calls        │    │  fallback: Codex │
└─────────────────┘    └──────────────────┘    └────────┬─────────┘
                                                         │
                                              ┌──────────┴──────────┐
                                              ▼                     ▼
                                       Claude CLI            Codex CLI
                                       (subscription)        (subscription)
```

Per-provider state is tracked (`healthy` / `degraded` / `down`). A 5-min
background probe re-promotes recovered providers. Auth-class failures
mark a provider `down` immediately; everything else marks `degraded`.

When the primary flips to unhealthy, alerts go to:

1. structured log line
2. SMTP email (`tarmo@veebist.ee`)
3. "Bot Alerts" Chatwoot inbox conversation (visible in the mobile app)

Debounced to one alert per provider per hour.

## File layout

```
bot/
├── Dockerfile                   node:20-bookworm-slim, ca-certificates, UID 1001
├── package.json                 dep: nodemailer (for failover alert emails)
├── index.js                     HTTP server, webhook handler, knowledge cache
├── providers/
│   ├── base.js                  ProviderError + error classification
│   ├── claude.js                ClaudeProvider (shells out to `claude -p ... --output-format json`)
│   ├── codex.js                 CodexProvider (shells out to `codex exec ...`)
│   ├── failover.js              FailoverProvider — primary/secondary + health tracking
│   └── index.js                 buildProvider() factory
├── lib/
│   ├── semaphore.js             Async semaphore for concurrency control
│   ├── chatwoot.js              Chatwoot API client (postMessage, fetchHistory, ...)
│   └── alerts.js                AlertSink (log + SMTP + Chatwoot inbox)
├── api/
│   ├── openai-shim.js           OpenAI-compatible /v1/chat/completions handler
│   └── chat.js                  Generic /api/chat handler (bearer auth)
└── knowledge/
    └── <site>.md                Per-site FAQ — loaded into system prompt, 5-min cache
```

## Configuration (env)

```bash
# core
CHATWOOT_URL=https://chat.veebist.cloud
CHATWOOT_API_TOKEN=<bot agent token>
CHATWOOT_ACCOUNT_ID=2

# providers
PRIMARY_LLM=claude              # claude | codex | none
SECONDARY_LLM=codex             # claude | codex | none
MAX_CONCURRENT=6                # semaphore cap; warns at half

# failover alerts (any can be left blank to disable that channel)
ALERT_INBOX_ID=3                # dedicated Chatwoot inbox for system alerts
ALERT_CONTACT_ID=11             # contact id linked to that inbox
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=info@scottest.ee
SMTP_PASS=...
ALERT_EMAIL_FROM=info@scottest.ee
ALERT_EMAIL_TO=tarmo@veebist.ee

# OpenAI-compatible shim (for Chatwoot's agent-AI Captain features)
CHATWOOT_OPENAI_KEY=<random 32-byte hex>

# Generic /api/chat endpoint (for external Veebist tools)
CHAT_BOT_API_TOKEN=<random 32-byte hex>
```

## Adding chat to a new client site

Two artifacts work together:

1. **`@veebist/chat-widget`** (in [veebist-platform](https://github.com/M1KK3R/veebist-platform)) — the React widget the site embeds
2. **This service** — shared infrastructure on the VPS, serves all sites via Chatwoot inboxes

Per-site steps (also automated by `scripts/onboard-site.mjs`):

```bash
# 1. interactive: creates inbox, assigns bot, collaborator, knowledge template
node scripts/onboard-site.mjs

# 2. in the new site's package.json
"@veebist/chat-widget": "file:../../veebist-platform/packages/chat-widget"

# 3. in the new site's root layout
import { ChatwootWidget } from '@veebist/chat-widget'
<ChatwootWidget />

# 4. set two env vars on the site's build
NEXT_PUBLIC_CHATWOOT_BASE_URL=https://chat.veebist.cloud
NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN=<copied from inbox settings>
```

That's it. Visitor chat works immediately; the bot routes through Claude
(or Codex on failover). Knowledge is hand-curated at `bot/knowledge/<slug>.md`
and reloaded every 5 min — no restart needed.

## Chatwoot v4 + Captain agent AI

Chatwoot v4 moved its agent-side AI features (Suggest reply, Summarize,
Rephrase, etc.) into a system called **Captain**. We hijack it to use our
own shim instead of api.openai.com.

Two `InstallationConfig` rows control this (set them once after the v4 upgrade):

| Name | Value |
|---|---|
| `CAPTAIN_OPEN_AI_API_KEY` | same value as `CHATWOOT_OPENAI_KEY` (bot env) |
| `CAPTAIN_OPEN_AI_ENDPOINT` | `https://chat-bot.veebist.cloud/` ← **no /v1** |
| `CAPTAIN_OPEN_AI_MODEL` | any OpenAI model name (e.g. `gpt-4o-mini`); the shim ignores it |

Why no `/v1` on the endpoint? Chatwoot's `Captain::BaseTaskService#api_base`
appends `/v1` itself, and the global `Llm::Config.configure_ruby_llm` lets
RubyLLM append `/chat/completions`. The bot serves **both** `/chat/completions`
and `/v1/chat/completions` to handle both code paths from a single endpoint.

## Codex CLI gotcha on the VPS

System `/usr/local/bin/codex` was the broken **0.93.0** for ChatGPT-account
auth (model `gpt-5.5` requires a newer CLI; npm's `@latest` is still 0.93.0).
Claudeuser's npm prefix has the working **0.132.0** at
`~/.npm-global/lib/node_modules/@openai/codex/`. We repointed `/usr/local/bin/codex`
there. If `sudo npm install -g @openai/codex` ever clobbers this:

```bash
sudo rm /usr/local/bin/codex
sudo ln -s /home/claudeuser/.npm-global/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
```

## Shared types

Sites that integrate the bot beyond the widget (custom server-side calls)
should depend on [`@veebist/chat-types`](../../../veebist-platform/packages/chat-types)
for the wire format (webhook payloads, `/api/chat` shapes, `/health` shape).

## Local development

```bash
# install deps
cd bot && npm install

# run with mocked providers (export DRY_RUN=1 in your env first, or hardcode for testing)
node index.js
```

## Operating

| Command | What |
|---|---|
| `docker logs chat-bot --tail 50 -f` | tail bot logs |
| `curl https://chat-bot.veebist.cloud/health \| jq` | provider state + semaphore depth |
| `docker compose --env-file .env up -d --force-recreate chat-bot` | redeploy bot only |
| `docker compose --env-file .env restart chat-bot` | restart bot (picks up new host mounts e.g. fresh Claude credentials.json) |
