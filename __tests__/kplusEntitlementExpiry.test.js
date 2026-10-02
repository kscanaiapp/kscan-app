// INT-KPLUS-006 -- K+ entitlement must self-expire, and
// SEC-KPLUS-005 -- anonymous / ineligible accounts must not self-grant K+.
//
// INT-KPLUS-006 history: the store once evaluated expiry ONCE, when a server row
// arrived, and froze the answer, so a session left open past expiresAt kept
// reporting 'active' forever.
//
// BUILD 35 PHASE A -- the self-expiry guarantee is kept, but what happens AT the
// boundary changed, deliberately. The old store reported 'expired' (a free-tier
// state that shows the upsell) the instant a bounded grant's end passed. That is
// wrong once the end can belong to a store subscription: a renewal can land in
// the same instant, and RESOLVING != FREE. Past its own end, bounded access is
// now UNVERIFIED: never active, never free. The store re-asks the server at the
// boundary and presents what the server says.
//
// Time is fake and timers fire only when the test says so
// (__tests__/helpers/kplusStoreHarness.js): no real-clock races.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const h = require('./helpers/kplusStoreHarness');

const { build, resolved, unavailable, MINUTE, DAY } = h;
const ROOT = path.resolve(__dirname, '..');

function boot(opts) {
  return h.loadKPlusStore(opts);
}

// ── read-time expiry ─────────────────────────────────────────────────────────

test('bounded access that lapses while the session stays open is never active, and never free', async () => {
  const { store, reader, clock } = boot();
  reader.answer(resolved(build.complimentary(clock, 1)));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');

  clock.advance(2 * DAY); // no auth event, no refresh, no resume in between
  const state = store.getKPlusEntitlementSnapshot().state;
  assert.notEqual(state, 'active', 'a lapsed grant must not still read as active');
  assert.notEqual(state, 'eligible', 'an unverified answer is not a free answer');
  assert.notEqual(state, 'expired', 'an unverified answer is not a free answer');
  assert.equal(store.getKPlusEntitlementClientState().status, 'unavailable');
  store.__clearKPlusExpiryTimerForTests();
});

test('a still-valid entitlement keeps reading active', async () => {
  const { store, reader, clock } = boot();
  reader.answer(resolved(build.complimentary(clock, 30)));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  clock.advance(10 * DAY);
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  store.__clearKPlusExpiryTimerForTests();
});

test('FAIL CLOSED: a K+ answer with a null or unparseable end that is not open-ended is not active', async () => {
  // The reader's strict parse refuses these (see kplusCanonicalMobileReader.test.js);
  // here the store is handed one directly, as a defence in depth.
  for (const bad of [null, 'not-a-date', '']) {
    const { store, reader, clock } = boot();
    reader.answer(resolved(build.complimentary(clock, 30, { effectiveExpiresAt: bad })));
    await store.refreshKPlusEntitlement();
    const state = store.getKPlusEntitlementSnapshot().state;
    assert.notEqual(state, 'active', `end ${JSON.stringify(bad)} must not be treated as never-expiring`);
    store.__clearKPlusExpiryTimerForTests();
  }
});

test('the snapshot reference stays stable across reads (useSyncExternalStore safety)', async () => {
  const { store, reader, clock } = boot();
  reader.answer(resolved(build.free(clock, { history: true })));
  await store.refreshKPlusEntitlement();
  const first = store.getKPlusEntitlementSnapshot();
  const second = store.getKPlusEntitlementSnapshot();
  assert.equal(first, second, 'getSnapshot must return a stable reference when nothing changed');

  // ...also for the downgraded (unverified) projection of lapsed bounded access.
  const b = boot();
  b.reader.answer(resolved(build.complimentary(b.clock, 1)));
  await b.store.refreshKPlusEntitlement();
  b.clock.advance(2 * DAY);
  assert.equal(b.store.getKPlusEntitlementSnapshot(), b.store.getKPlusEntitlementSnapshot());
  b.store.__clearKPlusExpiryTimerForTests();
});

