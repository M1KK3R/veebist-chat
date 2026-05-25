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

## Pipeline (v3)

Each visitor message goes through:

```
Visitor message
  → handoff trigger?     ─ yes ─→ assign human, stop
  → rate limit?          ─ blocked ─→ apology + stop
  → site config + snapshot (live Medusa + Payload + CMS knowledge)
  → strategy = selectStrategy(snapshot)   (snapshot | retriever | overflow)
      └─ retriever: pass-1 Claude (router) picks 10 relevant handles
  → buildSystemPrompt(knowledge, snapshot subset, feature flags)
  → provider.ask()       (Claude → Codex on failure)
  → URL validator        (fix Claude's slug-modification bug)
  → tool dispatcher      (handle [[LOOKUP_ORDER]], [[LOOKUP_REFUND]], [[VALIDATE_GIFTCARD]])
  → sanitizer            (strip Luhn-valid CCs, IBANs, JWTs, off-allowlist emails/phones)
  → Chatwoot.postMessage
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
│   ├── alerts.js                AlertSink (log + SMTP + Chatwoot inbox)
│   ├── rate-limit.js            Per-visitor token-bucket rate limiter
│   ├── url-validator.js         Post-processor: re-anchors LLM-mutated slugs to catalog truth
│   ├── tools.js                 Verified-lookup tool dispatcher (LOOKUP_ORDER/REFUND, VALIDATE_GIFTCARD)
│   └── sanitize.js              Final-pass scrub: Luhn-CC, IBAN, JWT, bearer, off-allowlist email/phone
├── catalog/
│   ├── medusa.js                Live products + regions
│   ├── payload.js               Articles + pages + curated CMS knowledge (from @veebist/chat-knowledge)
│   ├── snapshot.js              10-min stale-while-revalidate per-site cache
│   ├── format.js                Snapshot → compact markdown for system prompt
│   └── retriever.js             LLM-as-retriever: 2-pass strategy for 201-5000 item catalogs
├── api/
│   ├── openai-shim.js           OpenAI-compatible /v1/chat/completions handler
│   └── chat.js                  Generic /api/chat handler (bearer auth)
├── tests/                       node:test unit tests (npm test)
└── knowledge/
    └── <site>.md                Fallback per-site FAQ — used when Payload CMS knowledge is empty
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

# Verified-lookup routes on each site (shared with @veebist/chat-api on site host)
CHAT_API_TOKEN=<random 32-byte hex>

# Per-site (replace `SCOTTEST` with the site key)
SCOTTEST_MEDUSA_URL=https://api.scottest.veebist.cloud
SCOTTEST_MEDUSA_PUBLISHABLE_KEY=pk_…
SCOTTEST_PAYLOAD_URL=https://scottest.veebist.cloud/api
SCOTTEST_LOCALE=et
SCOTTEST_DISPLAY_NAME="ScotEst OÜ"
SCOTTEST_PRODUCT_LIMIT=100
SCOTTEST_CONTACT_EMAIL=info@scottest.ee
SCOTTEST_CONTACT_PHONE=+372…
SCOTTEST_SITE_URL=https://scottest.veebist.cloud      # used to call /api/chat/lookup-*
SCOTTEST_FEATURE_ORDER_LOOKUP=true                     # enable [[LOOKUP_ORDER/REFUND]] markers
SCOTTEST_FEATURE_GIFTCARD_VALIDATION=false             # opt-in; default off
SCOTTEST_KNOWLEDGE_STRATEGY=auto                       # auto | snapshot | retriever
```

## Verified-lookup tools

When `SCOTTEST_FEATURE_ORDER_LOOKUP=true` (or the matching `<SITE>_…` env),
the system prompt teaches the LLM to emit one of these on its own line:

```
[[LOOKUP_ORDER email=info@scottest.ee display_id=1234]]
[[LOOKUP_REFUND email=info@scottest.ee display_id=1234]]
[[VALIDATE_GIFTCARD code=ABCD-1234]]
```

`lib/tools.js` scans the reply for those, calls the matching route on the
site's origin (`POST <SITE_URL>/api/chat/{lookup-order,lookup-refund,validate-giftcard}`,
bearer = `CHAT_API_TOKEN`), and substitutes a localized natural-language
result. Each marker is matched against the actual server-side data — the
visitor's claimed email + order# must both match, otherwise the bot says
"I couldn't find that order" with no info leak.

