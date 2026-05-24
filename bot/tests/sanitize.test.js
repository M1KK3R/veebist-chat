import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeReply, __test_luhn } from '../lib/sanitize.js'

test('luhn check accepts the canonical Visa test number', () => {
  assert.equal(__test_luhn('4242424242424242'), true)
  assert.equal(__test_luhn('4000000000000002'), true)
})

test('luhn check rejects a non-Luhn 16-digit number', () => {
  assert.equal(__test_luhn('1234567890123456'), false)
})

test('strips a Luhn-valid card number', () => {
  const { reply, removed } = sanitizeReply('You mean 4242 4242 4242 4242?', {})
  assert.equal(reply.includes('4242'), false)
  assert.ok(removed.includes('credit_card'))
})

test('passes through long non-Luhn order numbers (avoids false strip)', () => {
  const { reply, removed } = sanitizeReply('Order #1234567890123 is shipped.', {})
  assert.ok(reply.includes('1234567890123'))
  assert.equal(removed.includes('credit_card'), false)
})

test('strips IBAN', () => {
  const { reply, removed } = sanitizeReply('Please pay to EE547700771004456439.', {})
  assert.equal(reply.includes('EE547700771004456439'), false)
  assert.ok(removed.includes('iban'))
})

test('strips JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const { reply, removed } = sanitizeReply(`Token: ${jwt}`, {})
  assert.equal(reply.includes('eyJ'), false)
  assert.ok(removed.includes('jwt'))
})

test('strips Bearer-style long tokens', () => {
  const { reply, removed } = sanitizeReply('Use Bearer abcdefghij1234567890ABCDEFGH for this', {})
  assert.equal(reply.includes('abcdefghij1234567890ABCDEFGH'), false)
  assert.ok(removed.includes('bearer_token'))
})

test('keeps allowlisted email, strips foreign one', () => {
  const { reply, removed } = sanitizeReply('Write to info@scottest.ee or to attacker@evil.com', {
    allowlist: { email: 'info@scottest.ee' },
  })
  assert.ok(reply.includes('info@scottest.ee'))
  assert.equal(reply.includes('attacker@evil.com'), false)
  assert.ok(removed.includes('foreign_email'))
})

test('keeps allowlisted phone, strips foreign intl phone', () => {
  const { reply, removed } = sanitizeReply('Call +372 5555 1234 or +1 (555) 999-0000', {
    allowlist: { phone: '+37255551234' },
  })
  assert.ok(reply.includes('+372 5555 1234'))
  assert.equal(reply.includes('+1'), false)
  assert.ok(removed.includes('foreign_phone'))
})

test('snapshot contactInfo extends the allowlist', () => {
  const { reply } = sanitizeReply('Email tarmo@veebist.ee for help.', {
    snapshot: { contactInfo: { email: 'tarmo@veebist.ee' } },
  })
  assert.ok(reply.includes('tarmo@veebist.ee'))
})

test('handles empty reply gracefully', () => {
  assert.deepEqual(sanitizeReply('', {}), { reply: '', removed: [] })
  assert.deepEqual(sanitizeReply(null, {}), { reply: '', removed: [] })
})

test('multiple types stripped in one pass', () => {
  const { removed } = sanitizeReply('Card 4242424242424242, IBAN EE547700771004456439, evil@x.com', {})
  assert.ok(removed.includes('credit_card'))
  assert.ok(removed.includes('iban'))
  assert.ok(removed.includes('foreign_email'))
})
