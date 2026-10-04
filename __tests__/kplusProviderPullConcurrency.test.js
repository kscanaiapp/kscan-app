// Opt-in real-Postgres Phase E interleavings. Every fixture is confined to a
// clearly named disposable/local container and deleted after each test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DB = process.env.KSCAN_DISPOSABLE_SUPABASE_DB_CONTAINER || '';
const dbTest = (name, fn) => test(name, {
  skip: DB ? false : 'set KSCAN_DISPOSABLE_SUPABASE_DB_CONTAINER to a disposable Supabase DB container',
}, fn);

function safeDb() {
  assert.match(DB, /disposable|test|local/i);
  assert.doesNotMatch(DB, /prod|staging|wyyuqf|yzqjvd/i);
}

async function psql(sql) {
  safeDb();
  const { stdout } = await execFileAsync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sql, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

const USER_A = 'e1000000-0000-4000-8000-000000000001';
const USER_B = 'e1000000-0000-4000-8000-000000000002';
const PRODUCT = 'fixture.apple.monthly';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

async function resetUsers(ids) {
  await psql(`delete from auth.users where id in (${ids.map((id) => `'${id}'::uuid`).join(',')});
    ${ids.map((id) => `insert into auth.users(id,email,aud,role) values ('${id}','phase-e-${id.slice(-4)}@test.invalid','authenticated','authenticated');`).join('\n')}`);
}

async function cleanupUsers(ids) {
  await psql(`delete from auth.users where id in (${ids.map((id) => `'${id}'::uuid`).join(',')});`);
}

function transition({
  user = USER_A, eventId, digest = DIGEST_A, state = 'active', occurredAt,
  periodStart, expiresAt, willRenew = true,
}) {
  return `select public.reconcile_kplus_provider_transition(
    p_user_id => '${user}'::uuid,
    p_provider => 'revenuecat',
    p_cause => 'provider_reconciliation',
    p_external_event_id => '${eventId}',
    p_provider_event_type => 'reconciliation_snapshot',
    p_provider_occurred_at => '${occurredAt}'::timestamptz,
    p_environment => 'production', p_store => 'apple', p_product_id => '${PRODUCT}',
    p_subscription_ref_digest => '${digest}', p_lifecycle_state => '${state}',
    p_period_type => 'paid', p_period_starts_at => '${periodStart}'::timestamptz,
    p_expires_at => '${expiresAt}'::timestamptz, p_will_renew => ${willRenew},
    p_trial_ends_at => null, p_grace_period_expires_at => null,
    p_pause_resumes_at => null, p_entitlement_key => 'k_plus');`;
}

async function finalState(user = USER_A) {
  return JSON.parse(await psql(`select json_build_object(
    'grants', count(*),
    'revoked', count(*) filter (where revoked_at is not null),
    'expires', max(expires_at),
    'transitions', (select count(*) from public.kplus_entitlement_transitions where user_id='${user}'::uuid)
  ) from public.kplus_entitlement_grants where user_id='${user}'::uuid and source='store_subscription';`));
}

function times() {
  const now = Date.now();
  return {
    old: new Date(now - 120000).toISOString(),
    newer: new Date(now - 60000).toISOString(),
    activeEnd: new Date(now + 86400000).toISOString(),
    expiredEnd: new Date(now - 86400000).toISOString(),
  };
}

dbTest('INTERLEAVING pull ACTIVE || pull ACTIVE -> one grant and one deterministic transition', async () => {
  await resetUsers([USER_A]);
  try {
    const t = times();
    const sql = transition({ eventId: `rcpull_${'1'.repeat(64)}`, occurredAt: t.old, periodStart: t.old, expiresAt: t.activeEnd });
    await Promise.all([psql(sql), psql(sql)]);
    const state = await finalState();
    assert.equal(state.grants, 1);
    assert.equal(state.revoked, 0);
    assert.equal(new Date(state.expires).toISOString(), t.activeEnd);
    assert.equal(state.transitions, 1);
  } finally { await cleanupUsers([USER_A]); }
});

dbTest('INTERLEAVING webhook ACTIVE || pull ACTIVE -> different references converge on one provider grant', async () => {
  await resetUsers([USER_A]);
  try {
    const t = times();
    await Promise.all([
      psql(transition({ eventId: 'evt_webhook_active', digest: DIGEST_A, occurredAt: t.old, periodStart: t.old, expiresAt: t.activeEnd })),
      psql(transition({ eventId: `rcpull_${'2'.repeat(64)}`, digest: DIGEST_B, occurredAt: t.old, periodStart: t.old, expiresAt: t.activeEnd })),
    ]);
    const state = await finalState();
    assert.equal(state.grants, 1);
    assert.equal(state.revoked, 0);
    assert.equal(state.transitions, 2);
  } finally { await cleanupUsers([USER_A]); }
});

dbTest('INTERLEAVING webhook EXPIRATION || older pull ACTIVE -> final provider grant remains terminal', async () => {
  await resetUsers([USER_A]);
  try {
    const t = times();
    await Promise.all([
      psql(transition({ eventId: 'evt_webhook_expiration', digest: DIGEST_A, state: 'expired', occurredAt: t.newer, periodStart: t.old, expiresAt: t.expiredEnd, willRenew: false })),
      psql(transition({ eventId: `rcpull_${'3'.repeat(64)}`, digest: DIGEST_B, occurredAt: t.old, periodStart: t.old, expiresAt: t.activeEnd })),
    ]);
    const state = await finalState();
    assert.equal(state.grants, 1);
    assert.equal(state.revoked, 0);
    assert.equal(new Date(state.expires).toISOString(), t.expiredEnd);
  } finally { await cleanupUsers([USER_A]); }
});

dbTest('INTERLEAVING newer webhook RENEWAL || older pull EXPIRED -> final provider grant remains active', async () => {
  await resetUsers([USER_A]);
  try {
    const t = times();
    await Promise.all([
      psql(transition({ eventId: 'evt_webhook_renewal', digest: DIGEST_A, occurredAt: t.newer, periodStart: t.newer, expiresAt: t.activeEnd })),
      psql(transition({ eventId: `rcpull_${'4'.repeat(64)}`, digest: DIGEST_B, state: 'expired', occurredAt: t.old, periodStart: t.old, expiresAt: t.expiredEnd, willRenew: false })),
    ]);
    const state = await finalState();
    assert.equal(state.grants, 1);
    assert.equal(state.revoked, 0);
    assert.equal(new Date(state.expires).toISOString(), t.activeEnd);
  } finally { await cleanupUsers([USER_A]); }
});

dbTest('INTERLEAVING actor A || actor B -> advisory lock keys are distinct', async () => {
  const answer = await psql(`select hashtextextended('kplus_entitlement:${USER_A}',0) <> hashtextextended('kplus_entitlement:${USER_B}',0);`);
  assert.equal(answer, 't');
});