The site-side routes are provided by [`@veebist/chat-api`](https://github.com/M1KK3R/veebist-platform/tree/main/packages/chat-api).

## Product links in replies

`catalog/format.js` renders each product as a markdown link in the system
prompt: `- [Title](https://site/pood/handle) €price [cats]`. Claude
copies these verbatim, so the visitor sees the **product name as a
clickable link**, not a separate bare URL. Articles + pages use the same
format.

For this to work, `<SITE>_SITE_URL` must be set on the bot host. The
webhook payload's `inbox.website_url` is unreliable (Chatwoot doesn't
always include it on `message_created`), so the env var is the canonical
source. Without it, products render without URLs and Claude correctly
says "the catalog has no URLs" rather than inventing them.

After all that, `lib/url-validator.js` runs as a safety net — if Claude
*does* mutate a URL (underscore↔hyphen swap, slug translation, etc.) it
fuzzy-matches against the snapshot and rewrites to canonical, or strips
the URL entirely if no match. Logs `URLs corrected=… removed=… ok=…`
when fixes fire.

## CMS-curated knowledge

If the site has [`@veebist/chat-knowledge`](https://github.com/M1KK3R/veebist-platform/tree/main/packages/chat-knowledge)
mounted at `/api/chat/knowledge`, the bot polls it on every snapshot
refresh and prefers its content over the local `knowledge/<site>.md`
fallback. The CMS lets clients update their KB through the Payload admin
UI — no SSH, no editing markdown on the bot host.

## LLM-as-retriever (Phase 2 catalog mode)

For catalogs > 200 products, `catalog/retriever.js` runs a two-pass
prompt: pass-1 router picks the ≤10 most relevant product handles from a
compact (handle | title | desc) catalog; pass-2 answerer composes the
reply with full details for just those picks. No embeddings, no extra
service — both passes go through the existing Claude/Codex providers.

The strategy is auto-selected by catalog size; override per-site with
`<SITE>_KNOWLEDGE_STRATEGY=snapshot|retriever|auto`.

## Output sanitization

Final-pass scrub runs on every reply (webhook + `/api/chat`) regardless of
whether tools fired. `lib/sanitize.js` strips:

- Luhn-valid credit card numbers (raw or space/dash-grouped)
- IBAN-shaped strings
- JWTs (`eyJ…`) + Bearer/api-key fragments ≥24 chars
- Email addresses NOT in `siteConfig.contactInfo` or the snapshot
- International phone numbers NOT in the allowlist

Stripped values are replaced with `…` so the surrounding sentence still
reads naturally. The set of fired patterns is logged but never the values.

## Tests

```bash
cd bot && npm test
```

42 tests covering: sanitizer (Luhn + allowlist), tool dispatcher (all 3
markers + EN/ET rendering + network failure), retriever strategy
selection + router parsing, and CMS knowledge fetch.

## Adding chat to a new client site

📖 **Canonical walkthrough**: [veebist-platform/docs/chat-onboarding.md](https://github.com/M1KK3R/veebist-platform/blob/master/docs/chat-onboarding.md)

That doc covers all features in one place: widget, CMS knowledge, verified
order/refund/gift-card lookup, URL patterns, the SQL migration Payload v3
needs, and the env vars on both the bot host and the per-site host.

Quick reference for the bot-host side only (run `scripts/onboard-site.mjs`
first to create the Chatwoot inbox interactively):

```
# Per-site env in ~/stacks/chatwoot/.env (one block per client)
ACME_DISPLAY_NAME=Acme OÜ
ACME_LOCALE=et
ACME_SITE_URL=https://acme.veebist.cloud           # ← required; else products render without URLs
ACME_MEDUSA_URL=https://acme.veebist.cloud/medusa
ACME_MEDUSA_PUBLISHABLE_KEY=pk_…
ACME_PAYLOAD_URL=https://acme.veebist.cloud/api
ACME_CONTACT_EMAIL=info@acme.ee
ACME_CONTACT_PHONE=+372…
ACME_FEATURE_ORDER_LOOKUP=false                    # flip true after mounting @veebist/chat-api routes
ACME_FEATURE_GIFTCARD_VALIDATION=false             # opt-in; yes/no only, rate-limited
ACME_KNOWLEDGE_STRATEGY=auto                       # auto | snapshot | retriever
ACME_URL_PATTERN_PRODUCT=/pood/{handle}            # override if site uses different paths
ACME_URL_PATTERN_ARTICLE=/blogi/{slug}
ACME_URL_PATTERN_PAGE=/lehed/{slug}
```

Plus one shared bearer across all sites + the bot:

```
CHAT_API_TOKEN=<32-byte hex; same value on bot + every site .env>
```

Bot detects new sites automatically — no code change. The `listSiteKeys()`
helper scans env for `<SITE>_MEDUSA_URL` or `<SITE>_PAYLOAD_URL`.

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
