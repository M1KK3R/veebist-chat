/**
 * Per-visitor rate limiter — protects against enumeration / spam.
 *
 * In-memory token bucket per key (Chatwoot conversation id, contact id, IP).
 * Resets every WINDOW_MS. Fine for single-instance bot; move to Redis if we
 * ever run multiple bot replicas.
 */

const WINDOW_MS = 5 * 60_000  // 5 min
const DEFAULT_MAX = 20         // 20 messages per 5 min per key

// Map<key, { count, windowStart }>
const counters = new Map()

// Garbage-collect old entries occasionally so the Map doesn't grow unbounded
let lastGC = Date.now()
function maybeGC() {
  const now = Date.now()
  if (now - lastGC < WINDOW_MS) return
  for (const [k, v] of counters.entries()) {
    if (now - v.windowStart > WINDOW_MS) counters.delete(k)
  }
  lastGC = now
}

export function consume(key, { max = DEFAULT_MAX, windowMs = WINDOW_MS } = {}) {
  maybeGC()
  const now = Date.now()
  const entry = counters.get(key)
  if (!entry || now - entry.windowStart > windowMs) {
    counters.set(key, { count: 1, windowStart: now })
    return { allowed: true, remaining: max - 1 }
  }
  if (entry.count >= max) {
    return { allowed: false, remaining: 0, retryAfterMs: windowMs - (now - entry.windowStart) }
  }
  entry.count++
  return { allowed: true, remaining: max - entry.count }
}
