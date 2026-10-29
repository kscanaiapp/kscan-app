#!/usr/bin/env node
'use strict';

/**
 * Bounded STAGING live probe for the deployed `black-owned-discovery` Edge
 * Function and migration 20261029125521. Tests the bytes staging serves, over
 * the same auth path the mobile client uses. Flags are NOT changed here; the
 * operator sets them between dispatches and passes the expected PHASE.
 *
 * PHASE
 *   readback   SQL readback only (ledger, RLS, grants, function privileges,
 *              row counts, runtime guard). No function call.
 *   disabled   Both organic flags false: authenticated call returns
 *              `unavailable` and performs zero quota/catalog work.
 *   discovery  Discovery on, badges off: auth rejection, empty catalog,
 *              invalid body, no ownership metadata.
 *   full       Discovery and badges on: temporary clearly-synthetic fixture
 *              lifecycle (prospect pipeline, ownership review, merchant,
 *              authorized ingest), retrieval, relevance, dedup, badges,
 *              opt-out, revocation, expiry, freshness, source authorization,
 *              quota, no sponsored output. ALL fixture rows and the two
 *              temporary reviewer grants are deleted in `finally`.
 *
 * SAFETY
 * - Staging only: refuses the production ref/URL before any network call.
 * - Uses existing synthetic accounts only; creates/deletes no Auth account.
 *   The PENDING and LOCKED synthetic accounts receive temporary staging-only
 *   reviewer rows for the duration of `full` and lose them in `finally`.
 * - Fixture destinations live under the K Scan-owned kscan.app domain and the
 *   brand is named as a synthetic staging fixture, never a real business.
 * - Report holds statuses, counts and booleans only: no token, email, UUID,
 *   request body or product payload.
 */

