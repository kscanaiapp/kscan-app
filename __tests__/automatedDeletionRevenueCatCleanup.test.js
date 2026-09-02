// KPLUS-P2-001 — the automated purge worker
// (supabase/functions/process-account-deletions/index.ts) must retire the
// RevenueCat K+ mirror once an account's own resources are purged, so a
// purged Supabase UUID cannot keep a live k_plus grant in RevenueCat for up
// to six months after the account is gone. The K+ entitlement deep audit
// (PR #285) found and deliberately did not repair this: "the fix belongs in
// the purge sequence ... which open PR #270 is actively editing" (the same
// worker P2-01 above already edits for Apple revocation).
//
// This file cannot execute process-account-deletions/index.ts directly (a
// Deno Edge Function — Deno.serve, Deno.env, npm: specifiers — which Node
// cannot run), so it uses the same source-slicing + ordering pattern as
// __tests__/automatedDeletionAppleRevocation.test.js. The cleanup call's own
// LOGIC (idempotency, HTTP classification, actor binding) is proven
// behaviorally, by execution, in __tests__/revenueCatCleanupClient.test.js
// against the real revenueCatClient.ts module this file imports.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const WORKER = read('supabase', 'functions', 'process-account-deletions', 'index.ts');

function processClaimedRequestBody(source = WORKER) {
  const start = source.indexOf('async function processClaimedRequest(');
  const end = source.indexOf('\nDeno.serve(');
  assert.ok(start > 0 && end > start, 'could not locate processClaimedRequest in the worker source');
  return source.slice(start, end);
}

// ── Import wiring: the worker uses the shared client, not a reimplementation ──

test('KPLUS-P2-001: the worker imports the RevenueCat cleanup helpers from the shared client', () => {
  assert.match(
    WORKER,
    /import \{\s*isBlockingRevenueCatCleanupStatus,\s*retireMirroredEntitlement,?\s*\} from '\.\.\/_shared\/revenuecat\/revenueCatClient\.ts';/,
  );
});

test('KPLUS-P2-001: no RevenueCat secret key or raw HTTP call is duplicated directly in the worker', () => {
  for (const forbidden of ['REVENUECAT_SECRET_API_KEY', 'api.revenuecat.com', 'grant_entitlement']) {
    assert.ok(!WORKER.includes(forbidden), `${forbidden} must never appear in the worker file`);
  }
});

// ── Ordering: cleanup runs after K Scan's own resources are confirmed purged, before the ledger is marked purged ──

test('RC-DEL-001/RC-DEL-006: RevenueCat cleanup runs AFTER the Auth user delete and the residual-verification check, and BEFORE mark_deletion_request_purged', () => {
  const body = processClaimedRequestBody();
  const authDeleteIdx = body.indexOf('await supabase.auth.admin.deleteUser(userId)');
  const residualIdx = body.indexOf('post-purge verification found residual rows in');
  const rcCallIdx = body.indexOf('await retireMirroredEntitlement({ appUserId: userId })');
  const rcBlockIdx = body.indexOf('isBlockingRevenueCatCleanupStatus(revenueCatCleanup.status)');
  const markIdx = body.indexOf("await rpc('mark_deletion_request_purged'");

  assert.ok(authDeleteIdx > -1, 'the worker must still delete the Auth user');
  assert.ok(residualIdx > -1, 'the worker must still verify no residual rows remain');
  assert.ok(rcCallIdx > -1, 'the worker must call retireMirroredEntitlement');
  assert.ok(rcBlockIdx > -1, 'the worker must check isBlockingRevenueCatCleanupStatus');
  assert.ok(markIdx > -1, 'the worker must still mark the request purged');

  assert.ok(authDeleteIdx < residualIdx, 'residual verification runs after the Auth delete (unchanged, B3 fix)');
  assert.ok(residualIdx < rcCallIdx, 'RevenueCat cleanup runs only after K Scan resources are confirmed purged');
  assert.ok(rcCallIdx < rcBlockIdx, 'the blocking check reads the cleanup result AFTER requesting it');
  assert.ok(rcBlockIdx < markIdx, 'a blocking cleanup outcome must be checked BEFORE the request is marked purged');
});

