/**
 * Per-site live snapshot — combines Medusa + Payload, cached with
 * stale-while-revalidate: serve old data immediately on cache miss,
 * fetch fresh in the background.
 */

import { fetchRegions, fetchProducts } from './medusa.js'
import { fetchArticles, fetchPages } from './payload.js'

// Live shipping options are intentionally NOT fetched: Medusa v2's
// /store/shipping-options endpoint requires a cart_id, which we don't have
// at the bot level. Put shipping info in the per-site knowledge.md instead.

const TTL_MS = 10 * 60_000  // 10 min
const STALE_MS = 60 * 60_000  // serve stale up to 1h if refetch fails

// Map<siteKey, { snapshot, builtAt, refreshing }>
const cache = new Map()

async function build(siteConfig) {
  const log = (...a) => console.log(new Date().toISOString(), '[snapshot]', siteConfig.displayName, ...a)

  const hasMedusa = !!siteConfig.medusa.url
  const hasPayload = !!siteConfig.payload.url

  let regionId = siteConfig.medusa.regionId
  if (hasMedusa && !regionId) {
    try {
      const regions = await fetchRegions(siteConfig)
      regionId = regions[0]?.id
      if (regionId) log(`auto-detected regionId=${regionId}`)
    } catch (err) {
      log('region detect failed:', err.message)
    }
  }

  const [products, articles, pages] = await Promise.all([
    hasMedusa
      ? fetchProducts(siteConfig, regionId).catch(err => { log('products fetch failed:', err.message); return [] })
      : Promise.resolve([]),
    hasPayload
      ? fetchArticles(siteConfig).catch(err => { log('articles fetch failed:', err.message); return [] })
      : Promise.resolve([]),
    hasPayload
      ? fetchPages(siteConfig).catch(err => { log('pages fetch failed:', err.message); return [] })
      : Promise.resolve([]),
  ])

  log(`built: ${products.length} products, ${articles.length} articles, ${pages.length} pages`)

  return {
    builtAt: Date.now(),
    products,
    shippingOptions: [],  // not live; see knowledge file
    articles,
    pages,
    contactInfo: siteConfig.contactInfo,
  }
}

export async function getSnapshot(siteKey, siteConfig) {
  const entry = cache.get(siteKey)
  const now = Date.now()

  // Fresh enough — return as-is
  if (entry && now - entry.builtAt < TTL_MS) return entry.snapshot

  // Stale-but-tolerable — return stale + refresh in background
  if (entry && now - entry.builtAt < STALE_MS) {
    if (!entry.refreshing) {
      entry.refreshing = build(siteConfig)
        .then(snap => { cache.set(siteKey, { snapshot: snap, builtAt: snap.builtAt, refreshing: null }) })
        .catch(() => { entry.refreshing = null })
    }
    return entry.snapshot
  }

  // Cold or way-stale — must build now
  const snapshot = await build(siteConfig)
  cache.set(siteKey, { snapshot, builtAt: snapshot.builtAt, refreshing: null })
  return snapshot
}

export function snapshotStats() {
  const stats = {}
  for (const [key, { builtAt }] of cache.entries()) {
    stats[key] = {
      builtAt,
      ageSec: Math.round((Date.now() - builtAt) / 1000),
    }
  }
  return stats
}
