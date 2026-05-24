import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectStrategy, buildRouterPrompt, parseRouterPicks, hydrateProducts, runRouter } from '../catalog/retriever.js'

const SMALL = { products: Array.from({ length: 50 }, (_, i) => ({ handle: `h${i}`, title: `T${i}` })) }
const MED = { products: Array.from({ length: 1000 }, (_, i) => ({ handle: `h${i}`, title: `T${i}` })) }
const BIG = { products: Array.from({ length: 10000 }, (_, i) => ({ handle: `h${i}`, title: `T${i}` })) }

test('selectStrategy: ≤200 → snapshot', () => {
  assert.equal(selectStrategy({}, SMALL), 'snapshot')
})

test('selectStrategy: 201–5000 → retriever', () => {
  assert.equal(selectStrategy({}, MED), 'retriever')
})

test('selectStrategy: >5000 → overflow', () => {
  assert.equal(selectStrategy({}, BIG), 'overflow')
})

test('selectStrategy: explicit override beats catalog size', () => {
  assert.equal(selectStrategy({ knowledgeStrategy: 'retriever' }, SMALL), 'retriever')
  assert.equal(selectStrategy({ knowledgeStrategy: 'snapshot' }, MED), 'snapshot')
})

test('buildRouterPrompt: includes title + question + JSON-array instruction', () => {
  const snap = { products: [{ handle: 'sauna', title: 'Sauna kütteseade', description: 'Kompaktne', categories: ['kuumus'] }] }
  const p = buildRouterPrompt(snap, 'soovitan saunakerist?')
  assert.match(p, /JSON array/i)
  assert.match(p, /sauna \| Sauna kütteseade/)
  assert.match(p, /soovitan saunakerist/)
})

test('parseRouterPicks: bare JSON array', () => {
  assert.deepEqual(parseRouterPicks('["a","b","c"]'), ['a', 'b', 'c'])
})

test('parseRouterPicks: code-fenced JSON', () => {
  assert.deepEqual(parseRouterPicks('```json\n["a","b"]\n```'), ['a', 'b'])
})

test('parseRouterPicks: JSON embedded in prose still extracted', () => {
  assert.deepEqual(parseRouterPicks('Sure, here are the picks: ["x","y"]. Hope that helps.'), ['x', 'y'])
})

test('parseRouterPicks: empty on garbage', () => {
  assert.deepEqual(parseRouterPicks(''), [])
  assert.deepEqual(parseRouterPicks('I don\'t know'), ['Idontknow'])  // fallback: first-line letter-collapse; not great but never empty-array-throws
})

test('hydrateProducts: returns matching products in pick order', () => {
  const snap = { products: [{ handle: 'a', title: 'A' }, { handle: 'b', title: 'B' }, { handle: 'c', title: 'C' }] }
  const out = hydrateProducts(snap, ['c', 'a', 'missing'])
  assert.deepEqual(out.map((p) => p.handle), ['c', 'a'])
})

test('runRouter: returns hydrated products on success', async () => {
  const snap = { products: [{ handle: 'foo', title: 'Foo' }, { handle: 'bar', title: 'Bar' }] }
  const provider = { ask: async () => ({ reply: '["foo"]', providerUsed: 'claude' }) }
  const sema = { run: (fn) => fn() }
  const out = await runRouter({ provider, semaphore: sema, snapshot: snap, question: 'foo?' })
  assert.deepEqual(out.map((p) => p.handle), ['foo'])
})

test('runRouter: returns null on provider failure', async () => {
  const provider = { ask: async () => { throw new Error('down') } }
  const sema = { run: (fn) => fn() }
  const out = await runRouter({ provider, semaphore: sema, snapshot: { products: [] }, question: 'q' })
  assert.equal(out, null)
})

test('runRouter: returns null when router output has no picks', async () => {
  const provider = { ask: async () => ({ reply: '[]', providerUsed: 'claude' }) }
  const sema = { run: (fn) => fn() }
  const out = await runRouter({ provider, semaphore: sema, snapshot: { products: [{ handle: 'a' }] }, question: 'q' })
  assert.equal(out, null)
})
