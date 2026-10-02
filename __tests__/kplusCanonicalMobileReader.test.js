// K+ canonical mobile entitlement authority (Build 35 Phase A).
//
// The mobile app reads K+ through ONE path: get_my_kplus_entitlement_summary()
// -> services/kplus/kplusEntitlementReader.ts -> services/kplus/
// kplusEntitlementStore.ts -> hooks/useKPlusEntitlement. Every existing K+ gate
// keeps consuming the hook; none learns where K+ came from.
//
// Matrix (Phase A brief section 12, mobile half):
//   T resolving mobile authority       U unavailable mobile authority
//   V malformed summary                W expired presentation snapshot
//   X actor change while an entitlement read is in flight
// plus the doctrine they protect, each with a NEGATIVE CONTROL: the check is
// re-run against a deliberately broken copy of the source and must go red.
//
// Time is fake and timers are manual (__tests__/helpers/kplusStoreHarness.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers/kplusStoreHarness');

const { build, resolved, unavailable, SIGNED_OUT, MINUTE, DAY } = h;
const plain = (v) => JSON.parse(JSON.stringify(v));
const read = (...p) => fs.readFileSync(path.join(h.ROOT, ...p), 'utf8');

// ── The reader ────────────────────────────────────────────────────────────────

function fakeSupabase({ session = { user: { id: 'u-1' } }, data = null, error = null, throwsOn = null } = {}) {
  const client = {
    rpcCalls: [],
    auth: {
      getSession: async () => {
        if (throwsOn === 'session') throw new Error('storage unavailable');
        return { data: { session } };
      },
    },
    rpc: (...args) => {
      client.rpcCalls.push(args);
      if (throwsOn === 'rpc') return Promise.reject(new Error('Network request failed'));
      return Promise.resolve({ data, error });
    },
  };
  return client;
}

async function readWith(client, sources) {
  const { reader } = h.loadKPlusReader({ client, sources });
  return plain(await reader.readKPlusEntitlementSummary());
}

test('READER: asks the one canonical RPC, with no argument, and returns the parsed summary', async () => {
  const clock = h.createClock();
  const summary = build.lifetime(clock);
  const client = fakeSupabase({ data: summary });
  const result = await readWith(client);
  assert.equal(result.status, 'resolved');
  assert.equal(result.summary.displaySource, 'lifetime');
  assert.equal(client.rpcCalls.length, 1);
  assert.deepEqual(client.rpcCalls[0], ['get_my_kplus_entitlement_summary'], 'identity is the JWT; the call names no user');
});

test('READER: a signed-out session is signed_out and never reaches the server', async () => {
  const client = fakeSupabase({ session: null });
  assert.deepEqual(await readWith(client), { status: 'signed_out' });
  assert.equal(client.rpcCalls.length, 0);
});

test('READER: every failure is unavailable -- none is ever a free answer', async () => {
  const cases = [
    ['an RPC error with a code is the server refusing', { error: { code: '42501', message: 'authentication required' } }, 'server_error'],
    ['an RPC error with an HTTP status is the server refusing', { error: { status: 503, message: 'upstream' } }, 'server_error'],
    ['an error with neither is a transport failure', { error: { message: 'Failed to fetch' } }, 'network'],
    ['a thrown rpc is a transport failure', { throwsOn: 'rpc' }, 'network'],
    ['an unreadable session store is a transport failure', { throwsOn: 'session' }, 'network'],
  ];
  for (const [label, opts, reason] of cases) {
    const result = await readWith(fakeSupabase(opts));
    assert.deepEqual(result, { status: 'unavailable', reason }, label);
  }
});

