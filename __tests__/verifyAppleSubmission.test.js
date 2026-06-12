const assert = require('node:assert/strict');
const test = require('node:test');

const { STEPS } = require('../scripts/verify-apple-submission');

test('Apple submission verifier runs the expected local release gates', () => {
  const rendered = STEPS.map(([command, args]) => [command, ...args].join(' '));

  assert.deepEqual(rendered, [
    'npm run test:privacy',
    'npm run test:auth-privacy',
    'npm run test:verify-supabase',
    'npm run test:analyze-contract',
    'node --test __tests__/routingGuard.test.js __tests__/processDeletionRequest.test.js __tests__/verifyAppleReadiness.test.js',
    'npm run verify:apple-readiness',
    'npx --yes eas-cli@latest metadata:lint',
  ]);
});
