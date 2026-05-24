/**
 * Generic /api/chat endpoint — for external Veebist tools / internal services
 * that want to ask the bot a question without going through Chatwoot.
 *
 * Auth: bearer token must match CHAT_BOT_API_TOKEN env var.
 *
 * Request:  { site?: "scottest", messages: [{role, content}, ...] }
 * Response: { reply: "...", provider: "claude" }
 */

import fs from 'node:fs/promises'

const knowledgeCache = new Map()
const KNOWLEDGE_TTL_MS = 5 * 60_000

async function loadKnowledge(knowledgePath, site) {
  if (!site) return ''
  const cached = knowledgeCache.get(site)
  if (cached && Date.now() - cached.ts < KNOWLEDGE_TTL_MS) return cached.data
  try {
    const data = await fs.readFile(`${knowledgePath}/${site}.md`, 'utf8')
    knowledgeCache.set(site, { ts: Date.now(), data })
    return data
  } catch {
    return ''
  }
}

function buildPrompt(messages, knowledge) {
  const lines = []
  if (knowledge) {
    lines.push('# Knowledge base', knowledge, '')
  }
  for (const m of messages) {
    if (!m || typeof m.content !== 'string') continue
    const role = m.role === 'system' ? 'System'
      : m.role === 'assistant' ? 'Assistant'
      : 'User'
    lines.push(`${role}: ${m.content}`)
  }
  lines.push('Assistant:')
  return lines.join('\n')
}

export function createApiChat({ provider, semaphore, expectedToken, knowledgePath, log }) {
  return async function handle(req, res, body) {
    const auth = req.headers['authorization'] || ''
    const token = auth.replace(/^Bearer\s+/i, '').trim()
    if (!expectedToken || token !== expectedToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid json' }))
      return
    }

    const { site, messages } = payload
    if (!Array.isArray(messages) || messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'messages required' }))
      return
    }

    const knowledge = await loadKnowledge(knowledgePath, site)
    const prompt = buildPrompt(messages, knowledge)

    try {
      const { reply, providerUsed } = await semaphore.run(() => provider.ask(prompt))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ reply, provider: providerUsed }))
      log?.(`[api-chat] site=${site || '-'} provider=${providerUsed} reply=${reply.length}c`)
    } catch (err) {
      log?.('[api-chat] all providers failed:', err.message)
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}
