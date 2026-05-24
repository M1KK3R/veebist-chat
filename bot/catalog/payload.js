/**
 * Payload CMS v3 read-only client — articles + pages for the bot prompt.
 *
 * Only published content is fetched. Token is optional for sites whose
 * collections are publicly readable.
 */

const FETCH_TIMEOUT_MS = 10_000

async function fetchJson(url, { token, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

export async function fetchArticles(siteConfig) {
  const limit = siteConfig.payload.articleLimit
  // Many Payload configs don't expose `_status` for public queries — Payload
  // already excludes unpublished items from the unauthenticated API surface,
  // so we just omit the filter and let depth=0 keep payloads small.
  const params = new URLSearchParams({
    limit: String(limit),
    depth: '0',
    sort: '-publishedAt',
  })
  const url = `${siteConfig.payload.url}/articles?${params}`
  try {
    const data = await fetchJson(url, { token: siteConfig.payload.token })
    return (data.docs || []).map(a => ({
      title: a.title || a.titleEt || a.titleEn,
      slug: a.slug,
      excerpt: (a.excerpt || a.summary || '').toString().slice(0, 200),
      publishedAt: a.publishedAt,
    }))
  } catch (err) {
    // Payload may not be set up on every site; treat as empty
    return []
  }
}

export async function fetchPages(siteConfig) {
  const params = new URLSearchParams({ limit: '50', depth: '0' })
  const url = `${siteConfig.payload.url}/pages?${params}`
  try {
    const data = await fetchJson(url, { token: siteConfig.payload.token })
    return (data.docs || []).map(p => ({
      title: p.title || p.titleEt || p.titleEn,
      slug: p.slug,
    }))
  } catch {
    return []
  }
}

/**
 * Fetch the per-site curated knowledge base from the @veebist/chat-knowledge
 * route handler. The Payload API base URL is /api — we strip that to derive
 * the parent origin where the chat route lives.
 *
 * Returns markdown (already aggregated server-side) or empty string on failure.
 * Empty string signals the caller to use the local knowledge/<site>.md fallback.
 */
export async function fetchCmsKnowledge(siteConfig) {
  if (!siteConfig?.payload?.url) return ''
  // Payload URLs are typically `https://site/api`. Knowledge lives at
  // `https://site/api/chat/knowledge`. Strip nothing — Payload's own custom
  // routes are siblings of its collection routes (Next route handlers).
  const base = siteConfig.payload.url.replace(/\/$/, '')
  const url = `${base}/chat/knowledge?lang=${encodeURIComponent(siteConfig.locale || 'et')}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return ''
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('text/markdown') && !ct.includes('text/plain')) return ''
    const body = await res.text()
    return body.trim()
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}
