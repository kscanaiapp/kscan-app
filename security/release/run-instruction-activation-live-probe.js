'use strict';

/**
 * Bounded Staging live probe for issue #639: proves the Elise brand voice and
 * the Scanner image product mission are DEPLOYED, ENABLED and EXECUTED.
 *
 * It sends one Elise conversational turn, three image-mode scans (legacy single
 * item, multi-item detection, selected item) and one TextScan as the governed
 * synthetic ACTIVE account, then reads the metadata-only activation lines the
 * functions log (`[elise_brand_voice]`, `[scan-identify] image_mission`) plus
 * the existing `gemini_start` lines from the Staging analytics API.
 *
 * - Staging only (asserted before any request). Never production.
 * - Reads only the repository's approved `assets/qa_fixtures` images.
 * - Creates no account and deploys nothing. Its only write is one owned
 *   style_chat_sessions row (as the app creates), deleted at the end.
 * - The report carries counts, enums, booleans and latencies only: no reply
 *   text, prompt text, image data, user id, email or token.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');
const {
  REQUIRED_ENV_VARS,
  CONTROL_ENTRY_PATH,
  findMissingEnvVars,
  assertStagingOnly,
  buildDetectRequest,
  buildSelectedItemRequest,
  buildScanIdentifyUrl,
  summarizeCandidates,
  assertEvidencePrivacy,
} = require('./run-elise-dominant-garment-live-probe');

function readCorrelation(body) {
  return {
    scanSessionId: typeof body?.scanSessionId === 'string' ? body.scanSessionId : null,
    imageDigestPrefix: typeof body?.imageDigestPrefix === 'string' ? body.imageDigestPrefix : null,
  };
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'assets', 'qa_fixtures');
const REPORT_FILE = 'instruction-activation-live-probe-report.json';

const ELISE_MESSAGE = 'What shoes would work with wide-leg navy trousers for a dinner out?';
const TEXT_QUERY = 'black leather ankle boots';

const ACTIVATION_LINE = /\[elise_brand_voice\] version=(\S+) enabled=(true|false) attached=(true|false)/;
const IMAGE_MISSION_LINE =
  /\[scan-identify\] image_mission version=(\S+) enabled=(true|false) request_mode=(\S+) attached=(true|false)/;
const GEMINI_START_LINE = /\[scan-identify\] gemini_start timeoutMs=(\d+) model=(\S+) mode=(\S+)/;

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name)).toString('base64');
}

async function post(url, key, token, body) {
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* reported as a contract failure */ }
  return { httpStatus: res.status, body: json, elapsedMs: Date.now() - startedAt };
}

/** Parse only allowlisted structural tokens out of the analytics rows. */
function parseActivationRows(rows) {
  const out = { elise: [], imageMission: [], geminiStart: [] };
  for (const row of rows) {
    const message = String(row.event_message || '');
    let m = ACTIVATION_LINE.exec(message);
    if (m) { out.elise.push({ version: m[1], enabled: m[2] === 'true', attached: m[3] === 'true' }); continue; }
    m = IMAGE_MISSION_LINE.exec(message);
    if (m) {
      out.imageMission.push({ version: m[1], enabled: m[2] === 'true', requestMode: m[3], attached: m[4] === 'true' });
      continue;
    }
    m = GEMINI_START_LINE.exec(message);
    if (m) out.geminiStart.push({ timeoutMs: Number(m[1]), model: m[2], mode: m[3] });
  }
  return out;
}

async function queryActivationRows(projectRef, managementToken, startIso) {
  const sql = "select timestamp, event_message from logs where source = 'function_logs' "
    + `and timestamp >= parseDateTimeBestEffort('${startIso}') `
    + "and (event_message like '%[elise_brand_voice]%' or event_message like '%image_mission%' "
    + "or event_message like '%gemini_start%') order by timestamp asc limit 200";
  const url = new URL(`https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs`);
  url.searchParams.set('sql', sql);
  url.searchParams.set('iso_timestamp_start', startIso);
  url.searchParams.set('iso_timestamp_end', new Date(Date.now() + 60_000).toISOString());
  const res = await fetch(url, { headers: { Authorization: `Bearer ${managementToken}` } });
  if (!res.ok) return { ok: false, httpStatus: res.status, rows: [] };
  const body = await res.json().catch(() => ({}));
  return { ok: true, httpStatus: res.status, rows: Array.isArray(body?.result) ? body.result : [] };
}

