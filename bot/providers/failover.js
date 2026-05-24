import { ProviderError } from './base.js'

const PROBE_PROMPT = 'Reply with the single word: OK'
const PROBE_INTERVAL_MS = 5 * 60_000
const ALERT_DEBOUNCE_MS = 60 * 60_000  // don't re-alert for the same provider within an hour

export class FailoverProvider {
  constructor({ primary, secondary, alerts, probeIntervalMs = PROBE_INTERVAL_MS, log = console.log }) {
    this.primary = primary
    this.secondary = secondary
    this.alerts = alerts
    this.log = log
    this.state = new Map()  // providerName -> { status, lastError, lastAlertAt }
    this.state.set(primary.name, { status: 'healthy' })
    if (secondary) this.state.set(secondary.name, { status: 'healthy' })
    if (probeIntervalMs > 0) this.probeTimer = setInterval(() => this.probe(), probeIntervalMs).unref?.()
  }

  async ask(prompt) {
    const primaryState = this.state.get(this.primary.name)
    if (primaryState.status === 'healthy') {
      try {
        const reply = await this.primary.ask(prompt)
        return { reply, providerUsed: this.primary.name }
      } catch (err) {
        this.markUnhealthy(this.primary.name, err)
      }
    }
    if (this.secondary) {
      const secondaryState = this.state.get(this.secondary.name)
      if (secondaryState.status === 'healthy') {
        try {
          const reply = await this.secondary.ask(prompt)
          return { reply, providerUsed: this.secondary.name }
        } catch (err) {
          this.markUnhealthy(this.secondary.name, err)
        }
      }
    }
    throw new ProviderError('all providers unhealthy', { kind: 'unknown', provider: 'failover', retryable: false })
  }

  markUnhealthy(name, err) {
    const kind = err instanceof ProviderError ? err.kind : 'unknown'
    const status = kind === 'auth' ? 'down' : 'degraded'
    const cur = this.state.get(name) || {}
    const wasHealthy = cur.status === 'healthy'
    this.state.set(name, { ...cur, status, lastError: err.message, lastErrorKind: kind, lastFailureAt: Date.now() })
    this.log(`[failover] ${name} → ${status} (${kind}): ${err.message.slice(0, 200)}`)
    if (wasHealthy || Date.now() - (cur.lastAlertAt || 0) > ALERT_DEBOUNCE_MS) {
      const nextState = this.state.get(name)
      nextState.lastAlertAt = Date.now()
      this.alerts?.fire({
        provider: name,
        status,
        kind,
        error: err.message,
      }).catch(e => this.log('[failover] alert failed:', e.message))
    }
  }

  markHealthy(name) {
    const cur = this.state.get(name)
    if (!cur || cur.status === 'healthy') return
    this.state.set(name, { status: 'healthy' })
    this.log(`[failover] ${name} → healthy`)
    this.alerts?.fire({
      provider: name,
      status: 'healthy',
      kind: 'recovery',
      error: 'recovered after being ' + cur.status,
    }).catch(e => this.log('[failover] recovery alert failed:', e.message))
  }

  async probe() {
    for (const [name, st] of this.state.entries()) {
      if (st.status === 'healthy') continue
      const provider = name === this.primary.name ? this.primary : this.secondary
      try {
        await provider.ask(PROBE_PROMPT)
        this.markHealthy(name)
      } catch {
        // still broken, leave state
      }
    }
  }

  stats() {
    return Object.fromEntries(this.state)
  }

  stop() {
    if (this.probeTimer) clearInterval(this.probeTimer)
  }
}