test('RC-DEL-006: Apple revocation is unchanged and still runs, and still blocks, before the Auth user is deleted', () => {
  const body = processClaimedRequestBody();
  const appleCallIdx = body.indexOf('await requestAppleRevocation(supabase, userId)');
  const appleBlockIdx = body.indexOf('isBlockingAppleRevocationStatus(appleRevocation.status)');
  const authDeleteIdx = body.indexOf('await supabase.auth.admin.deleteUser(userId)');
  const rcCallIdx = body.indexOf('await retireMirroredEntitlement({ appUserId: userId })');

  assert.ok(appleCallIdx > -1 && appleBlockIdx > -1 && authDeleteIdx > -1);
  assert.ok(appleCallIdx < appleBlockIdx && appleBlockIdx < authDeleteIdx, 'Apple revocation still gates the Auth delete, unmoved');
  assert.ok(authDeleteIdx < rcCallIdx, 'RevenueCat cleanup never runs before Apple revocation has already gated the Auth delete');

  assert.match(
    body.slice(appleBlockIdx, appleBlockIdx + 200),
    /throw new Error\(`apple_revocation_blocked:\$\{appleRevocation\.status\}`\);/,
    'Apple revocation still throws to block on a bad status — RevenueCat cleanup does not replace, reorder, or weaken this gate',
  );
});

// ── RC-DEL-007: a blocking cleanup outcome throws into the existing retry/dead-letter path ──

test('RC-DEL-007: a blocking RevenueCat cleanup status throws — the same mechanism every other purge-step error uses', () => {
  const body = processClaimedRequestBody();
  const blockCheckIdx = body.indexOf('if (isBlockingRevenueCatCleanupStatus(revenueCatCleanup.status)) {');
  assert.ok(blockCheckIdx > -1);
  const throwSnippet = body.slice(blockCheckIdx, blockCheckIdx + 200);
  assert.match(throwSnippet, /throw new Error\(`revenuecat_cleanup_blocked:\$\{revenueCatCleanup\.status\}`\);/);
});

test('RC-DEL-007: the existing retry lifecycle wraps processClaimedRequest, so a thrown RevenueCat block reaches schedule_deletion_retry_or_fail', () => {
  const loopStart = WORKER.indexOf('for (const row of claimedRows) {');
  const loopEnd = WORKER.indexOf('// INT-KPLUS-010 -- scheduled orphan sweep. Runs on the LIVE path only');
  assert.ok(loopStart > 0 && loopEnd > loopStart);
  const loop = WORKER.slice(loopStart, loopEnd);
  const callIdx = loop.indexOf('await processClaimedRequest(supabase, row, workerId)');
  const catchIdx = loop.indexOf('} catch (err) {');
  const retryRpcIdx = loop.indexOf("await rpc('schedule_deletion_retry_or_fail'");
  assert.ok(callIdx > -1 && catchIdx > -1 && retryRpcIdx > -1);
  assert.ok(callIdx < catchIdx && catchIdx < retryRpcIdx, 'a throw from processClaimedRequest (RevenueCat block included) must be caught and routed to the retry RPC');
});

// ── RC-DEL-005: actor-bound — only the worker-resolved userId is ever passed, never a client-supplied value ──

test('RC-DEL-005: the cleanup call passes only the worker-resolved userId — no client body, header, or query value can name a different actor', () => {
  const body = processClaimedRequestBody();
  const calls = body.match(/retireMirroredEntitlement\(\{[^}]*\}\)/g) ?? [];
  assert.equal(calls.length, 1, 'exactly one call site');
  assert.match(calls[0], /^retireMirroredEntitlement\(\{ appUserId: userId \}\)$/);
  // userId itself is set once, from the claimed DB row, never from the
  // incoming request (this worker takes no per-user request body at all —
  // requireWorkerAuth only checks a shared secret, not an identity).
  assert.match(WORKER, /const userId = String\(request\.user_id\);/);
});