test('V. MALFORMED: a summary that is wrong, from another contract version, or self-contradictory is unavailable -- never free, never K+', async () => {
  const clock = h.createClock();
  const ok = build.complimentary(clock, 30);
  const malformed = [
    ['null', null],
    ['an array', []],
    ['a string', 'k_plus'],
    ['an empty object', {}],
    ['another contract version', { ...ok, contractVersion: 2 }],
    ['an unknown access value', { ...ok, access: 'maybe' }],
    ['K+ without a display source', { ...ok, displaySource: null }],
    ['K+ that is neither bounded nor open-ended', { ...ok, effectiveExpiresAt: null, isOpenEnded: false }],
    ['K+ that is both bounded and open-ended', { ...ok, isOpenEnded: true }],
    ['a free answer that claims a source', { ...build.free(clock), displaySource: 'complimentary' }],
    ['an unknown display source', { ...ok, displaySource: 'platinum' }],
    ['a LIFETIME answer with an end date (a contradiction)', { ...ok, displaySource: 'lifetime' }],
    ['a non-boolean complimentaryHistory', { ...ok, complimentaryHistory: 'yes' }],
    ['a null complimentaryHistory', { ...ok, complimentaryHistory: null }],
    ['a local-offset timestamp', { ...ok, effectiveExpiresAt: '2027-03-15T12:00:00+02:00' }],
    ['an unknown store', { ...ok, store: 'amazon' }],
    ['no account management block', { ...ok, accountManagement: null }],
  ];
  for (const [label, data] of malformed) {
    const result = await readWith(fakeSupabase({ data }));
    assert.deepEqual(result, { status: 'unavailable', reason: 'malformed_response' }, label);
  }
});

test('READER: an older Phase 1 server (no complimentaryHistory) is still a valid answer; unknown server fields are dropped', async () => {
  const clock = h.createClock();
  const { complimentaryHistory, ...phase1 } = build.free(clock, { history: false });
  void complimentaryHistory;
  const result = await readWith(fakeSupabase({ data: { ...phase1, grantId: 'internal', providerEventId: 'evt' } }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.summary.complimentaryHistory, null, 'absent, not guessed');
  assert.equal(result.summary.grantId, undefined);
  assert.equal(result.summary.providerEventId, undefined);
});

test('READER: a lifetime answer parses, and a bounded lifetime answer does not', async () => {
  const clock = h.createClock();
  const lifetime = await readWith(fakeSupabase({ data: build.lifetime(clock) }));
  assert.equal(lifetime.status, 'resolved');
  assert.equal(lifetime.summary.isOpenEnded, true);
  assert.equal(lifetime.summary.effectiveExpiresAt, null);
  const bounded = await readWith(fakeSupabase({ data: build.lifetime(clock, { isOpenEnded: false, effectiveExpiresAt: clock.iso(DAY) }) }));
  assert.equal(bounded.status, 'unavailable');
});

// ── The doctrine, as re-runnable checks ───────────────────────────────────────
// Each check takes a `boot` that may load a mutated source. The real tests call
// it with the real source; the negative controls call it with a broken one.

const CHECKS = {
  // T
  async resolvingIsNotFree(boot) {
    const { store, contract, reader, clock } = boot();
    assert.equal(store.getKPlusEntitlementClientState().status, 'resolving');
    assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading');
    const refresh = store.refreshKPlusEntitlement(); // in flight, unanswered
    assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading', 'an unanswered read is not an answer');
    assert.equal(contract.shouldPresentKPlusPaywall(store.getKPlusEntitlementClientState()), false);
    assert.equal(contract.presentsKPlusAccess(store.getKPlusEntitlementClientState()), false);
    reader.release(resolved(build.free(clock)));
    await refresh;
  },

  // U
  async unreadableIsNotFree(boot) {
    // No cache at all.
    const a = boot();
    a.reader.answer(unavailable('network'));
    await a.store.refreshKPlusEntitlement();
    assert.equal(a.store.getKPlusEntitlementClientState().status, 'unavailable');
    assert.equal(a.store.getKPlusEntitlementSnapshot().state, 'error');
    assert.equal(a.contract.shouldPresentKPlusPaywall(a.store.getKPlusEntitlementClientState()), false);

    // A fresh cached FREE answer must not stand in for an unreadable server.
    const b = boot();
    b.reader.answer(resolved(build.free(b.clock, { history: true })), unavailable('server_error'));
    await b.store.refreshKPlusEntitlement();
    assert.equal(b.store.getKPlusEntitlementSnapshot().state, 'expired');
    await b.store.refreshKPlusEntitlement();
    assert.equal(b.store.getKPlusEntitlementSnapshot().state, 'error', 'a failed read after a free answer is unresolved, not free');
    assert.equal(b.contract.shouldPresentKPlusPaywall(b.store.getKPlusEntitlementClientState()), false);
  },

  // W
  async snapshotAgesOut(boot) {
    const { store, reader, clock } = boot();
    reader.answer(resolved(build.lifetime(clock)), unavailable('network'), unavailable('network'));
    await store.refreshKPlusEntitlement();
    // The server cannot be reached 14 minutes later: the bounded snapshot stands in.
    clock.advance(14 * MINUTE);
    await store.refreshKPlusEntitlement();
    assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
    assert.equal(plain(store.getKPlusEntitlementClientState()).origin, 'presentation_snapshot');
    // One minute more and the freshness policy ends it: unverified, not free.
    clock.advance(1 * MINUTE);
    const aged = plain(store.getKPlusEntitlementClientState());
    assert.deepEqual(aged, { status: 'unavailable', reason: 'snapshot_expired' });
    assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active');
    assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'eligible');
    assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'expired');
  },

  async lifetimeNeverExpires(boot) {
    const { store, reader, clock } = boot();
    reader.answer(resolved(build.lifetime(clock)));
    await store.refreshKPlusEntitlement();
    clock.advance(10 * 365 * DAY);
    assert.equal(store.getKPlusEntitlementSnapshot().state, 'active', 'open-ended access is not an expiring subscription');
    assert.equal(store.getKPlusEntitlementSnapshot().isOpenEnded, true);
  },

  async failsClosedOnUnreadableEnd(boot) {
    const { store, reader, clock } = boot();
    reader.answer(resolved(build.complimentary(clock, 30, { effectiveExpiresAt: null })));
    await store.refreshKPlusEntitlement();
    assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active');
  },

  async deviceNeverGrantsItself(boot) {
    // An activation response that says "active" does not make the device active.
    const row = {
      entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access', campaignKey: 'k',
      grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * DAY).toISOString(), revokedAt: null, externalSyncStatus: 'pending',
    };
    const { store, reader } = boot({ activation: h.createActivationClient({ ok: true, row }) });
    reader.answer(unavailable('network'));
    await store.activateKPlus();
    assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active');
  },
};

