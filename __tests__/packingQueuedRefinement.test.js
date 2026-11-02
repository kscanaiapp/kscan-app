'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rig, trip, wirePlan, settle } = require('./helpers/packingSourceRig');

async function initialPlan(r) {
  const pending = r.api.generate(trip);
  r.succeed();
  await pending;
}

async function cleanup(r, ...pending) {
  for (const call of r.calls) call.resolve({ data: null, error: { status: 499 } });
  await Promise.allSettled(pending);
  r.unmount();
}

test('Packing queued refinement cannot cross an A-B-A epoch into a new trip', async () => {
  const r = rig();
  let first, queued;
  try {
    await initialPlan(r);
    first = r.api.refineWith('Old trip first note');
    queued = r.api.refineWith('Old trip queued note');
    await settle();
    assert.equal(r.calls.length, 2);

    r.switchActor('actor-b');
    r.switchActor('actor-a');
    const fresh = r.api.generate({ ...trip, destination: 'Rome' });
    r.succeed(2, wirePlan('new-trip', 'Rome'));
    await fresh;
    r.succeed(1, wirePlan('departed-trip'));
    await Promise.all([first, queued]);

    assert.equal(r.calls.length, 3, 'no extra provider-bound request after an actor epoch change');
    assert.equal(r.api.status, 'ready');
    assert.equal(r.api.plan.planId, 'new-trip');
    assert.deepEqual(r.api.constraintNotes, []);
  } finally {
    await cleanup(r, first, queued);
  }
});

test('Packing queued refinement cannot follow a new trip within the same actor epoch', async () => {
  const r = rig();
  let first, queued;
  try {
    await initialPlan(r);
    first = r.api.refineWith('Original trip first note');
    queued = r.api.refineWith('Original trip queued note');
    await settle();
    const oldSession = r.calls[1].args.body.sessionId;
    const fresh = r.api.generate({ ...trip, destination: 'Rome' });
    assert.notEqual(r.calls[2].args.body.sessionId, oldSession);
    r.succeed(2, wirePlan('new-trip', 'Rome'));
    await fresh;
    r.succeed(1, wirePlan('old-trip'));
    await Promise.all([first, queued]);

    assert.equal(r.calls.length, 3);
    assert.equal(r.api.plan.planId, 'new-trip');
    assert.deepEqual(r.api.constraintNotes, []);
  } finally {
    await cleanup(r, first, queued);
  }
});

test('Packing current-session refinements still accumulate and dispatch in order', async () => {
  const r = rig();
  let first, queued;
  try {
    await initialPlan(r);
    first = r.api.refineWith('More formal');
    queued = r.api.refineWith('Rain friendly');
    await settle();
    assert.equal(r.calls.length, 2);
    assert.deepEqual(r.calls[1].args.body.constraints.notes, ['More formal']);
    r.succeed(1, {
      ...wirePlan('formal'),
      constraints: { excludedItemIds: [], notes: ['More formal'], packLight: false },
    });
    await first;
    await settle();
    assert.equal(r.calls.length, 3);
    assert.deepEqual(r.calls[2].args.body.constraints.notes, ['More formal', 'Rain friendly']);
    r.succeed(2, {
      ...wirePlan('final'),
      constraints: { excludedItemIds: [], notes: ['More formal', 'Rain friendly'], packLight: false },
    });
    await queued;
    assert.equal(r.api.plan.planId, 'final');
  } finally {
    await cleanup(r, first, queued);
  }
});

test('Packing a failed refinement does not strand the next authorized queued refinement', async () => {
  const r = rig();
  let first, queued;
  try {
    await initialPlan(r);
    first = r.api.refineWith('More formal');
    queued = r.api.refineWith('Rain friendly');
    await settle();
    r.fail(1, { status: 500 });
    await first;
    await settle();
    assert.equal(r.calls.length, 3);
    assert.deepEqual(r.calls[2].args.body.constraints.notes, ['More formal', 'Rain friendly']);
    r.succeed(2, {
      ...wirePlan('recovered'),
      constraints: { excludedItemIds: [], notes: ['More formal', 'Rain friendly'], packLight: false },
    });
    await queued;
    assert.equal(r.api.status, 'ready');
    assert.equal(r.api.plan.planId, 'recovered');
  } finally {
    await cleanup(r, first, queued);
  }
});
