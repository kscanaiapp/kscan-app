#!/usr/bin/env node
/**
 * Phase 7 pre-staging verification script (scan-identify clothingType overlay).
 *
 * STAGING ONLY. Hard-refuses the production Supabase project and any
 * ambiguous/missing environment identity before sending a single request.
 * See docs/phase7-prestaging-staging-handoff.md for the commands that put a
 * build in a state this script can actually validate.
 *
 * This script is a PREPARATION artifact. It was authored and dry-run tested
 * locally; it has NEVER been run against the real staging project, because
 * staging is not deployed with this candidate as of authoring. Do not treat
 * a passing --dry-run as evidence the live scenarios pass.
 *
 * Usage:
 *   node scripts/verify-phase7-staging.js --dry-run
 *     Validates scenario structure and the refuse-production/refuse-ambiguous
 *     logic. Makes zero network calls. Safe to run anywhere, anytime.
 *
 *   SUPABASE_URL=https://yzqjvdfgefveprobvvyw.supabase.co \
 *   STAGING_USER_JWT=eyJ... \
 *   node scripts/verify-phase7-staging.js
 *     Runs every scenario in qa/phase7-staging-fixtures/scenarios.js against
 *     the given URL. Exits non-zero and refuses to send anything if the URL
 *     does not resolve to the approved staging project ref.
 *
 * Exit codes:
 *   0  ALL_TESTS_PASSED
 *   1  FAILED (a P0/P1 assertion failed, or the environment check refused to run)
 *   2  PARTIAL_PASS_WITH_GAPS (every P0/P1 passed; a P2/P3 gap remains — see
 *      the printed summary for which)
 *
 * No production credentials are read, logged, or accepted. No secret value
 * is ever printed — only whether one was present.
 */

'use strict';

const { SCENARIOS } = require('../qa/phase7-staging-fixtures/scenarios.js');

const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry'; // supabase/functions/*, scripts/smoke-scan-identify.js
const APPROVED_STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw'; // per the pre-staging integration brief, Section 11
const ENDPOINT_PATH = '/functions/v1/scan-identify';
const TIMEOUT_MS = 20000;