const realBoot = (opts) => h.loadKPlusStore(opts);
const mutate = (file, find, replace) => {
  const source = fs.readFileSync(file, 'utf8');
  const first = source.indexOf(find);
  assert.ok(first >= 0, `mutation anchor must exist: ${find.slice(0, 60)}`);
  assert.equal(source.indexOf(find, first + 1), -1, `mutation anchor must be unique: ${find.slice(0, 60)}`);
  return source.slice(0, first) + replace + source.slice(first + find.length);
};
const bootMutated = (find, replace) => (opts = {}) => h.loadKPlusStore({
  ...opts,
  sources: { [h.STORE_PATH]: mutate(h.STORE_PATH, find, replace) },
});

test('T. RESOLVING: an unanswered read is neither Free nor K+ and never opens a paywall', async () => {
  await CHECKS.resolvingIsNotFree(realBoot);
});

test('U. UNAVAILABLE: an unreadable server is unresolved -- never free, and a cached FREE answer never stands in for it', async () => {
  await CHECKS.unreadableIsNotFree(realBoot);
});

test('U. UNAVAILABLE: a fresh K+ snapshot may stand in while the server is unreachable (presentation only)', async () => {
  const { store, reader, clock } = realBoot();
  reader.answer(resolved(build.subscription(clock)), unavailable('network'));
  await store.refreshKPlusEntitlement();
  clock.advance(3 * MINUTE);
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  assert.equal(plain(store.getKPlusEntitlementClientState()).origin, 'presentation_snapshot');
  store.__clearKPlusExpiryTimerForTests();
});

test('V. MALFORMED: after a fresh K+ answer, a malformed one never falls back to the snapshot', async () => {
  const { store, reader, clock } = realBoot();
  reader.answer(resolved(build.lifetime(clock)), unavailable('malformed_response'));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  await store.refreshKPlusEntitlement();
  assert.deepEqual(plain(store.getKPlusEntitlementClientState()), { status: 'unavailable', reason: 'malformed_response' });
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'error');
});

