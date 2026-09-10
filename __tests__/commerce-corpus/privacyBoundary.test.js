/**
 * Focused secret/PII boundary (spec section 43).
 *
 * The corpusValidator.test.js suite already proves the REAL corpus is clean.
 * This suite proves the privacy guard actually bites, using synthetic
 * hostile fixtures constructed in-memory (never written to disk), so the
 * refusal is demonstrated rather than assumed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { scanForPrivacyViolations, assertPrivacySafe } = require('../../tools/commerce-corpus/lib/privacyGuard');

const HOSTILE_CASES = [
  { name: 'access token key', fixture: { retailer: 'Example', accessToken: 'abc123' } },
  { name: 'JWT-shaped value under an innocuous key', fixture: { note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' } },
  { name: 'API-key-shaped value', fixture: { config: { storage_token: 'sk_live_abcdef1234567890' } } },
  { name: 'session identifier', fixture: { deviceId: 'device-abc-123' } },
  { name: 'email address', fixture: { email: 'shopper@example.com' } },
  { name: 'phone number', fixture: { phone_number: '+1-555-0100' } },
  { name: 'raw user id', fixture: { user_id: 'user_9f8e7d6c' } },
  { name: 'private/signed image URL field', fixture: { signedUrl: 'https://private.example.com/media/abc?sig=xyz' } },
  { name: 'credential-shaped query parameter key', fixture: { access_token: 'shhh' } },
  { name: 'bearer token value', fixture: { header: 'Bearer abcdefghijklmnop' } },
];

for (const { name, fixture } of HOSTILE_CASES) {
  test(`privacy guard REFUSES: ${name}`, () => {
    const result = scanForPrivacyViolations(fixture);
    assert.equal(result.safe, false, `expected a violation for: ${name}`);
    assert.ok(result.violations.length > 0);
    assert.throws(() => assertPrivacySafe(fixture, name), /PRIVACY_GUARD_REJECTED/);
  });
}

test('privacy guard does NOT silently strip - it fails closed with the input intact', () => {
  const fixture = { retailer: 'Example', email: 'shopper@example.com' };
  const before = JSON.stringify(fixture);
  try {
    assertPrivacySafe(fixture, 'silent-strip-check');
    assert.fail('expected assertPrivacySafe to throw');
  } catch (err) {
    assert.match(err.message, /PRIVACY_GUARD_REJECTED/);
  }
  assert.equal(JSON.stringify(fixture), before, 'the guard must never mutate the input it rejects');
});

test('KNOWN LIMITATION (documented, not silently passed over): the reused guard has no generic email/phone VALUE-shape pattern - only the exact key names above catch them; a real email address under an unrecognized key name is not caught by value alone', () => {
  const fixture = { contactInfo: 'shopper@example.com' };
  const result = scanForPrivacyViolations(fixture);
  assert.equal(
    result.safe,
    true,
    'if this now fails, the reused privacy guard gained a generic email value-pattern - update this test to match, do not just delete it',
  );
  // This is exactly why this corpus's own fixtures must only ever place
  // real-shaped values under recognized keys, and why manual review (not
  // just this guard) matters at PR time for anything unusual.
});

test('an ordinary, PII-free commerce fixture passes cleanly', () => {
  const fixture = { retailer: 'Nordstrom', price: 40, currency: 'USD', productUrl: 'https://www.nordstrom.com/s/example/1' };
  const result = scanForPrivacyViolations(fixture);
  assert.equal(result.safe, true);
  assert.deepEqual(result.violations, []);
});
