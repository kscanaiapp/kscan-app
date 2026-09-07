'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scanForPrivacyViolations, assertPrivacySafe } = require('./privacyGuard');

test('PRIVACY: prohibited root key is rejected', () => {
  const { safe, violations } = scanForPrivacyViolations({ user_id: 'abc-123', fixtureId: 'x' });
  assert.equal(safe, false);
  assert.ok(violations.some((v) => v.reason.includes('user_id')));
});

test('PRIVACY: prohibited nested key is rejected', () => {
  const { safe, violations } = scanForPrivacyViolations({
    fixtureId: 'x',
    request: { headers: { auth_token: 'secret' } },
  });
  assert.equal(safe, false);
  assert.ok(violations.some((v) => v.path.includes('auth_token')));
});

test('PRIVACY: prohibited key inside an array element is rejected', () => {
  const { safe, violations } = scanForPrivacyViolations({
    fixtureId: 'x',
    items: [{ ok: true }, { device_id: 'abc' }],
  });
  assert.equal(safe, false);
  assert.ok(violations.some((v) => v.path.includes('[1].device_id')));
});

test('PRIVACY: a JWT-shaped string value is rejected even under an innocuous key name', () => {
  const { safe, violations } = scanForPrivacyViolations({
    fixtureId: 'x',
    someField: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_not_real_but_shaped_like_a_jwt',
  });
  assert.equal(safe, false);
  assert.ok(violations.some((v) => v.reason.includes('jwt_shaped_string')));
});

test('PRIVACY: a base64 image data URI is rejected (private media representation)', () => {
  const { safe, violations } = scanForPrivacyViolations({
    fixtureId: 'x',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
  });
  assert.equal(safe, false);
  assert.ok(violations.some((v) => v.reason.includes('data_uri_base64_media')));
});

test('PRIVACY: a precise GPS coordinate pair value is rejected', () => {
  const { safe, violations } = scanForPrivacyViolations({ fixtureId: 'x', location: '37.774900, -122.419400' });
  assert.equal(safe, false);
  assert.ok(violations.some((v) => v.reason.includes('precise_gps_pair')));
});

test('PRIVACY: an ordinary safe fixture-shaped object passes', () => {
  const { safe, violations } = scanForPrivacyViolations({
    fixtureId: 'synthetic-dress-00',
    corpusTier: 'SYNTHETIC',
    groundTruth: { source: 'synthetic_generator_construction', confidence: 'authoritative', category: 'dress' },
  });
  assert.equal(safe, true, JSON.stringify(violations));
});

test('PRIVACY: assertPrivacySafe throws (fails closed) rather than silently stripping', () => {
  assert.throws(() => assertPrivacySafe({ email: 'user@example.com' }, 'test'), /PRIVACY_GUARD_REJECTED/);
});
