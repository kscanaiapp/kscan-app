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

test('RevenueCat adapter fails closed without a secret key and never treats sync as an availability dependency', () => {
  assert.match(REVENUECAT_CLIENT_SOURCE, /REVENUECAT_SECRET_API_KEY/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /failed_retryable/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /AbortSignal\.timeout/);
});

test('RevenueCat adapter never mutates duration additively (overwrite semantics, not extension)', () => {
  assert.match(REVENUECAT_CLIENT_SOURCE, /duration:\s*'custom'/);
  assert.match(REVENUECAT_CLIENT_SOURCE, /end_time_ms:\s*endTimeMs/);
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
