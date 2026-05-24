/**
 * Per-site config for the bot — which Medusa / Payload backend to fetch
 * live catalog data from, and per-site tuning.
 *
 * Keys are matched against the Chatwoot inbox name (lowercased substring
 * match in detectSite()). Add a new entry per onboarded site.
 *
 * Tokens come from env so secrets don't live in source.
 */

export const SITES = {
  scottest: {
    displayName: 'ScottEst',
    locale: 'et',  // primary visitor language (also used as fallback for Payload queries)
    medusa: {
      url: process.env.SCOTTEST_MEDUSA_URL || 'https://scottest.veebist.cloud/medusa',
      publishableKey: process.env.SCOTTEST_MEDUSA_PUBLISHABLE_KEY,
      productLimit: Number(process.env.SCOTTEST_PRODUCT_LIMIT || 100),
      regionId: process.env.SCOTTEST_MEDUSA_REGION_ID,  // optional; auto-detected
    },
    payload: {
      url: process.env.SCOTTEST_PAYLOAD_URL || 'https://scottest.veebist.cloud/api',
      token: process.env.SCOTTEST_PAYLOAD_TOKEN,  // optional, for non-public reads
      articleLimit: Number(process.env.SCOTTEST_ARTICLE_LIMIT || 10),
    },
    contactInfo: {
      email: 'info@scottest.ee',
      phone: '+372 ...',
    },
  },
}

export function getSiteConfig(siteKey) {
  return SITES[siteKey] || null
}
