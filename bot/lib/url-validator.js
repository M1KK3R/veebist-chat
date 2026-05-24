/**
 * Post-processor that validates URLs in the bot's reply against the snapshot.
 *
 * Catches Claude's tendency to:
 *   - "Auto-correct" slugs (underscores → hyphens or vice versa)
 *   - Translate slugs from Estonian to English (or back)
 *   - Invent plausible URLs for content that doesn't exist
 *
 * Strategy:
 *   1. Build a set of all valid URLs from the snapshot (using the site's URL patterns)
 *   2. Find every URL in the reply that points at our site
 *   3. If it's an exact match → leave alone
 *   4. If a fuzzy match exists (underscores↔hyphens swap, case-insensitive) → rewrite to the canonical URL
 *   5. If no match → strip the URL entirely (markdown link text stays, just the URL is removed)
 */

function applyPattern(pattern, slug) {
  return pattern.replace('{handle}', slug).replace('{slug}', slug)
}

function normalizeSlug(s) {
  return s.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '')
}

function buildValidUrls(snapshot, siteUrl, urlPatterns) {
  const valid = new Map()  // normalized URL → canonical URL
  const add = (canon) => {
    if (canon) valid.set(normalizeSlug(canon), canon)
  }
  if (urlPatterns?.product) {
    for (const p of snapshot.products || []) {
      add(`${siteUrl}${applyPattern(urlPatterns.product, p.handle)}`)
    }
  }
  if (urlPatterns?.article) {
    for (const a of snapshot.articles || []) {
      add(`${siteUrl}${applyPattern(urlPatterns.article, a.slug)}`)
    }
  }
  if (urlPatterns?.page) {
    for (const p of snapshot.pages || []) {
      add(`${siteUrl}${applyPattern(urlPatterns.page, p.slug)}`)
    }
  }
  // The site root itself is always valid (bot may legitimately point at the home page)
  add(siteUrl)
  add(`${siteUrl}/`)
  return valid
}

const URL_RE = /https?:\/\/[^\s)\]]+/g
const TRAILING_PUNCT = /[.,;:!?)]+$/

/**
 * Validate URLs in `reply` against the snapshot's catalog.
 * Returns { reply: cleanedReply, fixes: { ok, corrected, removed } } for logging.
 */
export function validateUrls(reply, snapshot, { siteUrl, urlPatterns }) {
  if (!reply || !siteUrl || !snapshot) return { reply, fixes: { ok: 0, corrected: 0, removed: 0 } }
  const valid = buildValidUrls(snapshot, siteUrl, urlPatterns)
  const fixes = { ok: 0, corrected: 0, removed: 0 }

  const cleaned = reply.replace(URL_RE, (match) => {
    const trailing = match.match(TRAILING_PUNCT)?.[0] || ''
    const url = trailing ? match.slice(0, -trailing.length) : match
    // External URLs (not our site) pass through unchanged
    if (!url.startsWith(siteUrl)) {
      fixes.ok++
      return match
    }
    // Exact match in catalog
    if ([...valid.values()].includes(url)) {
      fixes.ok++
      return match
    }
    // Fuzzy match — underscores↔hyphens, case, etc.
    const norm = normalizeSlug(url)
    const canonical = valid.get(norm)
    if (canonical) {
      fixes.corrected++
      return canonical + trailing
    }
    // No match — strip the URL. Leaves the link text if it was markdown,
    // since this regex only matches the URL part, not the brackets.
    fixes.removed++
    return ''
  })

  // Clean up empty markdown link brackets left behind: "[text]()"
  const tidy = cleaned.replace(/\[([^\]]+)\]\(\s*\)/g, '$1')

  return { reply: tidy, fixes }
}