/**
 * Pure verdict over the parsed evidence. `imageRequestsReachedGemini` is the
 * number of image-mode requests whose response proves a provider answer.
 */
function evaluate(evidence) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  const { logs, elise, legacy, detect, selected, text } = evidence;

  add('elise_turn_succeeded', elise.httpStatus === 200 && elise.status === 'success',
    `http=${elise.httpStatus} status=${elise.status}`);
  add('elise_brand_voice_enabled_and_attached',
    logs.elise.length >= 1 && logs.elise.every((l) => l.enabled && l.attached && l.version === 'elise-brand-voice-v1'),
    `lines=${logs.elise.length}`);
  add('elise_structured_contract_intact',
    Array.isArray(elise.capabilities) && elise.capabilities.includes('structured_actions') && elise.actionsIsArray,
    `capabilities=${(elise.capabilities || []).join(',')}`);

  const missionModes = logs.imageMission.map((l) => l.requestMode).sort();
  add('image_mission_enabled_and_attached_every_image_call',
    logs.imageMission.length >= 3 && logs.imageMission.every((l) => l.enabled && l.attached
      && l.version === 'scan-image-product-mission-v1'),
    `lines=${logs.imageMission.length} modes=${missionModes.join(',')}`);
  for (const mode of ['legacy_single_item', 'multi_item_detection', 'selected_item']) {
    add(`image_mission_mode_${mode}`, missionModes.includes(mode), `seen=${missionModes.includes(mode)}`);
  }
  const imageStarts = logs.geminiStart.filter((l) => l.mode === 'image').length;
  const textStarts = logs.geminiStart.filter((l) => l.mode === 'text').length;
  add('textscan_reached_gemini', textStarts >= 1, `text gemini_start=${textStarts}`);
  add('textscan_isolated_one_mission_per_image_call', logs.imageMission.length === imageStarts,
    `image gemini_start=${imageStarts} image_mission=${logs.imageMission.length}`);

  add('legacy_scan_contract', legacy.httpStatus === 200 && typeof legacy.status === 'string',
    `http=${legacy.httpStatus} status=${legacy.status}`);
  add('multi_item_detection_contract', detect.httpStatus === 200 && detect.v2Status !== null && detect.candidateCount >= 1,
    `http=${detect.httpStatus} v2=${detect.v2Status} candidates=${detect.candidateCount}`);
  add('selected_item_contract', selected.httpStatus === 200 && selected.v2Status !== null,
    `http=${selected.httpStatus} v2=${selected.v2Status} candidates=${selected.candidateCount}`);
  add('textscan_contract', text.httpStatus === 200 && typeof text.status === 'string',
    `http=${text.httpStatus} status=${text.status}`);

  return { pass: checks.every((c) => c.pass), checks };
}

function summarizeV2(result, evidenceId) {
  const v2 = result.body && typeof result.body === 'object' ? result.body.identificationV2 : null;
  const candidates = summarizeCandidates(v2, evidenceId);
  return {
    httpStatus: result.httpStatus,
    elapsedMs: result.elapsedMs,
    status: typeof result.body?.status === 'string' ? result.body.status : null,
    v2Status: typeof v2?.status === 'string' ? v2.status : null,
    candidateCount: candidates.length,
    categories: candidates.map((c) => c.category).filter(Boolean),
  };
}

