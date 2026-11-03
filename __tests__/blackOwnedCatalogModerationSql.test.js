// Executes the real discovery migrations in PGlite. Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8');
const base = read('20261029125521_black_owned_discovery_v1.sql');
const moderation = read('20261103030000_black_owned_catalog_moderation.sql');
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVIEWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function database() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;
    insert into auth.users values('${ADMIN}'),('${REVIEWER}'),('${USER}');`);
  await db.exec(base);
  await db.exec(moderation);
  await db.query('insert into discovery_reviewers values($1,\'administrator\',true),($2,\'reviewer\',true)', [ADMIN, REVIEWER]);
  await db.exec('set role service_role');
  return db;
}
async function manage(db, action, data, actor = ADMIN) {
  return (await db.query('select discovery_manage($1,$2,$3::jsonb) as id', [actor, action, JSON.stringify(data)])).rows[0].id;
}
const future = (days) => new Date(Date.now() + days * 86400000).toISOString();
async function merchant(db) {
  const brand = await manage(db, 'register_brand', { name: 'Isolated Synthetic Brand', website: 'https://fixture-fashion.com/', categories: ['outerwear'], markets: ['US'] });
  const evidence = await manage(db, 'submit_evidence', { brand_id: brand, method: 'authorized_attestation', provenance_ref: 'fixture:attestation', corroboration_ref: 'fixture:corroboration', authorized_submission: true, expires_at: future(90), retain_until: future(120) });
  await manage(db, 'request_review', { id: brand });
  await manage(db, 'review_ownership', { id: brand, status: 'verified', evidence_id: evidence, verified_until: future(60), policy_version: 'kscan-ownership-review-v1-draft' }, REVIEWER);
  await manage(db, 'brand_visibility', { id: brand, public_label_allowed: true, public_permission_ref: 'fixture:consent', operating_status: 'active' });
  return await manage(db, 'merchant', { brand_id: brand, legal_identity_ref: 'fixture:identity', identity_verified_at: new Date(Date.now() - 1000).toISOString(), identity_expires_at: future(90), status: 'active', catalog_status: 'approved', approved_domains: ['fixture-fashion.com'], image_domains: ['images.fixture-fashion.com'], markets: ['US'], source_kind: 'authorized_json', source_authorization_ref: 'fixture:feed-license', source_authorized_until: future(90), credential_ref: 'FIXTURE_FEED' });
}
function product(changes = {}) { return { source_product_id: 'synthetic-bomber', variant_id: 'M', title: 'Synthetic cropped leather bomber', category: 'outerwear', subtype: 'bomber', attributes: { primary_color: 'black', material_estimate: 'leather', silhouette: 'cropped' }, image_url: 'https://images.fixture-fashion.com/bomber.jpg', product_url: 'https://fixture-fashion.com/products/bomber', price_amount: 120, availability: 'in_stock', markets: ['US'], source_provenance_ref: 'fixture:feed-license', ...changes }; }
async function sync(db, id, key, products = [product()], complete = true) {
  await db.query('select discovery_begin_sync($1,$2)', [id, key]);
  return (await db.query('select discovery_ingest($1,$2,$3::jsonb,$4) as n', [id, key, JSON.stringify(products), complete])).rows[0].n;
}
const eligible = async (db) => (await db.query("select discovery_candidates('outerwear','bomber','US') as r")).rows[0].r.rows.length;
const productId = async (db) => (await db.query('select id from discovery_products limit 1')).rows[0].id;
const state = async (db, id) => (await db.query('select validation_state from discovery_products where id=$1', [id])).rows[0].validation_state;

test('moderator rejection survives later full and partial syncs', async () => {
  const db = await database();
  try {
    const m = await merchant(db);
    await sync(db, m, 'catalog:2026110301');
    assert.equal(await eligible(db), 1);
    const id = await productId(db);
    await db.query("select discovery_moderate_product($1,$2,'reject')", [ADMIN, id]);
    assert.equal(await eligible(db), 0);
    await sync(db, m, 'catalog:2026110302');
    assert.equal(await state(db, id), 'rejected', 'a feed resync must not re-validate a moderator rejection');
    assert.equal(await eligible(db), 0);
    await sync(db, m, 'catalog:2026110303', [product({ source_product_id: 'synthetic-other', product_url: 'https://fixture-fashion.com/products/other' })]);
    assert.equal(await state(db, id), 'rejected', 'a complete snapshot without the product keeps the rejection, not a withdrawal');
  } finally { await db.close(); }
});
test('restore lifts rejection; only a fresh authorized sync makes the product eligible again', async () => {
  const db = await database();
  try {
    const m = await merchant(db);
    await sync(db, m, 'catalog:2026110301');
    const id = await productId(db);
    await db.query("select discovery_moderate_product($1,$2,'reject')", [ADMIN, id]);
    await db.query("select discovery_moderate_product($1,$2,'restore')", [ADMIN, id]);
    assert.equal(await state(db, id), 'withdrawn');
    assert.equal(await eligible(db), 0);
    await sync(db, m, 'catalog:2026110302');
    assert.equal(await state(db, id), 'valid');
    assert.equal(await eligible(db), 1);
    const audit = (await db.query("select actor_id,from_state,to_state from discovery_audit where action='moderated' order by id")).rows;
    assert.deepEqual(audit.map((r) => [r.actor_id, r.from_state, r.to_state]), [[ADMIN, 'valid', 'rejected'], [ADMIN, 'rejected', 'withdrawn']]);
  } finally { await db.close(); }
});
test('feed-absence withdrawal still recovers on reappearance (unchanged behaviour)', async () => {
  const db = await database();
  try {
    const m = await merchant(db);
    await sync(db, m, 'catalog:2026110301');
    const id = await productId(db);
    await sync(db, m, 'catalog:2026110302', [product({ source_product_id: 'synthetic-other', product_url: 'https://fixture-fashion.com/products/other' })]);
    assert.equal(await state(db, id), 'withdrawn');
    await sync(db, m, 'catalog:2026110303');
    assert.equal(await state(db, id), 'valid');
  } finally { await db.close(); }
});
test('moderation requires an enabled administrator and a supported decision; customers cannot call it', async () => {
  const db = await database();
  try {
    const m = await merchant(db);
    await sync(db, m, 'catalog:2026110301');
    const id = await productId(db);
    await assert.rejects(db.query("select discovery_moderate_product($1,$2,'reject')", [REVIEWER, id]), (e) => e.code === '42501');
    await assert.rejects(db.query("select discovery_moderate_product($1,$2,'reject')", [USER, id]), (e) => e.code === '42501');
    await assert.rejects(db.query("select discovery_moderate_product($1,$2,'delete')", [ADMIN, id]));
    await assert.rejects(db.query("select discovery_moderate_product($1,gen_random_uuid(),'reject')", [ADMIN]));
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`);
      await assert.rejects(db.query("select discovery_moderate_product($1,$2,'reject')", [ADMIN, id]), (e) => e.code === '42501');
      await assert.rejects(db.query('select discovery_ingest($1,$2,$3::jsonb,true)', [m, 'catalog:2026110309', '[]']), (e) => e.code === '42501');
    }
    await db.exec('reset role; set role service_role');
    assert.equal(await state(db, id), 'valid');
  } finally { await db.close(); }
});
