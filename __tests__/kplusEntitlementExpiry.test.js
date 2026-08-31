// INT-KPLUS-006 — K+ entitlement must self-expire, and
// SEC-KPLUS-005 — anonymous / ineligible accounts must not self-grant K+.
//
// The store previously evaluated expiry ONCE, when a server row arrived, and
// froze the answer. A session left open past expiresAt with no auth event and
// no refresh kept reporting state 'active' forever.

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
    setTimeout,
    clearTimeout,
    Date,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier === './kplusClient') return clientMock;
      throw new Error(`Unexpected import: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: STORE_PATH }).runInContext(sandbox);
  return mod.exports;
}

const row = (expiresAt, status = 'active') => ({
  status,
  expiresAt,
  campaignKey: 'early-access',
  externalSyncStatus: 'synced',
});

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

/**
 * Loads the store FIRST, then lets the caller choose the expiry, so the (slow)
 * TypeScript transpile never eats into a short expiry window and makes the
 * timing flaky.
 */
function storeWithLater(status = 'active') {
  const holder = { expiresAt: null };
  const store = loadStore({
    fetchKPlusStatus: async () => ({ ok: true, row: row(holder.expiresAt, status) }),
    activateKPlusEarlyAccess: async () => ({ ok: true, row: row(holder.expiresAt, status) }),
  });
  return { store, holder };
}

function storeWith(expiresAt, status = 'active') {
  return loadStore({
    fetchKPlusStatus: async () => ({ ok: true, row: row(expiresAt, status) }),
    activateKPlusEarlyAccess: async () => ({ ok: true, row: row(expiresAt, status) }),
  });
}

// ── read-time expiry ─────────────────────────────────────────────────────────

test('an entitlement that lapses while the session stays open reports expired', async () => {
  // Active at first read, expired shortly after, with NO auth event, NO
  // refresh and NO resume in between.
  const { store, holder } = storeWithLater();
  holder.expiresAt = iso(150);
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');

  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(
    store.getKPlusEntitlementSnapshot().state,
    'expired',
    'a lapsed grant must not still read as active',
  );
  store.__clearKPlusExpiryTimerForTests();
});

test('a still-valid entitlement keeps reading active', async () => {
  const store = storeWith(iso(60_000));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  store.__clearKPlusExpiryTimerForTests();
});

test('an already-expired row never reads active', async () => {
  const store = storeWith(iso(-1000));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'expired');
  store.__clearKPlusExpiryTimerForTests();
});

test('FAIL CLOSED: an active row with a null or unparseable expiry is not active', async () => {
  for (const bad of [null, 'not-a-date', '']) {
    const store = storeWith(bad);
    await store.refreshKPlusEntitlement();
    assert.notEqual(
      store.getKPlusEntitlementSnapshot().state,
      'active',
      `expiry ${JSON.stringify(bad)} must not be treated as never-expiring`,
    );
    store.__clearKPlusExpiryTimerForTests();
  }
});

test('the snapshot reference stays stable across reads (useSyncExternalStore safety)', async () => {
  const store = storeWith(iso(-1000));
  await store.refreshKPlusEntitlement();
  const first = store.getKPlusEntitlementSnapshot();
  const second = store.getKPlusEntitlementSnapshot();
  assert.equal(first, second, 'getSnapshot must return a stable reference when nothing changed');
  store.__clearKPlusExpiryTimerForTests();
});

// ── expiry boundary notifies subscribers ─────────────────────────────────────

test('subscribers are notified AT the expiry boundary, without any other event', async () => {
  const { store, holder } = storeWithLater();
  holder.expiresAt = iso(150);
  await store.refreshKPlusEntitlement();

  let notifications = 0;
  const unsubscribe = store.subscribeToKPlusEntitlement(() => {
    notifications += 1;
  });

  await new Promise((resolve) => setTimeout(resolve, 350));
  unsubscribe();

  assert.ok(notifications >= 1, 'the expiry boundary must wake subscribers');
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'expired');
  store.__clearKPlusExpiryTimerForTests();
});

test('the actor reset clears the pending expiry timer and the snapshot', async () => {
  const store = storeWith(iso(60_000));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  store.resetKPlusEntitlementCache();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading');
});

// ── SEC-KPLUS-005: anonymous self-grant ──────────────────────────────────────

const ACTIVATE_SRC = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'kplus-activate', 'index.ts'),
  'utf8',
);
const COMMON_SRC = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion', 'common.ts'),
  'utf8',
);

test('requireUser surfaces the anonymous flag from the verified identity', () => {
  assert.match(
    COMMON_SRC,
    /isAnonymous:\s*Boolean\(\(user as \{ is_anonymous\?: boolean \}\)\.is_anonymous\)/,
    'requireUser must report whether the verified identity is anonymous',
  );
});

test('isEligibleAccountActor denies anonymous and malformed identities', () => {
  const output = ts.transpileModule(COMMON_SRC, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  // Evaluate only the pure helpers; the module's async paths need Deno.
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    Deno: { env: { get: () => 'https://example.test' } },
    require: () => ({}),
  };
  vm.createContext(sandbox);
  try {
    new vm.Script(output, { filename: 'common.ts' }).runInContext(sandbox);
  } catch {
    // Import-time Deno/npm specifics may not evaluate here; the assertions
    // below fall back to source-level proof in that case.
  }
  const isEligible = mod.exports.isEligibleAccountActor;
  if (typeof isEligible === 'function') {
    const uuid = '11111111-1111-4111-8111-111111111111';
    assert.equal(isEligible({ id: uuid, isAnonymous: false }), true);
    assert.equal(isEligible({ id: uuid, isAnonymous: true }), false, 'anonymous must be denied');
    assert.equal(isEligible(null), false);
    assert.equal(isEligible({ id: 'nope', isAnonymous: false }), false);
  } else {
    assert.match(COMMON_SRC, /return user\.isAnonymous !== true;/);
  }
});

test('kplus-activate denies an anonymous identity BEFORE the grant RPC', () => {
  const denyIdx = ACTIVATE_SRC.indexOf('isEligibleAccountActor(authUser)');
  const grantIdx = ACTIVATE_SRC.indexOf("rpc('grant_kplus_early_access'");
  assert.ok(denyIdx > 0, 'kplus-activate must check actor eligibility');
  assert.ok(grantIdx > 0);
  assert.ok(denyIdx < grantIdx, 'the eligibility check must precede the grant');
  assert.match(ACTIVATE_SRC, /ACCOUNT_REQUIRED/);

  // CERT-MUT-M1b. Presence and ORDER are not polarity. Dropping the `!` --
  //     if (isEligibleAccountActor(authUser)) { ...403 ACCOUNT_REQUIRED... }
  // -- leaves every assertion above satisfied while inverting the guard into
  // "anonymous sessions may self-grant K+, real accounts may not". Anonymous
  // sign-in is disabled on staging, so no live test can catch this either:
  // this assertion is the only thing standing between that inversion and a
  // green suite. The negation is therefore pinned explicitly.
  assert.match(
    ACTIVATE_SRC,
    /if \(!isEligibleAccountActor\(authUser\)\) \{/,
    'the guard must DENY ineligible actors, not admit them',
  );
});

test('kplus-activate denies a deactivated account BEFORE the grant RPC', () => {
  const activeIdx = ACTIVATE_SRC.indexOf('assertAccountActive(authUser.id)');
  const grantIdx = ACTIVATE_SRC.indexOf("rpc('grant_kplus_early_access'");
  assert.ok(activeIdx > 0, 'kplus-activate must assert the account is active');
  assert.ok(activeIdx < grantIdx, 'the account-state check must precede the grant');
});

test('an eligible account is unchanged: the grant path is still reached', () => {
  // The guards must be additive, not a rewrite of the success path.
  assert.match(ACTIVATE_SRC, /rpc\('grant_kplus_early_access', \{ p_user_id: authUser\.id \}\)/);
  assert.match(ACTIVATE_SRC, /campaignStatus/);
  assert.match(ACTIVATE_SRC, /already_active/);
  assert.match(ACTIVATE_SRC, /campaign_already_consumed/);
});
