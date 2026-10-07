'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, runModule, createRenderer } = require('./helpers/componentRenderer');
const proof = runModule('services/kplus/kplusCapabilityProof.ts', {}, { jsx: false });
const FLAGS = { voiceScan: false, vto: false, concierge: false, packing: true, watchlist: true, cloudSync: true, cloudRestore: true, cloudMigration: true };
const records = [
  ['packing_intelligence', 'packing_generation_and_refinement'], ['smart_watchlist', 'watch_tracking'],
  ['cloud_closet', 'closet_outbound_sync'], ['cloud_closet', 'closet_cross_device_restore'],
].map(([capability, proofType]) => ({ capability, proofType, environment: 'staging', buildAuthority: 'fixture', status: 'PROVEN_RUNTIME', provenAt: '2026-10-06', expiresAt: '2026-10-08', evidenceRef: 'governed-fixture' }));
const context = { environment: 'staging', buildAuthority: 'fixture', nowMs: Date.parse('2026-10-07'), records };
const server = Object.fromEntries(['packing_intelligence', 'smart_watchlist', 'cloud_closet'].map(id => [id, { status: 'confirmed', basis: 'fixture' }]));
function catalog(mutate) { return runModule('services/kplus/kplusActivationCatalog.ts', { '../../constants/featureFlags': {}, './kplusCapabilityProof': proof }, { jsx: false, mutate }); }
function ids(subject, flags = FLAGS, ctx = context) { return subject.resolveActivationCapabilities(flags, server, {}, ctx).map(c => c.id); }
function rejectsUnproven(subject) {
  assert.deepEqual(ids(subject, FLAGS, { ...context, records: [] }), []);
}
test('P0 claims require runtime proof as well as build flags and server posture', () => {
  const subject = catalog();
  assert.deepEqual(ids(subject), ['packing_intelligence', 'smart_watchlist', 'cloud_closet']);
  rejectsUnproven(subject);
  for (const key of ['packing', 'watchlist', 'cloudSync', 'cloudRestore', 'cloudMigration']) {
    const expected = key === 'packing' ? 'packing_intelligence' : key === 'watchlist' ? 'smart_watchlist' : 'cloud_closet';
    assert.ok(!ids(subject, { ...FLAGS, [key]: false }).includes(expected), key);
  }
});
for (const status of ['UNPROVEN', 'PROVEN_SOURCE_ONLY']) test(`proof level ${status} cannot advertise`, () => {
  assert.deepEqual(ids(catalog(), FLAGS, { ...context, records: records.map(r => ({ ...r, status })) }), []);
});
test('missing, expired, future, wrong environment, wrong build and missing evidence fail closed', () => {
  for (const patch of [{ environment: 'production' }, { buildAuthority: 'wrong' }, { evidenceRef: '' }, { expiresAt: '2026-10-06' }, { provenAt: '2026-10-08' }]) {
    assert.deepEqual(ids(catalog(), FLAGS, { ...context, records: records.map(r => ({ ...r, ...patch })) }), []);
  }
  assert.deepEqual(ids(catalog(), FLAGS, { ...context, environment: undefined }), []);
});
test('Cloud backup and cross-device copy follow different proof types', () => {
  const withoutRestore = { ...context, records: records.filter(r => r.proofType !== 'closet_cross_device_restore') };
  const resolve = ctx => catalog().resolveActivationCapabilities(FLAGS, server, {}, ctx).find(c => c.id === 'cloud_closet');
  assert.doesNotMatch(resolve(withoutRestore).description, /across devices/);
  assert.match(resolve(context).description, /across devices/);
});
test('tracking proof cannot imply worker or either platform push', () => {
  for (const type of ['watch_worker_behavior', 'watch_push_ios', 'watch_push_android']) {
    assert.equal(proof.hasRuntimeCapabilityProof('smart_watchlist', type, context), false);
  }
});
test('NC-PV proof bypass: a hand-confirmed server entry cannot substitute for runtime evidence', () => {
  const mutant = catalog(source => {
    const pattern = /if \(id === '(packing_intelligence|smart_watchlist|cloud_closet)' && !hasRuntimeCapabilityProof[^\n]+return false;/g;
    const matches = source.match(pattern); assert.equal(matches.length, 3);
    return source.replace(pattern, '');
  });
  assert.throws(() => rejectsUnproven(mutant), assert.AssertionError);
});
test('NC-PV-06: removing the cloud flags makes the dark-build claim test fail', () => {
  const mutant = catalog(source => {
    assert.ok(source.includes('cloud_closet: cloudSync && cloudRestore && cloudMigration'));
    return source.replace('cloud_closet: cloudSync && cloudRestore && cloudMigration', 'cloud_closet: true');
  });
  assert.throws(() => assert.ok(!ids(mutant, { ...FLAGS, cloudSync: false }).includes('cloud_closet')), assert.AssertionError);
});
test('NC-PV-07: unconfirmed service posture remains hidden even with runtime evidence', () => {
  const hidden = subject => assert.deepEqual(subject.resolveActivationCapabilities(FLAGS,
    Object.fromEntries(Object.keys(server).map(id => [id, { status: 'unconfirmed', basis: 'fixture' }])), {}, context), []);
  hidden(catalog());
  assert.throws(() => hidden(catalog(source => {
    const target = 'const status = serverEnablement[id]?.status;';
    assert.ok(source.includes(target));
    return source.replace(target, target + "\nif (status === 'unconfirmed') return true;");
  })), assert.AssertionError);
});

test('NC-PV-02 / NC-PV-03: real Packing handler refuses client-only access and a lapse during retrieval', async () => {
  const directory = 'supabase/functions/stylechat-generate';
  function loadHandler(mutate) {
    const cache = new Map();
    function load(relative) {
      if (cache.has(relative)) return cache.get(relative);
      assert.ok(relative.startsWith(directory + '/'), 'only the pure Packing closure');
      const modules = new Proxy({}, {
        has: (_target, specifier) => typeof specifier === 'string' && specifier.startsWith('.'),
        getOwnPropertyDescriptor: (_target, specifier) => typeof specifier === 'string' && specifier.startsWith('.') ? { configurable: true, enumerable: true } : undefined,
        get: (_target, specifier) => load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))),
      });
      const exports = runModule(relative, modules, { jsx: false, ...(relative.endsWith('/packingHandler.ts') ? { mutate } : {}) });
      cache.set(relative, exports); return exports;
    }
    return { handler: load(directory + '/packingHandler.ts'), contract: load(directory + '/packingContract.ts') };
  }
  async function verify(mutate, lapse) {
    const { handler, contract } = loadHandler(mutate);
    const request = contract.parsePackingRequest({ schemaVersion: 'packing-plan-v1', sessionId: '10000000-0000-4000-8000-000000000001', trip: { destination: 'Synthetic', startDate: '2026-10-20', endDate: '2026-10-23', tripType: 'city', activities: ['dinner'] } });
    assert.equal(request.ok, true);
    let checks = 0, reads = 0, provider = 0, quota = 0;
    const result = await handler.handlePackingRequest({ request, actorId: '10000000-0000-4000-8000-000000000002', requestId: 'synthetic',
      hasActiveKPlus: async () => { checks++; return lapse && checks === 1; },
      closet: { listClosetItems: async () => { reads++; return []; } },
      reserveDailyGeneration: async () => { quota++; return { status: 'reserved' }; },
      callProvider: async () => { provider++; return {}; }, now: () => 0, makePlanId: () => 'synthetic' });
    assert.equal(result.httpStatus, 403); assert.equal(result.body.status, 'not_entitled');
    assert.equal(reads, lapse ? 1 : 0); assert.equal(provider, 0); assert.equal(quota, 0);
  }
  await verify(undefined, false); await verify(undefined, true);
  await assert.rejects(verify(source => {
    assert.ok(source.includes('entitled = await deps.hasActiveKPlus();'));
    return source.replace('entitled = await deps.hasActiveKPlus();', 'entitled = true;');
  }, false), assert.AssertionError);
  await assert.rejects(verify(source => {
    assert.ok(source.includes('stillEntitled = await deps.hasActiveKPlus();'));
    return source.replace('stillEntitled = await deps.hasActiveKPlus();', 'stillEntitled = true;');
  }, true), assert.AssertionError);
});

