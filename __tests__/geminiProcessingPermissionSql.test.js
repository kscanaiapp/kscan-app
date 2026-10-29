const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
async function fixture() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;
    insert into auth.users values('${A}'),('${B}');`);
  for (const name of ['20260617000001_create_legal_acceptances.sql',
    '20260812031312_legal_acceptances_restore_ai_processing.sql',
    '20261029184000_gemini_processing_permission.sql']) {
    await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', name), 'utf8'));
  }
  return db;
}
async function actor(db, id, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(`set role ${role}`);
}
const read = async (db, expected = A) => (await db.query(
  'select public.get_ai_processing_permission($1::uuid) as result', [expected])).rows[0].result;
const set = async (db, granted, expected = A, revision) => {
  const currentRevision = revision ?? (await read(db, expected)).revision;
  return (await db.query('select public.set_ai_processing_permission($1::uuid,$2::boolean,$3::bigint) as result',
    [expected, granted, currentRevision])).rows[0].result;
};
async function receipt(db, user = A, version = 'v2_google_gemini') {
  await db.query("insert into public.legal_acceptances(user_id,acceptance_type,policy_version) values($1,'ai_processing',$2)", [user, version]);
}
test('actual permission migration: immutable receipts, withdrawal/re-consent, isolation, direct-write refusal and deletion', async (t) => {
  const db = await fixture();
  try {
    await actor(db, A);
    await t.test('no receipt or legacy receipt cannot grant; withdrawal remains allowed', async () => {
      assert.equal((await read(db)).granted, false);
      await assert.rejects(set(db, true), (e) => e.code === '42501');
      await receipt(db, A, 'v1');
      await assert.rejects(set(db, true), (e) => e.code === '42501');
      assert.equal((await set(db, false)).granted, false);
    });
    await receipt(db);
    const historical = (await db.query('select * from legal_acceptances order by policy_version')).rows;
    await t.test('current receipt does not override withdrawal; affirmative re-consent does', async () => {
      assert.equal((await read(db)).granted, false);
      assert.equal((await set(db, true)).granted, true);
      assert.equal((await set(db, false)).granted, false);
      assert.equal((await set(db, false)).granted, false, 'withdrawal replay is idempotent');
      assert.deepEqual((await db.query('select * from legal_acceptances order by policy_version')).rows, historical);
    });
    await t.test('User A cannot target User B or use a null identity fence', async () => {
      await assert.rejects(read(db, B), (e) => e.code === '42501');
      await assert.rejects(set(db, true, B, 0), (e) => e.code === '42501');
      await assert.rejects(set(db, false, null, 0), (e) => e.code === '42501');
      await assert.rejects(set(db, null), (e) => e.code === '22023');
      await assert.rejects(read(db, A + "' OR 1=1--"), (e) => e.code === '22P02');
    });
    await t.test('a delayed grant cannot overwrite a newer withdrawal, while repeated withdrawal stays off', async () => {
      const prior = await read(db);
      const withdrawn = await set(db, false);
      assert.ok(withdrawn.revision > prior.revision);
      await assert.rejects(set(db, true, A, prior.revision), (e) => e.code === '40001');
      assert.equal((await read(db)).granted, false);
      assert.equal((await set(db, false, A, prior.revision)).granted, false);
      assert.equal((await db.query('select count(*)::int as n from ai_processing_permissions')).rows[0].n, 1);
    });
    await t.test('no client direct insert/update/delete can bypass the guarded RPC', async () => {
      await assert.rejects(db.query('update ai_processing_permissions set granted=true where user_id=$1', [A]), (e) => e.code === '42501');
      await assert.rejects(db.query('delete from ai_processing_permissions where user_id=$1', [A]), (e) => e.code === '42501');
      await assert.rejects(db.query("insert into ai_processing_permissions(user_id,policy_version,granted) values($1,'v2_google_gemini',true)", [B]), (e) => e.code === '42501');
    });
    await t.test('simultaneous grant intents share one revision; duplicate withdrawal cannot create extra rows', async () => {
      const prior = await read(db);
      const grants = await Promise.allSettled([set(db, true, A, prior.revision), set(db, true, A, prior.revision)]);
      assert.equal(grants.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(grants.filter((r) => r.status === 'rejected' && r.reason.code === '40001').length, 1);
      const active = await read(db);
      const withdrawals = await Promise.all([set(db, false, A, active.revision), set(db, false, A, active.revision)]);
      assert.ok(withdrawals.every((r) => r.granted === false));
      assert.equal((await db.query('select count(*)::int as n from ai_processing_permissions')).rows[0].n, 1);
    });
    await t.test('account-switch fence rejects stale A action under B authority; foreign rows hidden', async () => {
      await actor(db, B);
      assert.equal((await db.query('select * from ai_processing_permissions')).rows.length, 0);
      await assert.rejects(set(db, true, A, 0), (e) => e.code === '42501');
      assert.equal((await read(db, B)).granted, false);
      await receipt(db, B);
      assert.equal((await read(db, B)).granted, true, 'existing current receipt preserves its authority without a backfill');
    });
    await t.test('anonymous invocation has no execute privilege', async () => {
      await actor(db, '', 'anon');
      await assert.rejects(read(db), (e) => e.code === '42501');
      await assert.rejects(set(db, false), (e) => e.code === '42501');
    });
    await t.test('FK cascade removes current state when synthetic Auth actor is deleted', async () => {
      await db.exec('reset role');
      await db.query('delete from auth.users where id=$1', [A]);
      assert.equal((await db.query('select * from ai_processing_permissions where user_id=$1', [A])).rows.length, 0);
    });
    await t.test('functions pin search_path and expose exactly actor-fenced signatures', async () => {
      const rows = (await db.query("select proname,proconfig,prosecdef from pg_proc where proname in ('get_ai_processing_permission','set_ai_processing_permission') order by proname")).rows;
      assert.equal(rows.length, 2);
      for (const row of rows) { assert.equal(row.prosecdef, true); assert.ok(row.proconfig.some((p) => p.startsWith('search_path='))); }
    });
  } finally { await db.close(); }
});
