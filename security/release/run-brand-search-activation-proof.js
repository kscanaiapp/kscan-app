'use strict';
// Activation evidence only. No deploy, research import, account creation, LLM request,
// secret export or authentication/consent override. Credentials are injected by GitHub.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const REPO = 'kscanaiapp/kscan-app';
const REFS = { staging: 'yzqjvdfgefveprobvvyw', production: 'wyyuqfdxucjksghsmhry' };
const HASHES = { 'scan-identify': '1f5807e1b5bbf9f100a913cd8feeb30eefa0e69fe0284c7e9157b04edd3e0de2', 'stylechat-generate': 'caef9e6938a7a99ad21f62c5695e8b7b82e7de2d23f7c80f365765b67766f443' };
// Prior owner-authorized paid probe artifacts: 41914232506, 41917396270,
// 41921139229, 41924395591; all telemetry ledgers reconciled before this activation.
// Owner approved one additional bounded retry after the first Staging skip.
const PRIOR_USD = 0.2886, MAX_USD = 5, MAX_CALLS = 18;
// One commerce_only request: no Gemini, at most primary/fallback shopping plus
// optional bounded H3 fallback and the existing Poshmark lane. Reserve six calls,
// above the actual five-call upper bound, at $0.01 each (cost estimate, not billing).
const RESERVE_CALLS = 6, RESERVE_USD = 0.06;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
function budget(priorCalls, priorUsd) {
  if (!Number.isInteger(priorCalls) || priorCalls < 0 || !Number.isFinite(priorUsd) || priorUsd < 0) throw Error('invalid_budget_history');
  if (priorCalls + RESERVE_CALLS > MAX_CALLS || PRIOR_USD + priorUsd + RESERVE_USD > MAX_USD) throw Error('paid_budget_exhausted');
  return { priorAuthorizedEstimatedUsd: PRIOR_USD, priorActivationReservedCalls: priorCalls, priorActivationReservedUsd: priorUsd, reservedCalls: RESERVE_CALLS, reservedUsd: RESERVE_USD, ceilingUsd: MAX_USD, activationCallCeiling: MAX_CALLS };
}
function gh(args) {
  const out = spawnSync('gh', args, { encoding: 'utf8' });
  if (out.status !== 0) throw Error('budget_evidence_unavailable');
  return out.stdout;
}
function previousReservations() {
  const runs = JSON.parse(gh(['run', 'list', '--repo', REPO, '--workflow', 'brand-search-activation-proof.yml', '--limit', '100', '--json', 'databaseId,event,status']));
  let calls = 0, usd = 0;
  for (const run of runs.filter(r => r.event === 'workflow_dispatch' && String(r.databaseId) !== process.env.GITHUB_RUN_ID)) {
    if (run.status !== 'completed') throw Error('another_paid_proof_unsettled');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobse-proof-history-'));
    const download = spawnSync('gh', ['run', 'download', String(run.databaseId), '--repo', REPO, '--name', `brand-search-proof-${run.databaseId}`, '--dir', dir], { encoding: 'utf8' });
    if (download.status !== 0 || !fs.existsSync(path.join(dir, 'brand-search-proof-ledger.json'))) { calls += RESERVE_CALLS; usd += RESERVE_USD; continue; }
    const prior = JSON.parse(fs.readFileSync(path.join(dir, 'brand-search-proof-ledger.json'), 'utf8'));
    if (![0, RESERVE_CALLS].includes(prior.reservedCalls) || ![0, RESERVE_USD].includes(prior.reservedUsd)) throw Error('invalid_prior_reservation');
    calls += prior.reservedCalls; usd += prior.reservedUsd;
  }
  return { calls, usd };
}
function reserveDurably(value) {
  const fd = fs.openSync('brand-search-proof-ledger.json', 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function withPreference(read, write, task) {
  const before = await read();
  try { await write(true); if (await read() !== true) throw Error('preference_not_persisted'); return await task(); }
  finally { await write(before); if (await read() !== before) throw Error('preference_restore_failed'); }
}
function expansionEvents(rows) {
  return rows.flatMap(row => {
    const text = String(row.event_message ?? '');
    const at = text.indexOf('[brand-search-expansion]');
    if (at < 0) return [];
    try { const value = JSON.parse(text.slice(text.indexOf('{', at))); return Number.isSafeInteger(value.revision) && value.providerCalls === 1 ? [value] : []; } catch { return []; }
  });
}
async function run(env = process.env) {
  reserveDurably({ reservedCalls: 0, reservedUsd: 0 });
  const report = { target: env.PROOF_TARGET, paidHttpAttempts: 0, nativeUiJourney: 'NOT_TESTED' };
  let token;
  try {
    const ref = REFS[env.PROOF_TARGET];
    if (!ref || env.CONFIRM_PAID !== 'ONE BOUNDED BRAND SEARCH') throw Error('explicit_paid_scope_required');
    const base = `https://${ref}.supabase.co`;
    if (String(env.SUPABASE_URL).replace(/\/+$/, '') !== base) throw Error('wrong_environment');
    for (const key of ['SUPABASE_PUBLISHABLE_KEY', 'REVIEW_EMAIL', 'REVIEW_PASSWORD', 'SUPABASE_ACCESS_TOKEN']) if (!env[key]) throw Error('review_configuration_missing');
    const acceptedHashes = { 'scan-identify': env.ACCEPTED_SCAN_BUNDLE ?? HASHES['scan-identify'], 'stylechat-generate': env.ACCEPTED_ELISE_BUNDLE ?? HASHES['stylechat-generate'] };
    if (Object.values(acceptedHashes).some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw Error('invalid_accepted_staging_bundle');
    const request = async (url, init, label) => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw Error(`${label}_http_${response.status}`);
      return { response, body: await response.json().catch(() => null) };
    };
    const management = async (suffix, body) => (await request(`https://api.supabase.com/v1/projects/${ref}/${suffix}`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }, 'management_read')).body;
    const sql = async query => await management('database/query', { query });
    const functions = await management('functions');
    report.deployed = functions.filter(f => HASHES[f.slug]).map(f => ({ slug: f.slug, version: f.version, sha256: f.ezbr_sha256, jwt: f.verify_jwt }));
    if (report.deployed.length !== 2 || report.deployed.some(f => f.sha256 !== acceptedHashes[f.slug] || f.jwt !== (f.slug === 'stylechat-generate'))) throw Error('unaccepted_deployed_source');
    // Production proof cannot accept a bundle that differs from live Staging.
    if (env.PROOF_TARGET === 'production') {
      const stage = (await request(`https://api.supabase.com/v1/projects/${REFS.staging}/functions`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } }, 'accepted_staging_read')).body;
      if (Object.entries(acceptedHashes).some(([slug, hash]) => !stage.some(f => f.slug === slug && f.ezbr_sha256 === hash && f.status === 'ACTIVE'))) throw Error('production_staging_bundle_mismatch');
    }
    const secrets = await management('secrets');
    if (!secrets.some(s => s.name === 'BLACK_OWNED_BRAND_SEARCH_EXPANSION_ENABLED' && (s.value ?? s.digest) === sha('true'))) throw Error('expansion_flag_not_on');
    // Owner explicitly authorized the bounded Staging query under the first
    // 500 free Poshmark calls. Do not extend that exception to Production.
    const poshmarkOn = secrets.some(s => s.name === 'POSHMARK_ENABLED' && (s.value ?? s.digest) === sha('true'));
    if (poshmarkOn && env.PROOF_TARGET !== 'staging') throw Error('unpriced_optional_provider_enabled');
    report.poshmarkAllowance = poshmarkOn ? 'owner_confirmed_first_500_free_calls' : 'disabled';
    const auth = await request(base + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: env.REVIEW_EMAIL, password: env.REVIEW_PASSWORD }) }, 'password_auth');
    token = auth.body?.access_token;
    const actor = auth.body?.user?.id;
    if (!token || auth.body?.user?.is_anonymous || !/^[0-9a-f-]{36}$/.test(actor ?? '')) throw Error('legitimate_review_identity_required');
    process.stderr.write(`::add-mask::${token}\n`);
    const headers = { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const rest = async (resource, body, extra = {}) => (await request(base + '/rest/v1/' + resource, { headers: { ...headers, ...extra }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }, 'authenticated_rest')).body;
    const receipts = await rest(`legal_acceptances?select=acceptance_type,policy_version&user_id=eq.${actor}`);
    const permission = await rest('rpc/get_ai_processing_permission', { p_expected_user_id: actor });
    if (!receipts.some(r => r.acceptance_type === 'ai_processing' && r.policy_version === 'v2_google_gemini') || permission?.granted !== true) throw Error('current_ai_consent_required');
    report.currentConsent = true;
    const readPref = async () => (await rest(`user_stylist_preferences?select=include_black_owned_brand_search&user_id=eq.${actor}`))?.[0]?.include_black_owned_brand_search === true;
    const writePref = async value => await rest('user_stylist_preferences?on_conflict=user_id', { user_id: actor, include_black_owned_brand_search: value }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    const others = await rest('user_stylist_preferences?select=user_id&user_id=neq.' + actor);
    if (!Array.isArray(others) || others.length) throw Error('cross_account_read_exposed');
    report.crossAccountReadIsolated = true;
    const sources = await sql("select id,revision,brand_name,categories from public.black_owned_brand_search_sources where enabled and us_eligible and review_status='qualified' and categories @> array['outerwear']");
    if (!sources.length) throw Error('no_category_relevant_sources');
    const state = (await sql(`select (select count(*) from public.user_stylist_preferences where include_black_owned_brand_search and user_id <> '${actor}'::uuid) as other_optins, (select column_default from information_schema.columns where table_schema='public' and table_name='user_stylist_preferences' and column_name='include_black_owned_brand_search') as preference_default`))[0];
    if (Number(state.other_optins) !== 0) throw Error('concurrent_optins_prevent_attribution');
    report.customerDefaultOff = state.preference_default === 'false';
    const prior = previousReservations();
    report.budget = budget(prior.calls, prior.usd);
    await withPreference(readPref, writePref, async () => {
      report.preferenceOptInPersisted = true;
      const before = await sql('select source_id,search_count from public.brand_search_source_coverage');
      const start = new Date().toISOString();
      reserveDurably({ ...report.budget, runId: env.GITHUB_RUN_ID, target: env.PROOF_TARGET, reservedAt: start });
      report.paidHttpAttempts = 1;
      const commerceStarted = Date.now();
      const result = await request(base + '/functions/v1/scan-identify', { method: 'POST', headers, body: JSON.stringify({ mode: 'image', requestMode: 'commerce_only', identification: { item_type: 'outerwear', subtype: 'moto jacket', primary_color: 'black', material_estimate: 'leather', confidence_score: 0.96 }, searchQueries: ['black leather moto jacket'], market: { country: 'US', locale: 'en-US', currency: 'USD' } }) }, 'commerce_only');
      const products = result.body?.recommendedProducts ?? result.body?.purchaseOptions ?? [];
      report.shopping = { http: result.response.status, status: result.body?.status ?? null, elapsedMs: Date.now() - commerceStarted, count: products.length, unsupportedOwnershipLabel: products.some(p => p.ownershipIdentity || p.ownershipVerificationStatus) };
      let events = [];
      for (let n = 0; n < 8 && !events.length; n++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const url = new URL(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs`);
        url.searchParams.set('sql', `select timestamp,event_message from logs where source='function_logs' and timestamp >= parseDateTimeBestEffort('${start}') and event_message like '%[brand-search-expansion]%' order by timestamp asc limit 30`);
        url.searchParams.set('iso_timestamp_start', start); url.searchParams.set('iso_timestamp_end', new Date().toISOString());
        const logs = await request(url, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } }, 'metadata_logs');
        events = expansionEvents(logs.body?.result ?? []);
      }
      const after = await sql('select source_id,search_count from public.brand_search_source_coverage');
      const proven = events.find(e => sources.some(s => Number(s.revision) === e.revision));
      const source = proven && sources.find(s => Number(s.revision) === proven.revision);
      const grew = source && Number(after.find(c => c.source_id === source.id)?.search_count ?? 0) > Number(before.find(c => c.source_id === source.id)?.search_count ?? 0);
      report.sourceQuery = source ? { id: source.id, revision: proven.revision, category: 'outerwear', providerCalls: proven.providerCalls, expansionMs: proven.expansionMs, outcome: proven.outcome, validNewProducts: proven.validProducts, coverageIncreased: !!grew, evidence: 'accepted bundle callSerper(choice.query) branch plus positive source-revision provider telemetry' } : null;
      report.actualSourceQuery = !!source && !!grew;
      report.primarySurvivedSecondaryFailure = source && proven.outcome !== 'ok' ? products.length > 0 : 'covered_by_focused_regression';
    });
    report.preferenceRestored = true;
    report.verdict = report.actualSourceQuery && report.customerDefaultOff && !report.shopping.unsupportedOwnershipLabel ? 'PASS' : 'PARTIAL';
  } catch (error) { report.verdict = 'FAIL'; report.error = /^[a-z0-9_]+$/.test(error.message) ? error.message : 'proof_operational_failure'; }
  finally { token = undefined; fs.writeFileSync('brand-search-proof-report.json', JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report));
  return report;
}
if (require.main === module) run().then(r => { process.exitCode = r.verdict === 'PASS' ? 0 : 1; });
module.exports = { budget, withPreference, expansionEvents, run };
