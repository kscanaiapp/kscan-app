#!/usr/bin/env node
'use strict';

/**
 * Bounded live probe for SEC-B35-KPLUS-001 (K+ Early Access server hold)
 * against the ALREADY DEPLOYED staging `kplus-activate` function.
 *
 * It tests the deployed bytes over HTTP; it does not read or execute source,
 * deploys nothing, creates no account, writes nothing, and calls no AI or
 * commerce provider. It proves, for the bytes staging is actually serving:
 *
 *   1. the two server campaign controls are NOT set on staging (OFF by default),
 *   2. an anonymous and an invalid-token request are rejected,
 *   3. an authenticated, eligible account is DENIED (403 CAMPAIGN_CLOSED) and
 *      is never granted K+ -- twice, so repetition cannot change the outcome,
 *   4. the actor's entitlement-related rows are byte-for-byte unchanged by
 *      count (user_entitlements, kplus_entitlement_grants,
 *      kplus_activation_events, kplus_entitlement_activations),
 *   5. the function's own logs show the closed-campaign denial for this run
 *      and show NO activation completion (the step that precedes any
 *      RevenueCat mirror) and no grant-RPC failure.
 *
 * SCOPE AND SAFETY
 * - Staging only; refuses a production ref or URL before any network call.
 * - Signs in exactly one existing synthetic account (STAGING_SYNTHETIC_ACTIVE);
 *   never provisions or deletes one.
 * - At most 4 HTTP calls to the function (anonymous, invalid token, 2 x
 *   authenticated POST) plus 1 authenticated GET method check, plus read-only
 *   Management API reads (secret NAMES only, row COUNTS only, log lines).
 * - Emits contract facts only: statuses, booleans, secret names, table row
 *   counts. Never a token, email, user id, request/response body or log line.
 *   The report is scanned for secret/PII shapes before it is written.
 */

const fs = require('node:fs');

const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const FUNCTION_PATH = '/functions/v1/kplus-activate';
const REPORT_FILE = 'kplus-activate-hold-live-probe-report.json';
const MANAGEMENT_API = 'https://api.supabase.com/v1/projects';

const HOLD_CONTROL_NAMES = Object.freeze([
  'KPLUS_EARLY_ACCESS_ENABLED',
  'KPLUS_EARLY_ACCESS_CAMPAIGN_ELIGIBILITY_CERTIFIED',
]);
const STATE_TABLES = Object.freeze([
  'user_entitlements',
  'kplus_entitlement_grants',
  'kplus_activation_events',
  'kplus_entitlement_activations',
]);
const LOG_MARKERS = Object.freeze({
  closed: 'kplus_early_access_campaign_closed',
  completed: 'kplus_activation_completed',
  rpcFailed: 'kplus_activation_rpc_failed',
});
const REQUIRED_ENV_VARS = Object.freeze([
  'SUPABASE_STAGING_PROJECT_REF',
  'SUPABASE_STAGING_URL',
  'SUPABASE_STAGING_PUBLISHABLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'STAGING_SYNTHETIC_ACTIVE_EMAIL',
  'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_EVIDENCE_PATTERNS = Object.freeze([
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT shape
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email shape
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // uuid shape
  /sbp_[A-Za-z0-9]{10,}/, // management token shape
]);

class KPlusHoldProbeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'KPlusHoldProbeError';
    this.code = code;
  }
}

function findMissingEnvVars(env) {
  return REQUIRED_ENV_VARS.filter((name) => !env[name]);
}

function assertStagingOnly(projectRef, supabaseUrl) {
  if (projectRef === PRODUCTION_PROJECT_REF) {
    throw new KPlusHoldProbeError('refusing to run against production', 'PRODUCTION_REF');
  }
  if (projectRef !== STAGING_PROJECT_REF) {
    throw new KPlusHoldProbeError(`project ref is not the staging project: ${projectRef}`, 'UNEXPECTED_REF');
  }
  if (String(supabaseUrl).includes(PRODUCTION_PROJECT_REF)) {
    throw new KPlusHoldProbeError('refusing to run against a production URL', 'PRODUCTION_URL');
  }
  assertNotProductionUrl(supabaseUrl);
}

function functionUrl(supabaseUrl) {
  return `${String(supabaseUrl).replace(/\/+$/, '')}${FUNCTION_PATH}`;
}

/** The JWT `sub` is the actor id; it is validated as a UUID before it ever reaches SQL. */
function actorIdFromJwt(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    if (typeof claims.sub === 'string' && UUID_PATTERN.test(claims.sub)) return claims.sub;
  } catch { /* fall through */ }
  throw new KPlusHoldProbeError('access token did not carry a valid actor id', 'BAD_ACTOR');
}

