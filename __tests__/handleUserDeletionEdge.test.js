/**
 * Static wiring gate for the account-deletion intake Edge Function.
 *
 * Behaviour is proven in `supabase/functions/handle-user-deletion/handler.test.ts`,
 * which drives the real request path under Deno. THIS file guards the things a
 * behavioural test cannot see: that the shared, audited primitives are the ones
 * actually wired in, and that a future edit does not quietly reintroduce a
 * hand-rolled auth check, a raw token log, or a body-supplied user id.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FUNCTION_DIR = path.join(__dirname, '..', 'supabase', 'functions', 'handle-user-deletion');

const entry = fs.readFileSync(path.join(FUNCTION_DIR, 'index.ts'), 'utf8');
const source = fs.readFileSync(path.join(FUNCTION_DIR, 'handler.ts'), 'utf8');
const shared = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'deletion', 'common.ts'),
  'utf8',
);

test('the entry point only serves the handler, so the module is importable by tests', () => {
  assert.match(entry, /Deno\.serve\(createHandler\(\)\)/);
  assert.doesNotMatch(entry, /deletion_requests/, 'no request logic lives in the entry point');
});

test('handle-user-deletion verifies the caller JWT through the shared requireUser', () => {
  assert.match(source, /requireUser as requireUserImpl/);
  assert.match(source, /deps\.requireUser\(req\)/);
  // The audited implementation it delegates to.
  assert.match(shared, /startsWith\('bearer '\)/i);
  assert.match(shared, /auth\.getUser\(accessToken\)/);
});

test('the shared auth path validates the extracted user id as a UUID', () => {
  assert.match(shared, /isValidUuid\(user\.id\)/);
  assert.match(shared, /UUID_REGEX/);
});

test('handle-user-deletion does not accept a user id from the request body', () => {
  assert.doesNotMatch(source, /req\.json\(/);
  assert.doesNotMatch(source, /body\??\.[A-Za-z_]*user/i);
});

test('handle-user-deletion keeps CORS OPTIONS support', () => {
  assert.match(source, /req\.method === 'OPTIONS'/);
  assert.match(shared, /'Access-Control-Allow-Methods':\s*'POST, OPTIONS, GET'/);
});

test('handle-user-deletion returns safe errors and avoids raw REST detail logs', () => {
  assert.match(source, /Unable to process deletion request/);
  assert.doesNotMatch(source, /console\.error\([^;]*detail/s);
  // Structured logging only: no direct console use that could bypass redaction.
  assert.doesNotMatch(source, /console\.(log|warn|error)\(/);
});

test('the active-lifecycle guard matches the partial unique index exactly', () => {
  // If these drift apart, intake either creates a duplicate (index narrower) or
  // refuses a legitimate new request (index wider).
  const indexStatuses = ['pending', 'processing', 'deactivated', 'purging', 'legal_hold'];
  const declared = source
    .slice(source.indexOf('const ACTIVE_LIFECYCLE_STATUSES'))
    .slice(0, source.slice(source.indexOf('const ACTIVE_LIFECYCLE_STATUSES')).indexOf(']'));
  for (const status of indexStatuses) {
    assert.match(declared, new RegExp(`'${status}'`), `${status} must count as an active lifecycle`);
  }
});

test('handle-user-deletion reserves the privacy rate limit only after the already-active short-circuit', () => {
  const alreadyIdx = source.indexOf('alreadyRequestedResponse(existing)');
  const rateIdx = source.indexOf("deps.reserveRateLimit(user.id, 'account_deletion')");
  assert.ok(alreadyIdx !== -1, 'the short-circuit must exist');
  assert.ok(rateIdx !== -1, 'the reservation must exist');
  assert.ok(alreadyIdx < rateIdx, 'observing an existing lifecycle must never be rate-limited away');
  assert.match(source, /rateLimitedResponse/);
});

test('the raw restoration token is never persisted, returned, or logged', () => {
  // Only the hash may be written.
  assert.match(source, /restoration_token_hash: params\.tokenHash/);
  assert.doesNotMatch(source, /restoration_token:\s*rawToken/);
  assert.doesNotMatch(source, /token:\s*rawToken/);

  // The raw token may appear in exactly one place: the emailed URL.
  const rawTokenUses = source.match(/rawToken/g) ?? [];
  assert.equal(rawTokenUses.length, 3, 'rawToken is generated, hashed, and put in the link only');
  assert.match(source, /buildRestorationUrl\(rawToken\)/);

  // And never in a log field.
  assert.doesNotMatch(source, /logEvent\([^)]*rawToken/s);
});

test('the token hash is written in the same INSERT that creates the row', () => {
  const insertIdx = source.indexOf('restoration_token_hash: params.tokenHash');
  const emailIdx = source.indexOf('deps.sendRestorationEmail(');
  assert.ok(insertIdx !== -1 && emailIdx !== -1);
  assert.ok(insertIdx < emailIdx, 'hash persistence precedes the email attempt');
  assert.match(
    source,
    /restoration_token_expires_at: params\.gracePeriodEndsAt/,
    'token expiry must sit inside the grace window (DB CHECK constraint)',
  );
});

test('the accepted lifecycle is never rolled back because mail failed', () => {
  assert.doesNotMatch(source, /method: 'DELETE'/, 'no compensating delete exists');
  assert.match(source, /restorationEmailQueued\b/);
  assert.match(source, /status: 'deactivated'/);
});

test('the request grace window is the advertised 30 days', () => {
  assert.match(source, /const GRACE_PERIOD_DAYS = 30;/);
  assert.match(source, /addDaysIso\(now, GRACE_PERIOD_DAYS\)/);
});
