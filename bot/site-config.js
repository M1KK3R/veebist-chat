/**
 * Per-site config — entirely env-driven so adding a site = just writing env vars.
 *
 * Convention: every config field for site `acme` is `ACME_<FIELD>`. The
 * onboarding CLI (scripts/onboard-site.mjs) appends a block per new site.
 *
 *   <SITE>_MEDUSA_URL                  required: enables the catalog snapshot
 *   <SITE>_MEDUSA_PUBLISHABLE_KEY      required: pk_... from Medusa admin
 *   <SITE>_PAYLOAD_URL                 optional: enables article/page snapshot
 *   <SITE>_PAYLOAD_TOKEN               optional: for non-public reads
 *   <SITE>_DISPLAY_NAME                optional: shown in bot prompts (defaults to siteKey)
 *   <SITE>_LOCALE                      optional: et|en (defaults to "et")
 *   <SITE>_PRODUCT_LIMIT               optional: snapshot cap (defaults to 100)
 *   <SITE>_ARTICLE_LIMIT               optional: article cap (defaults to 10)
 *   <SITE>_MEDUSA_REGION_ID            optional: auto-detected if blank
 *   <SITE>_CONTACT_EMAIL               optional: surfaced in bot prompt
 *   <SITE>_CONTACT_PHONE               optional: surfaced in bot prompt
 */

export function getSiteConfig(siteKey) {
  if (!siteKey) return null
  const upper = siteKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const medusaUrl = process.env[`${upper}_MEDUSA_URL`]
  const payloadUrl = process.env[`${upper}_PAYLOAD_URL`]

  // Site is "registered" if it has at least one backend configured.
  if (!medusaUrl && !payloadUrl) return null

  return {
    key: siteKey,
    displayName: process.env[`${upper}_DISPLAY_NAME`] || siteKey,
    locale: process.env[`${upper}_LOCALE`] || 'et',
    medusa: {
      url: medusaUrl || null,
      publishableKey: process.env[`${upper}_MEDUSA_PUBLISHABLE_KEY`] || null,
      productLimit: Number(process.env[`${upper}_PRODUCT_LIMIT`] || 100),
      regionId: process.env[`${upper}_MEDUSA_REGION_ID`] || null,
    },
    payload: {
      url: payloadUrl || null,
      token: process.env[`${upper}_PAYLOAD_TOKEN`] || null,
      articleLimit: Number(process.env[`${upper}_ARTICLE_LIMIT`] || 10),
    },
    contactInfo: {
      email: process.env[`${upper}_CONTACT_EMAIL`] || null,
      phone: process.env[`${upper}_CONTACT_PHONE`] || null,
    },
    // URL patterns for emitting catalog item links in the bot prompt.
    // `{handle}` / `{slug}` are the only placeholders.
    // Defaults work for typical Veebist sites; override per-site when paths differ
    // (e.g. scottest uses /<slug> at root for both articles AND pages, no prefix).
    urlPatterns: {
      product: process.env[`${upper}_URL_PATTERN_PRODUCT`] || '/pood/{handle}',
      article: process.env[`${upper}_URL_PATTERN_ARTICLE`] || '/blogi/{slug}',
      page: process.env[`${upper}_URL_PATTERN_PAGE`] || '/lehed/{slug}',
    },
    // Public origin used by the bot to call the per-site Next.js route handlers
    // (`/api/chat/lookup-order` etc.). Defaults to the Chatwoot inbox's
    // website_url; this env var is the canonical override.
    siteUrl: process.env[`${upper}_SITE_URL`] || null,
    // Per-site feature flags. Off by default; opt-in via env.
    //   <SITE>_FEATURE_GIFTCARD_VALIDATION=true  → bot can emit [[VALIDATE_GIFTCARD]]
    //   <SITE>_FEATURE_ORDER_LOOKUP=true         → bot can emit [[LOOKUP_ORDER]] / [[LOOKUP_REFUND]]
    //   <SITE>_KNOWLEDGE_STRATEGY=snapshot|retriever|auto  (default auto, see catalog/retriever.js)
    featureFlags: {
      giftcardValidation: process.env[`${upper}_FEATURE_GIFTCARD_VALIDATION`] === 'true',
      orderLookup: process.env[`${upper}_FEATURE_ORDER_LOOKUP`] === 'true',
    },
    knowledgeStrategy: process.env[`${upper}_KNOWLEDGE_STRATEGY`] || 'auto',
  }
}

/** Helper to discover all registered sites by scanning env vars. */
export function listSiteKeys() {
  const seen = new Set()
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^([A-Z][A-Z0-9_]*)_MEDUSA_URL$/) || k.match(/^([A-Z][A-Z0-9_]*)_PAYLOAD_URL$/)
    if (m) seen.add(m[1].toLowerCase())
  }
  return [...seen]
}
