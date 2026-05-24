export class Semaphore {
  constructor(capacity, { warnAtDepth = Math.ceil(capacity / 2), onWarn } = {}) {
    this.capacity = capacity
    this.active = 0
    this.queue = []
    this.warnAtDepth = warnAtDepth
    this.onWarn = onWarn
  }

  async acquire() {
    if (this.active < this.capacity) {
      this.active++
      return
    }
    await new Promise(resolve => {
      this.queue.push(resolve)
      if (this.queue.length >= this.warnAtDepth && this.onWarn) {
        this.onWarn(this.queue.length, this.capacity)
      }
    })
    this.active++
  }

  release() {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }

  async run(fn) {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  stats() {
    return { active: this.active, queued: this.queue.length, capacity: this.capacity }
  }
}
