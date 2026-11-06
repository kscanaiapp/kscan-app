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
      'public.kplus_sandbox_review_revoke(uuid,text)', 'public.kplus_sandbox_review_sweep()',
      'public.kplus_sandbox_review_permits(uuid,timestamptz)',
      'public.claim_kplus_sandbox_review_reconciliation(uuid,integer,integer)'];
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

// ── Repair B: expiry and revocation at the CANONICAL ACCESS BOUNDARY ─────────
// These prove access is denied by kplus_entitlement_facts itself, the instant
// an authorization stops being active -- with the sweep never run and with the
// grant row still (or again) unrevoked.

const expireAuthorization = (db, user) => db.exec(`update public.kplus_sandbox_review_accounts
  set starts_at = now() - interval '10 days', expires_at = now() - interval '1 second' where user_id = '${user}'`);
const newerTransition = (db, user, id, digestChar) => db.exec(`select public.reconcile_kplus_provider_transition(
  p_user_id => '${user}', p_provider => 'revenuecat', p_cause => 'provider_event',
  p_external_event_id => '${id}', p_provider_event_type => 'renewal',
  p_provider_occurred_at => now() - interval '5 seconds', p_environment => 'sandbox', p_store => 'apple',
  p_product_id => 'kscan.kplus.monthly', p_subscription_ref_digest => '${digestChar.repeat(64)}',
  p_lifecycle_state => 'active', p_period_type => 'paid', p_period_starts_at => now() - interval '5 seconds',
  p_expires_at => now() + interval '7 days', p_will_renew => true)`);
const lifetime = (db, user, env, id, digestChar) => db.exec(`select public.reconcile_kplus_provider_lifetime_transition(
  p_user_id => '${user}', p_provider => 'revenuecat', p_cause => 'provider_event',
  p_external_event_id => '${id}', p_provider_event_type => 'lifetime_purchase',
  p_provider_occurred_at => now() - interval '1 minute', p_environment => '${env}', p_store => 'apple',
  p_product_id => 'kscan.kplus.lifetime', p_purchase_ref_digest => '${digestChar.repeat(64)}',
  p_lifecycle_state => 'active', p_purchased_at => now() - interval '1 minute')`);
const canonical = async (db, user) => (await one(db, `select public.kplus_has_active_entitlement('${user}') v`)).v === true;
const unrevokedSandbox = async (db, user) => Number((await one(db, `select count(*) n from public.kplus_entitlement_grants
  where user_id = '${user}' and provider_environment = 'sandbox' and revoked_at is null`)).n);
const claimReview = (db, user, cooldown = 300) =>
  one(db, `select public.claim_kplus_sandbox_review_reconciliation('${user}', ${cooldown}, 30) r`).then((x) => x.r);
const auditCount = async (db, user, action) => Number((await one(db, `select count(*) n from public.kplus_sandbox_review_audit
  where user_id = '${user}' and action = '${action}'`)).n);

test('sandbox review SQL: kplus_entitlement_facts is the prior body plus exactly ONE conjunct (narrowest change)', () => {
  const extract = (sql) => {
    const start = sql.indexOf('create or replace function public.kplus_entitlement_facts(');
    assert.ok(start >= 0);
    return sql.slice(start, sql.indexOf('$$;', start) + 3);
  };
  const before = extract(read('20261002010000_kplus_paid_lifetime_entitlement_foundation.sql'));
  const after = extract(read(TARGET));
  const conjunct = "      and (g.provider_environment is distinct from 'sandbox'\n"
    + '        or public.kplus_sandbox_review_permits(g.user_id, p_at))\n';
  assert.equal(after.split(conjunct).length, 2, 'the conjunct appears exactly once');
  assert.equal(after.replace(conjunct, ''), before, 'nothing else in the canonical fact source changed');
  // Mutation control: the comparison above is sensitive to a one-token drift.
  assert.notEqual(after.replace(conjunct, '').replace("when 'normal' then", "when 'normal'  then"), before);
});

