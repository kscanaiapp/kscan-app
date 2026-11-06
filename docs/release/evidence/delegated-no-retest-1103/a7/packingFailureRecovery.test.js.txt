// Issue #705 — mounted Packing failure recovery. Every case drives the real
// screen -> hook -> store -> packingClient path with a controlled transport, and
// asserts what the traveller actually sees: the message, whether TRY AGAIN is
// offered, and that the last authoritative plan is never replaced or cached.
const test = require('node:test'), assert = require('node:assert/strict');
const { rig, trip, wirePlan, settle, byTestId, textContent } = require('./helpers/packingSourceRig');

// supabase-js hands a non-2xx Edge response back as FunctionsHttpError whose
// `context` is the fetch Response; its body can be read exactly once.
function httpError(status, body) {
    let read = false;
    return { name: 'FunctionsHttpError', context: { status, json: async () => {
                if (read) throw new TypeError('Body is unusable');
                read = true;
                return body;
            } } };
}
const envelope = (fields) => ({ contractVersion: 'packing_plan_v1', requestId: 'req-1', plan: null, generalGuide: null, ...fields });

// The trip form is prefilled from the store, exactly as after an earlier
// interrupted attempt, so the real SUBMIT button dispatches.
function mountWithTrip(r) {
    r.store.beginPackingRequest({ actorId: 'actor-a', sessionId: 'seed', trip });
    r.store.applyPackingFailure({ actorId: 'actor-a', message: 'Previous interruption', errorCode: 'TEST', retryable: true });
    r.screen();
}
async function failFirstGeneration(r, outcome) {
    mountWithTrip(r);
    r.node('packing-submit').props.onPress();
    assert.equal(r.calls.length, 1);
    outcome(r);
    await settle();
}
const seen = r => ({
    error: byTestId(r.render(), 'packing-error').length > 0,
    message: textContent(r.node('packing-error')),
    retry: byTestId(r.render(), 'packing-retry').length > 0,
    plan: byTestId(r.render(), 'packing-plan').length > 0,
});

test('A7-PK-01 consent 403 shows the Privacy settings instruction and no TRY AGAIN', async () => {
    const r = rig();
    try {
        await failFirstGeneration(r, r => r.fail(0, httpError(403, { errorCode: 'AI_PROCESSING_CONSENT_REQUIRED', error: 'consent required' })));
        const ui = seen(r);
        assert.ok(ui.error);
        assert.match(ui.message, /Privacy settings/);
        assert.equal(ui.retry, false);
        assert.equal(r.api.errorCode, 'AI_PROCESSING_CONSENT_REQUIRED');
        assert.equal(r.disk.size, 0, 'nothing cached');
    }
    finally { r.unmount(); }
});

test('A7-PK-02 a K+ lapse the server reports as 403 is not presented as a connection problem', async () => {
    const r = rig();
    try {
        await failFirstGeneration(r, r => r.fail(0, httpError(403, envelope({ status: 'not_entitled', message: 'Packing plans are part of K+.', errorCode: 'PACKING_REQUIRES_KPLUS' }))));
        const ui = seen(r);
        assert.doesNotMatch(ui.message, /connection/i);
        assert.match(ui.message, /part of K\+/);
        assert.equal(ui.retry, false, 'retrying cannot restore an entitlement');
        assert.equal(r.api.errorCode, 'PACKING_REQUIRES_KPLUS');
    }
    finally { r.unmount(); }
});

test('A7-PK-03 a 500 usage-check failure keeps its server explanation and stays retryable', async () => {
    const r = rig();
    try {
        await failFirstGeneration(r, r => r.fail(0, httpError(500, envelope({ status: 'error', message: 'I could not check your daily usage just now. Please try again.', errorCode: 'PACKING_USAGE_CHECK_FAILED' }))));
        const ui = seen(r);
        assert.match(ui.message, /daily usage/);
        assert.equal(ui.retry, true);
    }
    finally { r.unmount(); }
});