test('W. EXPIRED SNAPSHOT: a cached K+ answer is presented for at most 15 minutes, then it is unverified (not free)', async () => {
  await CHECKS.snapshotAgesOut(realBoot);
});

test('W. EXPIRED SNAPSHOT: it never outlives the entitlement it describes', async () => {
  const { store, reader, clock } = realBoot();
  reader.answer(resolved(build.complimentary(clock, 0.002 /* ~2.9 minutes */)), unavailable('network'));
  await store.refreshKPlusEntitlement();
  clock.advance(2 * MINUTE);
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active', 'still inside its own end');
  clock.advance(2 * MINUTE);
  assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active', 'past its own end, long before 15 minutes');
  store.__clearKPlusExpiryTimerForTests();
});

test('W. EXPIRED SNAPSHOT: a device clock set back cannot keep a snapshot alive', async () => {
  const { store, reader, clock } = realBoot();
  reader.answer(resolved(build.lifetime(clock)), unavailable('network'));
  await store.refreshKPlusEntitlement();
  clock.advance(-6 * MINUTE); // set back beyond the 5-minute skew allowance
  await store.refreshKPlusEntitlement();
  assert.deepEqual(plain(store.getKPlusEntitlementClientState()), { status: 'unavailable', reason: 'clock_untrusted' });
  assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active');
});

test('X. ACTOR CHANGE: a read in flight for actor A is discarded when the actor changes, even if B has already answered', async () => {
  const { store, reader, clock } = realBoot();
  // A's read is outstanding (held open)...
  const aRead = store.refreshKPlusEntitlement();
  assert.equal(reader.heldCount(), 1);
  // ...A signs out and B signs in; B's own read completes first as FREE.
  store.resetKPlusEntitlementCache();
  const bRead = store.refreshKPlusEntitlement();
  assert.equal(reader.heldCount(), 2);
  // B (second held) answers; then A's late K+ answer lands.
  reader.heldOrder = null;
  reader.release(resolved(build.lifetime(clock))); // oldest held == A's read
  reader.release(resolved(build.free(clock, { history: false }))); // B's read
  await Promise.all([aRead, bRead]);
  const snapshot = store.getKPlusEntitlementSnapshot();
  assert.equal(snapshot.state, 'eligible', "B's own answer stands; A's late lifetime answer was not applied");
  assert.equal(snapshot.isOpenEnded, false);
  assert.equal(snapshot.displaySource, null);
});

test('X. ACTOR CHANGE: with no answer yet for B, A\'s late answer leaves B resolving -- not K+, not free', async () => {
  const { store, reader, clock } = realBoot();
  const aRead = store.refreshKPlusEntitlement();
  store.resetKPlusEntitlementCache();
  reader.release(resolved(build.lifetime(clock)));
  await aRead;
  assert.equal(store.getKPlusEntitlementClientState().status, 'resolving');
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading');
});

test('LIFETIME + stale cache across an actor boundary: the previous actor\'s snapshot never stands in for the next actor', async () => {
  const { store, reader, clock } = realBoot();
  reader.answer(resolved(build.lifetime(clock)), unavailable('network'));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  store.resetKPlusEntitlementCache(); // A -> B
  await store.refreshKPlusEntitlement(); // B's read fails
  assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active', "A's cached lifetime snapshot was shown to B");
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'error');
});

test('the device never grants itself K+ from an activation response', async () => {
  await CHECKS.deviceNeverGrantsItself(realBoot);
});

test('a lifetime purchase is never treated as an expiring subscription on the device', async () => {
  await CHECKS.lifetimeNeverExpires(realBoot);
});

test('K+ access with no readable end that is not open-ended fails closed', async () => {
  await CHECKS.failsClosedOnUnreadableEnd(realBoot);
});

// ── Negative controls: the checks above must go RED against broken sources ───

async function mustFail(check, boot, label) {
  let failed = false;
  try {
    await check(boot);
  } catch {
    failed = true;
  }
  assert.equal(failed, true, `NEGATIVE CONTROL SURVIVED: ${label}`);
}