test('sandbox review SQL (B): expiry denies access immediately -- no sweep, grant row still unrevoked', async () => {
  const db = await database();
  try {
    await authorize(db, A);
    await transition(db, A, 'sandbox', 'evt_exp_1', 'a');
    assert.equal(await access(db, A), true);
    assert.equal(await canonical(db, A), true);

    await expireAuthorization(db, A);
    assert.equal(await unrevokedSandbox(db, A), 1, 'the sweep has NOT run: the grant row is still unrevoked');
    assert.equal(await access(db, A), false, 'expired authorization -> no access at the resolver');
    assert.equal(await canonical(db, A), false, 'the canonical server predicate (every premium gate) agrees');

    // Time precision: asked about an instant inside BOTH the grant's period and the
    // old authorization window (grant started ~1 min ago; window ended 1 s ago), access was real.
    assert.equal((await one(db, `select s.has_access v from public.kplus_effective_access_state('${A}','k_plus', now() - interval '20 seconds') s`)).v, true);
    // A not-yet-started authorization is not active either.
    await db.exec(`update public.kplus_sandbox_review_accounts set starts_at = now() + interval '1 hour', expires_at = now() + interval '2 days' where user_id = '${A}'`);
    assert.equal(await access(db, A), false);
  } finally { await db.close(); }
});

test('sandbox review SQL (B): ordinary sandbox semantics without an authorization row are unchanged (Staging testers)', async () => {
  const db = await database();
  try {
    await transition(db, B, 'sandbox', 'evt_stg_1', 'b');
    await lifetime(db, C, 'sandbox', 'evt_stg_lt', 'c');
    assert.equal(await access(db, B), true, 'sandbox subscription, no review row -> access as before');
    assert.equal(await access(db, C), true, 'sandbox lifetime, no review row -> access as before');
    assert.equal((await one(db, `select public.kplus_sandbox_review_permits('${B}', now()) v`)).v, true);
  } finally { await db.close(); }
});

test('sandbox review SQL (B): overlapping grants -- only the sandbox grant loses access; production, complimentary and lifetime keep it', async () => {
  const db = await database();
  try {
    await authorize(db, A, 'internal_tester', 3, 'T-OVERLAP');
    await transition(db, A, 'sandbox', 'evt_ov_s', 'a');
    await lifetime(db, A, 'sandbox', 'evt_ov_lt', 'b');
    await expireAuthorization(db, A);
    assert.equal(await access(db, A), false, 'expired review gates the sandbox subscription AND the sandbox lifetime');

    // Production subscription for the same user keeps access, and its expiry is the effective one.
    await transition(db, A, 'production', 'evt_ov_p', 'c');
    const s = await one(db, `select s.has_access, s.effective_expires_at, (select expires_at from public.kplus_entitlement_grants
      where user_id='${A}' and provider_environment='production') p from public.kplus_effective_access_state('${A}','k_plus', now()) s`);
    assert.equal(s.has_access, true);
    assert.equal(new Date(s.effective_expires_at).getTime(), new Date(s.p).getTime(), 'effective expiry comes from the production grant only');

    // Complimentary access for a review account is untouched.
    await authorize(db, C, 'internal_tester', 3, 'T-COMP');
    await transition(db, C, 'sandbox', 'evt_ov_cs', 'd');
    // Minimal profiles shim (grant_kplus_complimentary requires an active profile).
    await db.exec(`create table if not exists public.profiles (id uuid primary key, account_status text, account_locked_at timestamptz);
      insert into public.profiles (id, account_status) values ('${C}', 'active')`);
    const comp = (await one(db, `select public.grant_kplus_complimentary('${C}', 'complimentary', 'comp-c-1', null, now() - interval '1 minute', now() + interval '30 days') r`)).r;
    assert.equal(Number((await one(db, `select count(*) n from public.kplus_entitlement_grants where user_id='${C}' and source='complimentary' and revoked_at is null`)).n), 1,
      `complimentary grant created (${JSON.stringify(comp)})`);
    await db.exec(`select public.kplus_sandbox_review_revoke('${C}', 'review_complete')`);
    assert.equal(await unrevokedSandbox(db, C), 0, 'the sandbox grant itself was revoked');
    assert.equal(await access(db, C), true, 'complimentary grant survives revocation of review access');

    // Production lifetime for a review account is untouched.
    await authorize(db, B, 'internal_tester', 3, 'T-LT');
    await lifetime(db, B, 'production', 'evt_ov_plt', 'e');
    await expireAuthorization(db, B);
    await db.exec('select public.kplus_sandbox_review_sweep()');
    assert.equal(await access(db, B), true, 'a production lifetime grant is never gated or revoked');
  } finally { await db.close(); }
});

