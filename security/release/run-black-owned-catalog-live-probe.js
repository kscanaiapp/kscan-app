#!/usr/bin/env node
'use strict';

/**
 * Bounded STAGING live probe for Black-Owned Discovery catalog operations
 * (PR #692: migration 20261103030000, `black-owned-catalog-sync`, head-noun
 * subtype matching, accessory alias, durable moderation). It tests the bytes
 * Staging serves, over the same JWT path the mobile client uses, and the real
 * worker path: the deployed worker fetches this branch's public fixture feed.
 *
 * PHASE
 *   readback  SQL readback only. No function call.
 *   full      Temporary, clearly synthetic fixture lifecycle. ALL fixture rows
 *             and the two temporary reviewer grants are deleted in `finally`.
 *
 * SAFETY
 * - Staging only: refuses the production ref/URL before any network call.
 * - Uses existing synthetic accounts only; creates/deletes no Auth account.
 * - The fixture brand is named a synthetic staging fixture, never a real
 *   business; destinations live under the K Scan-owned kscan.app domain.
 * - Report holds statuses, counts and booleans only: no token, secret, email,
 *   UUID, request body or product payload.
 */

const fs = require('node:fs');
const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const REPORT_FILE = 'black-owned-catalog-live-probe-report.json';
const DISCOVERY = '/functions/v1/black-owned-discovery';
const WORKER = '/functions/v1/black-owned-catalog-sync';
const CREDENTIAL_REF = 'STAGING_FIXTURE_FEED';
const MIGRATIONS = ['20261029125521', '20261103030000'];

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const report = { phase: null, startedAt: new Date().toISOString(), checks: [], readback: null, failures: [] };
function check(name, pass, detail = {}) {
  report.checks.push({ name, pass: Boolean(pass), ...detail });
  if (!pass) report.failures.push(name);
}

