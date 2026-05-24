/**
 * Verified-lookup tool processor.
 *
 * The system prompt teaches the LLM to emit a self-contained marker
 * whenever the visitor wants to look up sensitive data:
 *
 *   [[LOOKUP_ORDER email=info@scottest.ee display_id=1234]]
 *   [[LOOKUP_REFUND email=info@scottest.ee display_id=1234]]
 *   [[VALIDATE_GIFTCARD code=ABCD-1234]]
 *
 * We parse those out of the LLM reply, call the per-site Next.js route
 * with a shared bearer (CHAT_API_TOKEN), and replace the marker with
 * a sanitized result in the visitor's language. Markers in the original
 * reply are stripped — visitors never see the marker syntax.
 *
 * The actual second pass through Claude (to produce a natural-language
 * answer) is intentionally optional: a deterministic template is faster
 * and still safe, because the data comes from a verified server-side
 * lookup, not the LLM's imagination.
 */

const MARKER_RE = /\[\[(LOOKUP_ORDER|LOOKUP_REFUND|VALIDATE_GIFTCARD)\s+([^\]]+)\]\]/g
const FETCH_TIMEOUT_MS = 10_000

function parseAttrs(blob) {
  const out = {}
  for (const m of blob.matchAll(/(\w+)\s*=\s*("[^"]*"|\S+)/g)) {
    const v = m[2].replace(/^"|"$/g, '')
    out[m[1]] = v
  }
  return out
}

async function callRoute(url, token, body, log) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data = {}
    try { data = JSON.parse(text) } catch { data = { _raw: text } }
    return { status: res.status, data }
  } catch (err) {
    log?.('[tools] route call failed:', url, err.message)
    return { status: 0, data: { error: err.message } }
  } finally {
    clearTimeout(t)
  }
}

function renderOrderResult(locale, status, data) {
  if (status === 404) {
    return locale === 'en'
      ? 'No order matched that email + order number. Please double-check both.'
      : 'Selle e-postiga ja tellimuse numbriga tellimust ei leidnud. Palun kontrolli mõlemat.'
  }
  if (status !== 200 || !data?.order) {
    return locale === 'en'
      ? 'Sorry, I could not check the order status right now — please try again in a moment.'
      : 'Vabandust, tellimuse staatust ei õnnestunud praegu kontrollida — proovi hetke pärast uuesti.'
  }
  const o = data.order
  const labels = locale === 'en'
    ? { pending: 'pending', confirmed: 'confirmed', shipped: 'shipped', partially_shipped: 'partially shipped', delivered: 'delivered', cancelled: 'cancelled', returned: 'returned' }
    : { pending: 'ootel', confirmed: 'kinnitatud', shipped: 'saadetud', partially_shipped: 'osaliselt saadetud', delivered: 'kohale toimetatud', cancelled: 'tühistatud', returned: 'tagastatud' }
  const label = labels[o.status] || o.status
  const itemSummary = (o.items || [])
    .slice(0, 4)
    .map(it => `${it.title}${it.quantity > 1 ? ` x${it.quantity}` : ''}`)
    .join(', ')
  return locale === 'en'
    ? `Order #${o.displayId} is ${label}. Items: ${itemSummary || '—'}.`
    : `Tellimus #${o.displayId} on ${label}. Sisu: ${itemSummary || '—'}.`
}

function renderRefundResult(locale, status, data) {
  if (status === 404) {
    return locale === 'en'
      ? 'No order matched that email + order number, so I cannot check the refund.'
      : 'Selle e-postiga ja tellimuse numbriga tellimust ei leidnud — tagastust ei saa kontrollida.'
  }
  if (status !== 200) {
    return locale === 'en'
      ? 'Sorry, the refund status could not be checked right now.'
      : 'Vabandust, tagastuse staatust ei õnnestunud praegu kontrollida.'
  }
  if (!data.refund) {
    return locale === 'en'
      ? `No return has been registered yet for order #${data?.order?.displayId || '—'}.`
      : `Tellimuse #${data?.order?.displayId || '—'} kohta pole tagastust veel registreeritud.`
  }
  const r = data.refund
  return locale === 'en'
    ? `Refund for #${r.displayId}: status "${r.status}" (last update ${r.updatedAt}).`
    : `Tagastus tellimuse #${r.displayId} kohta: staatus "${r.status}" (viimane uuendus ${r.updatedAt}).`
}