test('sandbox review SQL (B): revocation records truthful before/after access in the canonical ledger', async () => {
  const db = await database();
  try {
    await authorize(db, A);
    await transition(db, A, 'sandbox', 'evt_led_1', 'a');
    await db.exec(`select public.kplus_sandbox_review_revoke('${A}', 'review_complete')`);
    const t = await one(db, `select access_before, access_after from public.kplus_entitlement_transitions
      where user_id='${A}' and cause='grant_revocation'`);
    assert.deepEqual([t.access_before, t.access_after], [true, false]);
  } finally { await db.close(); }
});

// ── Race interleavings ───────────────────────────────────────────────────────
// PGlite is a single connection, so true parallel transactions cannot run here.
// Each test below replays one adverse INTERLEAVING of separately committed
// transactions -- exactly the orderings the webhook (admission, then apply) and
// the reconciler (claim, then transitions) can produce against a revocation.

test('sandbox review SQL (race): admission -> revoke -> late apply re-activates the ROW but never ACCESS; sweep cleans up', async () => {
  const db = await database();
  try {
    await authorize(db, A);
    await transition(db, A, 'sandbox', 'evt_race_1', 'a');
    assert.equal(await admit(db, A, 'abc201'), true, 'webhook admission committed while the review was active');
    await db.exec(`select public.kplus_sandbox_review_revoke('${A}', 'review_complete')`);
    assert.equal(await unrevokedSandbox(db, A), 0);

    await newerTransition(db, A, 'evt_race_2', 'a');
    assert.equal(await unrevokedSandbox(db, A), 1, 'hazard reproduced: a newer provider event cleared revoked_at on the row');
    assert.equal(await access(db, A), false, 'the resolver still denies access');
    assert.equal(await canonical(db, A), false);

    const swept = (await one(db, 'select public.kplus_sandbox_review_sweep() r')).r;
    assert.equal(swept.accounts, 1, 'a revoked-but-unexpired account with a re-activated grant is swept');
    assert.equal(await unrevokedSandbox(db, A), 0);
    assert.equal((await one(db, `select detail from public.kplus_sandbox_review_audit where user_id='${A}' order by id desc limit 1`)).detail, 'revoked_cleanup');
    assert.equal((await one(db, `select revoked_reason r from public.kplus_sandbox_review_accounts where user_id='${A}'`)).r, 'review_complete',
      'the first revocation keeps its reason');
    assert.equal((await one(db, 'select public.kplus_sandbox_review_sweep() r')).r.accounts, 0, 'sweep is idempotent');
  } finally { await db.close(); }
});

test('sandbox review SQL (race): expiry between admission and apply -> a NEW grant is created but grants no access', async () => {
  const db = await database();
  try {
    await authorize(db, A);
    assert.equal(await admit(db, A, 'abc301'), true);
    await expireAuthorization(db, A);
    await transition(db, A, 'sandbox', 'evt_race_new', 'f');
    assert.equal(await unrevokedSandbox(db, A), 1);
    assert.equal(await access(db, A), false);
  } finally { await db.close(); }
});

test('sandbox review SQL (race): reconcile claim -> revoke -> late transition never restores access', async () => {
  const db = await database();
  try {
    await authorize(db, A);
    assert.equal((await claimReview(db, A)).classification, 'claimed');
    await db.exec(`select public.kplus_sandbox_review_revoke('${A}', 'review_complete')`);
    await transition(db, A, 'sandbox', 'evt_race_rc', 'a');
    assert.equal(await access(db, A), false);
  } finally { await db.close(); }
});

// ── Repair C: missed-webhook recovery claim ──────────────────────────────────

