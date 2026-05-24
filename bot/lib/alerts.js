import nodemailer from 'nodemailer'

export class AlertSink {
  constructor({ log = console.log, email, chatwoot, alertInboxId, alertContactId } = {}) {
    this.log = log
    this.email = email
    this.chatwoot = chatwoot
    this.alertInboxId = alertInboxId
    this.alertContactId = alertContactId
  }

  async fire({ provider, status, kind, error }) {
    const subject = `[chat-bot] ${provider} → ${status} (${kind})`
    const body = `Provider: ${provider}\nStatus: ${status}\nKind: ${kind}\nError: ${error}\nTime: ${new Date().toISOString()}\n`
    this.log(`[alert] ${subject}`)

    const tasks = []
    if (this.email) tasks.push(this.sendEmail(subject, body).catch(e => this.log('[alert] email failed:', e.message)))
    if (this.chatwoot && this.alertInboxId) {
      tasks.push(this.postToChatwoot(subject, body).catch(e => this.log('[alert] chatwoot failed:', e.message)))
    }
    await Promise.all(tasks)
  }

  async sendEmail(subject, body) {
    if (!this.email?.transport) return
    await this.email.transport.sendMail({
      from: this.email.from,
      to: this.email.to,
      subject,
      text: body,
    })
  }

  async postToChatwoot(subject, body) {
    await this.chatwoot.createConversation({
      inboxId: this.alertInboxId,
      sourceId: `alert-${Date.now()}`,
      contactId: this.alertContactId,
      message: `${subject}\n\n${body}`,
    })
  }
}

export function buildEmailConfig(env) {
  if (!env.SMTP_HOST || !env.ALERT_EMAIL_TO) return null
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE !== 'false',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  })
  return {
    transport,
    from: env.ALERT_EMAIL_FROM || env.SMTP_USER,
    to: env.ALERT_EMAIL_TO,
  }
}
