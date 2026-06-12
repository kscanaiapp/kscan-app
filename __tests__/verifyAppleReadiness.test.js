const assert = require('node:assert/strict');
const test = require('node:test');

const { hasReviewInfo, verify } = require('../scripts/verify-apple-readiness');

test('Apple readiness verifier has no local configuration failures', () => {
  const result = verify();
  const failures = result.checks.filter((item) => !item.ok);

  assert.deepEqual(failures, []);
});

test('Apple readiness verifier reports known external gates as warnings', () => {
  const result = verify();
  const labels = result.warnings.map((item) => item.label);

  assert.ok(labels.includes('App Store Connect app ID is not configured in eas.json'));
  assert.ok(labels.includes('App Review contact and demo account are not encoded in store.config.json'));
  assert.ok(labels.includes('EAS iOS credentials still require interactive Apple Developer validation'));
});

test('hasReviewInfo requires contact, demo account, and notes', () => {
  assert.equal(hasReviewInfo({ apple: {} }), false);
  assert.equal(
    hasReviewInfo({
      apple: {
        review: {
          firstName: 'K',
          lastName: 'Scan',
          phoneNumber: '+15555550123',
          emailAddress: 'review@example.com',
          demoUsername: 'reviewer@example.com',
          demoPassword: 'not-a-real-password',
          notes: 'Review notes',
        },
      },
    }),
    true,
  );
});
