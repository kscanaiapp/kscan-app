/**
 * Production deletion worker — Apple revocation integration.
 *
 * supabase/functions/process-account-deletions/index.ts is the function that
 * actually purges accounts in production. Its source lived only in the deployed
 * bundle for a period (deploy-only drift, recovered in b42a16e), which is why
 * the Apple revocation added to the in-repo operator pipeline did not reach it.
 *
 * The worker is Deno and reaches Supabase Auth, so its behaviour is exercised
 * by the Deno suite in supabase/functions/_shared/appleAuth/revocationGate.test.ts.
 * What this file pins is the part that no unit test can: that the call is
 * present, that it sits on the correct side of the irreversible auth delete,
 * and that a blocking answer cannot reach it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKER = 'supabase/functions/process-account-deletions/index.ts';

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** Source with comments removed, so prose describing a rule cannot satisfy it. */
function readCode(relativePath) {
  return readSource(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the production worker source is present in the repository', () => {
  // It was absent for a period — deployed but never committed. If it disappears
  // again, the Apple revocation wiring silently stops being reviewable.
  assert.ok(
    fs.existsSync(path.join(ROOT, WORKER)),
    'the deployed purge worker must be committed, not deploy-only',
  );
});

test('the worker calls the Apple revocation gate', () => {
  const code = readCode(WORKER);

  assert.match(
    code,
    /import \{[\s\S]*?requestAppleRevocation[\s\S]*?\} from '\.\.\/_shared\/appleAuth\/revocationGate\.ts'/,
  );
  assert.match(code, /await requestAppleRevocation\(\{/);
});

test('Apple revocation happens BEFORE the auth user is deleted', () => {
  // The load-bearing assertion of this whole task. apple_auth_credentials is
  // keyed by auth.users(id) ON DELETE CASCADE, so once deleteUser runs the
  // stored token is gone and revocation is permanently impossible.
  const code = readCode(WORKER);

  const revokeIndex = code.indexOf('requestAppleRevocation({');
  const deleteIndex = code.indexOf('auth.admin.deleteUser(');

  assert.ok(revokeIndex > -1, 'the worker must attempt Apple revocation');
  assert.ok(deleteIndex > -1, 'the worker must still delete the auth user');
  assert.ok(
    revokeIndex < deleteIndex,
    'revoking after the auth delete is impossible: the credential has already cascaded away',
  );
});

test('a blocking status throws before the auth delete is reached', () => {
  const code = readCode(WORKER);

  const guardIndex = code.indexOf('isBlockingRevocationStatus(appleRevocation.status)');
  const throwIndex = code.indexOf('throw new Error(`apple_revocation_blocked:');
  const deleteIndex = code.indexOf('auth.admin.deleteUser(');

  assert.ok(guardIndex > -1, 'the returned status must be evaluated');
  assert.ok(throwIndex > -1, 'a blocking status must abort the purge');
  assert.ok(guardIndex < deleteIndex && throwIndex < deleteIndex);
});

test('a blocking status also precedes the AUTH_DELETE_STARTED ledger entry', () => {
  // If Apple blocks, the auth delete genuinely never started. Writing that
  // transition anyway would misstate the lifecycle in the audit ledger.
  const code = readCode(WORKER);

  const revokeIndex = code.indexOf('requestAppleRevocation({');
  const ledgerIndex = code.indexOf("AUTH_DELETE_STARTED");

  assert.ok(revokeIndex > -1 && ledgerIndex > -1);
  assert.ok(revokeIndex < ledgerIndex);
});

test('blocking uses the existing retry path rather than a new one', () => {
  // Throwing inside processClaimedRequest is caught by the worker loop, which
  // calls schedule_deletion_retry_or_fail: retryable with backoff, dead-lettered
  // when attempts exhaust, and never marked purged. Reusing it means the retry
  // semantics of this release are unchanged.
  const code = readCode(WORKER);

  assert.match(code, /schedule_deletion_retry_or_fail/);
  assert.match(code, /mark_deletion_request_purged/);

  const throwIndex = code.indexOf('throw new Error(`apple_revocation_blocked:');
  const markPurgedIndex = code.indexOf('mark_deletion_request_purged');
  assert.ok(
    throwIndex < markPurgedIndex,
    'a blocked revocation must abort well before the request can be marked purged',
  );
});

test('the target user comes from the worker’s own deletion candidate', () => {
  const code = readCode(WORKER);

  // `userId` is derived from the claimed deletion_requests row at the top of
  // processClaimedRequest, never from the HTTP request body.
  assert.match(code, /const userId = String\(request\.user_id\)/);

  const call = code.slice(
    code.indexOf('await requestAppleRevocation({'),
    code.indexOf('await requestAppleRevocation({') + 320,
  );
  assert.match(call, /userId,/, 'the trusted candidate id must be what is sent');
  assert.ok(
    !/req\.json\(\)|body\.userId|body\?\.userId/.test(call),
    'no request-body value may choose whose Apple authorization is revoked',
  );
});

test('the worker implements no Apple logic of its own', () => {
  const code = readCode(WORKER);
  for (const forbidden of [
    'appleid.apple.com',
    'auth/revoke',
    'auth/token',
    'client_secret',
    'ES256',
    'AES-GCM',
    'APPLE_PRIVATE_KEY',
    'APPLE_TOKEN_ENCRYPTION_KEY',
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `apple-revoke-credential is the single revocation authority (found ${forbidden})`,
    );
  }
});

test('the revocation gate reimplements no Apple logic either', () => {
  // apple-revoke-credential is the single revocation authority. The gate is only
  // transport plus status interpretation; duplicating Apple crypto or endpoints
  // here would create a second place to get Apple wrong.
  const code = readCode('supabase/functions/_shared/appleAuth/revocationGate.ts');
  for (const forbidden of [
    'appleid.apple.com',
    'auth/revoke',
    'auth/token',
    'client_secret',
    'ES256',
    'AES-GCM',
    'crypto.subtle',
    'APPLE_PRIVATE_KEY',
  ]) {
    assert.ok(!code.includes(forbidden), `the gate must not reimplement Apple logic (found ${forbidden})`);
  }
});

test('the gate fails closed on every non-safe answer', () => {
  // The allowlist is what makes an unknown status block. If this ever became a
  // blocklist, a new status word from the Edge Function would silently permit an
  // auth delete without revocation.
  const code = readCode('supabase/functions/_shared/appleAuth/revocationGate.ts');
  assert.match(
    code,
    /export function isBlockingRevocationStatus\(status: string\): boolean \{\s*return !isCompleteStatus\(status\);/,
    'blocking must be defined as "not explicitly safe", not as a list of known failures',
  );
});

test('nothing added to the worker logs a secret or an Apple response body', () => {
  const code = readCode(WORKER);
  const appleLogs = (code.match(/logEvent\('apple_[^;]*?\);/gs) ?? []);
  assert.ok(appleLogs.length >= 2, 'the revocation outcome should be observable in logs');

  for (const line of appleLogs) {
    assert.ok(
      !/serviceRoleKey|SERVICE_ROLE|refreshToken|refresh_token|encrypted|envelope|\bbody\b/.test(line),
      `an Apple log line carries something it must not: ${line.slice(0, 120)}`,
    );
    // uid is passed through shortUserId, matching every other log in this file.
    if (line.includes('uid:')) assert.match(line, /uid: shortUserId\(userId\)/);
  }
});

test('the non-Apple deletion sequence is otherwise unchanged', () => {
  // Everything the worker did before must still be there and in the same order.
  // This task adds a step; it does not restructure the purge.
  const code = readCode(WORKER);

  const order = [
    'revokeAllSessions(userId, null)',
    'deleteDirectUserRows(supabase, userId)',
    'transferSharedRooms(supabase, userId)',
    'deleteOwnedStorage(supabase, userId)',
    'requestAppleRevocation({',
    'AUTH_DELETE_STARTED',
    'auth.admin.deleteUser(',
    'mark_deletion_request_purged',
  ];

  let cursor = -1;
  for (const marker of order) {
    const index = code.indexOf(marker, cursor + 1);
    assert.ok(index > -1, `the worker must still perform: ${marker}`);
    assert.ok(index > cursor, `${marker} is out of order in the purge sequence`);
    cursor = index;
  }
});

test('the recovered worker still matches the deployed lease and heartbeat model', () => {
  // Guards against an accidental rewrite of the recovered source: these are the
  // concurrency primitives production depends on.
  const code = readCode(WORKER);
  assert.match(code, /heartbeat\(requestId, workerId\)/);
  assert.match(code, /lost_lease/);
  assert.match(code, /requireWorkerAuth\(req\)/);
});