test('A7-PK-04 the daily limit does not offer a TRY AGAIN that cannot succeed today', async () => {
    const r = rig();
    try {
        await failFirstGeneration(r, r => r.calls[0].resolve({ data: envelope({ status: 'error', message: "You've used today's Elise generations. Your packing plan will be here tomorrow.", errorCode: 'PACKING_LIMIT_REACHED' }), error: null }));
        const ui = seen(r);
        assert.match(ui.message, /tomorrow/);
        assert.equal(ui.retry, false);
    }
    finally { r.unmount(); }
});

test('A7-PK-05 the per-minute burst limit (HTTP 200 envelope) explains itself and is retryable', async () => {
    const r = rig();
    try {
        await failFirstGeneration(r, r => r.calls[0].resolve({ data: envelope({ status: 'error', message: 'You are packing faster than I can keep up. Try again in a moment.', errorCode: 'PACKING_BURST_LIMIT' }), error: null }));
        const ui = seen(r);
        assert.match(ui.message, /faster than I can keep up/);
        assert.equal(ui.retry, true);
    }
    finally { r.unmount(); }
});

test('A7-PK-06 provider failure and malformed/empty bodies fail honestly, retryably, and cache nothing', async () => {
    for (const data of [
        envelope({ status: 'error', message: 'I could not finish your packing plan just now. Your trip details are still here — try again.', errorCode: 'PACKING_GENERATION_FAILED' }),
        null,
        '<html>502</html>',
        { status: 'success', message: 'Done', plan: { planId: 'p', trip: { destination: 'Paris' }, packedItems: [], outfits: [] } },
    ]) {
        const r = rig();
        try {
            await failFirstGeneration(r, r => r.calls[0].resolve({ data, error: null }));
            const ui = seen(r);
            assert.ok(ui.error, JSON.stringify(data));
            assert.equal(ui.retry, true);
            assert.equal(ui.plan, false);
            assert.doesNotMatch(ui.message, /saved|ready|done/i);
            assert.equal(r.disk.size, 0);
        }
        finally { r.unmount(); }
    }
});

test('A7-PK-07 a hung request that hits the client timeout says it took too long, not "check your connection"', async () => {
    const r = rig();
    const realSetTimeout = global.setTimeout;
    try {
        // Fire the client's 30s abort immediately; supabase-js reports the abort
        // as a returned FunctionsFetchError, never a throw.
        mountWithTrip(r);
        global.setTimeout = (fn) => { fn(); return 0; };
        r.node('packing-submit').props.onPress();
        global.setTimeout = realSetTimeout;
        assert.equal(r.calls[0].args.signal.aborted, true);
        r.fail(0, { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function', context: { name: 'AbortError' } });
        await settle();
        const ui = seen(r);
        assert.match(ui.message, /took too long/);
        assert.equal(ui.retry, true);
        assert.equal(r.api.errorCode, 'PACKING_TIMEOUT');
    }
    finally { global.setTimeout = realSetTimeout; r.unmount(); }
});

test('A7-PK-08 a failed refresh keeps the last plan and does not narrate the error as Elise plan copy', async () => {
    const r = rig();
    try {
        mountWithTrip(r);
        r.node('packing-submit').props.onPress();
        r.succeed(0, wirePlan('plan-ok'));
        await settle();
        const cachedBefore = [...r.disk.values()].join('');
        r.node('packing-toggle-light').props.onPress();
        r.fail(1, httpError(500, envelope({ status: 'error', message: 'I could not check your daily usage just now. Please try again.', errorCode: 'PACKING_USAGE_CHECK_FAILED' })));
        await settle();
        const ui = seen(r);
        assert.ok(ui.error);
        assert.ok(ui.plan, 'plan stays');
        assert.equal(r.api.plan.planId, 'plan-ok');
        assert.equal([...r.disk.values()].join(''), cachedBefore, 'cache untouched by a failure');
        const narration = byTestId(r.render(), 'packing-message').map(textContent).join(' ');
        assert.doesNotMatch(narration, /daily usage/, 'the failure is not narrated over the plan');
        assert.equal((r.render() && textContent(r.node('packing-error')).match(/daily usage/g) || []).length, 1);
    }
    finally { r.unmount(); }
});
