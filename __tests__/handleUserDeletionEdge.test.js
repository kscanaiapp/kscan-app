/**
 * handle-user-deletion request-intake guarantees.
 *
 * The intake endpoint no longer re-implements authentication inline: it
 * delegates to the shared deletion guard (_shared/deletion/common.ts), the same
 * helper every other deletion endpoint uses. These tests therefore assert each
 * guarantee where it actually lives, so the shared helper cannot be weakened
 * without failing here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'handle-user-deletion', 'index.ts'),
  'utf8',
);
const shared = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion', 'common.ts'),
  'utf8',
);

test('the caller identity comes from the shared server-side guard', () => {
  assert.match(source, /requireUser\(req\)/, 'intake must use the shared guard');
  assert.doesNotMatch(
    source,
    /auth\.getUser\(/,
    'intake must not re-implement token verification inline',
  );
});

test('the shared guard verifies a bearer JWT with auth.getUser', () => {
  assert.match(shared, /startsWith\('bearer '\)/i);
  assert.match(shared, /auth\.getUser\(accessToken\)/);
  assert.match(
    shared,
    /if \(error \|\| !user\?\.id \|\| !isValidUuid\(user\.id\)\)/,
    'a failed lookup or malformed subject must be rejected',
  );
});

test('the shared guard validates the extracted user id as a UUID', () => {
  assert.match(shared, /UUID_REGEX/);
  assert.match(shared, /export function isValidUuid/);
});

test('the deleting actor is never taken from the request body', () => {
  assert.doesNotMatch(source, /req\.json\(/);
  assert.doesNotMatch(source, /body\??\.[A-Za-z_]*user/i);
});

test('CORS preflight is supported through the shared header set', () => {
  assert.match(source, /req\.method === 'OPTIONS'/);
  assert.match(source, /corsHeaders/);
  assert.match(shared, /'Access-Control-Allow-Methods':\s*'POST, OPTIONS, GET'/);
});

test('errors stay generic and raw REST detail is not logged', () => {
  assert.match(source, /Unable to process deletion request/);
  assert.doesNotMatch(source, /console\.error\([^;]*detail/s);
});

test('duplicate requests are guarded across every active lifecycle status', () => {
  // Stronger than the original pending/processing pair: an account already
  // deactivated, purging, or on legal hold must not open a second request.
  for (const status of ['pending', 'processing', 'deactivated', 'purging', 'legal_hold']) {
    assert.match(
      source,
      new RegExp(`const ACTIVE_STATUSES = \\[[^\\]]*'${status}'`),
      `${status} must count as an active request`,
    );
  }
  assert.match(source, /status=in\.\(\$\{ACTIVE_STATUSES\.join\(','\)\}\)/);
});

test('an existing legacy pending row is upgraded, not duplicated', () => {
  assert.match(source, /existing\.status === 'pending' \|\| existing\.status === 'processing'/);
  assert.match(source, /status: 'deactivated'/);
});

test('handle-user-deletion reserves privacy rate limit only after alreadyRequested short-circuit', () => {
  const alreadyIdx = source.indexOf('alreadyRequested: true');
  const rateIdx = source.indexOf("reservePrivacyRequestRateLimit(user.id, 'account_deletion')");
  assert.ok(alreadyIdx !== -1, 'must preserve alreadyRequested short-circuit');
  assert.ok(rateIdx !== -1, 'must reserve account_deletion rate limit');
  assert.ok(alreadyIdx < rateIdx, 'existing-request check must precede rate-limit reservation');
  assert.match(source, /rateLimitedResponse/);
});