// ── expiry boundary notifies subscribers and re-asks the server ──────────────

test('subscribers are notified AT the expiry boundary, without any other event, and the server is asked again', async () => {
  const { store, reader, clock, timers } = boot();
  reader.answer(resolved(build.complimentary(clock, 1)));
  await store.refreshKPlusEntitlement();
  assert.equal(reader.calls, 1);
  assert.equal(timers.pending(), 1, 'an expiry boundary is armed');
  assert.equal(timers.nextDelay(), DAY);

  let notifications = 0;
  const unsubscribe = store.subscribeToKPlusEntitlement(() => { notifications += 1; });

  clock.advance(DAY);
  timers.runDue();
  assert.ok(notifications >= 1, 'the expiry boundary must wake subscribers');
  assert.equal(reader.calls, 2, 'the boundary re-asks the server');
  // While the answer is being re-read it reads as "checking", not a flash of an error.
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading');

  // The server now says the complimentary term ended.
  reader.release(resolved(build.free(clock, { history: true })));
  await h.flush();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'expired');
  unsubscribe();
  store.__clearKPlusExpiryTimerForTests();
});

test('a subscription that renewed at the boundary is never told it is free', async () => {
  const { store, reader, clock, timers } = boot();
  reader.answer(resolved(build.subscription(clock, { effectiveExpiresAt: clock.iso(MINUTE) })));
  await store.refreshKPlusEntitlement();
  clock.advance(MINUTE);
  timers.runDue();
  // Mid-refresh and before the server answers: unresolved, not free.
  const during = store.getKPlusEntitlementSnapshot().state;
  assert.ok(during === 'loading' || during === 'error', `unresolved, got ${during}`);
  reader.release(resolved(build.subscription(clock, { effectiveExpiresAt: clock.iso(30 * DAY) })));
  await h.flush();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active', 'the renewal is picked up from the server');
  store.__clearKPlusExpiryTimerForTests();
});

test('if the boundary re-read fails, the answer stays unresolved (error), never free', async () => {
  const { store, reader, clock, timers } = boot();
  reader.answer(resolved(build.complimentary(clock, 1)));
  await store.refreshKPlusEntitlement();
  clock.advance(DAY);
  timers.runDue();
  reader.release(unavailable('network'));
  await h.flush();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'error');
  store.__clearKPlusExpiryTimerForTests();
});

test('the actor reset clears the pending expiry timer and the snapshot', async () => {
  const { store, reader, clock, timers } = boot();
  reader.answer(resolved(build.complimentary(clock, 30)));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  assert.equal(timers.pending(), 1);
  store.resetKPlusEntitlementCache();
  assert.equal(timers.pending(), 0, 'no timer survives an actor boundary');
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading');
});

test('a refresh superseded by a failed activation does not leave the store reporting "checking" forever', async () => {
  const { store, reader, clock } = boot({ activation: h.createActivationClient({ ok: false, reason: 'request_failed' }) });
  reader.answer(resolved(build.complimentary(clock, 1)));
  await store.refreshKPlusEntitlement();
  clock.advance(DAY); // the bounded answer has now lapsed: unverified
  // A refresh starts, and is then superseded by an activation attempt that fails.
  const slowRefresh = store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading', 'while re-reading it says checking');
  assert.equal(await store.activateKPlus(), 'failed');
  reader.release(resolved(build.free(clock, { history: true }))); // the superseded read finally lands
  await slowRefresh;
  // Its answer was superseded and is not applied, and the marker is settled:
  // an unverified answer now reads as "could not check", not "checking".
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'error');
  store.__clearKPlusExpiryTimerForTests();
});

test('a timer armed for a previous actor can never re-read for the next one', async () => {
  const { store, reader, clock, timers } = boot();
  reader.answer(resolved(build.complimentary(clock, 1)));
  await store.refreshKPlusEntitlement();
  store.resetKPlusEntitlementCache();
  clock.advance(2 * DAY);
  timers.runDue();
  assert.equal(reader.calls, 1, 'the cleared timer must not fire a read');
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
