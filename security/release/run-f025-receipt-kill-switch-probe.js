#!/usr/bin/env node
'use strict';

/**
 * Bounded STAGING proof for B35-F-025: with PURCHASE_IMPORT_EXTRACT_ENABLED=false
 * the deployed purchase-import-extract refuses an authenticated, eligible actor
 * at the kill switch, before any reservation or Gemini call. It also reads back
 * the F025 migration ledger row and settlement grants.
 *
 * SAFETY
 * - Staging only: refuses the production ref/URL before any network call.
 * - Uses the existing synthetic ACTIVE account; creates/deletes nothing.
 * - Sends an empty body, so even an enabled function could not reach Gemini.
 * - Report holds statuses, counts and booleans only.
 */

const fs = require('node:fs');
const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const REPORT_FILE = 'f025-receipt-kill-switch-probe-report.json';
const FN = '/functions/v1/purchase-import-extract';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const report = { startedAt: new Date().toISOString(), checks: [], failures: [] };
function check(name, pass, detail = {}) {
  report.checks.push({ name, pass: Boolean(pass), ...detail });
  if (!pass) report.failures.push(name);
}

async function main() {
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
    if (!res.ok) throw new Error(`sql ${res.status}`);
    return JSON.parse(text);
  }
  const receiptRows = async () => Number((await sql(
    "select count(*)::int as n from public.provider_request_reservations where function_name = 'purchase-import-extract'",
  ))[0].n);

  const [ledger] = await sql("select count(*)::int as n from supabase_migrations.schema_migrations where version = '20261103011431'");
  check('f025 migration applied once', ledger.n === 1, { count: ledger.n });
  const grants = await sql(`select p.proname as fn,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('complete_provider_request', 'release_provider_request', 'settle_provider_request_for_actor')`);
  for (const g of grants) check(`${g.fn} denies anon/authenticated`, !g.anon && !g.auth);
  check('settle_provider_request_for_actor service_role only', grants.some((g) => g.fn === 'settle_provider_request_for_actor' && g.svc));

  const before = await receiptRows();
  const post = async (headers) => {
    const res = await fetch(`${base}${FN}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: publishable, ...headers }, body: '{}' });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* non-json */ }
    return { http: res.status, errorClass: json?.errorClass ?? null };
  };

  const anonymous = await post({});
  check('no user JWT is refused', anonymous.http === 401, { http: anonymous.http });

  const signIn = await signInSyntheticUser(base, publishable, env('STAGING_SYNTHETIC_ACTIVE_EMAIL'), env('STAGING_SYNTHETIC_ACTIVE_PASSWORD'));
  if (!signIn.ok) throw new Error(`synthetic sign-in failed (${signIn.status})`);
  process.stderr.write(`${maskLine(signIn.accessToken)}\n`);
  const disabled = await post({ Authorization: `Bearer ${signIn.accessToken}` });
  check('eligible actor stops at the kill switch', disabled.errorClass === 'feature_disabled', disabled);

  const after = await receiptRows();
  check('no reservation created', after === before, { before, after });
}

main()
  .catch((error) => { report.failures.push(`error: ${error instanceof Error ? error.message : 'unknown'}`); })
  .finally(() => {
    report.finishedAt = new Date().toISOString();
    report.ok = report.failures.length === 0;
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  });
