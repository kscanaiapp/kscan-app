const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sql = name => fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
async function actor(db, id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
  await db.exec('set role authenticated');
}
test('E018 actual SQL restores own tombstones without weakening lifecycle or foreign ownership',async t=>{
  const {PGlite}=await import('@electric-sql/pglite');
  const db=await PGlite.create();
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated,anon;
      create table profiles(id uuid primary key,account_status text,account_locked_at timestamptz);
      create table deletion_requests(id uuid primary key,user_id uuid,status text,requested_at timestamptz);
      insert into auth.users(id) values('${A}'),('${B}');
      insert into profiles(id,account_status) values('${A}','active'),('${B}','active');`);
    for(const table of ['privacy_settings','dressing_rooms','dressing_room_items','dressing_room_messages',
      'inspiration_items','style_chat_sessions','style_chat_messages','style_memory_events','legal_acceptances'])
      await db.exec(`create table ${table}(id uuid)`);
    for(const name of ['20260617215307_create_saved_scans.sql',
      '202606180001_fix_staging_grants_saved_scans_soft_delete.sql',
      '202606180002_fix_saved_scans_soft_delete_select_policy.sql'])await db.exec(sql(name));
    const helper=sql('20260723070000_profiles_backfill_and_active_account_hardening.sql')
      .match(/create or replace function public\.is_active_account\(\)[\s\S]*?\$\$;/i);
    assert.ok(helper);
    await db.exec(helper[0]);
    await db.exec(sql('20261031162813_saved_scans_active_account_guard.sql'));
    await db.query("insert into saved_scans(user_id,local_id,title,deleted_at) values($1,'restore','original',now())",[A]);
    await actor(db,A);
    await t.test('negative control: previous policy filters the explicit restore',async()=>{
      assert.equal((await db.query('update saved_scans set deleted_at=null where user_id=$1 returning id',[A])).rows.length,0);
    });
    await db.exec('reset role');
    await db.exec(sql('20261102125053_saved_scan_explicit_restore.sql'));
    await db.exec(sql('20261102125053_saved_scan_explicit_restore.sql'));
    await actor(db,A);
    await t.test('active owner restores exactly own scan and repeat remains one record',async()=>{
      for(let i=0;i<2;i++)assert.equal((await db.query('update saved_scans set deleted_at=null where user_id=$1 returning id,deleted_at',[A])).rows.length,1);
      assert.equal((await db.query('select count(*)::int n from saved_scans where user_id=$1 and deleted_at is null',[A])).rows[0].n,1);
    });
    await t.test('foreign caller cannot restore or read owner tombstone',async()=>{
      await actor(db,A);await db.query('update saved_scans set deleted_at=now() where user_id=$1',[A]);
      await actor(db,B);
      assert.equal((await db.query('update saved_scans set deleted_at=null where user_id=$1 returning id',[A])).rows.length,0);
      assert.equal((await db.query('select id from saved_scans where user_id=$1',[A])).rows.length,0);
    });
    for(const state of ['pending_deletion','locked'])await t.test(state+' cannot restore a private tombstone',async()=>{
      await db.exec('reset role');await db.query('update profiles set account_status=$1 where id=$2',[state,A]);
      await actor(db,A);
      assert.equal((await db.query('update saved_scans set deleted_at=null where user_id=$1 returning id',[A])).rows.length,0);
      assert.equal((await db.query('select id from saved_scans where user_id=$1',[A])).rows.length,0);
    });
    await t.test('restoration after account recovery retains owner check and no hard delete',async()=>{
      await db.exec('reset role');await db.query("update profiles set account_status='active' where id=$1",[A]);
      await actor(db,A);
      await assert.rejects(db.query('update saved_scans set user_id=$1 where user_id=$2',[B,A]),e=>e.code==='42501');
      assert.equal((await db.query('update saved_scans set deleted_at=null where user_id=$1 returning id',[A])).rows.length,1);
      assert.equal((await db.query('delete from saved_scans where user_id=$1 returning id',[A])).rows.length,0);
    });
  } finally {await db.close();}
});
