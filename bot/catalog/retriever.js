/**
 * LLM-as-retriever — Phase 2 catalog strategy.
 *
 * Why this exists: for sites with > a few hundred products, stuffing the
 * whole catalog into every prompt blows the token budget. Real RAG would
 * use embeddings; we instead use a two-pass LLM call with the existing
 * Claude/Codex CLI providers, so no new keys or services are needed.
 *
 * Pass 1 (router): we send a *compact* catalog (id + title + 1-line desc)
 * and the visitor's question, and ask the LLM to pick the relevant IDs.
 * Pass 2 (answerer): we hydrate full details for the picked IDs and run a
 * normal prompt against those.
 *
 * Strategy selector — by product count:
 *   ≤ 200 → 'snapshot' (the Phase 1 behaviour: full catalog inline)
 *   201-5000 → 'retriever'
 *   > 5000 → 'overflow' (caller falls back to snapshot but logs a warning;
 *            the router prompt would itself be too big)
 *
 * Per-site env override: <SITE>_KNOWLEDGE_STRATEGY=snapshot|retriever|auto
 */

const ROUTER_BUDGET = 200  // items we ask router to pick from
const ROUTER_PICKS = 10    // top-N IDs router should return

export function selectStrategy(siteConfig, snapshot) {
  const explicit = siteConfig?.knowledgeStrategy
  if (explicit === 'snapshot' || explicit === 'retriever') return explicit
  const n = snapshot?.products?.length || 0
  if (n <= 200) return 'snapshot'
  if (n <= 5000) return 'retriever'
  return 'overflow'
}

/**
 * Compact one-line catalog item for the router prompt.
 * id is the handle so the answerer can re-hydrate.
 */
function compactProduct(p) {
  const desc = (p.description || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const cats = (p.categories || []).slice(0, 3).join(', ')
  return `${p.handle} | ${p.title} | ${cats}${desc ? ' | ' + desc : ''}`
}

export function buildRouterPrompt(snapshot, question, picks = ROUTER_PICKS) {
  const lines = [
    'You are a product-catalog router. From the catalog below, choose the items most likely relevant to the visitor question.',
    `Reply with ONLY a JSON array of up to ${picks} product handles, in priority order. No prose, no explanation, no code fences.`,
    'Example: ["handle-a","handle-b","handle-c"]',
    '',
    '## Catalog (handle | title | categories | short desc)',
  ]
  for (const p of (snapshot.products || []).slice(0, ROUTER_BUDGET)) {
    lines.push(compactProduct(p))
  }
  lines.push('', `## Visitor question`, question, '', 'JSON array:')
  return lines.join('\n')
}

/**
 * Parse the router output — we accept either a bare JSON array, a JSON
 * array wrapped in code fences, or a fallback comma-list scan.
 */
export function parseRouterPicks(text) {
  if (!text) return []
  // 1. Strip code fences if present
  const stripped = text.replace(/```(?:json)?/gi, '').trim()
  // 2. Try direct JSON parse on the first [...] block
  const arrMatch = stripped.match(/\[[\s\S]*?\]/)
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0])
      if (Array.isArray(arr)) return arr.map((s) => String(s).trim()).filter(Boolean)
    } catch { /* fall through */ }
  }
  // 3. Last-ditch: comma split on the first line
  const first = stripped.split('\n')[0]
  return first.split(/[,\n]/).map((s) => s.replace(/[^a-zA-Z0-9_-]/g, '').trim()).filter(Boolean)
}

export function hydrateProducts(snapshot, handles) {
  const byHandle = new Map((snapshot.products || []).map((p) => [p.handle, p]))
  const out = []
  for (const h of handles) {
    const hit = byHandle.get(h)
    if (hit) out.push(hit)
  }
  return out
}

/**
 * Build the answerer's catalog markdown — only the picks, formatted the
 * same way as the Phase 1 snapshot so the answerer reads it identically.
 */
export function buildAnswererSnapshot(snapshot, picks) {
  return {
    ...snapshot,
    products: picks,
  }
}

/**
 * High-level orchestration. Returns the answerer-ready snapshot subset OR
 * null when the strategy says we should fall back to the regular snapshot.
 *
 * The actual answerer call still happens in index.js — it's the same
 * provider.ask() path; we just feed it a smaller `formatSnapshotForPrompt`
 * input.
 */
export async function runRouter({ provider, semaphore, snapshot, question, log }) {
  const prompt = buildRouterPrompt(snapshot, question)
  let reply = ''
  try {
    const r = await semaphore.run(() => provider.ask(prompt))
    reply = r.reply || ''
  } catch (err) {
    log?.('[retriever] router call failed:', err.message)
    return null
  }
  const picks = parseRouterPicks(reply)
  log?.(`[retriever] router picked ${picks.length} handle(s):`, picks.slice(0, 5).join(','))
  if (!picks.length) return null
  return hydrateProducts(snapshot, picks)
}