function renderGiftCardResult(locale, status, data) {
  if (status === 503) {
    return locale === 'en'
      ? 'Gift-card validation is not enabled on this site — please paste the code at checkout and the system will tell you if it works.'
      : 'Kingituskaardi kontroll pole sellel veebilehel sisse lülitatud — sisesta kood ostukorvis, süsteem näitab kas see töötab.'
  }
  if (status === 429) {
    return locale === 'en'
      ? 'Too many gift-card checks from this location — please wait a minute and try again.'
      : 'Liiga palju kingituskaardi kontrolle — palun oota natuke ja proovi uuesti.'
  }
  if (status !== 200) {
    return locale === 'en'
      ? 'Sorry, the gift-card code could not be validated right now.'
      : 'Vabandust, kingituskaardi koodi ei õnnestunud praegu kontrollida.'
  }
  return data?.valid
    ? (locale === 'en' ? 'That gift-card code looks valid.' : 'Kingituskaardi kood on kehtiv.')
    : (locale === 'en' ? 'That gift-card code does not look valid.' : 'Kingituskaardi kood pole kehtiv.')
}

/**
 * Walk every marker in `reply`, dispatch to the matching site route, and
 * splice the rendered result in place of each marker. Markers that fail
 * (network error, unknown kind, feature disabled) are replaced with the
 * generic apologetic strings above — never left raw.
 *
 * @param {string} reply              raw LLM reply
 * @param {object} opts
 * @param {object} opts.siteConfig    from getSiteConfig()
 * @param {string} opts.token         CHAT_API_TOKEN (shared with the site routes)
 * @param {string} opts.locale        'et' | 'en' (for response wording)
 * @param {(...a:any[])=>void} [opts.log]
 * @returns {Promise<{reply:string, calls:Array<{kind:string,status:number}>}>}
 */
export async function processLookups(reply, opts) {
  if (!reply || !opts?.siteConfig?.siteUrl) return { reply, calls: [] }
  if (!MARKER_RE.test(reply)) {
    MARKER_RE.lastIndex = 0
    return { reply, calls: [] }
  }
  MARKER_RE.lastIndex = 0
  const base = String(opts.siteConfig.siteUrl).replace(/\/$/, '')
  const token = opts.token
  const locale = opts.locale || 'et'
  const calls = []
  const matches = [...reply.matchAll(MARKER_RE)]
  const replacements = await Promise.all(matches.map(async (m) => {
    const kind = m[1]
    const attrs = parseAttrs(m[2])
    if (kind === 'LOOKUP_ORDER') {
      const { status, data } = await callRoute(`${base}/api/chat/lookup-order`, token, {
        email: attrs.email, displayId: attrs.display_id,
      }, opts.log)
      calls.push({ kind, status })
      return renderOrderResult(locale, status, data)
    }
    if (kind === 'LOOKUP_REFUND') {
      const { status, data } = await callRoute(`${base}/api/chat/lookup-refund`, token, {
        email: attrs.email, displayId: attrs.display_id,
      }, opts.log)
      calls.push({ kind, status })
      return renderRefundResult(locale, status, data)
    }
    if (kind === 'VALIDATE_GIFTCARD') {
      const { status, data } = await callRoute(`${base}/api/chat/validate-giftcard`, token, {
        code: attrs.code,
      }, opts.log)
      calls.push({ kind, status })
      return renderGiftCardResult(locale, status, data)
    }
    return ''
  }))
  let out = reply
  for (let i = 0; i < matches.length; i++) {
    out = out.replace(matches[i][0], replacements[i])
  }
  return { reply: out, calls }
}

export const __marker_re_for_tests = MARKER_RE
export const __parse_attrs_for_tests = parseAttrs