test('NC-PV-09: canonical Watch creation cannot replace the entitlement RPC with client state', () => {
  const file = path.join(ROOT, 'supabase/migrations/20260830190500_watchlist_create_honours_changed_intent.sql');
  const source = fs.readFileSync(file, 'utf8');
  function verify(sql) {
    assert.match(sql, /if not public\.kplus_has_active_entitlement\(p_user_id, 'k_plus'\) then/);
    assert.match(sql, /revoke all on function public\.create_user_commerce_watch\([^;]+from public, anon, authenticated;/);
  }
  verify(source);
  const target = "if not public.kplus_has_active_entitlement(p_user_id, 'k_plus') then";
  assert.ok(source.includes(target));
  assert.throws(() => verify(source.replace(target, 'if false then')), assert.AssertionError);
});
test('P1-WATCH-LAPSE + NC-PV-WATCH-LAPSE execute the fresh provider boundary', async () => {
  const rel = 'supabase/functions/commerce-watch-refresh/watchEntitlementGuard.ts';
  async function contract(guard) {
    let active = true, calls = 0;
    const observe = async () => { calls++; return 'observation'; };
    const read = async () => active;
    assert.equal(await guard('synthetic', read, observe), 'observation');
    active = false;
    assert.equal(await guard('synthetic', read, observe), null);
    assert.equal(calls, 1);
    active = true;
    assert.equal(await guard('synthetic', read, observe), 'observation');
    assert.equal(calls, 2);
    assert.equal(await guard('synthetic', async () => { throw Error('unavailable'); }, observe), null);
    assert.equal(calls, 2);
  }
  await contract(runModule(rel, {}, { jsx: false }).runEntitledWatchObservation);
  const mutant = runModule(rel, {}, { jsx: false, mutate: source => {
    assert.ok(source.includes('if (active !== true) return null;'));
    return source.replace('if (active !== true) return null;', '');
  }});
  await assert.rejects(contract(mutant.runEntitledWatchObservation), assert.AssertionError);
  const index = fs.readFileSync(path.join(ROOT, 'supabase/functions/commerce-watch-refresh/index.ts'), 'utf8');
  assert.match(index, /runEntitledWatchObservation\(row\.user_id/);
  assert.match(index, /rpc\('kplus_has_active_entitlement'/);
  assert.match(index, /if \(!outcome\)[\s\S]*?skipped_not_kplus/);
});

test('an open memoized membership list removes expiring evidence without a VTO network read', () => {
  function contract(mutate) {
    const renderer = createRenderer();
    let now = Date.now();
    const expiration = now + 60_000;
    const liveRecords = records.map(record => ({ ...record, provenAt: new Date(now - 1000).toISOString(), expiresAt: new Date(expiration).toISOString() }));
    const getContext = () => ({ ...context, records: liveRecords, nowMs: now });
    const callbacks = [];
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay) => { assert.ok(delay > 0); callbacks.push(callback); return 0; };
    try {
      const hook = runModule('hooks/useKPlusLiveCapabilitySignals.ts', {
        ...renderer.runtimeModules,
        '../constants/featureFlags': { VTO_UI_ENABLED: false },
        '../services/kplus/kplusLiveCapabilitySignals': { readKPlusLiveCapabilityState: () => { throw Error('no VTO read needed'); } },
        '../services/kplus/kplusCapabilityProof': { capabilityProofContext: getContext },
      }, { jsx: false, mutate });
      let displayed;
      function Membership() {
        const { signals } = hook.useKPlusLiveCapabilitySignals();
        displayed = renderer.runtimeModules.react.useMemo(() => ids(catalog(), FLAGS, getContext()), [signals]);
        return null;
      }
      const element = renderer.jsx(Membership, {});
      renderer.render(element);
      assert.equal(displayed.length, 3); assert.ok(callbacks.length > 0);
      now = expiration + 1;
      callbacks[0](); renderer.render(element);
      assert.deepEqual(displayed, []);
    } finally { globalThis.setTimeout = originalTimeout; }
  }
  contract();
  assert.throws(() => contract(source => {
    const refresh = 'setResult(current => ({ ...current, signals: { ...current.signals } }));';
    assert.ok(source.includes(refresh)); return source.replace(refresh, '');
  }), assert.AssertionError);
});
