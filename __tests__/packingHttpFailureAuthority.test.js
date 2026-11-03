const test = require('node:test');
const assert = require('node:assert/strict');
const { rig, trip, wirePlan, settle, byTestId } = require('./helpers/packingSourceRig');

for (const status of [403, 429, 500]) {
  test(`Packing HTTP ${status} cannot replace or cache a plan from a success-shaped error body`, async () => {
    const r = rig();
    try {
      r.store.beginPackingRequest({ actorId: 'actor-a', sessionId: 'seed', trip });
      r.store.applyPackingFailure({ actorId: 'actor-a', message: 'Previous interruption', errorCode: 'TEST', retryable: true });
      r.screen();
      r.node('packing-submit').props.onPress();
      r.succeed(0, wirePlan('kept-authoritative-plan'));
      await settle();
      const saved = [...r.disk.values()];
      r.node('packing-toggle-light').props.onPress();
      let reads = 0;
      r.fail(1, { name: 'FunctionsHttpError', context: { status, json: async () => {
        reads++;
        return { contractVersion: 'packing_plan_v1', status: 'success', message: 'Your new plan', plan: wirePlan('failed-response-plan') };
      } } });
      await settle();
      assert.equal(reads, 1);
      assert.equal(r.api.status, 'failed', 'non-2xx transport cannot certify generation success');
      assert.equal(r.api.plan.planId, 'kept-authoritative-plan');
      assert.deepEqual([...r.disk.values()], saved, 'failed refresh cannot replace the cached plan');
      assert.equal(byTestId(r.render(), 'packing-error').length, 1);
    } finally {
      r.unmount();
    }
  });
}
