import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchCmsKnowledge } from '../catalog/payload.js'

// Helper: swap global.fetch for a single test, restoring afterwards.
function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original
  })
}

test('fetchCmsKnowledge: returns empty when payload url missing', async () => {
  const md = await fetchCmsKnowledge({})
  assert.equal(md, '')
})

test('fetchCmsKnowledge: builds URL as <payloadUrl>/chat/knowledge?lang=...', async () => {
  let capturedUrl
  await withFetch(async (url) => {
    capturedUrl = String(url)
    return new Response('# kb', { status: 200, headers: { 'content-type': 'text/markdown' } })
  }, async () => {
    await fetchCmsKnowledge({
      payload: { url: 'https://scottest.veebist.cloud/api' },
      locale: 'et',
    })
  })
  assert.equal(capturedUrl, 'https://scottest.veebist.cloud/api/chat/knowledge?lang=et')
})

test('fetchCmsKnowledge: returns markdown when content-type is text/markdown', async () => {
  const md = await withFetch(async () =>
    new Response('## Test\nbody', { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } }),
  () =>
    fetchCmsKnowledge({ payload: { url: 'https://x/api' }, locale: 'et' }))
  assert.equal(md, '## Test\nbody')
})

test('fetchCmsKnowledge: empty on 4xx', async () => {
  const md = await withFetch(async () =>
    new Response('not found', { status: 404 }),
  () =>
    fetchCmsKnowledge({ payload: { url: 'https://x/api' }, locale: 'et' }))
  assert.equal(md, '')
})

test('fetchCmsKnowledge: empty when content-type is wrong (avoids JSON 200 fooling us)', async () => {
  const md = await withFetch(async () =>
    new Response(JSON.stringify({ message: 'forgot to set the route' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  () =>
    fetchCmsKnowledge({ payload: { url: 'https://x/api' }, locale: 'et' }))
  assert.equal(md, '')
})

test('fetchCmsKnowledge: empty on fetch throw', async () => {
  const md = await withFetch(async () => { throw new Error('network down') },
  () =>
    fetchCmsKnowledge({ payload: { url: 'https://x/api' }, locale: 'et' }))
  assert.equal(md, '')
})

test('fetchCmsKnowledge: defaults locale to et when missing', async () => {
  let captured
  await withFetch(async (url) => {
    captured = String(url)
    return new Response('x', { status: 200, headers: { 'content-type': 'text/markdown' } })
  }, () =>
    fetchCmsKnowledge({ payload: { url: 'https://x/api' } }))
  assert.match(captured, /lang=et$/)
})
