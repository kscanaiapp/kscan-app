// K+ activation / reconciliation Edge Function contract tests.
//
// These are static source-contract checks (the same style as
// styleOutfitEdgeContract.test.js) -- no Deno runtime required. They assert
// the security invariants a hostile-client review would check first: the
// activation endpoint derives identity only from the verified JWT, never
// trusts any client-supplied field, always calls the SECURITY DEFINER RPC
// (never writes user_entitlements directly), and never lets a RevenueCat
// failure block or roll back the local grant. The reconciliation endpoint
// requires a server-side secret and is never reachable by a user JWT alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ACTIVATE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'kplus-activate', 'index.ts'),
  'utf8',
);
const RECONCILE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'kplus-reconcile-revenuecat', 'index.ts'),
  'utf8',
);
const REVENUECAT_CLIENT_SOURCE = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', '_shared', 'revenuecat', 'revenueCatClient.ts'),
  'utf8',
);

test('kplus-activate derives identity only from the verified JWT', () => {
  assert.match(ACTIVATE_SOURCE, /requireUser\(req\)/);
  assert.doesNotMatch(ACTIVATE_SOURCE, /body\.(userId|user_id)/);
  assert.doesNotMatch(ACTIVATE_SOURCE, /req\.json\(\)/, 'must never parse a client body for identity/grant fields');
});

