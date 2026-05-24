import { ClaudeProvider } from './claude.js'
import { CodexProvider } from './codex.js'
import { FailoverProvider } from './failover.js'

export function buildProvider({ primaryName, secondaryName, alerts, log }) {
  const make = name => {
    if (name === 'claude') return new ClaudeProvider()
    if (name === 'codex') return new CodexProvider()
    if (name === 'none') return null
    throw new Error(`unknown provider: ${name}`)
  }
  const primary = make(primaryName)
  if (!primary) throw new Error('primary provider required')
  const secondary = secondaryName && secondaryName !== 'none' ? make(secondaryName) : null
  return new FailoverProvider({ primary, secondary, alerts, log })
}

export { ProviderError } from './base.js'