// ── RC-DEL-002 / RC-DEL-004: no K+ gating, exactly one call site, safe to re-run ──

test('RC-DEL-002: cleanup is unconditional — it is never gated on K+ status, so a non-K+ user purge runs the identical call', () => {
  const body = processClaimedRequestBody();
  const rcCallIdx = body.indexOf('await retireMirroredEntitlement({ appUserId: userId })');
  const precedingLines = body.slice(Math.max(0, rcCallIdx - 400), rcCallIdx);
  assert.ok(
    !/if\s*\([^)]*(kplus|k_plus|entitlement)/i.test(precedingLines),
    'no K+/entitlement conditional guards the cleanup call — it runs the same way for every purged account',
  );
});

test('RC-DEL-004: exactly one call site exists — no duplicate cleanup invocation that could double-mutate on retry', () => {
  const attempts = WORKER.match(/retireMirroredEntitlement\(\{ appUserId: userId \}\)/g) ?? [];
  assert.equal(attempts.length, 1, 'exactly one call to retireMirroredEntitlement in the worker');
});

// ── Observability: the status word is recorded, never a RevenueCat response body ──

test('the RevenueCat cleanup status word (not a customer id or response body) is recorded in the success log and return value', () => {
  const body = processClaimedRequestBody();
  assert.match(body, /revenueCatCleanup: revenueCatCleanup\.status/);
  const occurrences = body.match(/revenueCatCleanup: revenueCatCleanup\.status/g) ?? [];
  assert.equal(occurrences.length, 2, 'recorded once in the success log and once in the return value');
});

// ── No unrelated behavior changed ──

test('unrelated purge behavior is unchanged — direct rows, room transfer, storage, and terminal marking still run in order', () => {
  const body = processClaimedRequestBody();
  const directIdx = body.indexOf('const direct = await deleteDirectUserRows(supabase, userId);');
  const roomsIdx = body.indexOf('const rooms = await transferSharedRooms(supabase, userId);');
  const storageIdx = body.indexOf('const storage = await deleteOwnedStorage(supabase, userId);');
  const rcCallIdx = body.indexOf('await retireMirroredEntitlement({ appUserId: userId })');
  const markIdx = body.indexOf("await rpc('mark_deletion_request_purged'");
  assert.ok(directIdx > -1 && directIdx < roomsIdx && roomsIdx < storageIdx && storageIdx < rcCallIdx && rcCallIdx < markIdx);
});

// ── RC-DEL-008: mutation control — removing the cleanup call from the irreversible purge path must fail this suite's own guard ──

test('RC-DEL-008 (mutation control): stripping the RevenueCat cleanup call out of processClaimedRequest fails the ordering assertion above', () => {
  const mutated = WORKER.replace(
    /\n {2}const revenueCatCleanup = await retireMirroredEntitlement\(\{ appUserId: userId \}\);\n {2}if \(isBlockingRevenueCatCleanupStatus\(revenueCatCleanup\.status\)\) \{\n {4}throw new Error\(`revenuecat_cleanup_blocked:\$\{revenueCatCleanup\.status\}`\);\n {2}\}\n/,
    '\n',
  );
  assert.notEqual(mutated, WORKER, 'the mutation must actually remove source text, or this control proves nothing');

  const body = processClaimedRequestBody(mutated);
  const rcCallIdx = body.indexOf('await retireMirroredEntitlement({ appUserId: userId })');
  assert.equal(rcCallIdx, -1, 'the mutated source must no longer call retireMirroredEntitlement');

  assert.throws(() => {
    assert.ok(rcCallIdx > -1, 'the worker must call retireMirroredEntitlement');
  }, /the worker must call retireMirroredEntitlement/);
});
