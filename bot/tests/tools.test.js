import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processLookups, __parse_attrs_for_tests as parseAttrs } from '../lib/tools.js'

function withFetch(impl, fn) {
  const orig = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig })
}

test('parseAttrs handles bare and quoted values', () => {
  assert.deepEqual(parseAttrs('email=x@y.z display_id=1234'), { email: 'x@y.z', display_id: '1234' })
  assert.deepEqual(parseAttrs('code="ABCD 1234"'), { code: 'ABCD 1234' })
})

test('returns reply unchanged when no markers present', async () => {
  const { reply, calls } = await processLookups('Tellimus on saadetud.', {
    siteConfig: { siteUrl: 'https://x' }, token: 't',
  })
  assert.equal(reply, 'Tellimus on saadetud.')
  assert.equal(calls.length, 0)
})

test('returns reply unchanged when siteUrl is missing', async () => {
  const { reply } = await processLookups('[[LOOKUP_ORDER email=x display_id=1]]', { siteConfig: {} })
  assert.match(reply, /\[\[LOOKUP_ORDER/)
})

test('LOOKUP_ORDER 200 hits /api/chat/lookup-order with bearer + body and renders ET order summary', async () => {
  let capturedUrl, capturedInit
  const out = await withFetch(async (url, init) => {
    capturedUrl = String(url)
    capturedInit = init
    return new Response(JSON.stringify({ found: true, order: { status: 'shipped', displayId: 1234, items: [{ title: 'Sauna', quantity: 1 }] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }, () => processLookups('Kontrollin: [[LOOKUP_ORDER email=info@scottest.ee display_id=1234]] kohe.', {
    siteConfig: { siteUrl: 'https://scottest.veebist.cloud' },
    token: 'tok-1',
    locale: 'et',
  }))
  assert.equal(capturedUrl, 'https://scottest.veebist.cloud/api/chat/lookup-order')
  assert.equal(capturedInit.headers.Authorization, 'Bearer tok-1')
  assert.match(out.reply, /Tellimus #1234 on saadetud/)
  assert.match(out.reply, /Sauna/)
  // marker removed
  assert.equal(out.reply.includes('[['), false)
})

test('LOOKUP_ORDER 404 renders friendly ET denial', async () => {
  const out = await withFetch(async () => new Response('{"found":false}', { status: 404, headers: { 'content-type': 'application/json' } }),
    () => processLookups('[[LOOKUP_ORDER email=wrong@x.com display_id=99]]', {
      siteConfig: { siteUrl: 'https://x.com' }, token: 't', locale: 'et',
    }))
  assert.match(out.reply, /ei leidnud/i)
})

test('LOOKUP_REFUND renders refund status', async () => {
  const out = await withFetch(async () => new Response(JSON.stringify({ found: true, refund: { displayId: 1, status: 'refunded', updatedAt: '2026-05-23' } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    () => processLookups('[[LOOKUP_REFUND email=x@y.z display_id=1]]', {
      siteConfig: { siteUrl: 'https://x' }, token: 't', locale: 'et',
    }))
  assert.match(out.reply, /Tagastus tellimuse #1/)
  assert.match(out.reply, /refunded/)
})

test('VALIDATE_GIFTCARD 200 with valid:true renders kehtiv (ET)', async () => {
  const out = await withFetch(async () => new Response('{"valid":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    () => processLookups('[[VALIDATE_GIFTCARD code=ABCD]]', {
      siteConfig: { siteUrl: 'https://x' }, token: 't', locale: 'et',
    }))
  assert.match(out.reply, /kehtiv/)
})

test('VALIDATE_GIFTCARD 503 explains disabled', async () => {
  const out = await withFetch(async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    () => processLookups('[[VALIDATE_GIFTCARD code=ABCD]]', {
      siteConfig: { siteUrl: 'https://x' }, token: 't', locale: 'et',
    }))
  assert.match(out.reply, /pole sellel veebilehel sisse lülitatud/)
})

test('VALIDATE_GIFTCARD 429 explains rate limit (EN)', async () => {
  const out = await withFetch(async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    () => processLookups('[[VALIDATE_GIFTCARD code=ABCD]]', {
      siteConfig: { siteUrl: 'https://x' }, token: 't', locale: 'en',
    }))
  assert.match(out.reply, /Too many gift-card checks/)
})

test('network error renders friendly ET apology', async () => {
  const out = await withFetch(async () => { throw new Error('boom') },
    () => processLookups('[[LOOKUP_ORDER email=x display_id=1]]', {
      siteConfig: { siteUrl: 'https://x' }, token: 't', locale: 'et',
    }))
  assert.match(out.reply, /ei õnnestunud praegu kontrollida/)
})
