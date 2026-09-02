// P2-01 (Build 35 Patch 2) — the AUTOMATED purge worker
// (supabase/functions/process-account-deletions/index.ts) must revoke Sign
// in with Apple before deleting the Auth user, exactly like the manual
// executor already does (see __tests__/manualDeletionAppleRevocation.test.js
// and __tests__/appleRevocationParity.test.js for the shared contract and its
// behavioral proof).
//
// This file cannot execute process-account-deletions/index.ts directly: it
// is a Deno Edge Function (Deno.serve, Deno.env, npm: specifiers), which
// Node cannot run. The established pattern for proving behavior inside this
// exact file without executing it is source-slicing plus ordering/pattern
// assertions -- see __tests__/orphanedOwnerMediaSweep.test.js, which proves
// the orphan sweep's fail-closed reference check the same way. The actual
// Apple-revocation LOGIC (not just its call site) is proven behaviorally, by
// execution, in __tests__/appleRevocationParity.test.js against the real
// appleRevocation.ts module this file imports.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const WORKER = read('supabase', 'functions', 'process-account-deletions', 'index.ts');

function processClaimedRequestBody() {
  const start = WORKER.indexOf('async function processClaimedRequest(');
  const end = WORKER.indexOf('\nDeno.serve(');
  assert.ok(start > 0 && end > start, 'could not locate processClaimedRequest in the worker source');
  return WORKER.slice(start, end);
}

// ── Import wiring: the worker uses the shared mirror, not a reimplementation ──

test('P2-01: the worker imports the shared Apple revocation mirror', () => {
  assert.match(
    WORKER,
    /import \{\s*isBlockingAppleRevocationStatus,\s*requestAppleRevocation,?\s*\} from '\.\.\/_shared\/deletion\/appleRevocation\.ts';/,
  );
});

test('P2-01: no JWT/.p8/client-secret logic is duplicated directly in the worker', () => {
  for (const forbidden of [
    'APPLE_PRIVATE_KEY',
    'APPLE_KEY_ID',
    'APPLE_TEAM_ID',
    'APPLE_TOKEN_ENCRYPTION_KEY',
    'client_secret',
    'appleid.apple.com',
  ]) {
    assert.ok(!WORKER.includes(forbidden), `${forbidden} must never appear in the worker file`);
  }
});

// ── Ordering: revocation before Auth delete, and the rest of the required sequence ──

test('P2-01: Apple revocation is requested, and its blocking check runs, before auth.admin.deleteUser', () => {
  const body = processClaimedRequestBody();
  const revokeCallIdx = body.indexOf('await requestAppleRevocation(supabase, userId)');
  const blockCheckIdx = body.indexOf('isBlockingAppleRevocationStatus(appleRevocation.status)');
  const authDeleteIdx = body.indexOf('await supabase.auth.admin.deleteUser(userId)');

  assert.ok(revokeCallIdx > -1, 'the worker must call requestAppleRevocation');
  assert.ok(blockCheckIdx > -1, 'the worker must check isBlockingAppleRevocationStatus');
  assert.ok(authDeleteIdx > -1, 'the worker must still delete the Auth user');

  assert.ok(revokeCallIdx < blockCheckIdx, 'the blocking check must read the revocation result AFTER requesting it');
  assert.ok(blockCheckIdx < authDeleteIdx, 'the blocking check must run BEFORE the Auth user is deleted');
});

test('P2-01: a blocking revocation status throws — the same mechanism every other purge-step error uses', () => {
  const body = processClaimedRequestBody();
  const blockCheckIdx = body.indexOf('if (isBlockingAppleRevocationStatus(appleRevocation.status)) {');
  assert.ok(blockCheckIdx > -1);
  const throwSnippet = body.slice(blockCheckIdx, blockCheckIdx + 200);
  assert.match(throwSnippet, /throw new Error\(`apple_revocation_blocked:\$\{appleRevocation\.status\}`\);/);
});

test('P2-01: revocation runs AFTER direct-row deletion, room transfer, and storage cleanup — cleanup order was not disturbed', () => {
  const body = processClaimedRequestBody();
  const directIdx = body.indexOf('const direct = await deleteDirectUserRows(supabase, userId);');
  const roomsIdx = body.indexOf('const rooms = await transferSharedRooms(supabase, userId);');
  const storageIdx = body.indexOf('const storage = await deleteOwnedStorage(supabase, userId);');
  const revokeIdx = body.indexOf('await requestAppleRevocation(supabase, userId)');

  assert.ok(directIdx > -1 && roomsIdx > -1 && storageIdx > -1, 'cleanup steps must still run');
  assert.ok(directIdx < revokeIdx, 'direct row deletion precedes revocation');
  assert.ok(roomsIdx < revokeIdx, 'room transfer precedes revocation');
  assert.ok(storageIdx < revokeIdx, 'storage cleanup precedes revocation');
});

