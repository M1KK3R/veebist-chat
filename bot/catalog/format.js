/**
 * Render a snapshot as compact markdown for inclusion in the bot's system prompt.
 *
 * Goals:
 *   - Keep token count low (≤ 5K tokens for ~100 products)
 *   - Make every line scannable by the LLM
 *   - Include the site URL on each product/article so the bot can link visitors directly
 */

function fmtPrice(amount, currency = 'eur') {
  if (typeof amount !== 'number') return ''
  const symbol = currency === 'eur' ? '€' : currency.toUpperCase() + ' '
  return `${symbol}${amount.toFixed(2)}`
}

function productLine(p, baseUrl) {
  const price = p.minPrice === p.maxPrice
    ? fmtPrice(p.minPrice, p.currency)
    : `${fmtPrice(p.minPrice, p.currency)}–${fmtPrice(p.maxPrice, p.currency)}`
  const cats = p.categories.length ? ` [${p.categories.join(', ')}]` : ''
  const stock = p.inStock ? '' : ' (otsas)'
  const url = baseUrl ? ` — ${baseUrl}/pood/${p.handle}` : ''
  return `- ${p.title} ${price}${cats}${stock}${url}`
}

function articleLine(a, baseUrl) {
  const date = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : ''
  const url = baseUrl ? ` — ${baseUrl}/blogi/${a.slug}` : ''
  const excerpt = a.excerpt ? `  ${a.excerpt}` : ''
  return `- ${a.title}${date ? ` (${date})` : ''}${url}${excerpt ? '\n  ' + excerpt : ''}`
}

function shippingLine(s) {
  const price = typeof s.price === 'number' ? fmtPrice(s.price, s.currency) : 'küsi'
  return `- ${s.name}: ${price}`
}

export function formatSnapshotForPrompt(snapshot, { siteUrl = '' } = {}) {
  if (!snapshot) return '(no live catalog snapshot)'

  const age = Math.round((Date.now() - snapshot.builtAt) / 60_000)
  const lines = [`# Live catalog (refreshed ~${age} min ago)`, '']

  if (snapshot.products?.length) {
    lines.push('## Tooted (products)')
    for (const p of snapshot.products) lines.push(productLine(p, siteUrl))
    lines.push('')
  }

  if (snapshot.shippingOptions?.length) {
    lines.push('## Tarne (shipping)')
    for (const s of snapshot.shippingOptions) lines.push(shippingLine(s))
    lines.push('')
  }

  if (snapshot.articles?.length) {
    lines.push('## Hiljutised artiklid (recent articles)')
    for (const a of snapshot.articles) lines.push(articleLine(a, siteUrl))
    lines.push('')
  }

  if (snapshot.pages?.length) {
    lines.push('## Lehed (pages)')
    for (const p of snapshot.pages) {
      const url = siteUrl ? ` — ${siteUrl}/lehed/${p.slug}` : ''
      lines.push(`- ${p.title}${url}`)
    }
    lines.push('')
  }

  if (snapshot.contactInfo) {
    lines.push('## Kontakt')
    if (snapshot.contactInfo.email) lines.push(`- Email: ${snapshot.contactInfo.email}`)
    if (snapshot.contactInfo.phone) lines.push(`- Tel: ${snapshot.contactInfo.phone}`)
  }

  return lines.join('\n')
}
