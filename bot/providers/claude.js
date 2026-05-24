import { spawn } from 'node:child_process'
import { ProviderError, classifyStderr } from './base.js'

const TIMEOUT_MS = 60_000

export class ClaudeProvider {
  constructor({ binPath = 'claude', timeoutMs = TIMEOUT_MS } = {}) {
    this.name = 'claude'
    this.binPath = binPath
    this.timeoutMs = timeoutMs
  }

  async ask(prompt) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binPath, ['-p', prompt, '--output-format', 'json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const t = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new ProviderError('claude CLI timeout', { kind: 'timeout', provider: this.name, retryable: true }))
      }, this.timeoutMs)

      proc.stdout.on('data', d => (stdout += d))
      proc.stderr.on('data', d => (stderr += d))
      proc.on('close', code => {
        clearTimeout(t)
        if (code !== 0) {
          const kind = classifyStderr(stderr)
          return reject(new ProviderError(
            `claude exit ${code}: ${stderr.slice(0, 500)}`,
            { kind, provider: this.name, retryable: kind !== 'auth' },
          ))
        }
        try {
          const result = JSON.parse(stdout)
          resolve(String(result.result || result.text || stdout).trim())
        } catch {
          resolve(stdout.trim())
        }
      })
      proc.on('error', err => {
        clearTimeout(t)
        reject(new ProviderError(err.message, { kind: 'crash', provider: this.name, retryable: true }))
      })
    })
  }
}
