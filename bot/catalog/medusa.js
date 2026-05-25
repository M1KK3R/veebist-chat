/**
 * Medusa v2 storefront API client — read-only catalog data for the bot prompt.
 *
 * All money values are decimals (Medusa v2 convention: 25 = €25).
 */

const FETCH_TIMEOUT_MS = 10_000

async function fetchJson(url, { publishableKey, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: publishableKey ? { 'x-publishable-api-key': publishableKey } : {},
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

export async function fetchRegions(siteConfig) {
  const url = `${siteConfig.medusa.url}/store/regions`
  const data = await fetchJson(url, { publishableKey: siteConfig.medusa.publishableKey })
  return data.regions || []
}

export async function fetchProducts(siteConfig, regionId) {
  const limit = siteConfig.medusa.productLimit
  const effectiveRegion = regionId || siteConfig.medusa.regionId
  const params = new URLSearchParams({ limit: String(limit) })
  // region_id is REQUIRED to get calculated_price populated on variants.
  if (effectiveRegion) params.set('region_id', effectiveRegion)
  // Medusa v2 rejects most field-subset queries; just fetch full objects.
  const url = `${siteConfig.medusa.url}/store/products?${params}`
  const data = await fetchJson(url, { publishableKey: siteConfig.medusa.publishableKey })
  return (data.products || []).map(normalizeProduct).filter(Boolean)
}

function normalizeProduct(p) {
  const variants = (p.variants || []).map(v => {
    const cp = v.calculated_price
    return {
      title: v.title,
      // manage_inventory=false in Medusa means "always in stock"; treat as in-stock
      inStock: v.manage_inventory === false
        ? true
        : (typeof v.inventory_quantity === 'number' ? v.inventory_quantity > 0 : null),
      price: typeof cp?.calculated_amount === 'number' ? cp.calculated_amount : null,
      currency: cp?.currency_code || 'eur',
    }
  })
  const prices = variants.map(v => v.price).filter(p => typeof p === 'number')
  const anyInStock = variants.some(v => v.inStock === true)
  // Per-site convention (see scottest-site/site/src/lib/i18n-product.ts):
  // Medusa stores one canonical product, EN translations live in
  // metadata.title_en / metadata.description_en. Passing the EN fields
  // through lets the formatter present both languages to the LLM so the
  // bot can answer correctly regardless of the visitor's language.
  const md = p.metadata || {}
  const titleEn = typeof md.title_en === 'string' ? md.title_en.trim() : ''
  const descriptionEn = typeof md.description_en === 'string' ? md.description_en.trim() : ''
  return {
    title: p.title,
    titleEn: titleEn || null,
    handle: p.handle,
    description: (p.description || '').slice(0, 240),
    descriptionEn: descriptionEn ? descriptionEn.slice(0, 240) : null,
    categories: (p.categories || []).map(c => c.name),
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
    currency: variants[0]?.currency || 'eur',
    inStock: anyInStock,
    variantCount: variants.length,
  }
}

export async function fetchShippingOptions(siteConfig, regionId) {
  if (!regionId) return []
  const url = `${siteConfig.medusa.url}/store/shipping-options?region_id=${regionId}`
  const data = await fetchJson(url, { publishableKey: siteConfig.medusa.publishableKey })
  return (data.shipping_options || []).map(o => ({
    name: o.name,
    price: o.amount ?? o.calculated_price?.calculated_amount ?? null,
    currency: o.currency_code || o.calculated_price?.currency_code || 'eur',
    type: o.type?.code,
  }))
}
