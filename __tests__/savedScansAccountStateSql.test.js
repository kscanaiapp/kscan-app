const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const migration = '20261031162813_saved_scans_active_account_guard.sql';
const sql = (name) => fs.readFileSync(path.join(ROOT, 'supabase/migrations', name), 'utf8');

async function actor(db, id, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(`set role ${role}`);
}
async function fixture() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, deleted_at timestamptz, banned_until timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;
    create table public.profiles(id uuid primary key,account_status text,account_locked_at timestamptz);
    create table public.deletion_requests(id uuid primary key,user_id uuid,status text,requested_at timestamptz);
    insert into auth.users(id) values('${A}'),('${B}');
    insert into public.profiles(id,account_status) values('${A}','active'),('${B}','active');`);
  // Execute the actual saved-scan policy history, not a mock authorization rule.
  for (const table of ['privacy_settings','dressing_rooms','dressing_room_items',
    'dressing_room_messages','inspiration_items','style_chat_sessions','style_chat_messages',
    'style_memory_events','legal_acceptances']) {
    await db.exec(`create table public.${table}(id uuid);`);
  }
  for (const name of ['20260617215307_create_saved_scans.sql',
    '202606180001_fix_staging_grants_saved_scans_soft_delete.sql',
    '202606180002_fix_saved_scans_soft_delete_select_policy.sql']) await db.exec(sql(name));
  // Reuse the actual canonical lifecycle helper, including its legacy-profile fallback.
  const helper = sql('20260723070000_profiles_backfill_and_active_account_hardening.sql')
    .match(/create or replace function public\.is_active_account\(\)[\s\S]*?\$\$;/i);
  assert.ok(helper, 'canonical account helper exists');
  await db.exec(helper[0]);
  await db.exec(sql(migration));
  await db.exec(sql(migration)); // forward migration remains replay-safe
  await actor(db, A);
  await db.query('insert into public.saved_scans(user_id,local_id,title) values($1,$2,$3)', [A,'fixture','original']);
  return db;
}

test('saved scans enforce current account lifecycle without changing ownership or tombstone contracts', async (t) => {
  const db = await fixture();
  const read = async () => (await db.query('select title from public.saved_scans where user_id=$1', [A])).rows;
  try {
    await t.test('active owner baseline and foreign ownership remain isolated', async () => {
      assert.equal((await read()).length, 1);
      await actor(db, B);
      assert.equal((await read()).length, 0);
      assert.equal((await db.query('update saved_scans set title=$1 where user_id=$2 returning id', ['foreign',A])).rows.length, 0);
      await assert.rejects(db.query('insert into saved_scans(user_id) values($1)', [A]), (e) => e.code === '42501');
      await actor(db, A);
      await assert.rejects(db.query('update saved_scans set user_id=$1 where user_id=$2', [B,A]), (e) => e.code === '42501');
    });
    for (const state of ['pending_deletion','locked']) {
      await t.test(`${state}: still-valid actor cannot read, insert or update`, async () => {
        await db.exec('reset role');
        await db.query('update profiles set account_status=$1 where id=$2', [state,A]);
        await actor(db, A);
        assert.equal((await read()).length, 0, 'inactive actor cannot read private scans');
        assert.equal((await db.query('update saved_scans set title=$1 where user_id=$2 returning id', ['inactive',A])).rows.length, 0);
        await assert.rejects(db.query('insert into saved_scans(user_id) values($1)', [A]), (e) => e.code === '42501');
      });
    }
    await t.test('a non-null account lock blocks even an active status', async () => {
      await db.exec('reset role');
      await db.query("update profiles set account_status='active',account_locked_at=now() where id=$1", [A]);
      await actor(db,A);
      assert.equal((await read()).length,0);
    });
    await t.test('restoration reopens own reads and preserves owner soft-delete/tombstone visibility', async () => {
      await db.exec('reset role');
      await db.query("update profiles set account_status='active',account_locked_at=null where id=$1", [A]);
      await actor(db,A);
      assert.deepEqual(await read(),[{title:'original'}], 'denied mutations left authority unchanged');
      assert.equal((await db.query('update saved_scans set deleted_at=now() where user_id=$1 returning id', [A])).rows.length,1);
      assert.equal((await read()).length,1,'owner can still see tombstones for synchronization');
      assert.equal((await db.query('delete from saved_scans where user_id=$1 returning id',[A])).rows.length,0,'no hard-delete policy added');
    });
    await t.test('missing identity and anonymous caller cannot read private scans', async () => {
      await actor(db,'');
      assert.equal((await read()).length,0);
      await actor(db,'','anon');
      await assert.rejects(read(), (e) => e.code === '42501');
    });
  } finally { await db.close(); }
});