async function callFunction(url, { apikey, bearer, method = 'POST', fetchImpl = fetch }) {
  const headers = { apikey, 'Content-Type': 'application/json' };
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetchImpl(url, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json };
}

async function managementJson(url, token, init, fetchImpl) {
  const response = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) return { ok: false, status: response.status, body: null };
  return { ok: true, status: response.status, body: await response.json().catch(() => null) };
}

/** Secret NAMES only. Values/digests are never read into the report. */
async function listHoldControlNames(projectRef, token, fetchImpl) {
  const result = await managementJson(`${MANAGEMENT_API}/${projectRef}/secrets`, token, { method: 'GET' }, fetchImpl);
  if (!result.ok || !Array.isArray(result.body)) return { readable: false, present: [] };
  const names = new Set(result.body.map((row) => String(row?.name ?? '')));
  return { readable: true, present: HOLD_CONTROL_NAMES.filter((name) => names.has(name)) };
}

async function countActorState(projectRef, token, actorId, fetchImpl) {
  if (!UUID_PATTERN.test(actorId)) throw new KPlusHoldProbeError('actor id is not a uuid', 'BAD_ACTOR');
  const query = STATE_TABLES.map((table) => `select '${table}' as t, count(*)::int as n from public.${table} where user_id = '${actorId}'`).join(' union all ');
  const result = await managementJson(`${MANAGEMENT_API}/${projectRef}/database/query`, token, {
    method: 'POST',
    body: JSON.stringify({ query }),
  }, fetchImpl);
  if (!result.ok || !Array.isArray(result.body)) return null;
  const counts = {};
  for (const row of result.body) counts[String(row.t)] = Number(row.n);
  return STATE_TABLES.every((table) => Number.isInteger(counts[table])) ? counts : null;
}

function sameCounts(before, after) {
  return Boolean(before && after) && STATE_TABLES.every((table) => before[table] === after[table]);
}

async function countLogMarkers(projectRef, token, startIso, fetchImpl) {
  const sql =`select event_message from logs where source = 'function_logs' and timestamp >= parseDateTimeBestEffort('${startIso}') and event_message like '%kplus_%' limit 200`;
  const url = new URL(`${MANAGEMENT_API}/${projectRef}/analytics/endpoints/logs`);
  url.searchParams.set('sql', sql);
  url.searchParams.set('iso_timestamp_start', startIso);
  url.searchParams.set('iso_timestamp_end', new Date().toISOString());
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const body = await response.json().catch(() => ({}));
  const rows = Array.isArray(body?.result) ? body.result : [];
  const counts = { closed: 0, completed: 0, rpcFailed: 0, examinedLines: rows.length };
  for (const row of rows) {
    const message = String(row?.event_message ?? '');
    for (const [key, marker] of Object.entries(LOG_MARKERS)) if (message.includes(marker)) counts[key] += 1;
  }
  return counts;
}

async function waitForClosedLogs(projectRef, token, startIso, fetchImpl, { attempts = 8, delayMs = 3000, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(delayMs); // function console logs reach the analytics API asynchronously
    last = await countLogMarkers(projectRef, token, startIso, fetchImpl);
    if (last && last.closed >= 2) return last;
  }
  return last;
}

function assertEvidencePrivacy(value) {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_EVIDENCE_PATTERNS) {
      if (pattern.test(value)) throw new KPlusHoldProbeError('sanitized evidence matched a forbidden secret/PII shape', 'EVIDENCE_PRIVACY');
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach(assertEvidencePrivacy); return; }
  if (value && typeof value === 'object') Object.values(value).forEach(assertEvidencePrivacy);
}