test('NEGATIVE CONTROL: if RESOLVING became Free, the resolving check goes red', async () => {
  await mustFail(CHECKS.resolvingIsNotFree, bootMutated(
    "    case 'resolving':\n      return DEFAULT_KPLUS_SNAPSHOT;",
    "    case 'resolving':\n      return { ...DEFAULT_KPLUS_SNAPSHOT, state: 'eligible' };",
  ), 'resolving projected as eligible');
});

test('NEGATIVE CONTROL: if a failed read were presented as Free, the unreadable check goes red', async () => {
  await mustFail(CHECKS.unreadableIsNotFree, bootMutated(
    "      if (refreshing && state.reason === 'snapshot_expired') return DEFAULT_KPLUS_SNAPSHOT;\n      return { ...DEFAULT_KPLUS_SNAPSHOT, state: 'error' };",
    "      if (refreshing && state.reason === 'snapshot_expired') return DEFAULT_KPLUS_SNAPSHOT;\n      return { ...DEFAULT_KPLUS_SNAPSHOT, state: 'eligible' };",
  ), 'unavailable projected as eligible');
});

test('NEGATIVE CONTROL: if a cached FREE answer could stand in for an unreadable server, the unreadable check goes red', async () => {
  await mustFail(CHECKS.unreadableIsNotFree, bootMutated(
    "    && lastServerSummary.access === 'k_plus'\n",
    '',
  ), 'free snapshot allowed to stand in');
});

test('NEGATIVE CONTROL: if the snapshot never aged out, the freshness check goes red', async () => {
  await mustFail(CHECKS.snapshotAgesOut, bootMutated(
    'return evaluated.status === \'resolved\' ? state : evaluated;',
    'return state;',
  ), 'snapshot served forever');
});

test('NEGATIVE CONTROL: if lifetime were treated as an expiring subscription, the lifetime check goes red', async () => {
  await mustFail(CHECKS.lifetimeNeverExpires, bootMutated(
    'if (summary.access !== \'k_plus\' || summary.isOpenEnded) return false;',
    'if (summary.access !== \'k_plus\') return false;',
  ), 'open-ended access flagged as an unreadable end');
});

test('NEGATIVE CONTROL: if an unreadable end were trusted, the fail-closed check goes red', async () => {
  await mustFail(CHECKS.failsClosedOnUnreadableEnd, bootMutated(
    '  if (hasUnreadableEnd(state.summary)) return UNVERIFIED;\n',
    '',
  ), 'fail-closed guard removed');
});

test('NEGATIVE CONTROL: if the client let an activation response set state, the self-grant check goes red', async () => {
  await mustFail(CHECKS.deviceNeverGrantsItself, bootMutated(
    '  await refreshKPlusEntitlement();\n  // The actor changed while the re-read was in flight',
    "  if (responseSaysActive) {\n    setClientState({ status: 'resolved', origin: 'server', summary: { contractVersion: 1, entitlementKey: 'k_plus', access: 'k_plus', displaySource: 'complimentary', effectiveExpiresAt: row.expiresAt, isOpenEnded: false, trialEndsAt: null, willRenew: null, store: null, billingState: null, complimentaryHistory: true, accountManagement: { storeManagementRelevant: false, managementStore: null }, snapshotIssuedAt: new Date().toISOString() } });\n  } else {\n    await refreshKPlusEntitlement();\n  }\n  // The actor changed while the re-read was in flight",
  ), 'device granted itself from the activation response');
});

// The reader's two contracts, re-runnable against a mutated reader source.
async function assertReaderNeverReportsFreeOnFailure(sources) {
  for (const opts of [
    { error: { code: '500', message: 'x' } },
    { error: { message: 'Failed to fetch' } },
    { throwsOn: 'rpc' },
  ]) {
    const result = await readWith(fakeSupabase(opts), sources);
    assert.equal(result.status, 'unavailable', 'a failed read must be unavailable, never a free answer');
  }
}
async function assertReaderRejectsMalformed(sources) {
  for (const data of [null, { access: 'k_plus' }, { ...build.complimentary(h.createClock()), displaySource: null }]) {
    const result = await readWith(fakeSupabase({ data }), sources);
    assert.deepEqual(result, { status: 'unavailable', reason: 'malformed_response' });
  }
}

