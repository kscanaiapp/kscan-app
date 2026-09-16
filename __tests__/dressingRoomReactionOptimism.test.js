const test = require('node:test');
const assert = require('node:assert/strict');

const { applyOptimisticReaction } = require('../services/dressingRoomReactionOptimism.ts');

test('no reaction -> tapping an emoji adds it and increments its count', () => {
  const result = applyOptimisticReaction({
    current: null,
    tapped: 'love',
    counts: { love: 4, like: 2 },
  });

  assert.equal(result.nextSelection, 'love');
  assert.equal(result.active, true);
  assert.deepEqual(result.nextCounts, { love: 5, like: 2 });
});

test('tapping the currently-selected emoji clears it and decrements its count', () => {
  const result = applyOptimisticReaction({
    current: 'love',
    tapped: 'love',
    counts: { love: 4, like: 2 },
  });

  assert.equal(result.nextSelection, null);
  assert.equal(result.active, false);
  assert.deepEqual(result.nextCounts, { love: 3, like: 2 });
});

test('changing from one emoji to another moves the count in one step (no visible remove-then-add)', () => {
  const result = applyOptimisticReaction({
    current: 'love',
    tapped: 'fire',
    counts: { love: 4, fire: 2 },
  });

  assert.equal(result.nextSelection, 'fire');
  assert.equal(result.active, true);
  assert.deepEqual(result.nextCounts, { love: 3, fire: 3 });
});

test('a count never goes negative even if local counts are behind the server', () => {
  const result = applyOptimisticReaction({
    current: 'love',
    tapped: 'love',
    counts: { love: 0 },
  });

  assert.equal(result.nextCounts.love, 0);
});

test('a non-finite or missing count is treated as zero before applying the delta', () => {
  const result = applyOptimisticReaction({
    current: null,
    tapped: 'love',
    counts: { love: Number.NaN },
  });

  assert.equal(result.nextCounts.love, 1);
});

test('the tapped reaction type that was not previously counted starts from zero', () => {
  const result = applyOptimisticReaction({
    current: null,
    tapped: 'looking',
    counts: {},
  });

  assert.equal(result.nextCounts.looking, 1);
});

test('does not mutate the input counts object', () => {
  const counts = { love: 4 };
  applyOptimisticReaction({ current: null, tapped: 'love', counts });
  assert.deepEqual(counts, { love: 4 });
});
