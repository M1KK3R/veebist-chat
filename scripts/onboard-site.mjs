#!/usr/bin/env node
/**
 * Onboard a new site to the Veebist chat stack.
 *
 *   node scripts/onboard-site.mjs
 *
 * Prompts for site slug + display name + URL + backend config, then:
 *   1. Creates a Chatwoot Website-channel inbox (via API)
 *   2. Assigns the bot agent + adds you as collaborator
 *   3. Creates bot/knowledge/<slug>.md from the example template
 *   4. Appends a per-site env block to chatwoot/.env so the bot's live
 *      catalog snapshot starts working for this site
 *   5. Prints the .env snippet to paste into the new site
 *
 * Required env (in chatwoot/.env at this repo root):
 *   CHATWOOT_URL                       e.g. https://chat.veebist.cloud
 *   CHATWOOT_API_TOKEN                 personal admin access token
 *   CHATWOOT_ACCOUNT_ID                e.g. 2
 *   ONBOARD_BOT_AGENT_ID               (optional) agent id to assign to the inbox
 *   ONBOARD_COLLABORATOR_USER_ID       (optional) your user id (adds to inbox so mobile shows it)
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const ENV_FILE = path.join(REPO_ROOT, '.env')
const KNOWLEDGE_DIR = path.join(REPO_ROOT, 'bot', 'knowledge')

try {
  const txt = await fs.readFile(ENV_FILE, 'utf8')
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
} catch {}

const {
  CHATWOOT_URL,
  CHATWOOT_API_TOKEN,
  CHATWOOT_ACCOUNT_ID = '1',
  ONBOARD_BOT_AGENT_ID,
  ONBOARD_COLLABORATOR_USER_ID,
} = process.env

if (!CHATWOOT_URL || !CHATWOOT_API_TOKEN) {
  console.error('Set CHATWOOT_URL and CHATWOOT_API_TOKEN in chatwoot/.env first.')
  process.exit(1)
}

function api(p, init = {}) {
  return fetch(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      api_access_token: CHATWOOT_API_TOKEN,
      ...(init.headers || {}),
    },
  })
}

async function ok(res, ctx) {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${ctx} failed: ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json()
}

const rl = readline.createInterface({ input, output })
const ask = (q, d = '') => rl.question(d ? `${q} [${d}]: ` : `${q}: `).then(s => (s || d).trim())
const askYN = (q, d = 'Y') => rl.question(`${q} [${d}/${d.toUpperCase() === 'Y' ? 'n' : 'y'}]: `).then(s => {
  const v = (s || d).toLowerCase()
  return v === 'y' || v === 'yes'
})

console.log('\n  Veebist chat — onboard new site\n')

// ─── identity ────────────────────────────────────────────────
const slug = await ask('Site slug (lowercase, no spaces — e.g. scottest)')
const slugUpper = slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')
const displayName = await ask('Display name (e.g. ScottEst Šoti tooted)')
const websiteUrl = await ask('Site URL (https://...)')

if (!slug || !displayName || !websiteUrl) {
  console.error('\nslug, display name, and URL are required.')
  process.exit(1)
}

// ─── backend config for live catalog ─────────────────────────
console.log('\n--- Live catalog backends (Medusa for products, Payload for articles) ---')
const useMedusa = await askYN('Does this site have a Medusa storefront?')
let medusaUrl = '', medusaKey = ''
if (useMedusa) {
  medusaUrl = await ask('  Medusa URL', `${websiteUrl}/medusa`)
  medusaKey = await ask('  Medusa publishable key (pk_...)')
}

const usePayload = await askYN('Does this site have a Payload CMS?')
let payloadUrl = ''
if (usePayload) {
  payloadUrl = await ask('  Payload API URL', `${websiteUrl}/api`)
}

const contactEmail = await ask('Contact email shown by bot (optional)', '')
const contactPhone = await ask('Contact phone shown by bot (optional)', '')

const addMe = await askYN('Add yourself as collaborator on the inbox?')

rl.close()

// ─── Chatwoot inbox creation ─────────────────────────────────
console.log('\nCreating Chatwoot inbox…')
const inbox = await ok(await api('/inboxes', {
  method: 'POST',
  body: JSON.stringify({
    name: displayName,
    channel: {
      type: 'web_widget',
      website_url: websiteUrl,
      welcome_title: 'Tere! Kuidas saame aidata?',
      welcome_tagline: 'AI assistent vastab kohe.',
    },
  }),
}), 'create inbox')
console.log(`  ✓ Inbox id=${inbox.id}, website_token=${inbox.website_token}`)

if (ONBOARD_BOT_AGENT_ID) {
  console.log('Assigning bot agent…')
  await ok(await api(`/inboxes/${inbox.id}/set_agent_bot`, {
    method: 'POST',
    body: JSON.stringify({ agent_bot: Number(ONBOARD_BOT_AGENT_ID) }),
  }), 'assign bot').catch(e => console.log(`  (skipped: ${e.message})`))
}

if (addMe && ONBOARD_COLLABORATOR_USER_ID) {
  console.log('Adding collaborator…')
  await ok(await api('/inbox_members', {
    method: 'POST',
    body: JSON.stringify({ inbox_id: inbox.id, user_ids: [Number(ONBOARD_COLLABORATOR_USER_ID)] }),
  }), 'add collaborator').catch(e => console.log(`  (skipped: ${e.message})`))
}

// ─── knowledge file from template ────────────────────────────
const knowledgePath = path.join(KNOWLEDGE_DIR, `${slug}.md`)
const examplePath = path.join(KNOWLEDGE_DIR, 'example.md')
let template = ''
try { template = await fs.readFile(examplePath, 'utf8') } catch {}
await fs.writeFile(
  knowledgePath,
  template || `# ${displayName}\n\n(Add FAQ + business info for the bot here.)\n`,
  { flag: 'wx' },
)
  .then(() => console.log(`  ✓ Created bot/knowledge/${slug}.md`))
  .catch(() => console.log(`  (already exists: bot/knowledge/${slug}.md)`))

// ─── env block appended to chatwoot/.env ─────────────────────
const envBlock = []
envBlock.push('')
envBlock.push(`# === Site: ${displayName} (added ${new Date().toISOString().slice(0, 10)}) ===`)
envBlock.push(`${slugUpper}_DISPLAY_NAME=${displayName}`)
if (medusaUrl) {
  envBlock.push(`${slugUpper}_MEDUSA_URL=${medusaUrl}`)
  envBlock.push(`${slugUpper}_MEDUSA_PUBLISHABLE_KEY=${medusaKey}`)
}
if (payloadUrl) {
  envBlock.push(`${slugUpper}_PAYLOAD_URL=${payloadUrl}`)
}
if (contactEmail) envBlock.push(`${slugUpper}_CONTACT_EMAIL=${contactEmail}`)
if (contactPhone) envBlock.push(`${slugUpper}_CONTACT_PHONE=${contactPhone}`)

const existingEnv = await fs.readFile(ENV_FILE, 'utf8').catch(() => '')
if (existingEnv.includes(`${slugUpper}_MEDUSA_URL=`) || existingEnv.includes(`${slugUpper}_PAYLOAD_URL=`)) {
  console.log(`  ⚠  chatwoot/.env already has a block for ${slugUpper} — skipping append`)
} else {
  await fs.appendFile(ENV_FILE, envBlock.join('\n') + '\n')
  console.log(`  ✓ Appended ${envBlock.length - 2} env vars to chatwoot/.env`)
  console.log(`  ↳ Run: cd ${REPO_ROOT} && docker compose --env-file .env restart chat-bot`)
}

// ─── next-steps printout for the storefront ──────────────────
console.log(`\n────────── Storefront-side wiring (paste into the new site) ──────────\n`)
console.log(`  # package.json`)
console.log(`  "@veebist/chat-widget": "file:../../veebist-platform/packages/chat-widget"\n`)
console.log(`  # src/app/(frontend)/layout.tsx`)
console.log(`  import { ChatwootWidget } from '@veebist/chat-widget'`)
console.log(`  <ChatwootWidget />\n`)
console.log(`  # .env`)
console.log(`  NEXT_PUBLIC_CHATWOOT_BASE_URL=${CHATWOOT_URL}`)
console.log(`  NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN=${inbox.website_token}\n`)
console.log(`────────── Done. ──────────\n`)
