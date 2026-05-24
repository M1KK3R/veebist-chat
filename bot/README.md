# chat-bot — Chatwoot ↔ Claude CLI bridge

A ~200-line Node service that turns a Chatwoot Agent Bot webhook into AI
responses powered by the host operator's Claude Code CLI subscription.

## Why CLI, not API?

Two patterns work:

1. **Anthropic API** — Use `@anthropic-ai/sdk`, set `ANTHROPIC_API_KEY` in env.
   Pros: stateless, no auth refresh issues. Cons: per-token billing on
   top of any existing Claude subscription.
2. **Claude CLI mounted from host** — Bind-mount the host's `~/.local/bin/claude`
   binary + `~/.claude{,.json}` auth state into the container; shell out to
   `claude -p "<prompt>"`. Uses your existing Claude Pro/Max subscription.
   No per-token billing, no API key to manage. This is the
   [kusimusi pattern](https://github.com/M1KK3R/kusimusi) — works for any
   container that runs as the same UID as the host user (1001 on this VPS).

This bot uses **option 2** because Veebist already pays for Claude
subscriptions per developer, and the message volume is well under what
a single Pro plan supports.

To swap to the API instead: replace `askClaude()` in `index.js` with an
`@anthropic-ai/sdk` call. ~10 line diff.

## Architecture

```
                          Chatwoot Rails
                                │
                                │  AgentBots::WebhookJob (Sidekiq)
                                │  POST https://chat-bot.../webhook
                                │  Body: { event:'message_created', conversation, content, ... }
                                ▼
                       ┌──────────────────┐
                       │  chat-bot        │
                       │  index.js        │
                       │  (Node 20 http)  │
                       └────┬─────────────┘
                            │
                  ┌─────────┼─────────────┐
                  ▼         ▼             ▼
            handoff?    fetch         knowledge.md
            (keywords) history       (5-min cache)
                  │     (last 6)         │
                  │         │            │
                  └─────────┴────────────┘
                            │
                            ▼
                  ┌──────────────────┐
                  │  claude -p ...   │
                  │  --output-format │
                  │  json            │
                  └──────┬───────────┘
                         │  result.text
                         ▼
                  POST /api/v1/accounts/<id>/
                       conversations/<id>/messages
                  → reply appears in widget
```

## File layout

```
bot/
├── Dockerfile          node:20-bookworm-slim, app user UID 1001
├── index.js            entrypoint: HTTP server, webhook handler, Claude shell-out, Chatwoot client
└── knowledge/
    └── <site>.md       markdown FAQ + business info, loaded into the system prompt
```

## index.js — the parts that matter

```js
// 1. Webhook arrives. Filter to incoming visitor messages.
async function handleWebhook(event) {
  if (event.event !== 'message_created') return
  if (event.message_type !== 'incoming') return
  if (event.private) return
  // Skip if conversation already in human queue.
  if (event.conversation?.status === 'open') return
  ...
```

```js
// 2. Handoff detection. Visitor asks for human → bot bows out.
const HANDOFF_TRIGGERS = [
  'human', 'agent', 'real person', 'speak to someone',
  'inimene', 'inimesega', 'klienditugi', 'töötaja',
]

if (HANDOFF_TRIGGERS.some(t => content.toLowerCase().includes(t))) {
  await postMessage(conversationId, '... transitioning message ...')
  await toggleStatus(conversationId, 'open')
  return
}
```

```js
// 3. Build prompt: system + knowledge + transcript + new message.
const prompt = `${systemPrompt}

# Conversation so far
${history.map(m => `${m.role}: ${m.content}`).join('\n')}

Visitor (latest): ${content}

Your reply:`

// 4. Shell out to Claude CLI. 60-second timeout.
const reply = await askClaude(prompt)

// 5. Post back as the AgentBot user.
await postMessage(conversationId, reply)
```

## Per-site knowledge

Each website inbox gets its own knowledge file. Currently:

- `knowledge/scottest.md` — ScottEst OÜ (Scottish tartan products, Estonia)

Add a new tenant:

1. Drop `knowledge/<slug>.md` with sections like:
   - Üldine info / General info
   - Teenused / Services
   - Tarne / Shipping
   - Maksmine / Payment
   - Kinkekaardid / Gift cards
   - Tagastus ja vahetus
   - Mida ma ei tea / What I cannot answer
2. Update `detectSite()` in `index.js` to map the inbox name → slug
3. `docker compose restart chat-bot` (or wait 5 min for cache eviction)

## Why the Dockerfile uses bookworm not alpine

The Claude CLI is a 236MB ELF binary statically linked against **glibc**.
Alpine uses **musl libc**. Running the glibc binary on musl fails with a
cryptic `claude: not found` even though `which claude` finds the file.

Solution: use a glibc base. `node:20-bookworm-slim` is the smallest
practical choice — ~70MB compressed.

## Why UID 1001

The host's `~/.local/share/claude/versions/2.1.146` (the actual binary)
and `~/.claude/.credentials.json` are mode 600/700 owned by `claudeuser`
(UID 1001). For the container to read them via bind mount, the container
process must run as the same UID.

```dockerfile
RUN groupadd -g 1001 app \
    && useradd -u 1001 -g 1001 -m -s /bin/bash app
USER app
```

## Why the bot talks to Chatwoot via the public URL

Inside the Docker network the bot could reach Rails at `http://rails:3000`.
But Chatwoot ships with `FORCE_SSL=true` (which we override to `false` —
see main README), and the SSL story across Docker network + Node fetch +
Rails middleware is fragile. The bot uses the public `https://chat.veebist.cloud`
URL instead — it's a fast loopback through Traefik and cleanly TLS-terminated.

```js
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'http://rails:3000'
```

Env override in `docker-compose.yml`:
```yaml
CHATWOOT_URL: https://chat.veebist.cloud
```

## Handoff: what it does, what it doesn't

When the visitor types a handoff keyword (`human`, `inimene`, etc.), the
bot does **two** things:

1. Posts a transitioning message — bilingual ET/EN
2. Calls `POST /conversations/<id>/toggle_status` to flip from `pending` → `open`

What it doesn't do:
- **Doesn't auto-assign** to a specific agent. Chatwoot's
  auto-assignment-on-inbox config handles that.
- **Doesn't notify agents directly**. Chatwoot's notification subscriptions
  fire when conversation status changes, *if* the agent is an inbox member
  and has notifications enabled.

## Debugging

```bash
# Tail bot logs
docker logs -f chat-bot

# Tail Chatwoot's view of webhook delivery
docker logs -f chatwoot-sidekiq | grep AgentBots::WebhookJob

# Test the bot's health endpoint
curl https://chat-bot.veebist.cloud/health
# Expect: {"status":"ok","uptime":<seconds>}

# Test Claude CLI directly inside the container
docker exec chat-bot sh -c 'echo test | claude -p "Reply OK" --output-format json'
# 401? Bot needs restart so it sees the refreshed auth file.

# Bot received a webhook but didn't reply?
# Look for the conv= log line:
docker logs chat-bot | grep conv=
# Each visitor message should log:
#   [bot] conv=N site=X asking…
#   [bot] conv=N replied (Y chars)
```

## Adding API-based alternative

If you'd rather pay per token than rely on the CLI mount (e.g. for a
client that doesn't share their Claude account), edit `askClaude()`:

```js
import Anthropic from '@anthropic-ai/sdk'
const client = new Anthropic()  // uses ANTHROPIC_API_KEY env

async function askClaude(prompt) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',  // or whatever's current
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content[0].text
}
```

Then in `Dockerfile`, drop the Claude bind-mount block. Set
`ANTHROPIC_API_KEY` in `.env`.

## License

MIT.
