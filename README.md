# veebist-chat — self-hosted Chatwoot CE + Claude-CLI AI bot

Open-source live chat for Veebist client sites. **Chatwoot Community Edition**
provides the website widget, agent inbox, and iOS / Android apps. A small
**Node bot service** sits next to it and shells out to **Claude Code CLI**
to answer visitor questions automatically, with a clean handoff path to a
human agent.

Currently powering `chat.veebist.cloud`, embedded on
[scottest.veebist.cloud](https://scottest.veebist.cloud).

## Why this setup

| | Why we picked it |
|---|---|
| **Chatwoot CE** | Open source, unlimited agents on self-host, polished iOS/Android apps that talk to self-hosted instances, supports Agent Bot webhooks out of the box. Tawk.to alternative without the upsell. |
| **Claude CLI in the bot** | The bot shells out to `claude -p "..."` using the operator's existing Claude subscription mounted from the host (kusimusi pattern). No per-token API fees. Same authenticated session, no API key in env. |
| **Dedicated Postgres + Redis** | Other stacks on the VPS (Medusa, Payload, n8n) have their own DBs. A Chatwoot upgrade that forces a Postgres major bump won't ripple into everything else. |
| **Internal-only bot webhook** | The bot's webhook endpoint is reachable publicly at `chat-bot.veebist.cloud/webhook` for testing, but Chatwoot calls it container-to-container via the shared `chatwoot` Docker network. |

## Architecture

```
                     ┌──────────────────────────────┐
                     │  scottest.veebist.cloud      │
                     │  Next.js storefront          │
                     │                              │
                     │  ChatwootWidget React        │
                     │  ├── loads /packs/js/sdk.js  │
                     │  └── injects iframe          │
                     └────────┬─────────────────────┘
                              │ visitor types
                              ▼
                  https://chat.veebist.cloud/widget
                              │
                              │  (iframe inside scottest)
                              ▼
                     ┌──────────────────────────────┐
                     │  Traefik (TLS, mytlschallenge)│
                     └──────┬───────────────────────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
        ┌───────────────┐      ┌──────────────────┐
        │ chatwoot-rails│      │   chat-bot       │
        │ (Puma + JS    │◀────▶│ Node 20 + Claude │
        │  widget host) │      │  CLI mounted     │
        └───┬───────────┘      └────────┬─────────┘
            │                           │ shells out
            │                           ▼
            │                  /home/app/bin/claude -p
            │                  (subscription auth)
            ▼
        ┌──────────────────┐
        │ chatwoot-postgres│
        │ chatwoot-redis   │
        │ chatwoot-sidekiq │
        └──────────────────┘
                  │
                  │ ActionCable WebSocket
                  ▼
        wss://chat.veebist.cloud/cable
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   Web admin           Mobile apps
   (browser)           (iOS/Android, official Chatwoot apps)
                       — push via Chatwoot's relay server
                       — FCM/APNs delivered to device
```

Flow on a typical message:

1. Visitor types in widget → POST to `/api/v1/widget/messages`
2. Chatwoot creates conversation in `pending` status, enqueues `AgentBots::WebhookJob`
3. Job POSTs to `chat-bot.veebist.cloud/webhook`
4. Bot loads `knowledge/<site>.md` + last 6 messages, shells out to `claude -p "..."`
5. Bot POSTs the reply back via Chatwoot's outgoing-message API as the AgentBot user
6. Chatwoot broadcasts the new message over ActionCable + sends a push to all agents in the inbox (you get the mobile/browser ping)
7. If visitor types `inimene` / `human` / `agent` → bot posts a transitioning message + flips conversation to `open` so a human takes over

## Stack components

| Service | Image | Notes |
|---|---|---|
| `chatwoot-rails` | `chatwoot/chatwoot:v3.16.0` | Web app, admin UI, widget host, ActionCable. Public via Traefik at `chat.veebist.cloud`. |
| `chatwoot-sidekiq` | same | Background workers: webhooks, emails, ActionCable broadcasts. |
| `chatwoot-postgres` | `pgvector/pgvector:pg16` | Dedicated. `chatwoot` database. |
| `chatwoot-redis` | `redis:7-alpine` | Dedicated, password-protected. Sessions + Sidekiq queues. |
| `chat-bot` | built from `bot/` | Node 20 bookworm (glibc — alpine/musl can't run the Claude ELF). Reads webhook, calls Claude CLI, posts reply. Public at `chat-bot.veebist.cloud` (mainly for `/health`). |

Layout on the VPS:
```
/home/claudeuser/stacks/chatwoot/
├── docker-compose.yml         all 5 services
├── .env                       secrets (gitignored)
├── README.md                  this file
└── bot/
    ├── Dockerfile             node:20-bookworm-slim, UID 1001 to match host
    ├── index.js               webhook receiver + Claude shell-out
    └── knowledge/
        └── scottest.md        per-site FAQ + structured info
```

## First-time deploy

Prerequisites:
- A DNS A record `chat.example.com` → your VPS IP
- A DNS A record `chat-bot.example.com` → same VPS IP (for the public `/health`; bot itself talks internal-only)
- Traefik running on the VPS with `traefik-public` network + `mytlschallenge` resolver
- The operator's Claude Code CLI installed in their VPS home dir at `~/.local/bin/claude`, authenticated (`~/.claude.json` + `~/.claude/.credentials.json` populated)
- Host user runs as UID 1001 — required so the bind-mounted Claude auth files are readable

Steps:

```bash
# 1. Clone this repo into /home/<host-user>/stacks/chatwoot
git clone https://github.com/M1KK3R/veebist-chat /home/claudeuser/stacks/chatwoot
cd /home/claudeuser/stacks/chatwoot

# 2. Copy + fill in .env (see .env.example)
cp .env.example .env
# Generate secrets:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"  # SECRET_KEY_BASE
node -e "console.log(require('crypto').randomBytes(24).toString('base64').replace(/[+/=]/g,''))"  # POSTGRES_PASSWORD
node -e "console.log(require('crypto').randomBytes(24).toString('base64').replace(/[+/=]/g,''))"  # REDIS_PASSWORD

# 3. Pull + bring up Postgres + Redis first
docker compose pull
docker compose up -d postgres redis

# 4. Initialize Chatwoot schema (one-off rails container)
docker compose run --rm rails bundle exec rails db:chatwoot_prepare

# 5. Generate VAPID keys for browser/mobile push
docker compose run --rm rails bundle exec ruby -e \
  'require "web-push"; k = WebPush.generate_key; puts "PUB=" + k.public_key; puts "PRIV=" + k.private_key'
# Paste the values into .env: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY

# 6. Bring up everything except the bot
docker compose up -d rails sidekiq

# 7. Open https://chat.example.com → register the first admin user
#    Settings → Account → DISABLE "Account signup" so randoms can't register

# 8. Profile → Profile Settings → copy Access Token (personal)
#    Or: Settings → Integrations → Agent Bots → New → "ScottEst AI",
#        outgoing URL https://chat-bot.example.com/webhook
#        — preferred: messages signed as bot, not as you
#    Paste into .env: BOT_CHATWOOT_API_TOKEN + BOT_CHATWOOT_ACCOUNT_ID
#    (the account_id is in your browser URL: /app/accounts/<N>/)

# 9. Build + start the bot
docker compose up -d chat-bot

# 10. In Chatwoot UI: Settings → Inboxes → New Inbox → Website
#     - URL, name, color, welcome message
#     - Skip agent selection at first, OR add yourself
#     - Bot configuration → assign your ScottEst AI bot
#     - SAVE → copy the Website Token from the inbox settings

# 11. Add yourself as an inbox member (critical for mobile app visibility):
#     Settings → Inboxes → your inbox → Collaborators tab → add yourself
#     (Without this, your mobile app shows an empty inbox list even though
#      conversations exist — the app filters to "your inboxes".)
```

## Embed the widget on a client site

The minimal embed is a `<script>` Chatwoot generates for each inbox. For
Next.js sites in the Veebist platform, use the
[`@veebist/chat-widget`](https://github.com/M1KK3R/veebist-platform/tree/master/packages/chat-widget)
package — lazy-loads the SDK after page hydration, no-op when env vars
are unset (so staging deploys don't accidentally enable chat).

```tsx
// site/src/app/layout.tsx
import { ChatwootWidget } from '@veebist/chat-widget'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        {children}
        <ChatwootWidget />
      </body>
    </html>
  )
}
```

Then pass NEXT_PUBLIC env vars at build time:

```
NEXT_PUBLIC_CHATWOOT_BASE_URL=https://chat.example.com
NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN=<from inbox settings>
```

Important: these vars are inlined at build time, not runtime. Re-build +
recreate the container after changing them.

## The AI bot

See `bot/README.md` for full bot internals. Quick summary:

- Receives Chatwoot webhook events at `POST /webhook` (event `message_created`)
- Filters: only incoming visitor messages, not bot/agent replies, not private notes
- Loads `knowledge/<site>.md` (5-min cache, refresh = save file)
- Fetches last 6 messages of the conversation via Chatwoot API
- Shells out: `claude -p "<system prompt + transcript + new message>" --output-format json`
- Posts the reply back to Chatwoot via outgoing-message API
- **Handoff detection**: if visitor says `inimene` / `human` / `agent` / etc., bot posts a transitioning message and toggles conversation status to `open` — moves it out of pending into the human queue
- **Per-site routing**: `detectSite()` in `bot/index.js` maps inbox name → knowledge file. Multi-tenant ready.

Edit `bot/knowledge/<site>.md` to teach the bot about your business. Cache
auto-refreshes — no restart needed.

## Push notifications

For mobile push, set `ENABLE_PUSH_RELAY_SERVER=true` in `.env`. This makes
your self-hosted instance forward push events through Chatwoot's central
relay server (free, no registration needed — works with the official iOS
+ Android Chatwoot apps).

For browser push, generate VAPID keys (see step 5 above) and set
`VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` in `.env`. After restart, agents
enable browser notifications in Profile → Notifications.

After enabling push relay, **log out and back in** of the mobile app so
it re-registers its device token with the relay.

## Realtime / WebSocket

ActionCable on `/cable` powers real-time message delivery to both the
visitor's widget and the agent's admin app. Requires WebSocket upgrade
to work through Traefik.

**Pitfall**: Chatwoot ships with `FORCE_SSL=true` in many guides. Rails's
SSL-enforce middleware 301-redirects any non-HTTPS request — and Rails
doesn't trust the proxy's `X-Forwarded-Proto` header by default, so it
sees the internal Docker-network request as plain HTTP and redirects.
On a regular GET this is invisible (Traefik already enforces TLS at the
edge, so the redirect goes to the same URL). On a **WebSocket upgrade**
the 301 aborts the handshake, leaving the widget polling-only — agent
replies don't show until the user refreshes.

**Fix**: set `FORCE_SSL=false`. Traefik already enforces HTTPS externally;
Rails doesn't need to redo it. Verified with:
```
curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x" \
  https://chat.example.com/cable
# Expect: HTTP/1.1 101 Switching Protocols
```

## Inbox membership matters (mobile app gotcha)

The Chatwoot mobile app filters the inbox list to "inboxes you're a
member of". If you're a super-admin but **not explicitly a collaborator
on the inbox**, the app shows an empty list — even though conversations
exist and you can see them in the web admin.

Add yourself: Settings → Inboxes → your inbox → Collaborators → add.

After that:
- Mobile app pull-to-refresh → inbox appears
- Auto-assignment picks you for new conversations
- You get push notifications for new messages
- The bot's handoff (status → `open`) routes to you

## Common operations

```bash
# Tail logs (rails errors, bot replies)
docker compose logs -f rails sidekiq chat-bot

# Backup the DB
docker compose exec -T postgres pg_dump -U chatwoot -Fc chatwoot \
  > chatwoot-$(date +%F).dump

# Restore
docker compose exec -T postgres pg_restore -U chatwoot -d chatwoot -c \
  < chatwoot-2026-05-24.dump

# Upgrade Chatwoot
# 1. Edit image tag in docker-compose.yml (e.g. v3.16.0 → v3.17.0)
# 2. docker compose pull
# 3. docker compose run --rm rails bundle exec rails db:chatwoot_prepare
# 4. docker compose up -d --force-recreate rails sidekiq

# Bot picked up stale Claude auth (401 errors)
# When Claude refreshes auth on the host, the bind-mounted credentials
# file may get a new inode that the container's mount can't see until
# restarted.
docker compose restart chat-bot
```

## Adding chat to a new Veebist client site

1. **DNS**: add `chat.<client-domain>` → your VPS IP (or keep all clients on a shared `chat.yourcompany.com`)
2. **Inbox**: in Chatwoot admin, Settings → Inboxes → New Website Inbox for the client. Copy the Website Token.
3. **Bot**: drop a `knowledge/<client-slug>.md` file into `bot/knowledge/` on the VPS, restart bot. Update `detectSite()` in `bot/index.js` if you want per-inbox routing (otherwise it defaults to scottest).
4. **Site**: install `@veebist/chat-widget` and mount in layout (see [Embed the widget](#embed-the-widget-on-a-client-site)).
5. **Env vars**: set `NEXT_PUBLIC_CHATWOOT_BASE_URL` + `NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN` in client's `.env.prod`. Rebuild.
6. **Inbox membership**: add the agents who'll cover this client to the inbox's Collaborators list, otherwise the mobile app won't show it.

## Source layout

```
veebist-chat/
├── README.md              this file
├── .env.example           templated env (copy to .env, fill secrets)
├── .gitignore             excludes .env + dump backups
├── docker-compose.yml     5-service stack: rails, sidekiq, postgres,
│                          redis, chat-bot
└── bot/
    ├── Dockerfile         node:20-bookworm-slim, UID 1001, mounts host
    │                       Claude CLI + auth state at runtime
    ├── index.js           ~200 lines: HTTP webhook + Chatwoot client +
    │                       Claude CLI shell-out + handoff detection
    └── knowledge/
        ├── scottest.md    example knowledge file for one tenant
        └── example.md     blank template you can copy for a new tenant
```

## Known issues / gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `bot: claude: not found` | alpine base image, glibc binary | Use `node:20-bookworm-slim` |
| `Failed to authenticate. 401 Invalid auth` from bot | Bind-mounted credentials file got a new inode after host token refresh | `docker compose restart chat-bot` |
| Agent replies don't show in widget until visitor refreshes | `FORCE_SSL=true` 301-redirects ActionCable upgrade | Set `FORCE_SSL=false` |
| Mobile app shows empty inbox list | You're not a member of the inbox | Settings → Inboxes → inbox → Collaborators → add yourself |
| Bot doesn't reply | Conversation status not `pending`, or webhook URL unreachable | Check `docker logs chat-bot`; verify https://chat-bot.veebist.cloud/health returns 200 |
| Conversation visible in web but no push notification | Push relay disabled, or you're not an inbox member, or notification toggle off in Profile → Notifications | Enable relay + member + toggles |
| `Channel email domain not present` in sidekiq logs | Chatwoot trying to send conversation-reply email but contact has no email | Cosmetic; ignore (or set up an inbox-level email channel) |

## License

Chatwoot is MIT licensed by [Chatwoot Inc.](https://www.chatwoot.com/);
this repo's bot + integration code is MIT licensed by Veebist.
