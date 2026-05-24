export class ChatwootClient {
  constructor({ baseUrl, apiToken, accountId, log = console.log }) {
    this.baseUrl = baseUrl
    this.apiToken = apiToken
    this.accountId = accountId
    this.log = log
  }

  url(path) {
    return `${this.baseUrl}/api/v1/accounts/${this.accountId}${path}`
  }

  headers() {
    return { 'Content-Type': 'application/json', api_access_token: this.apiToken }
  }

  async postMessage(conversationId, content, { isPrivate = false } = {}) {
    const res = await fetch(this.url(`/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ content, message_type: 'outgoing', private: isPrivate }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`postMessage failed: ${res.status} ${body.slice(0, 200)}`)
    }
    return res.json()
  }

  async fetchHistory(conversationId, limit = 6) {
    const res = await fetch(this.url(`/conversations/${conversationId}/messages`), {
      headers: { api_access_token: this.apiToken },
    })
    if (!res.ok) return []
    const data = await res.json().catch(() => ({}))
    return (data.payload || []).slice(-limit)
  }

  async toggleStatus(conversationId, status) {
    await fetch(this.url(`/conversations/${conversationId}/toggle_status`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ status }),
    }).catch(err => this.log('toggleStatus failed', err.message))
  }

  // Create a new conversation in an existing inbox. Used for posting alerts
  // into the dedicated "Bot Alerts" inbox so they show up in the mobile app.
  async createConversation({ inboxId, sourceId, contactId, message }) {
    const res = await fetch(this.url('/conversations'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        inbox_id: inboxId,
        source_id: sourceId,
        contact_id: contactId,
        message: { content: message, message_type: 'outgoing' },
        status: 'open',
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`createConversation failed: ${res.status} ${body.slice(0, 200)}`)
    }
    return res.json()
  }
}
