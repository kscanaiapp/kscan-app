const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const migration = fs.readFileSync(path.join(MIGRATIONS, '20261015214749_style_chat_greeting_actor_session_unique.sql'), 'utf8');
const ACTOR_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_RACE = '33333333-3333-4333-8333-333333333333';

async function fixture() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  // Only Auth identity and default Data API grants are fixtures. Tables,
  // current message RLS, existing source-message uniqueness and candidate
  // greeting uniqueness are executed from the actual migrations.
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;`);
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, '202606070001_style_chat.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, '202606180003_fix_style_chat_messages_session_rls.sql'), 'utf8'));
  const sourceIdentity = fs.readFileSync(path.join(MIGRATIONS, '202607200001_elise_generation_quota_idempotency.sql'), 'utf8')
    .split('create table if not exists public.elise_generation_operations')[0];
  await db.exec(sourceIdentity);
  await db.exec(`grant select,insert on style_chat_sessions,style_chat_messages to authenticated,anon;
    insert into auth.users values('${ACTOR_A}'),('${ACTOR_B}');
    insert into style_chat_sessions(id,user_id) values('${SESSION_A}','${ACTOR_A}'),('${SESSION_B}','${ACTOR_B}'),('${SESSION_RACE}','${ACTOR_A}');`);
  return db;
}

const insert = (db, { actor = ACTOR_A, session = SESSION_A, sender = 'assistant', blocks = [{ type: 'greeting' }], source = null } = {}) =>
  db.query(`insert into public.style_chat_messages(user_id,session_id,sender,content,ui_blocks,source_message_id)
    values($1,$2,$3,'Synthetic test message',$4::jsonb,$5) returning id`, [actor, session, sender, JSON.stringify(blocks), source]);

async function actor(db, id, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(`set role ${role}`);
}

test('greeting migration refuses dirty duplicate history without deleting or rewriting rows', async () => {
  const db = await fixture();
  try {
    await insert(db); await insert(db);
    await assert.rejects(db.exec(migration), (error) => error.code === '23505');
    assert.equal((await db.query('select count(*)::int as n from style_chat_messages')).rows[0].n, 2);
    assert.equal((await db.query("select count(*)::int as n from pg_indexes where indexname='style_chat_one_assistant_greeting_per_actor_session'")).rows[0].n, 0);
  } finally { await db.close(); }
});

test('actual greeting index preserves message policies, grants, normal messages and actor isolation', async (t) => {
  const db = await fixture();
  try {
    const policies = await db.query("select policyname,roles,cmd,qual,with_check from pg_policies where tablename in('style_chat_sessions','style_chat_messages') order by tablename,policyname");
    const grants = await db.query("select grantee,table_name,privilege_type from information_schema.role_table_grants where table_name in('style_chat_sessions','style_chat_messages') order by grantee,table_name,privilege_type");
    const existingIndexes = (await db.query("select indexname,indexdef from pg_indexes where tablename='style_chat_messages' order by indexname")).rows;
    await db.exec(migration);
    await t.test('only the new unique index changes; current RLS and table grants remain identical', async () => {
      assert.deepEqual((await db.query("select policyname,roles,cmd,qual,with_check from pg_policies where tablename in('style_chat_sessions','style_chat_messages') order by tablename,policyname")).rows, policies.rows);
      assert.deepEqual((await db.query("select grantee,table_name,privilege_type from information_schema.role_table_grants where table_name in('style_chat_sessions','style_chat_messages') order by grantee,table_name,privilege_type")).rows, grants.rows);
      assert.deepEqual((await db.query("select indexname,indexdef from pg_indexes where tablename='style_chat_messages' and indexname<>'style_chat_one_assistant_greeting_per_actor_session' order by indexname")).rows, existingIndexes);
      assert.equal((await db.query("select count(*)::int as n from pg_class where oid in('style_chat_sessions'::regclass,'style_chat_messages'::regclass) and relrowsecurity")).rows[0].n, 2);
    });
    await t.test('marker containment includes extra greeting fields but excludes ordinary and non-assistant messages', async () => {
      await insert(db);
      await assert.rejects(insert(db, { blocks: [{ type: 'other' }, { type: 'greeting', version: 1 }] }), (error) => error.code === '23505');
      for (const blocks of [[], ['greeting'], { type: 'greeting' }, [{ type: 'not_greeting' }]]) {
        await insert(db, { blocks }); await insert(db, { blocks });
      }
      await insert(db, { sender: 'user' }); await insert(db, { sender: 'user' });
      await insert(db, { sender: 'system' });
      await insert(db, { actor: ACTOR_B, session: SESSION_B });
      const userMessage = await insert(db, { sender: 'user', blocks: [] });
      await insert(db, { blocks: [], source: userMessage.rows[0].id });
      await assert.rejects(insert(db, { blocks: [], source: userMessage.rows[0].id }), (error) => error.code === '23505');
    });
    await t.test('actual RLS prevents wrong-actor and wrong-owner-session inserts and cross-actor winner reads', async () => {
      await actor(db, ACTOR_A);
      assert.equal((await db.query('select count(*)::int as n from style_chat_messages where session_id=$1', [SESSION_B])).rows[0].n, 0);
      await assert.rejects(insert(db, { actor: ACTOR_B, session: SESSION_B }), (error) => error.code === '42501');
      await assert.rejects(insert(db, { actor: ACTOR_A, session: SESSION_B }), (error) => error.code === '42501');
      await actor(db, '', 'anon');
      assert.equal((await db.query('select count(*)::int as n from style_chat_messages')).rows[0].n, 0);
      await assert.rejects(insert(db), (error) => error.code === '42501');
    });
    await t.test('competing greeting submissions persist one winner and one SQLSTATE23505 loser', async () => {
      await actor(db, ACTOR_A);
      // PGlite queues these calls. Live server multi-session certification is
      // separately required by the guarded Staging probe after governed deploy.
      const outcomes = await Promise.allSettled([insert(db, { session: SESSION_RACE }), insert(db, { session: SESSION_RACE })]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason.code === '23505').length, 1);
      assert.equal((await db.query("select count(*)::int as n from style_chat_messages where session_id=$1 and sender='assistant' and ui_blocks @> '[{\"type\":\"greeting\"}]'::jsonb", [SESSION_RACE])).rows[0].n, 1);
    });
  } finally { await db.close(); }
});