async function main() {
  const phase = process.env.PROBE_PHASE || 'readback';
  if (!['readback', 'full'].includes(phase)) throw new Error('invalid PROBE_PHASE');
  report.phase = phase;
  const ref = env('SUPABASE_STAGING_PROJECT_REF');
  const base = env('SUPABASE_STAGING_URL').replace(/\/+$/, '');
  if (ref !== STAGING_PROJECT_REF || ref === PRODUCTION_PROJECT_REF || base.includes(PRODUCTION_PROJECT_REF)) throw new Error('staging target required');
  assertNotProductionUrl(base);
  const publishable = env('SUPABASE_STAGING_PUBLISHABLE_KEY');
  const accessToken = env('SUPABASE_ACCESS_TOKEN');

  async function sql(query) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${STAGING_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`sql ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

  report.readback = await readback(sql);
  if (phase === 'readback') return;

  const workerSecret = env('DISCOVERY_CATALOG_WORKER_SECRET');
  const signIn = await signInSyntheticUser(base, publishable, env('STAGING_SYNTHETIC_ACTIVE_EMAIL'), env('STAGING_SYNTHETIC_ACTIVE_PASSWORD'));
  if (!signIn.ok) throw new Error(`synthetic sign-in failed (${signIn.status})`);
  const jwt = signIn.accessToken;
  process.stderr.write(`${maskLine(jwt)}\n`);
  const customerId = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub;
  process.stderr.write(`${maskLine(customerId)}\n`);

  async function call(path, { body, raw, headers = {} } = {}) {
    const started = Date.now();
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    return { http: res.status, ms: Date.now() - started, json };
  }
  const user = { apikey: publishable, Authorization: `Bearer ${jwt}` };
  const discover = (garment, primaryProducts = []) => call(DISCOVERY, { body: { garment, market: 'US', primaryProducts }, headers: user });
  const sync = (headers = { 'x-discovery-worker-secret': workerSecret }) => call(WORKER, { headers });
  const summarize = (r) => ({
    http: r.http, ms: r.ms, status: r.json?.status ?? null, error: r.json?.error ?? null,
    products: Array.isArray(r.json?.products) ? r.json.products.length : null,
    ownershipKeys: r.json?.primaryOwnership ? Object.keys(r.json.primaryOwnership).length : null,
    productsWithOwnership: Array.isArray(r.json?.products) ? r.json.products.filter((p) => p.ownershipIdentity).length : null,
  });
  const workerCounts = (r) => ({ http: r.http, ...(r.json && typeof r.json === 'object' ? Object.fromEntries(['enabled', 'merchants', 'succeeded', 'failed', 'skipped', 'products', 'error'].map((k) => [k, r.json[k] ?? null])) : {}) });
  const noSponsored = (r) => !JSON.stringify(r.json ?? {}).match(/"placementType":"(?!organic)|"sponsored":true|"disclosure":"Sponsored"/);

  // Scanner-shaped inputs: capitalized, plural, free-text subtypes.
  const bomber = { item_type: 'Outerwear', subtype: 'Cropped Bomber Jackets', primary_color: 'Black', material_estimate: 'Leather', silhouette: 'Cropped' };
  const hat = { item_type: 'Accessories', subtype: 'Bucket Hats', primary_color: 'black', material_estimate: 'cotton' };
  const productUrl = 'https://kscan.app/staging-fixture/products/synthetic-bomber';

  // ---- worker authorization, before any fixture exists ----------------------
  const noSecret = await sync({});
  const jwtOnly = await sync(user);
  const wrong = await sync({ 'x-discovery-worker-secret': `${workerSecret}x` });
  const empty = await sync();
  check('worker: no secret -> 401', noSecret.http === 401, workerCounts(noSecret));
  check('worker: customer JWT without worker secret -> 401', jwtOnly.http === 401, workerCounts(jwtOnly));
  check('worker: wrong secret -> 401', wrong.http === 401, workerCounts(wrong));
  check('worker: authorized, enabled, zero real merchants -> nothing synced', empty.http === 200 && empty.json?.enabled === true && empty.json?.merchants === 0, workerCounts(empty));

  const anon = await call(DISCOVERY, { body: { garment: bomber, market: 'US', primaryProducts: [] } });
  check('discovery: no JWT rejected', anon.http === 401 || anon.http === 403, summarize(anon));
  const emptyCatalog = await discover(bomber);
  check('discovery: authenticated empty catalog -> 200 empty', emptyCatalog.http === 200 && emptyCatalog.json?.status === 'empty', summarize(emptyCatalog));

  // ---- fixture lifecycle ------------------------------------------------------
  const adminId = (await sql(`select id from auth.users where email=${lit(env('STAGING_SYNTHETIC_PENDING_EMAIL'))}`))[0]?.id;
  const reviewerId = (await sql(`select id from auth.users where email=${lit(env('STAGING_SYNTHETIC_LOCKED_EMAIL'))}`))[0]?.id;
  if (!adminId || !reviewerId || adminId === reviewerId) throw new Error('fixture actors unavailable');
  process.stderr.write(`${maskLine(adminId)}\n${maskLine(reviewerId)}\n`);
  const fixture = { brand: null, merchant: null };
  const future = (secs) => new Date(Date.now() + secs * 1000).toISOString();
  const manage = async (action, data, actor = adminId) =>
    (await sql(`select public.discovery_manage(${lit(actor)}::uuid,${lit(action)},${lit(JSON.stringify(data))}::jsonb) as id`))[0].id;
  const site = 'https://kscan.app/staging-fixture/';
  // Normalized rows, identical to what the worker ingests from the fixture feed.
  const row = (id, variant, sku, title, category, subtype, attributes, slug, price) => ({ source_product_id: id, variant_id: variant, sku, title, category, subtype, attributes: { ...attributes, item_type: category, subtype }, image_url: `https://kscan.app/staging-fixture/images/${slug}.jpg`, product_url: `https://kscan.app/staging-fixture/products/${slug}`, price_amount: price, currency: 'USD', availability: 'in_stock', sizes: variant ? [variant] : [], markets: ['US'], source_provenance_ref: 'staging-fixture:feed-authorization' });
  const bomberAttrs = { primary_color: 'black', material_estimate: 'leather', silhouette: 'cropped' };
  const rows = [
    row('staging-fixture-bomber', 'M', 'kscan-staging-fixture-m', 'K Scan staging fixture - synthetic cropped leather bomber', 'outerwear', 'bomber jacket', bomberAttrs, 'synthetic-bomber', 120),
    row('staging-fixture-bomber', 'L', 'kscan-staging-fixture-l', 'K Scan staging fixture - synthetic cropped leather bomber', 'outerwear', 'bomber jacket', bomberAttrs, 'synthetic-bomber', 120),
    row('staging-fixture-bucket-hat', '', null, 'K Scan staging fixture - synthetic black cotton bucket hat', 'accessory', 'bucket hat', { primary_color: 'black', material_estimate: 'cotton', silhouette: 'structured' }, 'synthetic-bucket-hat', 45),
  ];
  let syncN = 0;
  const ingest = async () => {
    const key = `staging-probe-${Date.now()}-${syncN++}`;
    await sql(`select public.discovery_begin_sync(${lit(fixture.merchant)}::uuid,${lit(key)})`);
    return (await sql(`select public.discovery_ingest(${lit(fixture.merchant)}::uuid,${lit(key)},${lit(JSON.stringify(rows))}::jsonb,true) as n`))[0].n;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let merchantData;

  try {
    await sql(`insert into public.discovery_reviewers values(${lit(adminId)},'administrator',true),(${lit(reviewerId)},'reviewer',true)`);
    fixture.brand = await manage('register_brand', { name: 'K Scan Staging Fixture Brand (synthetic, not a real business)', website: site, categories: ['outerwear', 'accessory'], markets: ['US'] });
    const evidence = await manage('submit_evidence', { brand_id: fixture.brand, method: 'authorized_attestation', provenance_ref: 'staging-fixture:attestation', corroboration_ref: 'staging-fixture:corroboration', authorized_submission: true, expires_at: future(90 * 86400), retain_until: future(91 * 86400) });
    await manage('request_review', { id: fixture.brand });
    let selfReview = false;
    try { await manage('review_ownership', { id: fixture.brand, status: 'verified', evidence_id: evidence, verified_until: future(30 * 86400), policy_version: 'kscan-ownership-review-v1-draft' }, adminId); selfReview = true; } catch { /* expected */ }
    check('ownership: submitter cannot self-verify', !selfReview);
    await manage('review_ownership', { id: fixture.brand, status: 'verified', evidence_id: evidence, verified_until: future(30 * 86400), policy_version: 'kscan-ownership-review-v1-draft' }, reviewerId);
    await manage('brand_visibility', { id: fixture.brand, public_label_allowed: true, public_permission_ref: 'staging-fixture:consent', operating_status: 'active' });
    merchantData = { brand_id: fixture.brand, legal_identity_ref: 'staging-fixture:identity', identity_verified_at: future(-60), identity_expires_at: future(90 * 86400), status: 'active', catalog_status: 'approved', approved_domains: ['kscan.app', 'raw.githubusercontent.com'], image_domains: ['kscan.app'], markets: ['US'], source_kind: 'authorized_json', source_authorization_ref: 'staging-fixture:feed-authorization', source_authorized_until: future(90 * 86400), credential_ref: CREDENTIAL_REF };
    fixture.merchant = await manage('merchant', merchantData);

    // ---- the deployed worker fetches the public fixture feed ----------------
    const synced = await sync();
    check('worker: fetches the authorized feed and ingests every row', synced.http === 200 && synced.json?.merchants === 1 && synced.json?.succeeded === 1 && synced.json?.products === 3, workerCounts(synced));
    check('worker: response carries counts only', !/[0-9a-f]{8}-[0-9a-f]{4}-|kscan\.app|staging-fixture/.test(JSON.stringify(synced.json ?? {})));
    const stored = await sql(`select category, subtype, count(*)::int n from public.discovery_products where merchant_id=${lit(fixture.merchant)} and validation_state='valid' group by 1,2 order by 1`);
    check('ingest: scanner-facing subtypes stored canonically', JSON.stringify(stored.map((r) => [r.category, r.subtype, r.n])) === JSON.stringify([['accessory', 'bucket hat', 1], ['outerwear', 'bomber jacket', 2]]), { stored: stored.map((r) => `${r.category}:${r.subtype}:${r.n}`) });
    const again = await sync();
    check('worker: same-hour rerun is idempotent (no re-ingest)', again.http === 200 && again.json?.succeeded === 1 && again.json?.products === 3, workerCounts(again));

    // ---- retrieval with scanner phrasing --------------------------------------
    const ready = await discover(bomber);
    check('subtype: "Cropped Bomber Jackets" matches catalog "bomber jacket"', ready.json?.status === 'ready' && ready.json.products.length === 1, summarize(ready));
    check('dedup: two variants of one product render once', ready.json?.products?.length === 1);
    check('retrieval: organic/similar only, nothing sponsored', noSponsored(ready) && (ready.json?.products ?? []).every((p) => p.placementType === 'organic' && p.matchType === 'similar'));
    check('retrieval: verified ownership label present and authorized', ready.json?.products?.[0]?.ownershipIdentity?.publicOwnershipLabelAllowed === true && ready.json?.products?.[0]?.ownershipIdentity?.ownershipVerificationStatus === 'verified');
    check('retrieval: price, image and https destination surfaced', /^https:\/\/kscan\.app\//.test(ready.json?.products?.[0]?.productUrl ?? '') && /^https:\/\//.test(ready.json?.products?.[0]?.imageUrl ?? '') && Boolean(ready.json?.products?.[0]?.price));
    check('retrieval: no score or private provenance in payload', !/fashionMatchScore|provenance_ref|reviewer_id|submitted_by|credential|authorization_ref/.test(JSON.stringify(ready.json ?? {})));
    const accessory = await discover(hat);
    check('category: "Accessories" scans reach the accessory catalog', accessory.json?.status === 'ready' && accessory.json.products.length === 1, summarize(accessory));
    const boots = await discover({ item_type: 'footwear', subtype: 'chelsea boots', primary_color: 'black', material_estimate: 'leather' });
    check('relevance: other category -> empty', boots.json?.status === 'empty', summarize(boots));
    const parka = await discover({ ...bomber, subtype: 'parka' });
    check('relevance: other head noun -> empty', parka.json?.status === 'empty', summarize(parka));
    const weak = await discover({ ...bomber, primary_color: 'white', material_estimate: 'cotton', silhouette: 'oversized' });
    check('relevance: conflicting attributes -> empty', weak.json?.status === 'empty', summarize(weak));
    const withPrimary = await discover(bomber, [{ id: 'primary-fixture', productUrl }, { id: 'primary-other', productUrl: 'https://kscan.app/staging-fixture/products/unrelated' }]);
    check('dedup: product already shown as primary is excluded', withPrimary.json?.products?.length === 0, summarize(withPrimary));
    check('badges: only the exact primary URL identity is labelled', withPrimary.json?.primaryOwnership?.['primary-fixture']?.ownershipVerificationStatus === 'verified' && !withPrimary.json?.primaryOwnership?.['primary-other'], summarize(withPrimary));
    const bad = await call(DISCOVERY, { raw: '{"garment":{"item_type":"outerwear"},"market":"US","primaryProducts":[],"image":"x"}', headers: user });
    check('validation: unknown field rejected 400', bad.http === 400 && bad.json?.error === 'invalid_discovery_request', summarize(bad));
    const badUrl = await discover(bomber, [{ id: 'p', productUrl: 'x'.repeat(3000) }]);
    check('validation: oversized primary URL rejected 400', badUrl.http === 400, summarize(badUrl));

    // ---- durable moderation (migration 20261103030000) ------------------------
    const bomberIds = (await sql(`select id from public.discovery_products where merchant_id=${lit(fixture.merchant)} and source_product_id='staging-fixture-bomber'`)).map((r) => r.id);
    for (const id of bomberIds) await sql(`select public.discovery_moderate_product(${lit(adminId)}::uuid,${lit(id)}::uuid,'reject')`);
    const rejected = await discover(bomber);
    check('moderation: rejected product leaves the shelf', rejected.json?.status === 'empty', summarize(rejected));
    check('moderation: authorized sync after rejection ingests all rows', (await ingest()) === 3);
    const afterSync = await discover(bomber);
    const states = (await sql(`select distinct validation_state from public.discovery_products where merchant_id=${lit(fixture.merchant)} and source_product_id='staging-fixture-bomber'`)).map((r) => r.validation_state);
    check('moderation: rejection survives a later full sync', afterSync.json?.status === 'empty' && states.length === 1 && states[0] === 'rejected', { ...summarize(afterSync), states });
    check('moderation: unrelated product unaffected', (await discover(hat)).json?.status === 'ready');
    let reviewerModerated = false;
    try { await sql(`select public.discovery_moderate_product(${lit(reviewerId)}::uuid,${lit(bomberIds[0])}::uuid,'restore')`); reviewerModerated = true; } catch { /* expected */ }
    check('moderation: non-administrator cannot moderate', !reviewerModerated);
    for (const id of bomberIds) await sql(`select public.discovery_moderate_product(${lit(adminId)}::uuid,${lit(id)}::uuid,'restore')`);
    check('moderation: restore alone does not republish', (await discover(bomber)).json?.status === 'empty');
    await ingest();
    check('moderation: restore + fresh authorized sync republishes', (await discover(bomber)).json?.status === 'ready');
    const audits = (await sql(`select count(*)::int n from public.discovery_audit where action='moderated' and entity_id in (${bomberIds.map(lit).join(',')})`))[0].n;
    check('moderation: every decision audited', audits === bomberIds.length * 2, { audits });

    // ---- eligibility lifecycle -------------------------------------------------
    await manage('brand_visibility', { id: fixture.brand, public_label_allowed: false });
    const optOut = await discover(bomber, [{ id: 'primary-fixture', productUrl }]);
    check('consent: public permission withdrawn -> empty, no badge', optOut.json?.status === 'empty' && Object.keys(optOut.json?.primaryOwnership ?? {}).length === 0, summarize(optOut));
    await manage('brand_visibility', { id: fixture.brand, public_label_allowed: true, public_permission_ref: 'staging-fixture:consent', operating_status: 'active' });
    await manage('merchant', { ...merchantData, id: fixture.merchant, source_authorized_until: future(-1) });
    check('source authorization expired -> empty', (await discover(bomber)).json?.status === 'empty');
    const unauthorizedSync = await sync();
    check('worker: expired source authorization is refused, never synced', unauthorizedSync.http === 200 && unauthorizedSync.json?.succeeded === 0 && unauthorizedSync.json?.failed === 1, workerCounts(unauthorizedSync));
    await manage('merchant', { ...merchantData, id: fixture.merchant });
    await sql(`update public.discovery_products set synced_at=now()-interval '25 hours', expires_at=now()-interval '1 hour' where merchant_id=${lit(fixture.merchant)}`);
    check('freshness: >24h snapshot -> empty', (await discover(bomber)).json?.status === 'empty');
    await ingest();
    check('freshness: fresh sync restores retrieval', (await discover(bomber)).json?.status === 'ready');
    await manage('review_ownership', { id: fixture.brand, status: 'revoked' }, reviewerId);
    const revoked = await discover(bomber, [{ id: 'primary-fixture', productUrl }]);
    check('revocation: revoked ownership -> empty, no badge', revoked.json?.status === 'empty' && Object.keys(revoked.json?.primaryOwnership ?? {}).length === 0, summarize(revoked));
    await manage('request_review', { id: fixture.brand });
    await manage('review_ownership', { id: fixture.brand, status: 'verified', evidence_id: evidence, verified_until: future(45), policy_version: 'kscan-ownership-review-v1-draft' }, reviewerId);
    check('expiry: short verification live before deadline', (await discover(bomber)).json?.status === 'ready');
    await sleep(50_000);
    const expired = await discover(bomber, [{ id: 'primary-fixture', productUrl }]);
    check('expiry: past deadline -> empty, no badge (cache cannot leak)', expired.json?.status === 'empty' && Object.keys(expired.json?.primaryOwnership ?? {}).length === 0, summarize(expired));

    const campaigns = (await sql('select count(*)::int as n, count(*) filter (where active)::int as active from public.discovery_campaigns'))[0];
    check('sponsorship: zero campaigns, zero active', campaigns.n === 0 && campaigns.active === 0, campaigns);
  } finally {
    const steps = [];
    if (fixture.merchant) steps.push(`delete from public.discovery_products where merchant_id=${lit(fixture.merchant)};`, `delete from public.discovery_sync_runs where merchant_id=${lit(fixture.merchant)};`, `delete from public.discovery_merchants where id=${lit(fixture.merchant)};`);
    if (fixture.brand) steps.push(`delete from public.discovery_brands where id=${lit(fixture.brand)};`, `delete from public.discovery_evidence where brand_id=${lit(fixture.brand)};`);
    const cleanup = [];
    if (steps.length) cleanup.push(`do $fx$ begin perform set_config('discovery.actor_id',${lit(adminId)},true); ${steps.join(' ')} end $fx$`);
    cleanup.push(`delete from public.discovery_reviewers where actor_id in (${lit(adminId)},${lit(reviewerId)})`, `delete from public.discovery_request_limits where actor_id=${lit(customerId)}`);
    for (const q of cleanup) {
      try { await sql(q); } catch (e) { report.failures.push(`cleanup: ${String(e.message).slice(0, 120)}`); }
    }
    const left = (await sql('select (select count(*) from public.discovery_brands)::int b,(select count(*) from public.discovery_merchants)::int m,(select count(*) from public.discovery_products)::int p,(select count(*) from public.discovery_reviewers)::int r,(select count(*) from public.discovery_evidence)::int e,(select count(*) from public.discovery_sync_runs)::int s'))[0];
    check('cleanup: no fixture rows or reviewer grants remain', Object.values(left).every((n) => n === 0), left);
  }
}

async function readback(sql) {
  const [r] = await sql(`select json_build_object(
    'ledger', (select json_agg(version order by version) from supabase_migrations.schema_migrations where version in (${MIGRATIONS.map((v) => `'${v}'`).join(',')})),
    'customerTableGrants', (select coalesce(json_agg(distinct grantee||':'||table_name||':'||privilege_type),'[]'::json) from information_schema.role_table_grants where table_schema='public' and table_name like 'discovery\\_%' and grantee in ('anon','authenticated','PUBLIC')),
    'functions', (select json_agg(json_build_object('f',p.proname,'secdef',p.prosecdef,'pinnedPath',coalesce(array_to_string(p.proconfig,','),'') like '%search_path=%','anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),'service',has_function_privilege('service_role',p.oid,'EXECUTE')) order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'discovery\\_%'),
    'ingestPreservesRejection', (select position('validation_state=''rejected'' then ''rejected''' in prosrc)>0 from pg_proc where proname='discovery_ingest'),
    'rowCounts', json_build_object('brands',(select count(*) from public.discovery_brands),'merchants',(select count(*) from public.discovery_merchants),'products',(select count(*) from public.discovery_products),'reviewers',(select count(*) from public.discovery_reviewers),'activeCampaigns',(select count(*) from public.discovery_campaigns where active)),
    'runtimeGuard', (select environment from public.discovery_runtime_guard where singleton)
  ) as r`);
  const rb = r.r;
  const fns = rb.functions ?? [];
  check('readback: both discovery migrations recorded once', JSON.stringify(rb.ledger) === JSON.stringify(MIGRATIONS), { ledger: rb.ledger });
  check('readback: discovery_moderate_product present, service-role only', fns.some((f) => f.f === 'discovery_moderate_product' && f.service && !f.anon && !f.authenticated));
  check('readback: ingest preserves moderator rejection', rb.ingestPreservesRejection === true);
  check('readback: no anon/authenticated/PUBLIC table grants', rb.customerTableGrants.length === 0, { grants: rb.customerTableGrants.length });
  check('readback: no SECURITY DEFINER discovery functions, all pin search_path', fns.every((f) => !f.secdef && f.pinnedPath), { functions: fns.length });
  check('readback: anon/authenticated cannot EXECUTE any discovery function', fns.every((f) => !f.anon && !f.authenticated));
  check('readback: zero active campaigns', Number(rb.rowCounts.activeCampaigns) === 0, rb.rowCounts);
  return { ledger: rb.ledger, rowCounts: rb.rowCounts, runtimeGuard: rb.runtimeGuard, functions: fns.length };
}

main()
  .catch((error) => { report.failures.push(`fatal: ${String(error?.message ?? error).slice(0, 300)}`); })
  .finally(() => {
    report.finishedAt = new Date().toISOString();
    report.verdict = report.failures.length === 0 ? 'PASS' : 'FAIL';
    const out = JSON.stringify(report, null, 2);
    if (/eyJ[A-Za-z0-9_-]{10,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@[a-z0-9-]+\.[a-z]/i.test(out)) {
      fs.writeFileSync(REPORT_FILE, JSON.stringify({ verdict: 'FAIL', failures: ['report sanitizer tripped; withheld'] }));
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(REPORT_FILE, out);
    process.exitCode = report.verdict === 'PASS' ? 0 : 1;
  });
