const test = require('node:test'), assert = require('node:assert/strict');
const { rig, trip, wirePlan, settle, byTestId, textContent } = require('./helpers/packingSourceRig');
for (const os of ['ios', 'android'])
    test(os + ': actual mounted trip submit -> transport -> plan, failed regeneration -> retry', async () => {
        const r = rig(os);
        try {
            r.store.beginPackingRequest({
                actorId: 'actor-a', sessionId: 'seed', trip
            });
            r.store.applyPackingFailure({
                actorId: 'actor-a', message: 'Previous interruption', errorCode: 'TEST', retryable: true
            });
            r.screen();
            assert.equal(r.node('packing-submit').props.disabled, false);
            r.node('packing-submit').props.onPress();
            assert.equal(r.calls.length, 1);
            assert.equal(r.calls[0].name, 'stylechat-generate');
            assert.equal(r.calls[0].args.body.trip.destination, 'Paris');
            assert.ok(byTestId(r.render(), 'packing-loading').length);
            r.succeed();
            await settle();
            assert.ok(byTestId(r.render(), 'packing-plan').length);
            assert.match(textContent(r.node('packing-message')), /Your plan/);
            r.node('packing-toggle-light').props.onPress();
            r.fail(1);
            await settle();
            assert.ok(byTestId(r.render(), 'packing-error').length);
            assert.ok(byTestId(r.render(), 'packing-plan').length, 'last authoritative plan survives failure');
            r.node('packing-retry').props.onPress();
            assert.equal(r.calls.length, 3);
            r.succeed(2, wirePlan('retry-plan'));
            await settle();
            assert.equal(r.api.plan.planId, 'retry-plan');
            assert.equal(byTestId(r.render(), 'packing-error').length, 0);
        }
        finally {
            r.unmount();
        }
    });
