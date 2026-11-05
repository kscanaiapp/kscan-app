// Actual-migration authorization tests for
// supabase/migrations/20261106120000_kplus_sandbox_review_access.sql
// (B41 restricted sandbox REVIEW entitlement admission).
//
// Replays the REAL K+ migration chain on PGlite behind minimal Supabase shims,
// then proves the security design: server-held authorization only, exact
// account, sandbox provenance, bounded window, audit, revocation that never
// touches production grants, no client privileges, and deletion cascade.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8');
const CHAIN = [
  '20260829120000_kplus_entitlements.sql',
  '20260829180000_fix_grant_kplus_early_access_variable_conflict.sql',
  '20260915030553_kplus_entitlement_authority.sql',
  '20260915124849_kplus_reconcile_queue_excludes_inactive_rows.sql',
  '20260915181554_kplus_revenuecat_mirror_retirement.sql',
  '20260915181910_kplus_promotional_mirror_sources_search_path.sql',
  '20261002010000_kplus_paid_lifetime_entitlement_foundation.sql',
  '20261003195716_kplus_provider_pull_reconciliation.sql',
  '20261004231628_fix_kplus_reconciliation_uuid_selection.sql',
];
const TARGET = '20261106120000_kplus_sandbox_review_access.sql';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ANON = '33333333-3333-4333-8333-333333333333';
const GHOST = '44444444-4444-4444-8444-444444444444';
const C = '55555555-5555-4555-8555-555555555555';

