/**
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Lets Chatwoot's "OpenAI Integration" point at us instead of api.openai.com.
 * Translates the OpenAI Chat Completions request shape into a single prompt
 * for whichever LLM provider is healthy, then wraps the reply back in OpenAI
 * response shape.
 *
 * Auth: bearer token must match CHATWOOT_OPENAI_KEY env var.
 * Streaming: not yet — Chatwoot tolerates non-streaming responses.
 */

function flattenMessages(messages) {
  if (!Array.isArray(messages)) return ''
  const lines = []
  for (const m of messages) {
    if (!m || typeof m.content !== 'string') continue
    const role = m.role === 'system' ? 'System'
      : m.role === 'assistant' ? 'Assistant'
      : 'User'
    lines.push(`${role}: ${m.content}`)
  }
  lines.push('Assistant:')
  return lines.join('\n\n')
}

function wrapResponse({ reply, model, providerUsed }) {
  return {
    id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || providerUsed,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: reply },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    veebist_provider: providerUsed,
  }
}

function errorResponse(message, type = 'invalid_request_error', code = 400) {
  return {
    error: { message, type, code },
  }
}

export function createOpenAIShim({ provider, semaphore, expectedKey, log }) {
  return async function handle(req, res, body) {
    const auth = req.headers['authorization'] || ''
    const token = auth.replace(/^Bearer\s+/i, '').trim()
    if (!expectedKey || token !== expectedKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(errorResponse('invalid api key', 'invalid_api_key', 401)))
      return
    }

    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(errorResponse('invalid json body')))
      return
    }

    if (payload.stream) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(errorResponse('streaming not supported yet')))
      return
    }

    const prompt = flattenMessages(payload.messages)
    if (!prompt.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(errorResponse('messages required')))
      return
    }

    try {
      const { reply, providerUsed } = await semaphore.run(() => provider.ask(prompt))
      const out = wrapResponse({ reply, model: payload.model, providerUsed })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
      log?.(`[openai-shim] model=${payload.model || '-'} provider=${providerUsed} reply=${reply.length}c`)
    } catch (err) {
      log?.('[openai-shim] all providers failed:', err.message)
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(errorResponse(err.message, 'service_unavailable', 503)))
    }
  }
}
