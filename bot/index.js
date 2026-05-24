/**
 * Veebist chat-bot — bridges Chatwoot website inbox to Claude CLI.
 *
 * Flow per message:
 *   1. Chatwoot fires webhook on `message_created`
 *   2. We filter to incoming visitor messages (skip bot/agent replies + private notes)
 *   3. Load per-site knowledge from /app/knowledge/<site>.md
 *   4. Build conversation transcript from Chatwoot's last messages
 *   5. Shell out to `claude -p` with the prompt
 *   6. POST reply back via Chatwoot's outgoing-message API
 *   7. If Claude says it doesn't know / visitor asks for human → flag for handoff
 *
 * The Claude CLI binary + auth state are mounted from the host (kusimusi
 * pattern) so we use the operator's Claude subscription, not the per-token API.
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'

const CHATWOOT_URL = process.env.CHATWOOT_URL || 'http://rails:3000'
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || ''
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1'
const KNOWLEDGE_PATH = process.env.KNOWLEDGE_PATH || '/app/knowledge'
const PORT = Number(process.env.PORT || 3500)
const CLAUDE_TIMEOUT_MS = 60_000

/** Phrases that flip the conversation to the human queue (case-insensitive). */
const HANDOFF_TRIGGERS = [
  'human', 'agent', 'real person', 'speak to someone',
  'inimene', 'inimesega', 'klienditugi', 'töötaja',
]

const log = (...a) => console.log(new Date().toISOString(), '[bot]', ...a)

// ============================================================
// Claude CLI wrapper
// ============================================================

function askClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--output-format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('claude CLI timeout'))
    }, CLAUDE_TIMEOUT_MS)

    proc.stdout.on('data', d => (stdout += d))
    proc.stderr.on('data', d => (stderr += d))
    proc.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${stderr.slice(0, 500)}`))
      try {
        const result = JSON.parse(stdout)
        resolve(String(result.result || result.text || stdout).trim())
      } catch {
        resolve(stdout.trim())
      }
    })
    proc.on('error', err => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

// ============================================================
// Chatwoot API
// ============================================================

async function postMessage(conversationId, content, opts = {}) {
  const url = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_access_token: CHATWOOT_API_TOKEN },
    body: JSON.stringify({ content, message_type: 'outgoing', private: !!opts.private }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`postMessage failed: ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json()
}

async function fetchHistory(conversationId, limit = 10) {
  const url = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`
  const res = await fetch(url, {
    headers: { api_access_token: CHATWOOT_API_TOKEN },
  })
  if (!res.ok) return []
  const data = await res.json().catch(() => ({}))
  // Chatwoot returns { payload: [...], meta: {...} } ordered oldest→newest
  return (data.payload || []).slice(-limit)
}

async function toggleStatus(conversationId, status) {
  const url = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_access_token: CHATWOOT_API_TOKEN },
    body: JSON.stringify({ status }),
  }).catch(err => log('toggleStatus failed', err.message))
}

// ============================================================
// Knowledge loading
// ============================================================

const knowledgeCache = new Map()
const KNOWLEDGE_TTL_MS = 5 * 60_000

async function loadKnowledge(site) {
  const cached = knowledgeCache.get(site)
  if (cached && Date.now() - cached.ts < KNOWLEDGE_TTL_MS) return cached.data
  try {
    const data = await fs.readFile(`${KNOWLEDGE_PATH}/${site}.md`, 'utf8')
    knowledgeCache.set(site, { ts: Date.now(), data })
    return data
  } catch {
    return ''
  }
}

/**
 * Map an inbox to a "site" knowledge file. For now everything routes
 * to scottest. Add lookup by inbox.id or website token when there's
 * more than one site sharing the same Chatwoot install.
 */
function detectSite(event) {
  const websiteName = event?.conversation?.meta?.inbox?.name?.toLowerCase() || ''
  if (websiteName.includes('scottest')) return 'scottest'
  return 'scottest'
}

// ============================================================
// Webhook handler
// ============================================================

function buildSystemPrompt(site, knowledge) {
  return [
    `You are the website assistant for ${site}. Reply in the visitor's language (Estonian or English, auto-detected from their message).`,
    `Be concise — 1-3 sentences. Be friendly and helpful.`,
    `If the visitor asks something you cannot answer from the knowledge below, say "Edastan küsimuse meie meeskonnale" (ET) or "I'll pass this to our team" (EN), and DO NOT make up an answer.`,
    ``,
    `# Knowledge base`,
    knowledge || '(no knowledge loaded)',
  ].join('\n')
}

function buildTranscriptPrompt(systemPrompt, history, latestMessage) {
  const lines = [systemPrompt, '', '# Conversation so far']
  for (const m of history) {
    if (!m.content) continue
    const role = m.message_type === 'incoming' ? 'Visitor' : 'You'
    lines.push(`${role}: ${m.content}`)
  }
  lines.push('', `Visitor (latest): ${latestMessage}`, '', 'Your reply:')
  return lines.join('\n')
}

async function handleWebhook(event) {
  if (event.event !== 'message_created') return
  if (event.message_type !== 'incoming') return
  if (event.private) return

  const conversationId = event.conversation?.id
  const content = (event.content || '').trim()
  if (!conversationId || !content) return

  // Already-handed-off conversation? Don't second-guess the human.
  const status = event.conversation?.status
  if (status === 'pending' || status === 'open') {
    // open=human is engaged; only respond if conversation has bot owner
    // (Chatwoot creates new conversations as 'pending' for bot-assigned inboxes)
    if (status === 'open') return
  }

  // Hand-off detection
  if (HANDOFF_TRIGGERS.some(t => content.toLowerCase().includes(t))) {
    log(`conv=${conversationId} handoff requested`)
    await postMessage(conversationId, 'Hetkel ühendan teid meeskonnaga — palun oodake hetk.\n\nConnecting you with a human agent — please wait.')
    await toggleStatus(conversationId, 'open')
    return
  }

  const site = detectSite(event)
  const [knowledge, history] = await Promise.all([
    loadKnowledge(site),
    fetchHistory(conversationId, 6),
  ])
  const systemPrompt = buildSystemPrompt(site, knowledge)
  const prompt = buildTranscriptPrompt(systemPrompt, history, content)

  log(`conv=${conversationId} site=${site} asking…`)
  try {
    const reply = await askClaude(prompt)
    await postMessage(conversationId, reply || '...')
    log(`conv=${conversationId} replied (${reply.length} chars)`)
  } catch (err) {
    log(`conv=${conversationId} error`, err.message)
    await postMessage(conversationId, 'Vabandust, väike tehniline tõrge. Edastan küsimuse meie meeskonnale.\n\nApologies, technical issue. I will pass this to our team.')
    await toggleStatus(conversationId, 'open')
  }
}

// ============================================================
// HTTP server
// ============================================================

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
    return
  }

  if (req.method === 'POST' && (req.url === '/webhook' || req.url?.startsWith('/webhook'))) {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', async () => {
      try {
        const event = JSON.parse(body)
        // Respond to Chatwoot immediately so it doesn't time out;
        // process in the background.
        res.writeHead(200).end('ok')
        handleWebhook(event).catch(err => log('handleWebhook crash', err))
      } catch (err) {
        log('parse error', err.message)
        res.writeHead(400).end('bad json')
      }
    })
    return
  }

  res.writeHead(404).end()
})

server.listen(PORT, () => log(`listening on :${PORT}`))
