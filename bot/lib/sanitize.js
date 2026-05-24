/**
 * Final-pass reply scrubber.
 *
 * The system prompt already tells the LLM not to echo secrets, but
 * prompts are not security boundaries — a visitor may paste a credit
 * card number into a conversation and the LLM might quote it back
 * unintentionally ("…you mean 4242 4242 4242 4242?"). This module is
 * the belt-and-braces guard.
 *
 * What we strip:
 *   1. Credit-card-like number sequences, gated by a Luhn check to keep
 *      false positives down (order/ticket numbers don't pass Luhn).
 *   2. IBAN-like strings (2-letter country + 2 check digits + 10-30 alnum).
 *   3. JWT/bearer-like strings (`eyJ...` + base64 segments OR very long
 *      hex/base64 tokens >= 24 chars adjacent to "Bearer"/"Token").
 *   4. Email addresses NOT in the site's published allowlist.
 *   5. International-prefixed phone numbers NOT in the site's allowlist.
 *
 * Each strip is replaced with a neutral placeholder so the surrounding
 * text still flows ("Saatke …" rather than "Saatke ee547700771004456439").
 * The function returns the cleaned reply + an array of which patterns
 * fired (for logging — never re-emit the stripped values).
 */

const PLACEHOLDER = '…'  // single ellipsis char

function luhn(str) {
  let sum = 0
  let alt = false
  for (let i = str.length - 1; i >= 0; i--) {
    let n = Number(str[i])
    if (Number.isNaN(n)) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

const CC_RE = /\b(?:\d[ -]?){13,19}\b/g
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
const BEARER_RE = /\b(?:Bearer|Token|x-api-key)\s*[:=]?\s*[A-Za-z0-9_\-+/=]{24,}/gi
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_RE = /\+\d[\d\s().-]{6,}\d/g

function normEmail(s) {
  return String(s || '').trim().toLowerCase()
}

function normPhone(s) {
  return String(s || '').replace(/[^\d+]/g, '')
}

/**
 * @param {string} reply
 * @param {object} opts
 * @param {{email?:string|null, phone?:string|null}} [opts.allowlist]
 * @param {object} [opts.snapshot] catalog snapshot — also adds catalog emails/phones to allowlist
 * @returns {{reply:string, removed:string[]}}
 */
export function sanitizeReply(reply, opts = {}) {
  if (!reply) return { reply: '', removed: [] }
  const removed = new Set()

  const allowedEmails = new Set()
  const allowedPhones = new Set()
  if (opts.allowlist?.email) allowedEmails.add(normEmail(opts.allowlist.email))
  if (opts.allowlist?.phone) allowedPhones.add(normPhone(opts.allowlist.phone))
  if (opts.snapshot?.contactInfo?.email) allowedEmails.add(normEmail(opts.snapshot.contactInfo.email))
  if (opts.snapshot?.contactInfo?.phone) allowedPhones.add(normPhone(opts.snapshot.contactInfo.phone))

  let out = reply

  // 1. Credit cards (Luhn-gated, so we don't strip order numbers like 1234567890123)
  out = out.replace(CC_RE, (match) => {
    const digits = match.replace(/[ -]/g, '')
    if (digits.length < 13 || digits.length > 19) return match
    if (!luhn(digits)) return match
    removed.add('credit_card')
    return PLACEHOLDER
  })

  // 2. IBANs
  out = out.replace(IBAN_RE, (match) => {
    const clean = match.replace(/\s+/g, '')
    if (clean.length < 14 || clean.length > 34) return match
    removed.add('iban')
    return PLACEHOLDER
  })

  // 3. JWTs
  out = out.replace(JWT_RE, () => {
    removed.add('jwt')
    return PLACEHOLDER
  })

  // 4. Bearer/api-key fragments
  out = out.replace(BEARER_RE, () => {
    removed.add('bearer_token')
    return PLACEHOLDER
  })

  // 5. Emails outside the allowlist
  out = out.replace(EMAIL_RE, (match) => {
    const norm = normEmail(match)
    if (allowedEmails.has(norm)) return match
    removed.add('foreign_email')
    return PLACEHOLDER
  })

  // 6. International phone numbers outside the allowlist
  out = out.replace(PHONE_RE, (match) => {
    const norm = normPhone(match)
    if (allowedPhones.has(norm)) return match
    removed.add('foreign_phone')
    return PLACEHOLDER
  })

  return { reply: out, removed: [...removed] }
}

export const __test_luhn = luhn
