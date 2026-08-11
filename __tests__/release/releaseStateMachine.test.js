#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  ReleaseStateError,
  isValidTransition,
  applyTransition,
} = require('../../security/release/release-state-machine');

test('every state referenced by TRANSITIONS is a declared state (self-consistency)', () => {
  for (const s of STATES) assert.ok(s in TRANSITIONS, `missing transition table entry for ${s}`);
});

test('valid transitions are accepted', () => {
  const result = applyTransition({
    releaseId: 'rel-1', from: 'DRAFT', to: 'FROZEN', actor: 'AUTOMATION', timestamp: '2026-08-12T00:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.from, 'DRAFT');
  assert.equal(result.entry.to, 'FROZEN');
  assert.equal(result.entry.irreversible, false);
});

test('invalid transitions are rejected', () => {
  assert.equal(isValidTransition('DRAFT', 'PRODUCTION_VERIFIED'), false);
  assert.throws(
    () => applyTransition({ releaseId: 'rel-1', from: 'DRAFT', to: 'PRODUCTION_VERIFIED', actor: 'OWNER' }),
    (err) => err instanceof ReleaseStateError && err.code === 'INVALID_TRANSITION',
  );
});

test('unknown from/to states are rejected as INVALID_STATE, not silently coerced', () => {
  assert.throws(
    () => applyTransition({ releaseId: 'rel-1', from: 'NOT_A_STATE', to: 'FROZEN', actor: 'OWNER' }),
    { code: 'INVALID_STATE' },
  );
  assert.throws(
    () => applyTransition({ releaseId: 'rel-1', from: 'DRAFT', to: 'NOT_A_STATE', actor: 'OWNER' }),
    { code: 'INVALID_STATE' },
  );
});

test('CLOSED is terminal: no outbound transition exists', () => {
  assert.equal(TRANSITIONS.CLOSED.length, 0);
  assert.throws(
    () => applyTransition({ releaseId: 'rel-1', from: 'CLOSED', to: 'DRAFT', actor: 'OWNER' }),
    { code: 'TERMINAL_STATE' },
  );
});

test('AWAITING_PRODUCTION_APPROVAL -> PRODUCTION_DEPLOYING is OWNER-only and rejected for automation', () => {
  assert.throws(
    () => applyTransition({
      releaseId: 'rel-1', from: 'AWAITING_PRODUCTION_APPROVAL', to: 'PRODUCTION_DEPLOYING', actor: 'AUTOMATION',
    }),
    (err) => err instanceof ReleaseStateError && (err.code === 'UNAUTHORIZED_ACTOR' || err.code === 'OWNER_REQUIRED'),
  );
  assert.throws(
    () => applyTransition({
      releaseId: 'rel-1', from: 'AWAITING_PRODUCTION_APPROVAL', to: 'PRODUCTION_DEPLOYING', actor: 'AUTHORIZED_AGENT',
    }),
    { code: 'OWNER_REQUIRED' },
  );
  const owned = applyTransition({
    releaseId: 'rel-1', from: 'AWAITING_PRODUCTION_APPROVAL', to: 'PRODUCTION_DEPLOYING', actor: 'OWNER', actorId: 'justin',
  });
  assert.equal(owned.ok, true);
  assert.equal(owned.entry.irreversible, true);
});

test('no transition table entry grants AUTOMATION the AWAITING_PRODUCTION_APPROVAL -> PRODUCTION_DEPLOYING transition', () => {
  const t = TRANSITIONS.AWAITING_PRODUCTION_APPROVAL.find((x) => x.to === 'PRODUCTION_DEPLOYING');
  assert.ok(t, 'transition must exist');
  assert.deepEqual(t.actors, ['OWNER']);
});

test('transition history integrity: entry carries from/to/actor/reason/timestamp/releaseId', () => {
  const { entry } = applyTransition({
    releaseId: 'rel-42',
    from: 'STAGING_VERIFIED',
    to: 'AWAITING_PRODUCTION_APPROVAL',
    actor: 'AUTHORIZED_AGENT',
    actorId: 'ci-bot',
    reason: 'staging certification passed',
    timestamp: '2026-08-12T01:02:03.000Z',
  });
  assert.deepEqual(entry, {
    releaseId: 'rel-42',
    from: 'STAGING_VERIFIED',
    to: 'AWAITING_PRODUCTION_APPROVAL',
    actor: 'AUTHORIZED_AGENT',
    actorId: 'ci-bot',
    reason: 'staging certification passed',
    irreversible: false,
    timestamp: '2026-08-12T01:02:03.000Z',
  });
});

test('missing releaseId is rejected', () => {
  assert.throws(
    () => applyTransition({ from: 'DRAFT', to: 'FROZEN', actor: 'OWNER' }),
    { code: 'MISSING_RELEASE_ID' },
  );
});

test('unknown actor category is rejected', () => {
  assert.throws(
    () => applyTransition({ releaseId: 'rel-1', from: 'DRAFT', to: 'FROZEN', actor: 'RANDOM_PERSON' }),
    { code: 'INVALID_ACTOR' },
  );
});

// Fixtures below are deliberately SENTINELS, not realistic credentials: they
// match secret-shape-guard's regexes (so the guard is genuinely exercised) but
// spell out that they are not real tokens, so repository secret scanning and
// GitHub Push Protection do not fire on this file.
test('a credential-shaped reason or actorId is refused, never recorded', () => {
  assert.throws(
    () => applyTransition({
      releaseId: 'rel-1', from: 'DRAFT', to: 'FROZEN', actor: 'OWNER',
      reason: 'used token eyJNOT_A_REAL_TOKEN_ONLY_A_TEST_SENTINEL.placeholder',
    }),
    { code: 'EMBEDDED_SECRET_DETECTED' },
  );
  assert.throws(
    () => applyTransition({
      releaseId: 'rel-1', from: 'DRAFT', to: 'FROZEN', actor: 'OWNER',
      actorId: 'sbp_NOTAREALTOKENONLYATESTSENTINEL',
    }),
    { code: 'EMBEDDED_SECRET_DETECTED' },
  );
});

test('single-flight: a second release cannot enter AWAITING_PRODUCTION_APPROVAL while one is already there', () => {
  assert.throws(
    () => applyTransition({
      releaseId: 'rel-2', from: 'STAGING_VERIFIED', to: 'AWAITING_PRODUCTION_APPROVAL', actor: 'OWNER',
      otherActiveReleaseStates: ['AWAITING_PRODUCTION_APPROVAL'],
    }),
    { code: 'SINGLE_FLIGHT_VIOLATION' },
  );
  const ok = applyTransition({
    releaseId: 'rel-2', from: 'STAGING_VERIFIED', to: 'AWAITING_PRODUCTION_APPROVAL', actor: 'OWNER',
    otherActiveReleaseStates: ['STAGING_DEPLOYING'],
  });
  assert.equal(ok.ok, true);
});

test('failure/recovery branch is reachable end to end: STAGING_FAILED -> ROLLBACK_REQUIRED -> ROLLBACK_IN_PROGRESS -> ROLLED_BACK -> CLOSED', () => {
  const path = [
    ['STAGING_FAILED', 'ROLLBACK_REQUIRED', 'AUTOMATION'],
    ['ROLLBACK_REQUIRED', 'ROLLBACK_IN_PROGRESS', 'AUTOMATION'],
    ['ROLLBACK_IN_PROGRESS', 'ROLLED_BACK', 'AUTOMATION'],
    ['ROLLED_BACK', 'CLOSED', 'OWNER'],
  ];
  for (const [from, to, actor] of path) {
    const result = applyTransition({ releaseId: 'rel-3', from, to, actor });
    assert.equal(result.ok, true, `${from} -> ${to} as ${actor} should succeed`);
  }
});