const fs = require('node:fs');
const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const REPORT_FILE = 'black-owned-discovery-live-probe-report.json';
const FN_PATH = '/functions/v1/black-owned-discovery';
const PHASES = ['readback', 'disabled', 'discovery', 'full'];

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
  if (!PHASES.includes(phase)) throw new Error('invalid PROBE_PHASE');
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

  const signIn = await signInSyntheticUser(base, publishable, env('STAGING_SYNTHETIC_ACTIVE_EMAIL'), env('STAGING_SYNTHETIC_ACTIVE_PASSWORD'));
  if (!signIn.ok) throw new Error(`synthetic sign-in failed (${signIn.status})`);
  const jwt = signIn.accessToken;
  process.stderr.write(`${maskLine(jwt)}\n`);
  const customerId = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub;
  process.stderr.write(`${maskLine(customerId)}\n`);

  async function call(body, auth = 'user', raw) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth === 'user') Object.assign(headers, { apikey: publishable, Authorization: `Bearer ${jwt}` });
    if (auth === 'apikey') headers.apikey = publishable;
    const started = Date.now();
    const res = await fetch(`${base}${FN_PATH}`, { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    return { http: res.status, ms: Date.now() - started, json };
  }
  const summarize = (r) => ({
    http: r.http, ms: r.ms, status: r.json?.status ?? null, error: r.json?.error ?? null, version: r.json?.version ?? null,
    products: Array.isArray(r.json?.products) ? r.json.products.length : null,
    ownershipKeys: r.json?.primaryOwnership ? Object.keys(r.json.primaryOwnership).length : null,
    placementTypes: Array.isArray(r.json?.products) ? [...new Set(r.json.products.map((p) => p.placementType))] : [],
    productsWithOwnership: Array.isArray(r.json?.products) ? r.json.products.filter((p) => p.ownershipIdentity).length : null,
  });
  const noSponsored = (r) => !JSON.stringify(r.json ?? {}).match(/"placementType":"(?!organic)|"sponsored":true|"disclosure":"Sponsored"/);
  const limitRows = async () => (await sql(`select coalesce(sum(requests),0)::int as n from public.discovery_request_limits where actor_id=${lit(customerId)}`))[0].n;

  const garment = { item_type: 'outerwear', subtype: 'bomber', primary_color: 'black', material_estimate: 'leather', silhouette: 'cropped' };
  const request = (overrides = {}, primaryProducts = []) => ({ garment: { ...garment, ...overrides }, market: 'US', primaryProducts });

  if (phase === 'disabled') {
    const before = await limitRows();
    const authd = await call(request());
    const anon = await call(request(), 'none');
    const keyOnly = await call(request(), 'apikey');
    const after = await limitRows();
    check('disabled: authenticated returns 200 unavailable', authd.http === 200 && authd.json?.status === 'unavailable', summarize(authd));
    check('disabled: zero quota/catalog work (request_limits unchanged)', before === after, { before, after });
    check('disabled: no-JWT request recorded', true, { ...summarize(anon), note: 'gateway verify_jwt=true may reject before handler' });
    check('disabled: publishable-key-only request recorded', true, summarize(keyOnly));
    check('disabled: no sponsored output', noSponsored(authd));
    return;
  }

  if (phase === 'discovery') {
    const anon = await call(request(), 'none');
    const keyOnly = await call(request(), 'apikey');
    const before = await limitRows();
    const authd = await call(request());
    const bad = await call(null, 'user', '{"garment":{"item_type":"outerwear"},"market":"US","primaryProducts":[],"image":"x"}');
    const after = await limitRows();
    check('discovery: anonymous (no JWT) rejected', anon.http === 401 || anon.http === 403, summarize(anon));
    check('discovery: publishable key without user session rejected', keyOnly.http === 401 || keyOnly.http === 403, summarize(keyOnly));
    check('discovery: authenticated empty catalog returns 200 empty', authd.http === 200 && authd.json?.status === 'empty' && authd.json?.products?.length === 0, summarize(authd));
    check('discovery: version black-owned-discovery-v1', authd.json?.version === 'black-owned-discovery-v1');
    check('discovery: badges off -> no primary ownership metadata', Object.keys(authd.json?.primaryOwnership ?? {}).length === 0);
    check('discovery: unknown field (e.g. image) rejected 400', bad.http === 400 && bad.json?.error === 'invalid_discovery_request', summarize(bad));
    check('discovery: quota claimed for authenticated call', after > before, { before, after });
    check('discovery: no sponsored output', noSponsored(authd));
    return;
  }

  // ---- full fixture lifecycle -------------------------------------------
  const adminId = (await sql(`select id from auth.users where email=${lit(env('STAGING_SYNTHETIC_PENDING_EMAIL'))}`))[0]?.id;
  const reviewerId = (await sql(`select id from auth.users where email=${lit(env('STAGING_SYNTHETIC_LOCKED_EMAIL'))}`))[0]?.id;
  if (!adminId || !reviewerId || adminId === reviewerId) throw new Error('fixture actors unavailable');
  process.stderr.write(`${maskLine(adminId)}\n${maskLine(reviewerId)}\n`);
  const fixture = { brand: null, merchant: null, prospect: null };
  const future = (secs) => new Date(Date.now() + secs * 1000).toISOString();
  const manage = async (action, data, actor = adminId) =>
    (await sql(`select public.discovery_manage(${lit(actor)}::uuid,${lit(action)},${lit(JSON.stringify(data))}::jsonb) as id`))[0].id;
  const site = 'https://kscan.app/staging-fixture/';
  const productUrl = 'https://kscan.app/staging-fixture/products/synthetic-bomber';
  const product = (variant, sku) => ({ source_product_id: 'staging-fixture-bomber', variant_id: variant, sku, title: 'K Scan staging fixture - synthetic cropped leather bomber', category: 'outerwear', subtype: 'bomber', attributes: { primary_color: 'black', material_estimate: 'leather', silhouette: 'cropped' }, image_url: 'https://kscan.app/staging-fixture/images/synthetic-bomber.jpg', product_url: productUrl, price_amount: 120, currency: 'USD', availability: 'in_stock', sizes: [variant], markets: ['US'], source_provenance_ref: 'staging-fixture:feed-authorization' });
  let syncN = 0;
  const ingest = async () => {
    const key = `staging-fixture-sync-${Date.now()}-${syncN++}`;
    await sql(`select public.discovery_begin_sync(${lit(fixture.merchant)}::uuid,${lit(key)})`);
    return (await sql(`select public.discovery_ingest(${lit(fixture.merchant)}::uuid,${lit(key)},${lit(JSON.stringify([product('M', 'kscan-staging-fixture-m'), product('L', 'kscan-staging-fixture-l')]))}::jsonb,true) as n`))[0].n;
  };
  let merchantData;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await sql(`insert into public.discovery_reviewers values(${lit(adminId)},'administrator',true),(${lit(reviewerId)},'reviewer',true)`);

    // Phase C rehearsal: prospect pipeline is record-keeping only.
    fixture.prospect = await manage('prospect', { name: 'K Scan Staging Fixture Prospect (synthetic)', website: site, contact_channel: 'other', intake_checklist: { fixture: true } });
    for (const status of ['contacted', 'evaluating', 'onboarding']) await manage('prospect', { id: fixture.prospect, name: 'K Scan Staging Fixture Prospect (synthetic)', website: site, contact_channel: 'other', status, intake_checklist: { fixture: true } });
    let skipped = true;
    try { await manage('prospect', { id: fixture.prospect, name: 'x-invalid', status: 'prospect' }); skipped = false; } catch { /* expected */ }
    check('rehearsal: prospect -> contacted -> evaluating -> onboarding; backwards transition rejected', skipped);

    fixture.brand = await manage('register_brand', { name: 'K Scan Staging Fixture Brand (synthetic, not a real business)', website: site, categories: ['outerwear'], markets: ['US'] });
    const evidence = await manage('submit_evidence', { brand_id: fixture.brand, method: 'authorized_attestation', provenance_ref: 'staging-fixture:attestation', corroboration_ref: 'staging-fixture:corroboration', authorized_submission: true, expires_at: future(90 * 86400), retain_until: future(91 * 86400) });
    let selfReview = false;
    await manage('request_review', { id: fixture.brand });
    try { await manage('review_ownership', { id: fixture.brand, status: 'verified', evidence_id: evidence, verified_until: future(30 * 86400), policy_version: 'kscan-ownership-review-v1-draft' }, adminId); selfReview = true; } catch { /* expected */ }
    check('ownership: submitter cannot self-verify', !selfReview);
    await manage('review_ownership', { id: fixture.brand, status: 'verified', evidence_id: evidence, verified_until: future(30 * 86400), policy_version: 'kscan-ownership-review-v1-draft' }, reviewerId);

    const preConsent = await (async () => {
      merchantData = { brand_id: fixture.brand, legal_identity_ref: 'staging-fixture:identity', identity_verified_at: future(-60), identity_expires_at: future(90 * 86400), status: 'active', catalog_status: 'approved', approved_domains: ['kscan.app'], image_domains: ['kscan.app'], markets: ['US'], source_kind: 'authorized_json', source_authorization_ref: 'staging-fixture:feed-authorization', source_authorized_until: future(90 * 86400) };
      fixture.merchant = await manage('merchant', merchantData);
      await manage('prospect', { id: fixture.prospect, name: 'K Scan Staging Fixture Prospect (synthetic)', website: site, contact_channel: 'other', status: 'onboarding', brand_id: fixture.brand, merchant_id: fixture.merchant, intake_checklist: { fixture: true } });
      check('catalog: authorized ingest of 2 variants', (await ingest()) === 2);
      return call(request());
    })();
    check('consent: verified but no public permission -> empty', preConsent.json?.status === 'empty', summarize(preConsent));

    await manage('brand_visibility', { id: fixture.brand, public_label_allowed: true, public_permission_ref: 'staging-fixture:consent', operating_status: 'active' });
    const partnerships = (await sql(`select count(*)::int as n from public.discovery_partnerships where brand_id=${lit(fixture.brand)}`))[0].n;

    const ready = await call(request());
    check('retrieval: organic ready with zero partnership records', ready.json?.status === 'ready' && ready.json.products.length >= 1 && partnerships === 0, summarize(ready));
    check('dedup: two variants of one product render once', ready.json?.products?.length === 1, summarize(ready));
    check('retrieval: all products organic/similar, no sponsored', noSponsored(ready) && (ready.json?.products ?? []).every((p) => p.placementType === 'organic' && p.matchType === 'similar'));
    check('retrieval: no raw score or private provenance in payload', !/fashionMatchScore|provenance_ref|reviewer_id|submitted_by|terms_ref|credential/.test(JSON.stringify(ready.json ?? {})));
    check('retrieval: price/currency surfaced', ready.json?.products?.[0]?.price !== undefined, { price: ready.json?.products?.[0]?.price ?? null, currency: ready.json?.products?.[0]?.currency ?? null });

    const withPrimary = await call(request({}, [{ id: 'primary-fixture', productUrl }, { id: 'primary-other', productUrl: 'https://kscan.app/staging-fixture/products/unrelated' }]));
    check('dedup: primary-listed product excluded from organic shelf', withPrimary.json?.products?.length === 0, summarize(withPrimary));
    check('badges: exact primary URL identity gets ownership metadata; unrelated does not', withPrimary.json?.primaryOwnership?.['primary-fixture']?.ownershipVerificationStatus === 'verified' && !withPrimary.json?.primaryOwnership?.['primary-other'], summarize(withPrimary));

    const otherSubtype = await call(request({ subtype: 'parka' }));
    check('relevance: different subtype -> empty', otherSubtype.json?.status === 'empty', summarize(otherSubtype));
    const weak = await call(request({ primary_color: 'white', material_estimate: 'cotton', silhouette: 'oversized' }));
    check('relevance: conflicting attributes below threshold -> empty', weak.json?.status === 'empty', summarize(weak));

    await manage('brand_visibility', { id: fixture.brand, public_label_allowed: false });
    const optOut = await call(request({}, [{ id: 'primary-fixture', productUrl }]));
    check('opt-out: public permission withdrawn -> empty, no badge', optOut.json?.status === 'empty' && Object.keys(optOut.json?.primaryOwnership ?? {}).length === 0, summarize(optOut));
    await manage('brand_visibility', { id: fixture.brand, public_label_allowed: true, public_permission_ref: 'staging-fixture:consent', operating_status: 'active' });

    await manage('merchant', { ...merchantData, id: fixture.merchant, source_authorized_until: future(-1) });
    const sourceExpired = await call(request());
    check('source authorization: expired -> empty', sourceExpired.json?.status === 'empty', summarize(sourceExpired));
    await manage('merchant', { ...merchantData, id: fixture.merchant });

    await sql(`update public.discovery_products set synced_at=now()-interval '25 hours', expires_at=now()-interval '1 hour' where merchant_id=${lit(fixture.merchant)}`);
    const stale = await call(request());
    check('inventory freshness: >24h snapshot -> empty', stale.json?.status === 'empty', summarize(stale));
    await ingest();
    const refreshed = await call(request());
    check('inventory freshness: fresh snapshot restores retrieval', refreshed.json?.status === 'ready', summarize(refreshed));

    await manage('review_ownership', { id: fixture.brand, status: 'revoked' }, reviewerId);
    const revoked = await call(request({}, [{ id: 'primary-fixture', productUrl }]));
    check('revocation: revoked -> empty, no badge', revoked.json?.status === 'empty' && Object.keys(revoked.json?.primaryOwnership ?? {}).length === 0, summarize(revoked));

    await manage('request_review', { id: fixture.brand });
    await manage('review_ownership', { id: fixture.brand, status: 'verified', evidence_id: evidence, verified_until: future(45), policy_version: 'kscan-ownership-review-v1-draft' }, reviewerId);
    const beforeExpiry = await call(request());
    check('expiry: short verification is live before deadline', beforeExpiry.json?.status === 'ready', summarize(beforeExpiry));
    await sleep(50_000);
    const afterExpiry = await call(request({}, [{ id: 'primary-fixture', productUrl }]));
    check('expiry: verification past deadline -> empty, no badge (cache cannot leak)', afterExpiry.json?.status === 'empty' && Object.keys(afterExpiry.json?.primaryOwnership ?? {}).length === 0, summarize(afterExpiry));

    const campaigns = (await sql('select count(*)::int as n, count(*) filter (where active)::int as active from public.discovery_campaigns'))[0];
    check('sponsorship: zero campaigns, zero active', campaigns.n === 0 && campaigns.active === 0, campaigns);

    // Quota last: 30/min per account. Earlier calls in this minute count too.
    await sleep(61_000);
    const statuses = [];
    for (let i = 0; i < 32; i++) statuses.push((await call(request({ subtype: 'parka' }))).http);
    const ok = statuses.filter((s) => s === 200).length;
    const limited = statuses.filter((s) => s === 429).length;
    check('quota: 30 requests/minute then 429', ok === 30 && limited === 2, { ok, limited });
  } finally {
    // Evidence deletion nulls brands.evidence_id, which fires the audit trigger,
    // so fixture rows go first under the (still enabled) fixture admin actor.
    const steps = [];
    if (fixture.prospect) steps.push(`delete from public.discovery_prospects where id=${lit(fixture.prospect)};`);
    if (fixture.merchant) steps.push(`delete from public.discovery_products where merchant_id=${lit(fixture.merchant)};`, `delete from public.discovery_sync_runs where merchant_id=${lit(fixture.merchant)};`, `delete from public.discovery_partnerships where merchant_id=${lit(fixture.merchant)};`, `delete from public.discovery_merchants where id=${lit(fixture.merchant)};`);
    if (fixture.brand) steps.push(`delete from public.discovery_brands where id=${lit(fixture.brand)};`, `delete from public.discovery_evidence where brand_id=${lit(fixture.brand)};`);
    const cleanup = [];
    if (steps.length) cleanup.push(`do $fx$ begin perform set_config('discovery.actor_id',${lit(adminId)},true); ${steps.join(' ')} end $fx$`);
    cleanup.push(`delete from public.discovery_reviewers where actor_id in (${lit(adminId)},${lit(reviewerId)})`, `delete from public.discovery_request_limits where actor_id=${lit(customerId)}`);
    for (const q of cleanup) {
      try { await sql(q); } catch (e) { report.failures.push(`cleanup: ${String(e.message).slice(0, 120)}`); }
    }
    const left = (await sql("select (select count(*) from public.discovery_brands)::int b,(select count(*) from public.discovery_merchants)::int m,(select count(*) from public.discovery_products)::int p,(select count(*) from public.discovery_prospects)::int pr,(select count(*) from public.discovery_reviewers)::int r,(select count(*) from public.discovery_evidence)::int e"))[0];
    check('cleanup: no fixture rows or reviewer grants remain', Object.values(left).every((n) => n === 0), left);
  }
}