test('READER: a failed read is never reported as a free answer', async () => {
  await assertReaderNeverReportsFreeOnFailure();
});
test('READER: a malformed payload is never trusted', async () => {
  await assertReaderRejectsMalformed();
});

test('NEGATIVE CONTROL: if the reader mapped a failed read to a free answer, the reader contract goes red', async () => {
  const find = "    return { status: 'unavailable', reason: classifyError(response.error) };";
  const replace = "    return { status: 'resolved', summary: { contractVersion: 1, entitlementKey: 'k_plus', access: 'free', displaySource: null, effectiveExpiresAt: null, isOpenEnded: false, trialEndsAt: null, willRenew: null, store: null, billingState: null, complimentaryHistory: false, accountManagement: { storeManagementRelevant: false, managementStore: null }, snapshotIssuedAt: new Date().toISOString() } };";
  const sources = { [h.READER_PATH]: mutate(h.READER_PATH, find, replace) };
  await assert.rejects(() => assertReaderNeverReportsFreeOnFailure(sources), /never a free answer|unavailable/);
});

test('NEGATIVE CONTROL: if the reader accepted a malformed summary, the malformed contract goes red', async () => {
  const sources = {
    [h.READER_PATH]: mutate(h.READER_PATH,
      "  const summary = parseKPlusEntitlementSummary(response.data);\n  if (!summary) {\n    return { status: 'unavailable', reason: 'malformed_response' };\n  }\n  return { status: 'resolved', summary };",
      "  return { status: 'resolved', summary: response.data };"),
  };
  await assert.rejects(() => assertReaderRejectsMalformed(sources));
});

// ── Scope: gates stay unaware of purchase mechanics ──────────────────────────

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(h.ROOT, f).split(path.sep).join('/');

test('SCOPE: the canonical summary RPC is named in exactly one runtime place on the device', () => {
  const offenders = [];
  for (const dir of ['app', 'components', 'hooks', 'services', 'contexts', 'lib']) {
    const base = path.join(h.ROOT, dir);
    if (!fs.existsSync(base)) continue;
    for (const file of walk(base)) {
      const code = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/get_my_kplus_entitlement_summary|KPLUS_CLIENT_SUMMARY_RPC/.test(code)) offenders.push(rel(file));
    }
  }
  assert.deepEqual(offenders, ['services/kplus/kplusEntitlementReader.ts']);
});

test('SCOPE: no UI surface imports the contract or the reader -- gates consume only the hook', () => {
  const offenders = [];
  for (const dir of ['app', 'components']) {
    for (const file of walk(path.join(h.ROOT, dir))) {
      if (/kplusEntitlementContract|kplusEntitlementReader/.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel(file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('SCOPE: no K+ gate learns purchase mechanics (store grants, RevenueCat SDK, lifetime branching)', () => {
  const offenders = [];
  for (const dir of ['app', 'components', 'hooks']) {
    for (const file of walk(path.join(h.ROOT, dir))) {
      const code = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/store_lifetime|store_subscription|react-native-purchases|RevenueCat|displaySource\s*[=!]==/.test(code)) offenders.push(rel(file));
    }
  }
  assert.deepEqual(offenders, [], 'purchase complexity belongs in the entitlement/provider layer, not in a feature gate');
});

// Phase A pinned "the native purchase SDK is NOT added". Build 35 Phase B is the
// phase that adds it (an explicit, later spec), so the pin now says what is true
// after Phase B: exactly ONE purchases package, the official one, pinned exactly.
// The checks that matter for Phase A still hold: no feature gate imports it
// (previous test) and nothing else RevenueCat-shaped ships in the client.
test('SCOPE: the native purchase SDK is the single, exactly-pinned Phase B dependency', () => {
  const pkg = JSON.parse(read('package.json'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const purchaseish = Object.keys(all).filter((name) => /purchases|revenuecat/i.test(name));
  assert.deepEqual(purchaseish, ['react-native-purchases']);
  assert.match(all['react-native-purchases'], /^\d+\.\d+\.\d+$/, 'pinned exactly, no range');
});

test('SCOPE: the hook still decides access only from the resolved state', () => {
  const hook = read('hooks', 'useKPlusEntitlement.ts');
  assert.match(hook, /isActive: snapshot\.state === 'active'/);
});