test('supersession refuses late A response after B completes including disk write', async () => {
    const r = rig();
    try {
        const a = r.api.generate(trip), b = r.api.generate({
            ...trip, destination: 'Rome'
        });
        r.succeed(1, wirePlan('new', 'Rome'));
        await b;
        r.succeed(0, wirePlan('old'));
        await a;
        assert.equal(r.api.plan.planId, 'new');
        assert.equal(JSON.parse([...r.disk.values()][0]).plan.planId, 'new');
    }
    finally {
        r.unmount();
    }
});
test('actor A-B-A epochs reject the original response and cache mutation', async () => {
    const r = rig();
    try {
        const pending = r.api.generate(trip);
        r.switchActor('actor-b');
        r.switchActor('actor-a');
        r.succeed();
        await pending;
        assert.equal(r.api.plan, null);
        assert.equal(r.disk.size, 0);
    }
    finally {
        r.unmount();
    }
});
test('401 after partial data and wrong-schema success never become cached success; retry keeps trip', async () => {
    const r = rig();
    try {
        let pending = r.api.generate(trip);
        r.calls[0].resolve({
            data: {
                status: 'success', plan: wirePlan()
            }, error: { status: 401 }
        });
        await pending;
        assert.equal(r.api.status, 'failed');
        assert.equal(r.api.plan, null);
        assert.equal(r.disk.size, 0);
        pending = r.api.regenerate();
        r.succeed(1, { unexpected: true });
        await pending;
        assert.equal(r.api.status, 'failed');
        assert.equal(r.api.errorCode, 'PACKING_BAD_RESPONSE');
        assert.equal(r.api.trip.destination, 'Paris');
        assert.equal(r.disk.size, 0);
    }
    finally {
        r.unmount();
    }
});
test('cache-write failure does not fabricate loss of an authoritative successful plan', async () => {
    const r = rig();
    try {
        r.setDiskFailure(true);
        const p = r.api.generate(trip);
        r.succeed();
        await p;
        await settle();
        assert.equal(r.api.status, 'ready');
        assert.equal(r.disk.size, 0);
    }
    finally {
        r.unmount();
    }
});
test('two cumulative refinements serialize and retain both notes', async () => {
    const r = rig();
    try {
        let p = r.api.generate(trip);
        r.succeed();
        await p;
        const a = r.api.refineWith('More formal'), b = r.api.refineWith('Rain friendly');
        await settle();
        assert.equal(r.calls.length, 2);
        r.succeed(1, {
            ...wirePlan('refine-1'), constraints: {
                excludedItemIds: [], notes: ['More formal'], packLight: false
            }
        });
        await a;
        await settle();
        assert.equal(r.calls.length, 3);
        assert.deepEqual(r.calls[2].args.body.constraints.notes, ['More formal', 'Rain friendly']);
        r.succeed(2, {
            ...wirePlan('refine-2'), constraints: {
                excludedItemIds: [], notes: ['More formal', 'Rain friendly'], packLight: false
            }
        });
        await b;
        assert.equal(r.api.plan.planId, 'refine-2');
    }
    finally {
        r.unmount();
    }
});
test('invalid non-object cache plan is absent rather than a restored result', async () => {
    const key = 'kscan/packing/plan/v1/actor-a';
    const r = rig('ios', { [key]: JSON.stringify({
            actorId: 'actor-a', cachedAt: Date.now(), plan: {}, message: 'not validated'
        }) });
    try {
        assert.equal(await r.cache.readCachedPackingPlan('actor-a'), null);
    }
    finally {
        r.unmount();
    }
});
test('corrupted cached items never crash the mounted Packing screen', async () => {
    const key = 'kscan/packing/plan/v1/actor-a', bad = {
        ...wirePlan(), packedItems: null
    };
    const r = rig('ios', { [key]: JSON.stringify({
            actorId: 'actor-a', cachedAt: Date.now(), plan: bad, message: 'Cached result'
        }) });
    try {
        r.screen();
        await settle();
        assert.doesNotThrow(() => r.render());
        assert.equal(r.api.plan, null);
        assert.equal(r.calls.length, 0);
    }
    finally {
        r.unmount();
    }
});
for (const os of ['ios', 'android'])
    test(os + ': valid cached plan, checklist and refinement highlight restore visibly without network', async () => {
        const key = 'kscan/packing/plan/v1/actor-a', plan = {
            ...wirePlan(), changes: [{
                    outfitIndex: 0, removedItemIds: ['old-shirt'], addedItemIds: ['item-1']
                }]
        }, cachedAt = Date.now() - 3600000;
        const r = rig(os, { [key]: JSON.stringify({
                actorId: 'actor-a', cachedAt, plan, message: 'Saved result', packedOff: ['item-1']
            }) });
        try {
            r.screen();
            await settle();
            assert.ok(byTestId(r.render(), 'packing-offline-banner').length);
            assert.ok(byTestId(r.render(), 'packing-plan').length);
            assert.equal(r.api.restoredFrom, cachedAt);
            assert.deepEqual(r.api.packedOff, ['item-1']);
            assert.deepEqual(r.api.plan.changes, plan.changes);
            assert.equal(r.calls.length, 0);
        }
        finally {
            r.unmount();
        }
    });
test('cache and network share the same pure plan validator with no transport initialization', () => {
    const fs = require('node:fs'), path = require('node:path'), root = path.resolve(__dirname, '..'), parser = fs.readFileSync(path.join(root, 'services/packing/packingResponse.ts'), 'utf8');
    assert.doesNotMatch(parser, /supabaseClient|AsyncStorage|\bfetch\(/);
    const r = rig();
    try {
        assert.equal(typeof r.client.parsePackingPlan, 'function');
        assert.equal(r.client.parsePackingPlan({}), null);
    }
    finally {
        r.unmount();
    }
});
test('malformed cached nested values are dropped or normalized before actual rendering', async () => {
    const plan = wirePlan();
    plan.weather = {
        provenance: 'FORECAST', summary: { bad: true }
    };
    plan.packedItems[0].title = { bad: true };
    plan.outfits[0].label = { bad: true };
    plan.counts = { items: { bad: true } };
    plan.changes = [{
            outfitIndex: 0, removedItemIds: [{ bad: true }], addedItemIds: null
        }, {
            outfitIndex: 99, removedItemIds: [], addedItemIds: []
        }];
    const r = rig('android', { 'kscan/packing/plan/v1/actor-a': JSON.stringify({
            actorId: 'actor-a', cachedAt: Date.now(), plan, message: { bad: true }
        }) });
    try {
        r.screen();
        await settle();
        assert.doesNotThrow(() => r.render());
        assert.equal(r.api.plan.counts.items, 2);
        assert.equal(r.api.plan.weather.summary, null);
        assert.deepEqual(r.api.plan.changes, [{
                outfitIndex: 0, removedItemIds: [], addedItemIds: []
            }]);
        assert.equal(r.calls.length, 0);
    }
    finally {
        r.unmount();
    }
});
