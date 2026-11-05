const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function database() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public, auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    insert into auth.users values('${A}'),('${B}');`);
  await db.exec(read('20260713000001_user_stylist_preferences.sql'));
  await db.exec('grant select,insert,update on public.user_stylist_preferences to authenticated');
  await db.exec(read('20261104233754_black_owned_brand_search_expansion.sql'));
  return db;
}
const insert = async (db, id = 'fixture-source', domain = 'fixture-fashion.com', brand = 'Research Fixture') => db.query(`insert into public.black_owned_brand_search_sources
  (id,brand_name,official_website,canonical_domain,categories,us_eligible,enabled,review_status,reviewed_at,provenance_references)
  values($1,$2,$3,$4,array['outerwear'],true,true,'qualified',now(),array['fixture:public-review']) returning revision`, [id, brand, `https://${domain}/`, domain]);

test('actual migration: qualified source needs no merchant, feed, ownership or product records; updates and removals audited', async () => {
  const db = await database();
  try {
    await db.exec('set role service_role');
    const initial = (await insert(db)).rows[0].revision;
    await db.exec("update public.black_owned_brand_search_sources set enabled=false where id='fixture-source'");
    assert.ok(Number((await db.query('select revision from public.black_owned_brand_search_sources')).rows[0].revision) > Number(initial));
    await db.exec("delete from public.black_owned_brand_search_sources where id='fixture-source'");
    assert.deepEqual((await db.query('select operation from public.brand_search_source_audit order by id')).rows.map(r => r.operation), ['INSERT','UPDATE','DELETE']);
    await assert.rejects(db.exec('delete from public.brand_search_source_audit'), /permission denied/);
  } finally { await db.close(); }
});
test('actual migration: duplicates, stale, excluded, missing URL and unsupported categories rejected', async () => {
  const db = await database();
  try {
    await db.exec('set role service_role'); await insert(db);
    await assert.rejects(insert(db, 'duplicate-domain', 'fixture-fashion.com', 'Other'), /unique/);
    await assert.rejects(insert(db, 'duplicate-brand', 'other-fashion.com', 'research fixture'), /unique/);
    for (const update of ["official_website=''", "categories=array['beauty']", "reviewed_at=now()-interval '181 days'", "us_eligible=false", "review_status='excluded'", "alternate_domains=array['other-fashion.com']"]) {
      if (update.startsWith('alternate_')) await insert(db, 'other', 'other-fashion.com', 'Other');
      await assert.rejects(db.exec(`update public.black_owned_brand_search_sources set ${update} where id='fixture-source'`));
    }
  } finally { await db.close(); }
});
test('actual migration: anon/authenticated cannot read or edit sources, audit or coverage, or call service RPC', async () => {
  const db = await database();
  try {
    for (const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);
      for (const table of ['black_owned_brand_search_sources','brand_search_source_audit','brand_search_source_coverage']) {
        await assert.rejects(db.exec(`select * from public.${table}`), /permission denied/);
        await assert.rejects(db.exec(`delete from public.${table}`), /permission denied/);
      }
      await assert.rejects(db.exec("select public.record_brand_search_coverage('fixture-source',1,1)"), /permission denied/);
      await assert.rejects(insert(db), /permission denied/);
      await db.exec('reset role');
    }
  } finally { await db.close(); }
});
test('actual migration: preference defaults OFF; existing RLS prevents cross-account reads and updates', async () => {
  const db = await database();
  try {
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${A}'; insert into public.user_stylist_preferences(user_id) values('${A}')`);
    assert.equal((await db.query('select include_black_owned_brand_search as enabled from public.user_stylist_preferences')).rows[0].enabled, false);
    await db.exec('update public.user_stylist_preferences set include_black_owned_brand_search=true');
    await db.exec(`set request.jwt.claim.sub='${B}'`);
    assert.equal((await db.query('select * from public.user_stylist_preferences')).rows.length, 0);
    await assert.rejects(db.exec(`insert into public.user_stylist_preferences(user_id) values('${A}')`), /row-level security/);
    await db.exec(`update public.user_stylist_preferences set include_black_owned_brand_search=false where user_id='${A}'`);
    await db.exec(`set request.jwt.claim.sub='${A}'`);
    assert.equal((await db.query('select include_black_owned_brand_search as enabled from public.user_stylist_preferences')).rows[0].enabled, true);
  } finally { await db.close(); }
});
test('actual migration: coverage is revision-bound; disabling source rejects stale statistics', async () => {
  const db = await database();
  try {
    await db.exec('set role service_role'); const revision = (await insert(db)).rows[0].revision;
    await db.query('select public.record_brand_search_coverage($1,$2,2)', ['fixture-source',revision]);
    let row = (await db.query('select * from public.brand_search_source_coverage')).rows[0];
    assert.equal(Number(row.search_count),1); assert.equal(Number(row.valid_product_count),2); assert.ok(row.last_successful_search_at);
    await db.exec("update public.black_owned_brand_search_sources set enabled=false where id='fixture-source'");
    await db.query('select public.record_brand_search_coverage($1,$2,2)', ['fixture-source',revision]);
    row = (await db.query('select * from public.brand_search_source_coverage')).rows[0]; assert.equal(Number(row.search_count),1);
  } finally { await db.close(); }
});
