#!/usr/bin/env node
/**
 * Onboard a new site to the Veebist chat stack.
 *
 *   node scripts/onboard-site.mjs
 *
 * Prompts for site slug + display name + URL, then via the Chatwoot API:
 *   1. Creates a Website-channel inbox
 *   2. Assigns the bot agent to it
 *   3. (optional) Adds you as collaborator
 *   4. Creates bot/knowledge/<slug>.md from the example template
 *   5. Prints the .env snippet to paste into the new site
 *
 * Required env (in .env at repo root):
 *   CHATWOOT_URL                  e.g. https://chat.veebist.cloud
 *   CHATWOOT_API_TOKEN            personal admin access token
 *   CHATWOOT_ACCOUNT_ID           e.g. 2
 *   ONBOARD_BOT_AGENT_ID          (optional) agent id of the Veebist AI bot to assign
 *   ONBOARD_COLLABORATOR_USER_ID  (optional) your user id, added to the inbox so mobile shows it
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const envFile = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.env')
try {
  const txt = await fs.readFile(envFile, 'utf8')
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
  console.error('Set CHATWOOT_URL and CHATWOOT_API_TOKEN in .env first.')
  process.exit(1)
}

function api(path, init = {}) {
  return fetch(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}${path}`, {
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
const ask = q => rl.question(q).then(s => s.trim())

console.log('\n  Veebist chat — onboard new site\n')
const slug = await ask('Site slug (e.g. scottest):                 ')
const displayName = await ask('Display name (e.g. ScottEst Šoti tooted): ')
const websiteUrl = await ask('Site URL (https://...):                   ')
const knowledgeSource = (await ask('Knowledge source [markdown/payload]:      ')) || 'markdown'
const addMe = (await ask('Add yourself as collaborator? [Y/n]:      ')).toLowerCase() !== 'n'
rl.close()

if (!slug || !displayName || !websiteUrl) {
  console.error('\nslug, display name, and URL are required.')
  process.exit(1)
}

console.log('\nCreating Chatwoot inbox…')
const inbox = await ok(await api('/inboxes', {
  method: 'POST',
  body: JSON.stringify({
    name: displayName,
    channel: {
      type: 'web_widget',
      website_url: websiteUrl,
      welcome_title: 'Tere! Kuidas saame aidata?',
      welcome_tagline: 'Hi! How can we help?',
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
    body: JSON.stringify({
      inbox_id: inbox.id,
      user_ids: [Number(ONBOARD_COLLABORATOR_USER_ID)],
    }),
  }), 'add collaborator').catch(e => console.log(`  (skipped: ${e.message})`))
}

if (knowledgeSource === 'markdown') {
  const knowledgePath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bot', 'knowledge', `${slug}.md`)
  const examplePath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bot', 'knowledge', 'example.md')
  let template = ''
  try { template = await fs.readFile(examplePath, 'utf8') } catch {}
  await fs.writeFile(knowledgePath, template || `# ${displayName}\n\n(Add FAQ + product/service info for the bot here.)\n`, { flag: 'wx' })
    .then(() => console.log(`  ✓ Created bot/knowledge/${slug}.md`))
    .catch(() => console.log(`  (already exists: bot/knowledge/${slug}.md)`))
}

console.log(`\nDone. Add these to the new site's .env:\n`)
console.log(`  NEXT_PUBLIC_CHATWOOT_BASE_URL=${CHATWOOT_URL}`)
console.log(`  NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN=${inbox.website_token}`)
console.log(`\nThen drop <ChatwootWidget /> in your root layout (from @veebist/chat-widget) and deploy.\n`)