async function run(env = process.env) {
  assertStagingOnly(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_STAGING_URL);
  const missing = findMissingEnvVars(env);
  if (missing.length) throw new Error(`missing env: ${missing.join(',')}`);
  process.stderr.write(`${maskLine(env.SUPABASE_ACCESS_TOKEN)}\n`);

  const signIn = await signInSyntheticUser(env.SUPABASE_STAGING_URL, env.SUPABASE_STAGING_PUBLISHABLE_KEY,
    env.STAGING_SYNTHETIC_ACTIVE_EMAIL, env.STAGING_SYNTHETIC_ACTIVE_PASSWORD);
  process.stderr.write(`${maskLine(signIn.accessToken)}\n`);
  const key = env.SUPABASE_STAGING_PUBLISHABLE_KEY;
  const token = signIn.accessToken;
  const base = String(env.SUPABASE_STAGING_URL).replace(/\/+$/, '');
  const scanUrl = buildScanIdentifyUrl(base);
  const startIso = new Date(Date.now() - 5_000).toISOString();

  // Elise requires a session the caller owns. Create it exactly as the app does
  // (RLS-scoped insert as the user) and delete it afterwards; messages cascade.
  const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  const sessionId = crypto.randomUUID();
  const restHeaders = { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const sessionRes = await fetch(`${base}/rest/v1/style_chat_sessions`, {
    method: 'POST',
    headers: { ...restHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ id: sessionId, user_id: userId, title: 'K Scan activation probe', mode: 'general' }),
  });
  let eliseRaw;
  try {
    eliseRaw = await post(`${base}/functions/v1/stylechat-generate`, key, token,
      { sessionId, message: ELISE_MESSAGE });
  } finally {
    await fetch(`${base}/rest/v1/style_chat_sessions?id=eq.${sessionId}`, { method: 'DELETE', headers: restHeaders })
      .catch(() => {});
  }
  const elise = {
    sessionCreateStatus: sessionRes.status,
    httpStatus: eliseRaw.httpStatus,
    elapsedMs: eliseRaw.elapsedMs,
    status: typeof eliseRaw.body?.status === 'string' ? eliseRaw.body.status : null,
    replyLength: typeof eliseRaw.body?.message === 'string' ? eliseRaw.body.message.length : 0,
    capabilities: Array.isArray(eliseRaw.body?.capabilities) ? eliseRaw.body.capabilities : [],
    actionsIsArray: Array.isArray(eliseRaw.body?.actions),
  };

  const legacyRaw = await post(scanUrl, key, token, { mode: 'image', imageBase64: loadFixture('top.jpg') });
  const legacy = {
    httpStatus: legacyRaw.httpStatus,
    elapsedMs: legacyRaw.elapsedMs,
    status: typeof legacyRaw.body?.status === 'string' ? legacyRaw.body.status : null,
    category: typeof legacyRaw.body?.category === 'string' ? legacyRaw.body.category : null,
  };

  const detectRequest = buildDetectRequest(CONTROL_ENTRY_PATH, loadFixture('ambiguous_two_garments.jpg'));
  const evidenceId = detectRequest.evidence[0].evidenceId;
  const detectRaw = await post(scanUrl, key, token, detectRequest);
  const detect = summarizeV2(detectRaw, evidenceId);
  const firstCandidate = summarizeCandidates(detectRaw.body?.identificationV2, evidenceId)[0];
  let selected = { httpStatus: null, v2Status: null, candidateCount: 0, skipped: 'no candidate' };
  if (firstCandidate) {
    const selectedRaw = await post(scanUrl, key, token,
      buildSelectedItemRequest(detectRequest, firstCandidate, readCorrelation(detectRaw.body)));
    selected = summarizeV2(selectedRaw, evidenceId);
  }

  const textRaw = await post(scanUrl, key, token, { mode: 'text', textQuery: TEXT_QUERY });
  const text = {
    httpStatus: textRaw.httpStatus,
    elapsedMs: textRaw.elapsedMs,
    status: typeof textRaw.body?.status === 'string' ? textRaw.body.status : null,
  };

  // Function console logs reach the analytics API asynchronously.
  let query = { ok: false, rows: [] };
  let logs = parseActivationRows([]);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    query = await queryActivationRows(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_ACCESS_TOKEN, startIso);
    logs = parseActivationRows(query.rows);
    if (logs.elise.length >= 1 && logs.geminiStart.length >= 4) break;
  }

  const evidence = { logs, elise, legacy, detect, selected, text };
  const verdict = evaluate(evidence);
  const report = {
    probe: 'instruction-activation-live-probe-v1',
    environment: 'staging',
    startedAt: startIso,
    logQuery: { ok: query.ok, httpStatus: query.httpStatus, rowCount: query.rows.length },
    evidence,
    verdict,
  };
  assertEvidencePrivacy(report);
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  run().then((report) => {
    process.stdout.write(`${report.verdict.pass ? 'PASS' : 'FAIL'}\n`);
    process.exit(report.verdict.pass ? 0 : 1);
  }).catch((error) => {
    const failure = { probe: 'instruction-activation-live-probe-v1', error: String(error?.code || error?.name || 'error') };
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(failure, null, 2)}\n`);
    process.stderr.write(`probe failed: ${failure.error}\n`);
    process.exit(1);
  });
}

module.exports = { parseActivationRows, evaluate, ACTIVATION_LINE, IMAGE_MISSION_LINE, GEMINI_START_LINE };
