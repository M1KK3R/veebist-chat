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