async function readback(sql) {
  const [r] = await sql(`select json_build_object(
    'ledger', (select count(*) from supabase_migrations.schema_migrations where version='20261029125521'),
    'tables', (select json_agg(json_build_object('t',c.relname,'kind',c.relkind,'rls',c.relrowsecurity) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'discovery\\_%' and c.relkind in ('r','v')),
    'rowCounts', json_build_object('brands',(select count(*) from public.discovery_brands),'merchants',(select count(*) from public.discovery_merchants),'products',(select count(*) from public.discovery_products),'campaigns',(select count(*) from public.discovery_campaigns),'activeCampaigns',(select count(*) from public.discovery_campaigns where active),'reviewers',(select count(*) from public.discovery_reviewers),'partnerships',(select count(*) from public.discovery_partnerships),'prospects',(select count(*) from public.discovery_prospects)),
    'customerTableGrants', (select coalesce(json_agg(distinct grantee||':'||table_name||':'||privilege_type),'[]'::json) from information_schema.role_table_grants where table_schema='public' and table_name like 'discovery\\_%' and grantee in ('anon','authenticated','PUBLIC')),
    'functions', (select json_agg(json_build_object('f',p.proname,'secdef',p.prosecdef,'pinnedPath',coalesce(array_to_string(p.proconfig,','),'') like '%search_path=%','anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),'service',has_function_privilege('service_role',p.oid,'EXECUTE')) order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'discovery\\_%'),
    'policies', (select json_agg(tablename||':'||policyname||':'||array_to_string(roles,',') order by tablename) from pg_policies where schemaname='public' and tablename like 'discovery\\_%'),
    'runtimeGuard', (select environment from public.discovery_runtime_guard where singleton),
    'catalogRevision', (select revision from public.discovery_catalog_revision where singleton)
  ) as r`);
  const rb = r.r;
  const tables = rb.tables ?? [];
  const fns = rb.functions ?? [];
  check('readback: migration recorded exactly once', Number(rb.ledger) === 1, { ledger: rb.ledger });
  check('readback: 13 discovery tables, all RLS-enabled', tables.filter((t) => t.kind === 'r').length === 13 && tables.filter((t) => t.kind === 'r').every((t) => t.rls), { tables: tables.length });
  check('readback: no anon/authenticated/PUBLIC table or view grants', rb.customerTableGrants.length === 0, { grants: rb.customerTableGrants });
  check('readback: no SECURITY DEFINER discovery functions', fns.every((f) => !f.secdef), { functions: fns.length });
  check('readback: every discovery function pins search_path', fns.every((f) => f.pinnedPath));
  check('readback: anon/authenticated cannot EXECUTE any discovery function', fns.every((f) => !f.anon && !f.authenticated), { exposed: fns.filter((f) => f.anon || f.authenticated).map((f) => f.f) });
  check('readback: zero active campaigns', Number(rb.rowCounts.activeCampaigns) === 0, rb.rowCounts);
  return rb;
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
