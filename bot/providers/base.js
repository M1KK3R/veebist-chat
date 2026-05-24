export class ProviderError extends Error {
  constructor(message, { kind, provider, retryable }) {
    super(message)
    this.kind = kind
    this.provider = provider
    this.retryable = retryable
  }
}

// Error kinds drive failover decisions:
//   auth      — credentials stale/missing; switch & alert (won't fix itself)
//   ratelimit — quota hit; switch, will clear at reset
//   timeout   — hung subprocess; switch, retry primary later
//   crash     — non-zero exit; switch, retry primary later
//   parse     — malformed output; switch
//   network   — unreachable; switch
//   unknown   — switch, low confidence
export const ERROR_KINDS = ['auth', 'ratelimit', 'timeout', 'crash', 'parse', 'network', 'unknown']

export function classifyStderr(stderr = '') {
  const s = stderr.toLowerCase()
  if (/401|unauthor|logged out|please.*log.?in|invalid.*token|credential/.test(s)) return 'auth'
  if (/429|rate.?limit|quota|too many requests|usage.*cap/.test(s)) return 'ratelimit'
  if (/timeout|timed out/.test(s)) return 'timeout'
  if (/etimedout|enotfound|econnrefused|network/.test(s)) return 'network'
  return 'unknown'
}