async function run(env = process.env, fetchImpl = fetch, options = {}) {
  const missing = findMissingEnvVars(env);
  if (missing.length > 0) throw new KPlusHoldProbeError(`missing required env vars: ${missing.join(', ')}`, 'MISSING_ENV');
  assertStagingOnly(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_STAGING_URL);

  const projectRef = env.SUPABASE_STAGING_PROJECT_REF;
  const url = functionUrl(env.SUPABASE_STAGING_URL);
  const apikey = env.SUPABASE_STAGING_PUBLISHABLE_KEY;
  const managementToken = env.SUPABASE_ACCESS_TOKEN;
  const findings = {};

  // 1. The campaign is OFF by default: neither server control exists on staging.
  //    Checked BEFORE any authenticated call so a mis-set control can never turn
  //    this probe into a grant.
  const controls = await listHoldControlNames(projectRef, managementToken, fetchImpl);
  findings.campaignControlsAbsent = { secretListReadable: controls.readable, presentControlCount: controls.present.length, pass: controls.readable && controls.present.length === 0 };
  if (!findings.campaignControlsAbsent.pass) {
    return { generatedAtUtc: new Date().toISOString(), stagingProjectRef: projectRef, aborted: 'campaign controls present or unreadable; no authenticated call made', findings };
  }

  // 2. Zero-spend rejections.
  const anonymous = await callFunction(url, { apikey, fetchImpl });
  findings.anonymousRejected = { status: anonymous.status, pass: anonymous.status === 401 };
  const invalid = await callFunction(url, { apikey, bearer: 'not-a-real-jwt-at-all', fetchImpl });
  findings.invalidTokenRejected = { status: invalid.status, pass: [401, 403].includes(invalid.status) };

  // 3. Sign in the one synthetic account; mask the token before any other use.
  const signIn = await signInSyntheticUser(env.SUPABASE_STAGING_URL, apikey, env.STAGING_SYNTHETIC_ACTIVE_EMAIL, env.STAGING_SYNTHETIC_ACTIVE_PASSWORD, fetchImpl);
  if (!signIn.ok) throw new KPlusHoldProbeError(`synthetic sign-in failed: ${signIn.error}`, 'SIGN_IN_FAILED');
  process.stderr.write(maskLine(signIn.accessToken) + '\n');
  const bearer = signIn.accessToken;
  const actorId = actorIdFromJwt(bearer);

  const before = await countActorState(projectRef, managementToken, actorId, fetchImpl);
  findings.stateReadBefore = { readable: Boolean(before), pass: Boolean(before) };

  const startIso = new Date(Date.now() - 5000).toISOString();

  const method = await callFunction(url, { apikey, bearer, method: 'GET', fetchImpl });
  findings.nonPostRejected = { status: method.status, pass: method.status === 405 };

  // 4. The authenticated, eligible account is denied -- and denied again.
  const grantShape = (json) => Boolean(json && ('entitlementKey' in json || 'grantedAt' in json || 'expiresAt' in json || 'campaignStatus' in json));
  const first = await callFunction(url, { apikey, bearer, fetchImpl });
  findings.authenticatedDenied = { status: first.status, code: first.json?.code ?? null, grantFieldsPresent: grantShape(first.json), pass: first.status === 403 && first.json?.code === 'CAMPAIGN_CLOSED' && !grantShape(first.json) };
  const second = await callFunction(url, { apikey, bearer, fetchImpl });
  findings.repeatedRequestDenied = { status: second.status, code: second.json?.code ?? null, grantFieldsPresent: grantShape(second.json), pass: second.status === 403 && second.json?.code === 'CAMPAIGN_CLOSED' && !grantShape(second.json) };

  // 5. Nothing about the actor's entitlement state moved.
  const after = await countActorState(projectRef, managementToken, actorId, fetchImpl);
  findings.entitlementStateUnchanged = { before, after, pass: sameCounts(before, after) };

  // 6. The function's own logs agree: closed denials, no completion, no grant RPC.
  const logs = await waitForClosedLogs(projectRef, managementToken, startIso, fetchImpl, options.logPolling);
  findings.denialLoggedWithoutCompletion = {
    logsReadable: Boolean(logs),
    closedCount: logs?.closed ?? null,
    completionCount: logs?.completed ?? null,
    grantRpcFailureCount: logs?.rpcFailed ?? null,
    pass: Boolean(logs) && logs.closed >= 2 && logs.completed === 0 && logs.rpcFailed === 0,
  };

  return { generatedAtUtc: new Date().toISOString(), stagingProjectRef: projectRef, findings };
}

async function main() {
  const report = await run();
  assertEvidencePrivacy(report);
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
  const failed = Boolean(report.aborted) || !Object.values(report.findings).every((f) => f.pass === true);
  if (failed) {
    process.stderr.write(`One or more probe findings failed: ${JSON.stringify(report.findings, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    fs.writeFileSync(REPORT_FILE, JSON.stringify({ ok: false, error: err.message, code: err.code || 'UNKNOWN' }, null, 2) + '\n');
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_ENV_VARS,
  HOLD_CONTROL_NAMES,
  STATE_TABLES,
  LOG_MARKERS,
  KPlusHoldProbeError,
  findMissingEnvVars,
  assertStagingOnly,
  actorIdFromJwt,
  assertEvidencePrivacy,
  sameCounts,
  run,
};