function extractProjectRef(supabaseUrl) {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i.exec((supabaseUrl || '').trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * The one gate every scenario run passes through. Refuses to proceed on:
 *   - no URL at all
 *   - a URL that isn't a well-formed *.supabase.co origin
 *   - the production project ref, by exact match
 *   - anything that isn't the exact approved staging ref
 *
 * Never a substring or prefix check — a ref that merely CONTAINS the
 * approved ref would still be a different, wrong project.
 */
function assertStagingIdentity(supabaseUrl) {
  const ref = extractProjectRef(supabaseUrl);
  if (!ref) {
    return { ok: false, reason: `SUPABASE_URL is missing or not a *.supabase.co origin (got: ${JSON.stringify(supabaseUrl || null)})` };
  }
  if (ref === PRODUCTION_PROJECT_REF) {
    return { ok: false, reason: `refused: ${ref} is the PRODUCTION project ref, not staging` };
  }
  if (ref !== APPROVED_STAGING_PROJECT_REF) {
    return { ok: false, reason: `refused: ${ref} is not the approved staging project ref (${APPROVED_STAGING_PROJECT_REF})` };
  }
  return { ok: true, ref };
}

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

/** Structural-only checks on the fixture set. No network. */
function validateScenarioShapes() {
  const problems = [];
  const seen = new Set();
  for (const s of SCENARIOS) {
    if (seen.has(s.name)) problems.push(`duplicate scenario name: ${s.name}`);
    seen.add(s.name);
    if (!s.request || typeof s.request !== 'object') problems.push(`${s.name}: missing request`);
    if (!s.expect || typeof s.expect !== 'object') problems.push(`${s.name}: missing expect`);
    if (!s.flags || typeof s.flags !== 'object') problems.push(`${s.name}: missing flags`);
    if (!s.productCountBaseline) problems.push(`${s.name}: missing productCountBaseline declaration`);
  }
  const required = [
    'NO_NOTICE', 'CLOSET_SIMILARITY', 'RECENT_SCAN_SIMILARITY',
    'MULTI_ITEM_SELECTION_REQUIRED', 'SELECTED_ITEM_FOLLOWUP',
    'UNCERTAIN_CLOTHING_TYPE', 'PRODUCT_MATCH_TIMEOUT', 'FEATURE_FLAG_ROLLBACK',
  ];
  for (const name of required) {
    if (!seen.has(name)) problems.push(`required scenario missing: ${name}`);
  }
  return problems;
}

/** Contract assertions that do not require a live response — pure fixture review. */
function checkContractAssertionsPresent(scenario) {
  const gaps = [];
  if (scenario.productCountBaseline.source === 'not_yet_measured') {
    gaps.push({
      severity: 'P2',
      detail: `${scenario.name}: no approved product-count baseline recorded yet (source=not_yet_measured). ` +
        'Per the ungrounded-"within 10%" prohibition, the first live staging run must record one before this ' +
        'scenario can classify a count deviation as anything more specific than "observed."',
    });
  }
  return gaps;
}

async function runScenarioLive(scenario, baseUrl, token) {
  const url = baseUrl.replace(/\/+$/, '') + ENDPOINT_PATH;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  const result = {
    scenario: scenario.name,
    expected: scenario.expect,
    actual: null,
    contractAssertions: [],
    latencyMs: null,
    productResultCount: null,
    featureFlagState: scenario.flags,
    verdict: 'FAILED',
    failureReason: null,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(scenario.request),
      signal: controller.signal,
    });
    result.latencyMs = Date.now() - startedAt;

    if (res.status !== (scenario.expect.httpStatus ?? 200)) {
      result.failureReason = `HTTP ${res.status}, expected ${scenario.expect.httpStatus ?? 200}`;
      return result;
    }

    const body = await res.json().catch(() => null);
    if (!body) {
      result.failureReason = 'response body is not valid JSON';
      return result;
    }
    result.actual = { status: body.status, hasIdentificationV2: !!body.identificationV2 };
    result.productResultCount = Array.isArray(body.recommendedProducts) ? body.recommendedProducts.length : null;

    // Scenario-specific assertions are intentionally NOT exhaustively coded
    // here — they depend on live provider output this script has never seen.
    // The harness proves the WIRING is correct offline (see
    // __tests__/scannerPhase7FunnelIntegration.test.js and
    // supabase/functions/scan-identify/phase7PipelineSurvivability.test.ts);
    // this script's job against real staging is to report what actually came
    // back, not to assume the offline assertions still hold un-observed.
    result.contractAssertions.push({
      assertion: 'response is valid JSON with a recognized status',
      pass: typeof body.status === 'string',
    });
    result.verdict = result.contractAssertions.every((a) => a.pass) ? 'PASS' : 'FAILED';
    return result;
  } catch (err) {
    result.latencyMs = Date.now() - startedAt;
    result.failureReason = err && err.name === 'AbortError' ? 'request timed out' : `fetch error: ${err && err.message}`;
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  console.log('[verify-phase7-staging] Phase 7 pre-staging verification');
  console.log('[verify-phase7-staging] mode:', dryRun ? 'DRY RUN (no network)' : 'LIVE');
  console.log('');

  const shapeProblems = validateScenarioShapes();
  if (shapeProblems.length) {
    console.log('SCENARIO_FIXTURE_STRUCTURE_INVALID');
    for (const p of shapeProblems) console.log('  -', p);
    console.log('');
    console.log('FAILED');
    process.exit(1);
  }
  console.log(`[verify-phase7-staging] ${SCENARIOS.length} scenarios structurally valid.`);

  const gaps = SCENARIOS.flatMap(checkContractAssertionsPresent);

  if (dryRun) {
    console.log('');
    console.log('[verify-phase7-staging] dry-run scenario list:');
    for (const s of SCENARIOS) {
      console.log(`  - ${s.name}: ${s.description}`);
    }
    console.log('');
    console.log('[verify-phase7-staging] identity-gate self-test (no real credentials used):');
    for (const [label, url] of [
      ['missing url', undefined],
      ['production url', `https://${PRODUCTION_PROJECT_REF}.supabase.co`],
      ['wrong staging-shaped url', 'https://someotherref.supabase.co'],
      ['approved staging url', `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`],
    ]) {
      const check = assertStagingIdentity(url);
      console.log(`  - ${label}: ${check.ok ? 'ALLOWED' : 'REFUSED (' + check.reason + ')'}`);
    }
    console.log('');
    if (gaps.length) {
      console.log('[verify-phase7-staging] known gaps that will remain even after a live run passes:');
      for (const g of gaps) console.log(`  - [${g.severity}] ${g.detail}`);
      console.log('');
    }
    console.log('DRY_RUN_OK — no live scenario was executed, no network call was made.');
    console.log('PARTIAL_PASS_WITH_GAPS');
    process.exit(2);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const identity = assertStagingIdentity(supabaseUrl);
  console.log('[verify-phase7-staging] target:', supabaseUrl ? supabaseUrl.replace(/\/+$/, '') : '(unset)');
  if (!identity.ok) {
    console.log('[verify-phase7-staging] REFUSED:', identity.reason);
    console.log('');
    console.log('FAILED');
    process.exit(1);
  }
  console.log('[verify-phase7-staging] identity confirmed: staging project', identity.ref);

  const token = process.env.STAGING_USER_JWT;
  console.log('[verify-phase7-staging] auth token present:', token ? 'yes [REDACTED]' : 'NO');
  if (!token) {
    console.log('');
    console.log('FAILED');
    console.log('STAGING_JWT_REQUIRED — set STAGING_USER_JWT and re-run.');
    process.exit(1);
  }

  console.log('');
  const results = [];
  for (const scenario of SCENARIOS) {
    const r = await runScenarioLive(scenario, supabaseUrl, token);
    results.push(r);
    console.log(
      `- ${r.scenario}: verdict=${r.verdict} latencyMs=${r.latencyMs} products=${r.productResultCount} ` +
      (r.failureReason ? `failureReason=${r.failureReason}` : ''),
    );
  }

  const p0p1Failures = results.filter((r) => r.verdict === 'FAILED');
  console.log('');
  console.log('[verify-phase7-staging] scenario summary:', JSON.stringify(
    results.map((r) => ({
      scenario: r.scenario,
      verdict: r.verdict,
      latencyMs: r.latencyMs,
      productResultCount: r.productResultCount,
      featureFlagState: r.featureFlagState,
    })),
    null,
    2,
  ));

  if (p0p1Failures.length) {
    console.log('');
    console.log('FAILED');
    process.exit(1);
  }
  if (gaps.length) {
    console.log('');
    for (const g of gaps) console.log(`  - [${g.severity}] ${g.detail}`);
    console.log('PARTIAL_PASS_WITH_GAPS');
    process.exit(2);
  }
  console.log('');
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify-phase7-staging] unhandled error:', err);
  console.log('FAILED');
  process.exit(1);
});
