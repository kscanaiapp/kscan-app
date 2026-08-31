// K+ entitlement store contract tests.
//
// constants/featureFlags.ts-style VM-transpile with an injected requireMap
// (same technique as __tests__/styleOutfitEdgeContract.test.js) so the
// store's pure state-machine logic is tested against controlled fake
// kplusClient responses, with no real network/Supabase dependency.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const STORE_PATH = path.join(ROOT, 'services', 'kplus', 'kplusEntitlementStore.ts');

function loadStore(clientMock) {
  const source = fs.readFileSync(STORE_PATH, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    // INT-KPLUS-006: the store schedules a notification at the entitlement's
    // expiry boundary, so the sandbox needs real timers.
    setTimeout,
    clearTimeout,
    Date,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier === './kplusClient') return clientMock;
      throw new Error(`Unexpected import in kplusEntitlementStore.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: STORE_PATH }).runInContext(sandbox);
  return mod.exports;
}

function futureIso(daysFromNow = 30) {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}
function pastIso(daysAgo = 30) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

test('default snapshot is loading, and reset restores it', () => {
  const store = loadStore({ fetchKPlusStatus: async () => ({ ok: true, row: null }) });
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading');
  store.resetKPlusEntitlementCache();
  assert.deepEqual(store.getKPlusEntitlementSnapshot(), store.DEFAULT_KPLUS_SNAPSHOT);
});

test('refresh resolves eligible when there is no row', async () => {
  const store = loadStore({ fetchKPlusStatus: async () => ({ ok: true, row: null }) });
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'eligible');
});

test('refresh resolves active only when status is active AND expires_at is in the future', async () => {
  const store = loadStore({
    fetchKPlusStatus: async () => ({
      ok: true,
      row: { status: 'active', expiresAt: futureIso(), campaignKey: 'kplus_early_access_2026', externalSyncStatus: 'synced' },
    }),
  });
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
});

test('a stale-but-status-active row past its own expiry resolves to expired, never active', async () => {
  const store = loadStore({
    fetchKPlusStatus: async () => ({
      ok: true,
      row: { status: 'active', expiresAt: pastIso(), campaignKey: 'kplus_early_access_2026', externalSyncStatus: 'synced' },
    }),
  });
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'expired');
});

test('a signed-out read resolves to unavailable, a failed read resolves to error (fail closed, never active)', async () => {
  const signedOutStore = loadStore({ fetchKPlusStatus: async () => ({ ok: false, reason: 'signed_out' }) });
  await signedOutStore.refreshKPlusEntitlement();
  assert.equal(signedOutStore.getKPlusEntitlementSnapshot().state, 'unavailable');

  const errorStore = loadStore({ fetchKPlusStatus: async () => ({ ok: false, reason: 'read_failed' }) });
  await errorStore.refreshKPlusEntitlement();
  assert.equal(errorStore.getKPlusEntitlementSnapshot().state, 'error');
});

test('resetKPlusEntitlementCache invalidates an in-flight refresh so a late response cannot resurrect a previous actor\'s state', async () => {
  let resolveFetch;
  const store = loadStore({
    fetchKPlusStatus: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });
  const refreshPromise = store.refreshKPlusEntitlement();
  store.resetKPlusEntitlementCache(); // actor changed mid-flight
  resolveFetch({ ok: true, row: { status: 'active', expiresAt: futureIso(), campaignKey: null, externalSyncStatus: 'synced' } });
  await refreshPromise;
  assert.deepEqual(store.getKPlusEntitlementSnapshot(), store.DEFAULT_KPLUS_SNAPSHOT);
});

test('activateKPlus outcome mapping: granted, already_active, campaign_consumed, failed', async () => {
  const grantedStore = loadStore({
    activateKPlusEarlyAccess: async () => ({
      ok: true,
      row: { entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access', campaignKey: 'kplus_early_access_2026', grantedAt: new Date().toISOString(), expiresAt: futureIso(), externalSyncStatus: 'pending' },
    }),
  });
  assert.equal(await grantedStore.activateKPlus(), 'granted');

  const consumedStore = loadStore({
    activateKPlusEarlyAccess: async () => ({
      ok: true,
      row: { entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access', campaignKey: 'kplus_early_access_2026', grantedAt: pastIso(200), expiresAt: pastIso(), externalSyncStatus: 'synced' },
    }),
  });
  assert.equal(await consumedStore.activateKPlus(), 'campaign_consumed');

  const failedStore = loadStore({ activateKPlusEarlyAccess: async () => ({ ok: false, reason: 'request_failed' }) });
  assert.equal(await failedStore.activateKPlus(), 'failed');
});

test('activateKPlus reports already_active on a second call once the store already observed an active grant (double-tap / re-open)', async () => {
  const row = { entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access', campaignKey: 'kplus_early_access_2026', grantedAt: pastIso(10), expiresAt: futureIso(), externalSyncStatus: 'synced' };
  const store = loadStore({
    fetchKPlusStatus: async () => ({ ok: true, row }),
    activateKPlusEarlyAccess: async () => ({ ok: true, row }),
  });
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  assert.equal(await store.activateKPlus(), 'already_active');
});

// ── CERT-CLIENT-001 / CERT-CLIENT-002 ──────────────────────────────────────
// Found by the Build 34 K+ entitlement / failure-state certification, live on
// staging: a synthetic actor revoked with `revoked_at` alone was denied by
// EVERY server authority (kplus_has_active_entitlement, has_active_k_plus,
// the Closet RLS write gate) while the client resolved 'active'.

test('CERT-CLIENT-001: a revoked_at-only revocation is NOT active on the client either', () => {
  const revoked = {
    entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access',
    campaignKey: 'kplus_early_access_2026', grantedAt: pastIso(1),
    expiresAt: futureIso(120),           // still in the future, as a real revocation leaves it
    revokedAt: pastIso(0.04),            // the only signal that it is gone
    externalSyncStatus: 'synced',
  };
  const store = loadStore({ fetchKPlusStatus: async () => ({ ok: true, row: revoked }) });
  return store.refreshKPlusEntitlement().then(() => {
    assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active',
      'the client must not resolve active for a grant every server authority denies');
    assert.equal(store.getKPlusEntitlementSnapshot().state, 'expired');
  });
});

test('CERT-CLIENT-001: revocation does not change the answer for a genuinely active grant', () => {
  const live = {
    entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access',
    campaignKey: 'kplus_early_access_2026', grantedAt: pastIso(1),
    expiresAt: futureIso(120), revokedAt: null, externalSyncStatus: 'synced',
  };
  const store = loadStore({ fetchKPlusStatus: async () => ({ ok: true, row: live }) });
  return store.refreshKPlusEntitlement().then(() => {
    assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  });
});

test('CERT-CLIENT-001: activateKPlus also refuses to call a revoked grant active', async () => {
  const revokedRow = {
    entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access',
    campaignKey: 'kplus_early_access_2026', grantedAt: pastIso(1),
    expiresAt: futureIso(120), revokedAt: pastIso(0.04), externalSyncStatus: 'synced',
  };
  const store = loadStore({
    fetchKPlusStatus: async () => ({ ok: true, row: null }),
    activateKPlusEarlyAccess: async () => ({ ok: true, row: revokedRow }),
  });
  assert.equal(await store.activateKPlus(), 'campaign_consumed');
  assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active');
});

test('CERT-CLIENT-001: the client SELECTS revoked_at, so the predicate has something to read', () => {
  const fs2 = require('node:fs');
  const clientSrc = fs2.readFileSync(
    require('node:path').join(ROOT, 'services', 'kplus', 'kplusClient.ts'), 'utf8');
  assert.match(clientSrc, /revoked_at/, 'the column must be requested, not just consulted');
  assert.match(clientSrc, /revokedAt: raw\.revoked_at/);
});

test('CERT-CLIENT-002: a consumed campaign is never announced or counted as an activation', () => {
  const fs2 = require('node:fs');
  const sheet = fs2.readFileSync(
    require('node:path').join(ROOT, 'components', 'kplus', 'KPlusEarlyAccessSheet.tsx'), 'utf8');
  const consumedIdx = sheet.indexOf("outcome === 'campaign_consumed'");
  // #258 (merged ahead of this repair) renamed the sheet's telemetry
  // vocabulary repo-wide: kplus_activation_success -> kplus_activation_completed,
  // kplus_activation_failure -> kplus_activation_failed. This test asserts
  // against the current vocabulary, not the one CERT-CLIENT-002 was
  // originally written against.
  const successIdx = sheet.indexOf("emitKPlusEvent('kplus_activation_completed'");
  const announceIdx = sheet.indexOf("'K+ Early Access activated.'");
  assert.ok(consumedIdx > 0, 'campaign_consumed must be handled explicitly');
  assert.ok(consumedIdx < successIdx, 'it must short-circuit before the success event');
  assert.ok(consumedIdx < announceIdx, 'it must short-circuit before the success announcement');
  // and it must actually return, not fall through
  const block = sheet.slice(consumedIdx, successIdx);
  assert.match(block, /return;/, 'the consumed branch must return');
  assert.match(block, /kplus_activation_failed/, 'a consumed campaign is not a success event');
});