test('P2-01: revocation runs BEFORE the AUTH_DELETE_STARTED ledger transition, so nothing is half-written on a block', () => {
  const body = processClaimedRequestBody();
  const revokeIdx = body.indexOf('await requestAppleRevocation(supabase, userId)');
  const ledgerIdx = body.indexOf("p_reason_code: 'AUTH_DELETE_STARTED'");
  assert.ok(revokeIdx > -1 && ledgerIdx > -1);
  assert.ok(revokeIdx < ledgerIdx, 'a blocking revocation must throw before the ledger transition is written');
});

test('P2-01: exactly one revocation call site exists — no second Apple implementation', () => {
  const attempts = WORKER.match(/requestAppleRevocation\(supabase, userId\)/g) ?? [];
  assert.equal(attempts.length, 1, 'exactly one call to requestAppleRevocation in the worker');
  const otherAppleInvokes = WORKER.match(/functions\.invoke\('apple-revoke-credential'/g) ?? [];
  assert.equal(otherAppleInvokes.length, 0, 'the worker must not invoke apple-revoke-credential directly — only through the shared mirror');
});

// ── Retry integration: a thrown block reaches the existing durable retry path ──

test('P2-01: the retry lifecycle already wraps processClaimedRequest — a thrown blocking error reaches schedule_deletion_retry_or_fail', () => {
  const loopStart = WORKER.indexOf('for (const row of claimedRows) {');
  const loopEnd = WORKER.indexOf('// INT-KPLUS-010 -- scheduled orphan sweep. Runs on the LIVE path only');
  assert.ok(loopStart > 0 && loopEnd > loopStart);
  const loop = WORKER.slice(loopStart, loopEnd);
  const callIdx = loop.indexOf('await processClaimedRequest(supabase, row, workerId)');
  const catchIdx = loop.indexOf('} catch (err) {');
  const retryRpcIdx = loop.indexOf("await rpc('schedule_deletion_retry_or_fail'");
  assert.ok(callIdx > -1 && catchIdx > -1 && retryRpcIdx > -1);
  assert.ok(callIdx < catchIdx && catchIdx < retryRpcIdx, 'a throw from processClaimedRequest must be caught and routed to the retry RPC');
});

// ── Observability: the status word is recorded, never a token/code/response ──

test('P2-01: the Apple revocation status word (not a token or response body) is recorded in the purge ledger and success log', () => {
  const body = processClaimedRequestBody();
  assert.match(body, /appleAuthorizationRevocation: appleRevocation\.status/);
  // The status is a short enum word from a small known set — never a raw
  // Apple response, refresh token, or authorization code.
  assert.doesNotMatch(body, /appleRevocation\.detail/, 'the transport-only detail field must never be logged');
});

// ── No unrelated behavior changed: everything the task requires preserved ──

test('P2-01: unrelated purge behavior is unchanged — grace period, sessions, room transfer, storage, verification, terminal status', () => {
  const body = processClaimedRequestBody();
  // 30-day grace / restoration guard, unchanged.
  assert.match(body, /if \(request\.grace_period_ends_at && new Date\(String\(request\.grace_period_ends_at\)\) > new Date\(\)\) \{/);
  assert.match(body, /status: 'skipped_grace'/);
  // Session revocation still happens both at claim time and again right before Auth delete.
  const sessionRevokes = body.match(/await revokeAllSessions\(userId, null\);/g) ?? [];
  assert.equal(sessionRevokes.length, 2, 'sessions are still revoked at claim time and again before Auth delete');
  // Shared-room ownership transfer untouched.
  assert.match(body, /const rooms = await transferSharedRooms\(supabase, userId\);/);
  // Storage deletion untouched.
  assert.match(body, /const storage = await deleteOwnedStorage\(supabase, userId\);/);
  // Post-auth-delete residual verification untouched (still runs AFTER auth delete).
  const authDeleteIdx = body.indexOf('await supabase.auth.admin.deleteUser(userId)');
  const residualIdx = body.indexOf('post-purge verification found residual rows in');
  assert.ok(authDeleteIdx > -1 && residualIdx > -1 && authDeleteIdx < residualIdx);
  // Terminal status marking untouched.
  assert.match(body, /await rpc\('mark_deletion_request_purged', \{/);
});
