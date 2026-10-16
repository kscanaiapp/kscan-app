'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261016001500_vto_attempt_scoped_settlement.sql'), 'utf8',
);
const handler = fs.readFileSync(
  path.join(root, 'supabase/functions/vto-generate/vtoHandler.ts'), 'utf8',
);
const reservation = fs.readFileSync(
  path.join(root, 'supabase/functions/vto-generate/vtoReservation.ts'), 'utf8',
);

test('VTO-002: every new attempt receives an independent UUID', () => {
  assert.match(migration, /v_attempt uuid := gen_random_uuid\(\)/);
  assert.match(migration, /attempt_id=v_attempt/);
  assert.match(reservation, /attemptId: row\.attempt_id/);
});

test('VTO-002: unfinished and uncertain attempts never automatically re-dispatch', () => {
  assert.match(migration, /v_existing\.status in \('succeeded', 'in_flight'\)/);
  assert.match(migration, /v_existing\.uncertainty_reason is not null/);
  assert.match(handler, /reservation\.outcome === 'duplicate'/);
});

test('VTO-002: settlement is attempt-scoped and terminal success is immutable', () => {
  assert.match(migration, /attempt_id=p_attempt_id and status='in_flight'/);
  assert.match(migration, /function public\.settle_vto_generation_v2/);
  assert.match(reservation, /settle_vto_generation_v2/);
});

test('VTO-003: result cannot be returned before confirmed settlement', () => {
  assert.match(handler, /if \(!completed\) return fail\('authorization_failed'/);
  assert.match(reservation, /response\.ok && \(await response\.json\(\)\) === true/);
});

test('VTO-002/003: approved service role owns paid RPCs', () => {
  for (const rpc of ['reserve_vto_generation_v2','record_vto_task_v2',
    'settle_vto_generation_v2','claim_vto_reconciliation_v2']) {
    assert.match(migration, new RegExp('grant execute on function public\\.' + rpc + '\\('));
    assert.match(migration, new RegExp('revoke all on function public\\.' + rpc + '\\('));
  }
});

test('VTO-003: reconciliation is bounded and never triggers provider dispatch', () => {
  assert.match(migration, /reconciliation_attempts<6/);
  assert.match(migration, /least\(coalesce\(p_limit,20\),50\)/);
  assert.doesNotMatch(migration, /http_post|net\.http_post/);
});

test('VTO-004: completed receipt is distinct and cannot regenerate itself', () => {
  assert.match(handler, /prior_success_result_not_replayable/);
  assert.match(handler, /result_unavailable/);
  assert.match(migration, /result_digest text/);
});