async function database() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, is_anonymous boolean not null default false,
      deleted_at timestamptz, created_at timestamptz not null default now(), raw_app_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
    create schema extensions;
    grant usage on schema public, auth to anon, authenticated, service_role;
    insert into auth.users (id, email, is_anonymous) values
      ('${A}','a@test.invalid',false), ('${B}','b@test.invalid',false), ('${ANON}',null,true), ('${C}','c@test.invalid',false);`);
  for (const file of CHAIN) await db.exec(read(file));
  await db.exec(read(TARGET));
  return db;
}

const one = async (db, sql) => (await db.query(sql)).rows[0];
const authorize = (db, user, purpose = 'app_store_review', days = 7, ref = 'ASC-REVIEW-1') =>
  one(db, `select public.kplus_sandbox_review_authorize('${user}','${purpose}', now() + interval '${days} days','${ref}') r`).then((x) => x.r);
const admit = (db, user, key = 'abc123') =>
  one(db, `select public.kplus_sandbox_review_admit_event('${user}','${key}') r`).then((x) => x.r);
const transition = (db, user, env, id, digestChar) => db.exec(`select public.reconcile_kplus_provider_transition(
  p_user_id => '${user}', p_provider => 'revenuecat', p_cause => 'provider_event',
  p_external_event_id => '${id}', p_provider_event_type => 'initial_purchase',
  p_provider_occurred_at => now() - interval '1 minute', p_environment => '${env}', p_store => 'apple',
  p_product_id => 'kscan.kplus.monthly', p_subscription_ref_digest => '${digestChar.repeat(64)}',
  p_lifecycle_state => 'active', p_period_type => 'paid', p_period_starts_at => now() - interval '1 minute',
  p_expires_at => now() + interval '7 days', p_will_renew => true)`);
const access = async (db, user) =>
  (await one(db, `select s.has_access from public.kplus_effective_access_state('${user}', 'k_plus', now()) s`)).has_access === true;

test('sandbox review SQL: authorization rules (window, anonymous, unknown, purpose)', async () => {
  const db = await database();
  try {
    assert.equal((await authorize(db, A)).outcome, 'authorized');
    assert.equal((await authorize(db, B, 'internal_tester', 31)).reason, 'invalid_window');
    assert.equal((await authorize(db, B, 'internal_tester', -1)).reason, 'invalid_window');
    assert.equal((await authorize(db, ANON, 'internal_tester', 1)).reason, 'anonymous_user');
    assert.equal((await authorize(db, GHOST, 'internal_tester', 1)).reason, 'user_not_found');
    assert.equal((await authorize(db, B, 'paid_customer', 1)).reason, 'invalid_purpose');
    assert.equal((await authorize(db, B, 'internal_tester', 1, 'bad ref with spaces')).reason, 'invalid_approval_ref');
  } finally { await db.close(); }
});

test('sandbox review SQL: admission, sandbox provenance, revocation isolation, sweep and deletion cascade', async () => {
  const db = await database();
  try {
    await authorize(db, A);
    assert.equal(await admit(db, A), true);
    assert.equal(await admit(db, B), false, 'an account without authorization is refused');
    assert.equal(Number((await one(db, `select count(*) n from public.kplus_sandbox_review_audit where user_id = '${B}'`)).n), 0,
      'refusals for never-authorized users write nothing');

    await transition(db, A, 'sandbox', 'evt_a_1', 'a');
    await transition(db, B, 'production', 'evt_b_1', 'b');
    assert.equal(await access(db, A), true);
    assert.equal((await one(db, `select provider_environment e from public.kplus_entitlement_grants where user_id='${A}'`)).e, 'sandbox');
    assert.equal(await access(db, B), true);

    const revoked = (await one(db, `select public.kplus_sandbox_review_revoke('${A}','review_complete') r`)).r;
    assert.deepEqual([revoked.outcome, revoked.revokedSandboxGrants], ['revoked', 1]);
    assert.equal(await access(db, A), false);
    assert.equal((await one(db, `select revocation_reason x from public.kplus_entitlement_grants where user_id='${A}'`)).x, 'sandbox_review_revoked');
    assert.equal(Number((await one(db, `select count(*) n from public.kplus_entitlement_transitions where user_id='${A}' and cause='grant_revocation'`)).n), 1);
    assert.equal(await access(db, B), true, 'production grants are never touched');
    assert.equal(await admit(db, A, 'abc125'), false);
    assert.equal((await one(db, `select detail from public.kplus_sandbox_review_audit where user_id='${A}' order by id desc limit 1`)).detail, 'revoked');
    assert.equal((await one(db, `select public.kplus_sandbox_review_revoke('${B}','x_y') r`)).r.reason, 'not_authorized_account');

    // An authorized user who ALSO holds a production grant keeps it.
    await authorize(db, C, 'internal_tester', 2, 'T-C');
    await transition(db, C, 'sandbox', 'evt_c_s', 'd');
    await transition(db, C, 'production', 'evt_c_p', 'e');
    const rc = (await one(db, `select public.kplus_sandbox_review_revoke('${C}','review_complete') r`)).r;
    assert.equal(rc.revokedSandboxGrants, 1);
    assert.equal((await one(db, `select revoked_at is null v from public.kplus_entitlement_grants where user_id='${C}' and provider_environment='production'`)).v, true);
    assert.equal(await access(db, C), true);

    // Re-authorization clears revocation; expiry is enforced and swept.
    assert.equal((await authorize(db, A, 'app_store_review', 3, 'ASC-REVIEW-2')).outcome, 'authorized');
    assert.equal(await admit(db, A, 'abc126'), true);
    await transition(db, A, 'sandbox', 'evt_a_2', 'c');
    assert.equal(await access(db, A), true);
    await db.exec(`update public.kplus_sandbox_review_accounts set starts_at = now() - interval '10 days', expires_at = now() - interval '1 day' where user_id = '${A}'`);
    assert.equal(await admit(db, A, 'abc127'), false);
    assert.equal((await one(db, 'select public.kplus_sandbox_review_sweep() r')).r.accounts, 1);
    assert.equal(await access(db, A), false);
    assert.equal(await access(db, B), true);

    await db.exec(`delete from auth.users where id = '${A}'`);
    assert.equal(Number((await one(db, `select count(*) n from public.kplus_sandbox_review_accounts where user_id='${A}'`)).n), 0);
    assert.equal(Number((await one(db, `select count(*) n from public.kplus_sandbox_review_audit where user_id='${A}'`)).n), 0);
  } finally { await db.close(); }
});

test('sandbox review SQL: no client privileges; service_role reads and executes only; definer functions pinned', async () => {
  const db = await database();
  try {
    const v = async (sql) => (await db.query(sql)).rows[0].v === true;
    const tables = ['public.kplus_sandbox_review_accounts', 'public.kplus_sandbox_review_audit'];
    const fns = ['public.kplus_sandbox_review_authorize(uuid,text,timestamptz,text)', 'public.kplus_sandbox_review_admit_event(uuid,text)',
      'public.kplus_sandbox_review_revoke(uuid,text)', 'public.kplus_sandbox_review_sweep()'];
    for (const role of ['anon', 'authenticated']) {
      for (const t of tables) for (const p of ['select', 'insert', 'update', 'delete']) {
        assert.equal(await v(`select has_table_privilege('${role}', '${t}', '${p}') v`), false, `${role} ${p} ${t}`);
      }
      for (const f of fns) assert.equal(await v(`select has_function_privilege('${role}', '${f}', 'execute') v`), false, `${role} ${f}`);
    }
    for (const t of tables) {
      assert.equal(await v(`select has_table_privilege('service_role', '${t}', 'select') v`), true);
      for (const p of ['insert', 'update', 'delete']) assert.equal(await v(`select has_table_privilege('service_role', '${t}', '${p}') v`), false, `service_role ${p} ${t}`);
      assert.equal(await v(`select relrowsecurity v from pg_class where oid = '${t}'::regclass`), true);
      assert.equal(Number((await db.query(`select count(*) n from pg_policies where schemaname='public' and tablename='${t.split('.')[1]}'`)).rows[0].n), 0);
    }
    for (const f of fns) {
      assert.equal(await v(`select has_function_privilege('service_role', '${f}', 'execute') v`), true);
      assert.equal(await v(`select not exists (select 1 from aclexplode((select proacl from pg_proc where oid = '${f}'::regprocedure)) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') v`), true, `PUBLIC ${f}`);
      assert.equal(await v(`select prosecdef and coalesce(array_to_string(proconfig, ','), '') like '%search_path=public%' v from pg_proc where oid = '${f}'::regprocedure`), true, f);
    }
  } finally { await db.close(); }
});

test('sandbox review SQL: the sandbox revocation reason can never land on a production grant', async () => {
  const db = await database();
  try {
    await transition(db, B, 'production', 'evt_b_1', 'b');
    await assert.rejects(
      db.exec(`update public.kplus_entitlement_grants set revoked_at = now(), revocation_reason = 'sandbox_review_revoked' where user_id = '${B}'`),
      /check constraint/,
    );
  } finally { await db.close(); }
});

test('sandbox review SQL: the audit trail is append-only', async () => {
  const db = await database();
  try {
    await authorize(db, B, 'internal_tester', 1, 'T-AUDIT');
    assert.ok(Number((await one(db, 'select count(*) n from public.kplus_sandbox_review_audit')).n) > 0);
    await assert.rejects(db.exec(`update public.kplus_sandbox_review_audit set detail = 'tampered'`), /append-only/);
  } finally { await db.close(); }
});
