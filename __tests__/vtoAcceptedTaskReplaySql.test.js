const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const ACTOR = '11111111-2222-4333-8444-555555555555';
const OTHER_ACTOR = '99999999-8888-4777-8666-555555555555';
const KEY = 'synthetic-original-intent';
const RECEIPT = 'synthetic-task-receipt';
const MIGRATIONS = [
  '20260831130000_vto_generation_reservations.sql',
  '20260831160000_vto_paid_quota_attempt_counting.sql',
  '20261016001500_vto_attempt_scoped_settlement.sql',
  '20261123183230_vto_fence_accepted_task_replay.sql',
];

test('a failed accepted task still owns its original intent and quota', async (t) => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;`);
  await db.query('insert into auth.users values ($1), ($2)', [ACTOR, OTHER_ACTOR]);
  for (const migration of MIGRATIONS) {
    await db.exec(readFileSync(join(__dirname, '../supabase/migrations', migration), 'utf8'));
  }
  await db.exec('set role service_role');

  const reserve = async (actor, key) => (await db.query(
    'select * from public.reserve_vto_generation_v2($1, $2, 3)', [actor, key],
  )).rows[0];
  const first = await reserve(ACTOR, KEY);
  assert.equal(first.outcome, 'reserved');
  const record = await db.query(
    "select public.record_vto_task_v2($1, $2, $3, $4, 'test') as ok",
    [ACTOR, KEY, first.attempt_id, RECEIPT],
  );
  assert.equal(record.rows[0].ok, true);
  const settled = await db.query(
    "select public.settle_vto_generation_v2($1, $2, $3, 'failed', 'test') as ok",
    [ACTOR, KEY, first.attempt_id],
  );
  assert.equal(settled.rows[0].ok, true);

  for (let replay = 0; replay < 2; replay += 1) {
    const original = await reserve(ACTOR, KEY);
    assert.deepEqual(original, {
      outcome: 'duplicate', used: 1, daily_limit: 3, prior_status: 'failed',
      attempt_id: first.attempt_id, provider_task_id: RECEIPT,
    });
  }
  const deliberateRetry = await reserve(ACTOR, 'synthetic-new-intent');
  assert.equal(deliberateRetry.outcome, 'reserved');
  assert.notEqual(deliberateRetry.attempt_id, first.attempt_id);
  assert.equal(deliberateRetry.used, 2);
  const otherActor = await reserve(OTHER_ACTOR, KEY);
  assert.equal(otherActor.outcome, 'reserved');
  assert.equal(otherActor.provider_task_id, null);

  await db.exec('reset role; set role authenticated');
  await assert.rejects(reserve(ACTOR, KEY), { code: '42501' });
});
