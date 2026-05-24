import { spawn } from 'node:child_process'
import { ProviderError, classifyStderr } from './base.js'

const TIMEOUT_MS = 120_000  // Codex with reasoning_effort=high can be slow

// Codex stdout looks like:
//   ... preamble lines ...
//   --------
//   user
//   <prompt>
//   --------
//   assistant
//   <reply...>
//   tokens used
//   N
// We want the reply between the assistant marker and the tokens-used line.
function extractReply(stdout) {
  const lines = stdout.split('\n')
  const startIdx = lines.findIndex(l => l.trim() === 'codex' || l.trim() === 'assistant')
  if (startIdx === -1) return stdout.trim()
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^tokens\s+used/i.test(l.trim()))
  const slice = endIdx === -1 ? lines.slice(startIdx + 1) : lines.slice(startIdx + 1, endIdx)
  return slice.join('\n').trim()
}

export class CodexProvider {
  constructor({ binPath = 'codex', timeoutMs = TIMEOUT_MS, workdir = '/tmp' } = {}) {
    this.name = 'codex'
    this.binPath = binPath
    this.timeoutMs = timeoutMs
    this.workdir = workdir
  }

  async ask(prompt) {
    return new Promise((resolve, reject) => {
      const args = ['exec', '--skip-git-repo-check', '--color=never', prompt]
      const proc = spawn(this.binPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
      })
      let stdout = ''
      let stderr = ''
      const t = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new ProviderError('codex CLI timeout', { kind: 'timeout', provider: this.name, retryable: true }))
      }, this.timeoutMs)

      proc.stdout.on('data', d => (stdout += d))
      proc.stderr.on('data', d => (stderr += d))
      proc.on('close', code => {
        clearTimeout(t)
        const combined = stdout + '\n' + stderr
        if (/ERROR:|400 Bad Request|not supported|requires.*newer/i.test(combined)) {
          const kind = classifyStderr(combined)
          return reject(new ProviderError(
            `codex error: ${combined.slice(-500)}`,
            { kind, provider: this.name, retryable: kind !== 'auth' },
          ))
        }
        if (code !== 0) {
          const kind = classifyStderr(stderr)
          return reject(new ProviderError(
            `codex exit ${code}: ${stderr.slice(0, 500)}`,
            { kind, provider: this.name, retryable: kind !== 'auth' },
          ))
        }
        resolve(extractReply(stdout))
      })
      proc.on('error', err => {
        clearTimeout(t)
        reject(new ProviderError(err.message, { kind: 'crash', provider: this.name, retryable: true }))
      })
    })
  }
}