test('kplus-activate never writes user_entitlements directly -- only via the RPC', () => {
  assert.doesNotMatch(ACTIVATE_SOURCE, /from\(['"]user_entitlements['"]\)/);
  assert.match(ACTIVATE_SOURCE, /rpc\(['"]grant_kplus_early_access['"]/);
  assert.match(ACTIVATE_SOURCE, /p_user_id:\s*authUser\.id/);
});

test('kplus-activate never accepts client-supplied grant fields as RPC input', () => {
  // The only RPC parameter ever sent is the server-derived user id -- no
  // expires_at/grant_reason/tier/campaign_key field of any casing appears.
  const rpcCallMatch = ACTIVATE_SOURCE.match(/rpc\('grant_kplus_early_access',\s*\{([^}]*)\}\)/);
  assert.ok(rpcCallMatch, 'grant_kplus_early_access RPC call not found');
  assert.equal(rpcCallMatch[1].trim(), 'p_user_id: authUser.id');
});

test('kplus-activate treats RevenueCat sync as best-effort and never blocks the response on it', () => {
  assert.match(ACTIVATE_SOURCE, /syncPromotionalEntitlement/);
  // The success response is built and returned regardless of sync outcome --
  // there is no throw/return-error path keyed off the RevenueCat call result.
  const afterSync = ACTIVATE_SOURCE.slice(ACTIVATE_SOURCE.indexOf('syncPromotionalEntitlement'));
  assert.match(afterSync, /return json\(\{/);
  assert.doesNotMatch(afterSync, /return json\(\{ error:.*outcome/);

  // CERT-MUT-M5. The line above only rejected an error return that MENTIONS
  // `outcome` on the same line, so the one-line rollback a regression would
  // actually take --
  //
  //     if (!outcome.ok) {
  //       return json({ error: 'Activation failed. Please try again.' }, 502);
  //     }
  //
  // -- sailed straight through it, and this invariant (section 27: a
  // RevenueCat failure must NEVER roll back or block a valid complimentary
  // grant) had no test that could detect its violation. Count instead: once
  // the mirror has been attempted there is exactly ONE remaining `return`, and
  // it is the success payload. Any added early exit -- whatever it says --
  // makes this fail.
  // Slice from the CALL, not the import at the top of the file -- otherwise
  // every ordinary pre-flight guard counts as a post-mirror return.
  const callIdx = ACTIVATE_SOURCE.indexOf('await syncPromotionalEntitlement(');
  assert.ok(callIdx > 0, 'the mirror must actually be called, not merely imported');
  const afterCall = ACTIVATE_SOURCE.slice(callIdx);
  const returnsAfterCall = afterCall.match(/return json\(/g) ?? [];
  assert.equal(
    returnsAfterCall.length,
    1,
    'exactly one return may follow the mirror attempt: the success payload',
  );
  assert.doesNotMatch(
    afterCall,
    /if\s*\(\s*!\s*outcome[.\s]/,
    'nothing after the mirror attempt may branch on whether the mirror succeeded',
  );
  assert.match(
    afterCall,
    /return json\(\{[\s\S]{0,40}entitlementKey/,
    'the single remaining return is the entitlement payload, not an error',
  );
});

test('SEC-KPLUS-008: the RevenueCat mirror is gated on the ROW-SCOPED authority, not on an expiry', () => {
  // grant_kplus_early_access does not return revoked_at, so "expires_at is in
  // the future" is NOT the same question as "is this row live". A revoked
  // grant with a future expiry was mirrored into RevenueCat as a live
  // promotional entitlement -- confirmed on staging, where a revoked synthetic
  // actor's row read external_sync_status = 'synced' after revocation.
  //
  // K+ entitlement authority (Phase 1): this assertion previously required
  // rpc('kplus_has_active_entitlement'). That predicate now answers for the
  // USER across every grant, so a revoked Early Access row plus an active
  // store subscription reads true and would be mirrored. The mirror describes
  // one row, so it must ask about that row.
  assert.match(
    ACTIVATE_SOURCE,
    /rpc\('kplus_user_entitlement_row_is_active'/,
    'the activation function must ask whether THIS row is live before mirroring it',
  );
  assert.doesNotMatch(
    ACTIVATE_SOURCE,
    /rpc\('kplus_has_active_entitlement'/,
    'the user-level predicate is true whenever ANY grant is live, so it must never gate the row mirror',
  );
  // The mirror is entered only when that answer is true.
  assert.match(
    ACTIVATE_SOURCE,
    /if \(currentlyActive && grant\.expires_at\) \{/,
    'the mirror must be gated on the canonical answer, never on the expiry alone',
  );
  assert.doesNotMatch(
    ACTIVATE_SOURCE,
    /let syncStatus: string = 'not_required';[\s\S]{0,4}if \(grant\.expires_at\) \{/,
    'the pre-repair expiry-only gate must not come back',
  );
  // The canonical check happens BEFORE the mirror it gates.
  const checkIdx = ACTIVATE_SOURCE.indexOf("rpc('kplus_user_entitlement_row_is_active'");
  const mirrorIdx = ACTIVATE_SOURCE.indexOf('await syncPromotionalEntitlement(');
  assert.ok(checkIdx > 0 && mirrorIdx > 0);
  assert.ok(checkIdx < mirrorIdx, 'the authority is read before the mirror is attempted');
});

test('SEC-KPLUS-008: an unreadable authority fails CLOSED -- no mirror, no already_active claim', () => {
  // currentlyActive starts false and is only ever raised by a successful,
  // explicitly `=== true` response. A thrown or non-ok read leaves it false.
  assert.match(ACTIVATE_SOURCE, /let currentlyActive = false;/);
  assert.match(ACTIVATE_SOURCE, /currentlyActive = \(await activeResponse\.json\(\)\) === true;/);
  assert.match(ACTIVATE_SOURCE, /logEvent\('kplus_active_check_failed'/);
});

test('SEC-KPLUS-008: campaignStatus reports already_active only for a genuinely active grant', () => {
  assert.match(
    ACTIVATE_SOURCE,
    /: currentlyActive[\s\S]{0,8}\? 'already_active'/,
    'already_active must be decided by the row-scoped predicate',
  );
  assert.doesNotMatch(
    ACTIVATE_SOURCE,
    /: grant\.expires_at && new Date\(grant\.expires_at\) > new Date\(\)/,
    'the pre-repair expiry-only classification must not come back',
  );
});

test('SEC-KPLUS-008: the repair does not weaken the grant path or the best-effort posture', () => {
  // The grant itself is still unconditional and still comes from the RPC.
  assert.match(ACTIVATE_SOURCE, /rpc\('grant_kplus_early_access', \{ p_user_id: authUser\.id \}\)/);
  // The canonical check is read-only: it must never be able to change a grant.
  const checkStart = ACTIVATE_SOURCE.indexOf("rpc('kplus_user_entitlement_row_is_active'");
  const checkEnd = ACTIVATE_SOURCE.indexOf('const campaignStatus');
  assert.ok(checkStart > 0 && checkEnd > checkStart, 'the row-scoped check and campaignStatus anchors must both be found');
  const checkBlock = ACTIVATE_SOURCE.slice(checkStart, checkEnd);
  assert.doesNotMatch(checkBlock, /return json\(/, 'a failed authority read must not fail the request');
});

test('kplus-activate is POST-only with standard CORS handling', () => {
  assert.match(ACTIVATE_SOURCE, /req\.method === 'OPTIONS'/);
  assert.match(ACTIVATE_SOURCE, /req\.method !== 'POST'/);
});

test('kplus-reconcile-revenuecat requires a server secret, never a user JWT', () => {
  assert.match(RECONCILE_SOURCE, /x-kplus-reconcile-secret/);
  assert.doesNotMatch(RECONCILE_SOURCE, /requireUser/);
  assert.match(RECONCILE_SOURCE, /providedSecret !== expectedSecret/);
});

test('kplus-reconcile-revenuecat processes a bounded batch, never an unbounded loop', () => {
  assert.match(RECONCILE_SOURCE, /list_kplus_pending_revenuecat_sync/);
  assert.doesNotMatch(RECONCILE_SOURCE, /while\s*\(\s*true\s*\)/);
  assert.doesNotMatch(RECONCILE_SOURCE, /setInterval|setTimeout/);
});

test('SEC-KPLUS-008 (reconcile): every pending row is gated on the ROW-SCOPED authority before it is mirrored', () => {
  // list_kplus_pending_revenuecat_sync selects on external_sync_status alone.
  // A K Scan AI K+ Early Access row revoked by an operator keeps its future
  // expires_at, so while its sync status was still pending the sweep mirrored
  // it into RevenueCat as a LIVE promotional entitlement. kplus-activate was
  // repaired for exactly this; the reconcile path was not.
  //
  // The user-level kplus_has_active_entitlement is the wrong question here: it
  // is true whenever ANY grant is live, including when THIS row is revoked.
  // Comments are stripped first so the source may still explain why; any CODE
  // reference (a call, a constant, a table of names) is refused.
  const reconcileCode = RECONCILE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(
    reconcileCode,
    /kplus_has_active_entitlement/,
    'the user-level predicate is true whenever ANY grant is live, so it must never gate the row mirror',
  );

  // The mirror is called exactly once, inside the per-row loop, so there is no
  // second call site the gate could be bypassed through.
  assert.equal((RECONCILE_SOURCE.match(/syncPromotionalEntitlement\(/g) ?? []).length, 1);
  const loopStart = RECONCILE_SOURCE.indexOf('for (const row of rows) {');
  const mirrorIdx = RECONCILE_SOURCE.indexOf('await syncPromotionalEntitlement(');
  assert.ok(loopStart > 0 && mirrorIdx > loopStart, 'the mirror must be attempted inside the per-row loop');

  // Before the mirror, in the same iteration, a row not confirmed live leaves
  // the iteration -- counted, never mirrored.
  const beforeMirror = RECONCILE_SOURCE.slice(loopStart, mirrorIdx);
  assert.match(
    beforeMirror,
    /if \(!\(await isRowActive\(row\)\)\) \{\s*skippedNotActive \+= 1;\s*continue;\s*\}/,
    'a row the row-scoped authority does not confirm live must be skipped before the mirror',
  );

  // The sync status is written once, and only after a mirror attempt: a skipped
  // row is left exactly as the revocation left it.
  assert.equal((RECONCILE_SOURCE.match(/'set_kplus_revenuecat_sync_status'/g) ?? []).length, 1);
  assert.ok(
    RECONCILE_SOURCE.indexOf("rpcServiceRole('set_kplus_revenuecat_sync_status'") > mirrorIdx,
    'no sync status may be written before the mirror is attempted',
  );
});

test('SEC-KPLUS-008 (reconcile): the gate asks about THIS row and fails CLOSED', () => {
  const helperStart = RECONCILE_SOURCE.indexOf('async function isRowActive(row: PendingRow): Promise<boolean> {');
  const helperEnd = RECONCILE_SOURCE.indexOf('Deno.serve(');
  assert.ok(helperStart > 0 && helperEnd > helperStart, 'the isRowActive gate must be defined before the handler');
  const helper = RECONCILE_SOURCE.slice(helperStart, helperEnd);

  // Row-scoped predicate, keyed on the pending row itself.
  assert.match(
    helper,
    /rpcServiceRole\('kplus_user_entitlement_row_is_active', \{\s*p_user_id: row\.user_id,\s*p_entitlement_key: row\.entitlement_key,\s*\}\)/,
    'the gate must ask whether THIS row (user_id + entitlement_key) is live',
  );

  // Only a literal `true` from a successful read is live. A non-ok response or
  // a thrown request answers false -- no mirror and no status write follow.
  assert.match(helper, /if \(!activeResponse\.ok\) \{[\s\S]{0,160}?return false;\s*\}/);
  assert.match(helper, /return \(await activeResponse\.json\(\)\) === true;/);
  assert.match(helper, /\} catch \{[\s\S]{0,160}?return false;\s*\}/);
  assert.match(helper, /logEvent\('kplus_reconcile_active_check_failed'/);
  assert.doesNotMatch(helper, /return true/, 'no path may assume the row is live');
  assert.equal((helper.match(/\breturn\b/g) ?? []).length, 3, 'non-ok -> false, literal true, thrown -> false');
});

test('SEC-KPLUS-008 (reconcile): the gate keeps the batch bounded and RevenueCat failures non-blocking', () => {
  // Still one bounded list call and one pass over its rows -- the gate adds no
  // paging, no refill and no retry loop.
  assert.equal((RECONCILE_SOURCE.match(/rpcServiceRole\('list_kplus_pending_revenuecat_sync'/g) ?? []).length, 1);
  assert.equal((RECONCILE_SOURCE.match(/\bfor\s*\(/g) ?? []).length, 1);

  // No row -- skipped, unreadable or failed at RevenueCat -- may end the pass.
  const loopStart = RECONCILE_SOURCE.indexOf('for (const row of rows) {');
  const loopEnd = RECONCILE_SOURCE.indexOf("logEvent('kplus_reconcile_completed'");
  assert.ok(loopStart > 0 && loopEnd > loopStart);
  const loopCode = RECONCILE_SOURCE.slice(loopStart, loopEnd).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(loopCode, /\b(return|break|throw)\b/, 'nothing inside the per-row loop may end the pass early');

  // Skipped rows are reported, not folded into synced/stillPending.
  assert.match(RECONCILE_SOURCE, /return json\(\{ scanned: rows\.length, synced, stillPending, skippedNotActive \}\);/);
});

test('RevenueCat adapter fails closed without a secret key and never treats sync as an availability dependency', () => {
  assert.match(REVENUECAT_CLIENT_SOURCE, /REVENUECAT_SECRET_API_KEY/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /failed_retryable/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /AbortSignal\.timeout/);
});

test('RevenueCat adapter grants via the V2 project-scoped endpoint with an explicit expiry, never additive duration', () => {
  assert.match(REVENUECAT_CLIENT_SOURCE, /REVENUECAT_PROJECT_ID/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /\/v2\//);
  assert.match(REVENUECAT_CLIENT_SOURCE, /actions\/grant_entitlement/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /entitlement_id:\s*entitlementId/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /expires_at:\s*endTimeMs/);
  assert.doesNotMatch(REVENUECAT_CLIENT_SOURCE, /\/v1\/subscribers/);
});

test('RevenueCat adapter provisions the V2 customer record before granting (V2 does not auto-create it)', () => {
  assert.match(REVENUECAT_CLIENT_SOURCE, /ensureCustomerExists/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /projects\/\$\{encodeURIComponent\(projectId\)\}\/customers/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /customer_provisioning_failed/);
});

test('config.toml declares kplus-activate authenticated and kplus-reconcile-revenuecat unauthenticated', () => {
  const config = fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const activateBlock = config.split('[functions.kplus-activate]')[1]?.split('[functions.')[0] ?? '';
  assert.match(activateBlock, /verify_jwt\s*=\s*true/);
  const reconcileBlock = config.split('[functions.kplus-reconcile-revenuecat]')[1]?.split('[functions.')[0] ?? '';
  assert.match(reconcileBlock, /verify_jwt\s*=\s*false/);
});

test('kplus-activate and kplus-reconcile-revenuecat are governed functions', () => {
  const manifestLib = fs.readFileSync(path.join(ROOT, 'scripts', 'edge-function-manifest-lib.js'), 'utf8');
  assert.match(manifestLib, /'kplus-activate'/);
  assert.match(manifestLib, /'kplus-reconcile-revenuecat'/);
});

test('user_entitlements and kplus_activation_events are registered in both deletion-purge registries', () => {
  const tsRegistry = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion', 'userDataResources.ts'),
    'utf8',
  );
  const jsonRegistry = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'lib', 'account-deletion', 'user-data-resources.json'), 'utf8'),
  );
  for (const table of ['user_entitlements', 'kplus_activation_events']) {
    assert.match(tsRegistry, new RegExp(`table: '${table}'`));
    assert.ok(
      jsonRegistry.tables.some((entry) => entry.table === table),
      `${table} missing from lib/account-deletion/user-data-resources.json`,
    );
  }
});
