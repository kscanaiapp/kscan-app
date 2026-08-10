// Regression test for CodeQL js/polynomial-redos alerts #7/#8: the EMAIL
// regex in services/transactionalEmail.js has ambiguous adjacent [^\s@]+
// groups around a literal '.', so it must never run against unbounded,
// attacker-controlled input. The length gate has to short-circuit BEFORE
// EMAIL.test() — reordering the `||` operands alone is not enough because
// `.test()` is the left operand and always evaluates first.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateWaitlistWelcomeRequest,
  validateAccountDeletionRestorationRequest,
} = require('../services/transactionalEmail');

const VALID_WAITLIST_BODY = {
  eventType: 'waitlist_welcome',
  idempotencyKey: 'waitlist:11111111-1111-4111-8111-111111111111',
  recipientEmail: 'person@example.com',
};

function adversarialEmail(n) {
  // One '@' (so the required literal is found immediately), then N repeats
  // of "a." (so the [^\s@]+ before AND after the literal '.' both match
  // '.', making every dot a candidate split point), ending in a space so
  // the final [^\s@]+ can never reach '$' and the match is forced to
  // exhaust every split before failing. Empirically ~23s at n=40,000
  // against the raw regex with no length gate (measured on this machine).
  return `a@${'a.'.repeat(n)} `;
}

test('waitlist validator accepts a normal email', () => {
  const result = validateWaitlistWelcomeRequest(VALID_WAITLIST_BODY);
  assert.equal(result.ok, true);
});

test('waitlist validator rejects an oversized recipientEmail in bounded time', () => {
  const start = Date.now();
  const result = validateWaitlistWelcomeRequest({
    ...VALID_WAITLIST_BODY,
    recipientEmail: adversarialEmail(20_000),
  });
  const elapsedMs = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECIPIENT');
  assert.ok(elapsedMs < 250, `expected the length gate to short-circuit before regex evaluation, took ${elapsedMs}ms`);
});

test('account-deletion-restoration validator rejects an oversized recipientEmail in bounded time', () => {
  const start = Date.now();
  const result = validateAccountDeletionRestorationRequest({
    kind: 'restored',
    eventType: 'account_deletion_restoration',
    idempotencyKey: 'deletion-restored:22222222-2222-4222-8222-222222222222',
    recipientEmail: adversarialEmail(20_000),
    requestedAt: '2026-08-10T00:00:00.000Z',
    gracePeriodEndsAt: '2026-08-24T00:00:00.000Z',
  });
  const elapsedMs = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECIPIENT');
  assert.ok(elapsedMs < 250, `expected the length gate to short-circuit before regex evaluation, took ${elapsedMs}ms`);
});