test('sandbox review SQL (C): only an ACTIVE authorization opens a sandbox claim; cooldown cannot be bypassed', async () => {
  const db = await database();
  try {
    const controls = async (user) => Number((await one(db, `select count(*) n from public.kplus_provider_reconciliation_controls
      where user_id='${user}' and provider_environment='sandbox'`)).n);

    // No authorization row: refused, and nothing is written anywhere.
    assert.equal((await claimReview(db, B)).classification, 'not_authorized');
    assert.equal(await controls(B), 0);
    assert.equal(Number((await one(db, `select count(*) n from public.kplus_sandbox_review_audit where user_id='${B}'`)).n), 0);

    // Active: claimed through the existing claim; audited.
    await authorize(db, A);
    const first = await claimReview(db, A);
    assert.equal(first.classification, 'claimed');
    assert.match(first.claimToken, /^[0-9a-f-]{36}$/);
    assert.equal(await controls(A), 1);
    assert.equal(await auditCount(db, A, 'reconcile_admitted'), 1);

    // A second call inside the lease / cooldown is rate limited (no force path exists).
    const second = await claimReview(db, A);
    assert.ok(['in_flight', 'cooldown'].includes(second.classification), second.classification);
    assert.ok(second.retryAfterSeconds >= 1);
    await db.exec(`select public.finish_kplus_provider_reconciliation('${A}', 'sandbox', '${first.claimToken}', 'no_drift')`);
    assert.equal((await claimReview(db, A)).classification, 'cooldown', 'finishing the lease does not lift the cooldown');
    assert.equal(await auditCount(db, A, 'reconcile_admitted'), 1, 'rate-limited calls are not audited as admitted');

    // Revoked and expired: refused and audited, no new claim.
    await db.exec(`update public.kplus_provider_reconciliation_controls set cooldown_until = null where user_id='${A}'`);
    await db.exec(`select public.kplus_sandbox_review_revoke('${A}', 'review_complete')`);
    assert.equal((await claimReview(db, A)).classification, 'not_authorized');
    await authorize(db, C, 'internal_tester', 2, 'T-CLAIM');
    await expireAuthorization(db, C);
    assert.equal((await claimReview(db, C)).classification, 'not_authorized');
    assert.equal(await controls(C), 0);
    assert.deepEqual(
      (await db.query(`select user_id::text u, detail from public.kplus_sandbox_review_audit where action='reconcile_refused' order by id`)).rows
        .map((r) => [r.u, r.detail]),
      [[A, 'revoked'], [C, 'outside_window']],
    );

    // The production claim for the same user is a separate lease/cooldown and is never opened here.
    assert.equal(Number((await one(db, `select count(*) n from public.kplus_provider_reconciliation_controls where provider_environment='production'`)).n), 0);
  } finally { await db.close(); }
});

test('sandbox review SQL (C): client roles cannot reach the claim or the permit helper', async () => {
  {
    for (const role of ['anon', 'authenticated']) {
      const probe = await database();
      try {
        await probe.exec(`set role ${role}`);
        await assert.rejects(probe.query(`select public.claim_kplus_sandbox_review_reconciliation('${A}', 300, 30)`), /permission denied/);
      } finally { await probe.close(); }
    }
  }
});

test('sandbox review SQL (B): the app-facing summary, called AS authenticated, reflects expiry with no privilege error', async () => {
  const db = await database();
  try {
    await authorize(db, A);
    await transition(db, A, 'sandbox', 'evt_jwt_1', 'a');
    const asMember = async () => {
      await db.exec(`select set_config('request.jwt.claim.sub', '${A}', false); set role authenticated`);
      try {
        return (await one(db, 'select public.get_my_kplus_entitlement_summary() s')).s;
      } finally {
        await db.exec('reset role');
      }
    };
    assert.equal((await asMember()).access, 'k_plus', 'active review authorization: the member reads K+');
    await expireAuthorization(db, A);
    assert.equal((await asMember()).access, 'free', 'expired review authorization: the member reads free, sweep never run');
    assert.equal(await unrevokedSandbox(db, A), 1);
  } finally { await db.close(); }
});
