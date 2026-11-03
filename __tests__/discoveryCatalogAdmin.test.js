// Drives the operator tool's generated SQL against the real discovery migrations
// in PGlite. Synthetic fixtures only; no network, project or credential.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8');
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVIEWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const future = (days) => new Date(Date.now() + days * 86400000).toISOString();
const admin = () => import('../scripts/discovery-catalog-admin.mjs');

async function database() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;
    insert into auth.users values('${ADMIN}'),('${REVIEWER}');`);
  await db.exec(read('20261029125521_black_owned_discovery_v1.sql'));
  await db.exec(read('20261103030000_black_owned_catalog_moderation.sql'));
  await db.query("insert into discovery_reviewers values($1,'administrator',true),($2,'reviewer',true)", [ADMIN, REVIEWER]);
  await db.exec('set role service_role');
  return db;
}
const plan = () => ({
  actor: ADMIN,
  steps: [
    { action: 'register_brand', as: 'brand', data: { name: "Isolated Synthetic Brand's $test$", website: 'https://fixture-fashion.com/', categories: ['outerwear'], markets: ['US'] } },
    { action: 'submit_evidence', as: 'evidence', data: { brand_id: '{{brand}}', method: 'authorized_attestation', provenance_ref: 'fixture:attestation', corroboration_ref: 'fixture:corroboration', authorized_submission: true, expires_at: future(90), retain_until: future(120) } },
    { action: 'request_review', data: { id: '{{brand}}' } },
    { action: 'review_ownership', actor: REVIEWER, data: { id: '{{brand}}', status: 'verified', evidence_id: '{{evidence}}', verified_until: future(60), policy_version: 'kscan-ownership-review-v1-draft' } },
    { action: 'brand_visibility', data: { id: '{{brand}}', public_label_allowed: true, public_permission_ref: 'fixture:consent', operating_status: 'active' } },
    { action: 'merchant', as: 'merchant', data: { brand_id: '{{brand}}', legal_identity_ref: 'fixture:identity', identity_verified_at: new Date(Date.now() - 1000).toISOString(), identity_expires_at: future(90), status: 'active', catalog_status: 'approved', approved_domains: ['fixture-fashion.com'], image_domains: ['images.fixture-fashion.com'], markets: ['US'], source_kind: 'authorized_json', source_authorization_ref: 'fixture:feed-license', source_authorized_until: future(90), credential_ref: 'FIXTURE_FEED' } },
  ],
});

test('an onboarding plan runs through the reviewed SQL authority to a verified, sync-ready merchant', async () => {
  const { applyPlan, STATUS_SQL } = await admin();
  const db = await database();
  try {
    const ids = await applyPlan(plan(), async (sql) => (await db.query(sql)).rows, () => {});
    const brand = (await db.query('select name,ownership_status,public_label_allowed from discovery_brands where id=$1', [ids.brand])).rows[0];
    assert.deepEqual(brand, { name: "Isolated Synthetic Brand's $test$", ownership_status: 'verified', public_label_allowed: true });
    const merchant = (await db.query('select status,credential_ref from discovery_merchants where id=$1', [ids.merchant])).rows[0];
    assert.deepEqual(merchant, { status: 'active', credential_ref: 'FIXTURE_FEED' });
    await db.exec('reset role');
    const status = (await db.query(STATUS_SQL)).rows[0];
    assert.equal(status.publicly_verified_brands, 1); assert.equal(status.active_merchants, 1); assert.equal(status.eligible_products, 0);
  } finally { await db.close(); }
});
test('the SQL authority, not the tool, refuses self-verification and unauthorized actors', async () => {
  const { applyPlan } = await admin();
  const db = await database();
  try {
    const selfVerify = plan(); delete selfVerify.steps[3].actor;
    await assert.rejects(applyPlan(selfVerify, async (sql) => (await db.query(sql)).rows, () => {}), /reviewable authorized evidence required/);
    const stranger = { ...plan(), actor: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    await assert.rejects(applyPlan(stranger, async (sql) => (await db.query(sql)).rows, () => {}), /administrative authority required/);
  } finally { await db.close(); }
});
test('payloads cannot break out of their literal; plans and ids are validated before any query', async () => {
  const { jsonLiteral, manageSql, moderateSql, validatePlan, resolveRefs } = await admin();
  const hostile = { name: "x'); drop table discovery_brands; --", note: '$$ $kscan_$ $tag$' };
  const literal = jsonLiteral(hostile);
  const tag = literal.match(/^\$(kscan_[0-9a-f]+)\$/)[1];
  assert.equal(literal.split(`$${tag}$`).length, 3);
  const db = await database();
  try {
    await db.exec('reset role');
    assert.deepEqual((await db.query(`select ${literal} as v`)).rows[0].v, hostile);
  } finally { await db.close(); }
  assert.throws(() => manageSql("x'::uuid; --", 'register_brand', {}), /UUID/);
  assert.throws(() => moderateSql(ADMIN, ADMIN, 'delete'), /decision/);
  for (const bad of [{}, { actor: ADMIN, steps: [] }, { actor: ADMIN, steps: [{ action: 'drop', data: {} }] }, { actor: ADMIN, steps: [{ action: 'prospect', data: {}, as: 'a' }, { action: 'prospect', data: {}, as: 'a' }] }]) {
    assert.throws(() => validatePlan(bad));
  }
  assert.throws(() => resolveRefs({ id: '{{missing}}' }, {}), /unresolved/);
  assert.equal(resolveRefs('literal {{brand}} text', { brand: 'x' }), 'literal {{brand}} text');
});
test('management client refuses unknown projects and missing credentials; errors never echo the token', async () => {
  const { managementClient } = await admin();
  assert.throws(() => managementClient('notarealprojectref', 'token'));
  assert.throws(() => managementClient('yzqjvdfgefveprobvvyw', ''));
  const run = managementClient('yzqjvdfgefveprobvvyw', 'synthetic-secret-token', async (url, init) => {
    assert.equal(url, 'https://api.supabase.com/v1/projects/yzqjvdfgefveprobvvyw/database/query');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-secret-token');
    return new Response('{"message":"administrator required"}', { status: 400 });
  });
  await assert.rejects(run('select 1'), (error) => /administrator required/.test(error.message) && !error.message.includes('synthetic-secret-token'));
});
