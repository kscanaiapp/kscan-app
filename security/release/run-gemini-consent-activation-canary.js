'use strict';

/**
 * Bounded Staging canary for issues #701 + #639: proves the Gemini v2 consent
 * lifecycle gates real Gemini work, then that the Elise brand voice and the
 * Scanner image product mission execute for a consented actor.
 *
 * Owner-approved scope (2026-11-03): the governed synthetic ACTIVE account
 * records its OWN v2 acknowledgment through the app's authenticated upsert,
 * and exactly two paid Gemini requests are made (one Elise turn, one
 * image-mode scan of the repository's `top.jpg`, which carries a visible
 * wordmark). Every other request is denied by the consent gate before any
 * provider call.
 *
 * - Staging only (asserted before any request). Never production.
 * - Creates no account and deploys nothing. Writes: the actor's own v2
 *   ai_processing receipt (immutable legal ledger), its permission row via the
 *   revision-fenced RPC, and one owned style_chat_sessions row (deleted).
 * - The Elise reply is never written in plaintext: it is sealed to an
 *   operator-held RSA key so a reviewer can judge voice quality offline. The
 *   rest of the report carries counts, enums, booleans, latencies and public
 *   commerce facts only.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');
const {
  findMissingEnvVars,
  assertStagingOnly,
  buildScanIdentifyUrl,
  assertEvidencePrivacy,
} = require('./run-elise-dominant-garment-live-probe');
const { parseActivationRows } = require('./run-instruction-activation-live-probe');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'assets', 'qa_fixtures', 'top.jpg');
const REPORT_FILE = 'gemini-consent-activation-canary-report.json';
const ELISE_MESSAGE = 'What shoes would work with wide-leg navy trousers for a dinner out?';
const CONSENT_VERSION = 'v2_google_gemini';
// The identification Staging returned for top.jpg (run 41655013295), minus free text.
const COQ_HOODIE_IDENTIFICATION = Object.freeze({
  item_type: 'hoodie', subtype: 'pullover hoodie', primary_color: 'white', pattern: 'graphic print',
  material_estimate: 'cotton blend', silhouette: 'relaxed', fit: 'relaxed fit', length: 'hip length',
  sleeve_length: 'long sleeve', neckline_or_lapel: 'hooded with drawstrings', closure: 'pullover',
  visible_brand_text: 'COQ', brand_guess: 'COQ', logo_detected: true, non_fashion: false, confidence_score: 0.92,
});

// Operator-held key; only the matching private key (never committed) can open the sealed reply.
const REPLY_SEAL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA3Fjd2cp1MG36omZsgm5s
zN/DbjYQ108oiIA8Enf6pChzyu/4QLiZS9P9CGD9G/veB7oBYYh4t00VZUlfpDwZ
xVbTa18TKoDLKr4UB08zoIRJSG6eCxgvhL1Dm4qvh5V4yWCpT+PsgxwAcLFU5Uzb
RHuiNdl8s+2DaBjOZLUZR6ki5GFRRI1TlVIaaLj6E71HsaO1YVhzyLZImTyz6Nvx
ZCv4tzYTrKx7RExfaIynhNkfpdfxsT3sixwY+FkGnFeZm+V15B99s/5I/lYOR97O
Ufe706bER8q5MWnCNVhmZIbQRUfTzDLY7hfmRzNC3FOgcyFZmV8gvTXMP2T1Dmhe
jCHSHG7wjW5QjGvODBi3Ty62Yvvob3DgQ6l3iJbgXuAMh+1I4SaFtVIIHwJr82lW
36B6aDuac/fBeuMiBckc0c2tOG6vnDpwoZ8E74bPSoaSHqyBnWCVPnRZVzHQ33jU
ORtB9YeJN+8uLDA4ImbmSu1sxy4CI/jj9Gghm0xlwDApAgMBAAE=
-----END PUBLIC KEY-----`;

function sealText(text) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt(
    { key: REPLY_SEAL_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  // Hex so the privacy scanner's JWT/base64 shapes can never match ciphertext.
  return { alg: 'RSA-OAEP-256+A256GCM', wrappedKey: wrappedKey.toString('hex'), iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') };
}

async function call(url, key, token, body, extraHeaders = {}) {
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  return { httpStatus: res.status, body: json, elapsedMs: Date.now() - startedAt };
}

const errorCodeOf = (r) => (typeof r.body?.errorCode === 'string' ? r.body.errorCode : null);
const permissionOf = (r) => ({
  httpStatus: r.httpStatus,
  granted: typeof r.body?.granted === 'boolean' ? r.body.granted : null,
  revision: typeof r.body?.revision === 'number' ? r.body.revision : null,
  policyVersion: typeof r.body?.policy_version === 'string' ? r.body.policy_version : null,
  pgCode: typeof r.body?.code === 'string' ? r.body.code : null,
});

const SHORT = (v, n = 120) => (typeof v === 'string' ? v.slice(0, n) : typeof v === 'number' || typeof v === 'boolean' ? v : null);
function hostOf(url) { try { return new URL(String(url)).hostname; } catch { return null; } }

/** Public commerce facts only: no URLs beyond hostnames, no images. */
function summarizeScan(r) {
  const b = r.body && typeof r.body === 'object' ? r.body : {};
  const ident = b.identification && typeof b.identification === 'object' ? b.identification : {};
  const identification = {};
  for (const [k, v] of Object.entries(ident)) {
    if (['string', 'number', 'boolean'].includes(typeof v) && !/id$/i.test(k)) identification[k] = SHORT(v);
  }
  const listing = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 8).map((p) => ({
    title: SHORT(p?.title ?? p?.name, 90),
    brand: SHORT(p?.brand, 40),
    retailer: SHORT(p?.retailer ?? p?.source ?? p?.merchant ?? p?.store, 40),
    host: hostOf(p?.url ?? p?.link ?? p?.productUrl),
    price: SHORT(p?.price ?? p?.priceText, 20),
    matchTier: SHORT(p?.matchTier ?? p?.commerceMatch?.tier, 20),
  }));
  return {
    httpStatus: r.httpStatus,
    elapsedMs: r.elapsedMs,
    status: SHORT(b.status, 30),
    errorCode: errorCodeOf(r),
    identification,
    counts: {
      products: Array.isArray(b.products) ? b.products.length : 0,
      purchaseOptions: Array.isArray(b.purchaseOptions) ? b.purchaseOptions.length : 0,
      similarityMatches: Array.isArray(b.similarityMatches) ? b.similarityMatches.length : 0,
      recommendedProducts: Array.isArray(b.recommendedProducts) ? b.recommendedProducts.length : 0,
    },
    shoppingMetaKeys: b.shoppingMeta && typeof b.shoppingMeta === 'object' ? Object.keys(b.shoppingMeta).slice(0, 20) : [],
    products: listing(b.products),
    purchaseOptions: listing(b.purchaseOptions),
    recommendedProducts: listing(b.recommendedProducts),
    similarityMatches: listing(b.similarityMatches),
  };
}

async function queryLogs(projectRef, managementToken, startIso) {
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

function evaluate(e) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  const denied = (r) => r.httpStatus === 403 && r.errorCode === 'AI_PROCESSING_CONSENT_REQUIRED';

  if (e.consent.v2ReceiptBefore) {
    add('pre_ack_gate_skipped_receipt_already_present', true, 'v2 receipt existed before this run');
  } else {
    add('v1_only_actor_denied_before_gemini', denied(e.gates.preAck), `http=${e.gates.preAck.httpStatus} code=${e.gates.preAck.errorCode}`);
  }
  add('actor_v2_ack_recorded', e.consent.ackHttpStatus === 201 || e.consent.ackHttpStatus === 200,
    `http=${e.consent.ackHttpStatus}`);
  add('permission_granted_after_ack', e.consent.afterAck.granted === true && e.consent.afterAck.policyVersion === CONSENT_VERSION,
    JSON.stringify(e.consent.afterAck));
  add('withdraw_via_rpc', e.consent.withdrawn.granted === false
    && e.consent.withdrawn.revision === (e.consent.afterAck.revision ?? -1) + 1, JSON.stringify(e.consent.withdrawn));
  add('stale_revision_rejected', e.consent.stale.httpStatus >= 400 && e.consent.stale.granted === null,
    JSON.stringify(e.consent.stale));
  add('withdrawn_elise_denied_before_gemini', denied(e.gates.withdrawnElise),
    `http=${e.gates.withdrawnElise.httpStatus} code=${e.gates.withdrawnElise.errorCode}`);
  add('withdrawn_scan_denied_before_gemini', denied(e.gates.withdrawnScan),
    `http=${e.gates.withdrawnScan.httpStatus} code=${e.gates.withdrawnScan.errorCode}`);
  add('reenable_via_rpc', e.consent.reenabled.granted === true
    && e.consent.reenabled.revision === (e.consent.withdrawn.revision ?? -1) + 1, JSON.stringify(e.consent.reenabled));
  add('cross_account_permission_read_denied', e.consent.crossAccount.httpStatus >= 400 && e.consent.crossAccount.granted === null,
    JSON.stringify(e.consent.crossAccount));

  add('elise_turn_succeeded', e.elise.httpStatus === 200 && e.elise.status === 'success' && e.elise.replyLength > 0,
    `http=${e.elise.httpStatus} status=${e.elise.status} replyLength=${e.elise.replyLength}`);
  add('elise_prompt_version_has_brand_voice', e.elise.promptVersion === 'stylechat-prompt-v1+elise-brand-voice-v1'
    || e.elise.promptVersion === null, `promptVersion=${e.elise.promptVersion}`);
  add('elise_brand_voice_enabled_and_attached',
    e.logs.elise.length >= 1 && e.logs.elise.every((l) => l.enabled && l.attached && l.version === 'elise-brand-voice-v1'),
    `lines=${e.logs.elise.length}`);
  add('elise_structured_contract_intact', e.elise.capabilities.includes('structured_actions') && e.elise.actionsIsArray,
    `capabilities=${e.elise.capabilities.join(',')}`);

  add('scan_completed', e.scan.httpStatus === 200 && typeof e.scan.status === 'string',
    `http=${e.scan.httpStatus} status=${e.scan.status}`);
  add('image_mission_enabled_and_attached', e.logs.imageMission.length === 1
    && e.logs.imageMission.every((l) => l.enabled && l.attached && l.version === 'scan-image-product-mission-v1'),
    `lines=${e.logs.imageMission.length}`);
  const imageStarts = e.logs.geminiStart.filter((l) => l.mode === 'image').length;
  add('exactly_one_image_gemini_call', imageStarts === 1, `image gemini_start=${imageStarts}`);
  return { pass: checks.every((c) => c.pass), checks };
}

/**
 * Zero-spend mode: with a correctly deployed gate both functions refuse a
 * withdrawn actor before any provider call. Restores the prior grant.
 */
async function runGates(ctx) {
  const { key, token, rest, eliseUrl, scanUrl, restHeaders, userId, imageBase64, getPermission, setPermission, gate } = ctx;
  const before = await getPermission();
  if (before.granted !== true) throw Object.assign(new Error('actor not granted'), { code: 'NOT_GRANTED' });
  const sessionId = crypto.randomUUID();
  await fetch(`${rest}/style_chat_sessions`, {
    method: 'POST', headers: { ...restHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ id: sessionId, user_id: userId, title: 'K Scan consent gate check', mode: 'general' }),
  });
  let withdrawn; let elise; let scan; let restored;
  try {
    withdrawn = await setPermission(false, before.revision);
    elise = gate(await call(eliseUrl, key, token, { sessionId, message: ELISE_MESSAGE, contractVersion: '2' }));
    scan = gate(await call(scanUrl, key, token, { mode: 'image', imageBase64 }));
  } finally {
    restored = await setPermission(true, (withdrawn?.revision ?? before.revision));
    await fetch(`${rest}/style_chat_sessions?id=eq.${sessionId}`, { method: 'DELETE', headers: restHeaders }).catch(() => {});
  }
  const denied = (r) => r.httpStatus === 403 && r.errorCode === 'AI_PROCESSING_CONSENT_REQUIRED';
  const checks = [
    { name: 'withdraw_via_rpc', pass: withdrawn.granted === false, detail: JSON.stringify(withdrawn) },
    { name: 'withdrawn_elise_denied_before_gemini', pass: denied(elise), detail: `http=${elise.httpStatus} code=${elise.errorCode}` },
    { name: 'withdrawn_scan_denied_before_gemini', pass: denied(scan), detail: `http=${scan.httpStatus} code=${scan.errorCode}` },
    { name: 'grant_restored', pass: restored.granted === true, detail: JSON.stringify(restored) },
  ];
  return { evidence: { before, withdrawn, gates: { elise, scan }, restored }, verdict: { pass: checks.every((c) => c.pass), checks } };
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
  const rest = `${base}/rest/v1`;
  const scanUrl = buildScanIdentifyUrl(base);
  const eliseUrl = `${base}/functions/v1/stylechat-generate`;
  const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  const restHeaders = { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const imageBase64 = fs.readFileSync(FIXTURE).toString('base64');
  const startIso = new Date(Date.now() - 5_000).toISOString();

  const receiptsRes = await fetch(`${rest}/legal_acceptances?select=policy_version&acceptance_type=eq.ai_processing&user_id=eq.${userId}`,
    { headers: restHeaders });
  const receiptVersions = receiptsRes.ok ? (await receiptsRes.json()).map((r) => r.policy_version) : [];
  const getPermission = async (expected = userId) => permissionOf(
    await call(`${rest}/rpc/get_ai_processing_permission`, key, token, { p_expected_user_id: expected }));
  const setPermission = async (granted, revision) => permissionOf(await call(`${rest}/rpc/set_ai_processing_permission`,
    key, token, { p_expected_user_id: userId, p_granted: granted, p_expected_revision: revision }));
  const gate = (r) => ({ httpStatus: r.httpStatus, errorCode: errorCodeOf(r), elapsedMs: r.elapsedMs });

  // MODE B shopping continuation: exactly ONE commerce_only request, built as
  // services/commerceHydration.ts buildCommerceOnlyBody does, from the
  // identification Staging returned for top.jpg in run 41655013295. No image,
  // no enrich, so no Gemini call; the log check below proves that.
  if (env.CANARY_MODE === 'commerce') {
    const evidence = { requestMode: 'commerce_only', identification: COQ_HOODIE_IDENTIFICATION };
    const res = await call(scanUrl, key, token, evidence);
    let query = { ok: false, rows: [] };
    let logs = parseActivationRows([]);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      query = await queryLogs(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_ACCESS_TOKEN, startIso);
      logs = parseActivationRows(query.rows);
    }
    const scan = summarizeScan(res);
    const meta = res.body?.shoppingMeta && typeof res.body.shoppingMeta === 'object' ? res.body.shoppingMeta : {};
    const shoppingMeta = Object.fromEntries(Object.entries(meta)
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, SHORT(v, 60)]));
    // Same precedence as normalizeCommerceHydrationResponse.
    const offers = res.body && Array.isArray(res.body.purchaseOptions) ? scan.purchaseOptions : scan.recommendedProducts;
    const checks = [
      { name: 'commerce_only_http_200', pass: res.httpStatus === 200, detail: `http=${res.httpStatus} code=${scan.errorCode}` },
      { name: 'commerce_only_made_no_gemini_call', pass: logs.geminiStart.length === 0 && logs.imageMission.length === 0,
        detail: `gemini_start=${logs.geminiStart.length} image_mission=${logs.imageMission.length} logQueryOk=${query.ok}` },
      { name: 'commerce_only_not_deferred_again', pass: shoppingMeta.deferred !== true, detail: JSON.stringify(shoppingMeta) },
      { name: 'offers_have_https_merchant_hosts', pass: offers.every((p) => typeof p.host === 'string' && p.host.length > 0),
        detail: `offers=${offers.length} hosts=${[...new Set(offers.map((p) => p.host))].join(',')}` },
    ];
    const report = { probe: 'mode-b-commerce-continuation-v1', environment: 'staging', startedAt: startIso,
      evidence: { scan, shoppingMeta, logs }, verdict: { pass: checks.every((c) => c.pass), checks } };
    assertEvidencePrivacy(report);
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  // Paid activation runs only on an explicit dispatch; a push runs the free gate check.
  if (env.CANARY_MODE !== 'activation') {
    const { evidence: gateEvidence, verdict } = await runGates({ key, token, rest, eliseUrl, scanUrl, restHeaders, userId,
      imageBase64, getPermission, setPermission, gate });
    const report = { probe: 'gemini-consent-gate-check-v1', environment: 'staging', startedAt: startIso, evidence: gateEvidence, verdict };
    assertEvidencePrivacy(report);
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const before = await getPermission();

  const sessionId = crypto.randomUUID();
  const sessionRes = await fetch(`${rest}/style_chat_sessions`, {
    method: 'POST', headers: { ...restHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ id: sessionId, user_id: userId, title: 'K Scan consent canary', mode: 'general' }),
  });
  const eliseBody = { sessionId, message: ELISE_MESSAGE, contractVersion: '2' };

  let evidence;
  try {
    const v2ReceiptBefore = receiptVersions.includes(CONSENT_VERSION);
    const preAck = v2ReceiptBefore ? { httpStatus: null, errorCode: null, skipped: true } : gate(await call(eliseUrl, key, token, eliseBody));

    // The app's exact acknowledgment write (services/legalAcceptance.ts), ai_processing row only.
    const ack = await fetch(`${rest}/legal_acceptances?on_conflict=user_id,acceptance_type,policy_version`, {
      method: 'POST',
      headers: { ...restHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: userId, acceptance_type: 'ai_processing', policy_version: CONSENT_VERSION,
        source: 'mobile', app_version: 'staging-consent-canary', metadata: {} }]),
    });
    const afterAck = await getPermission();
    const withdrawn = await setPermission(false, afterAck.revision ?? 0);
    const stale = await setPermission(true, afterAck.revision ?? 0);
    const withdrawnElise = gate(await call(eliseUrl, key, token, eliseBody));
    const withdrawnScan = gate(await call(scanUrl, key, token, { mode: 'image', imageBase64 }));
    const reenabled = await setPermission(true, withdrawn.revision ?? 0);
    const crossAccount = await getPermission(crypto.randomUUID());

    const eliseRaw = await call(eliseUrl, key, token, eliseBody);
    const reply = typeof eliseRaw.body?.message?.content === 'string' ? eliseRaw.body.message.content : '';
    const elise = {
      sessionCreateStatus: sessionRes.status,
      httpStatus: eliseRaw.httpStatus,
      elapsedMs: eliseRaw.elapsedMs,
      status: typeof eliseRaw.body?.status === 'string' ? eliseRaw.body.status : null,
      errorCode: errorCodeOf(eliseRaw),
      replyLength: reply.length,
      promptVersion: typeof eliseRaw.body?.promptVersion === 'string' ? eliseRaw.body.promptVersion : null,
      contractVersion: typeof eliseRaw.body?.contractVersion === 'string' ? eliseRaw.body.contractVersion : null,
      capabilities: Array.isArray(eliseRaw.body?.capabilities) ? eliseRaw.body.capabilities : [],
      actionsIsArray: Array.isArray(eliseRaw.body?.actions),
      actionTypes: Array.isArray(eliseRaw.body?.actions) ? eliseRaw.body.actions.map((a) => SHORT(a?.type, 40)) : [],
      sealedReply: reply ? sealText(reply) : null,
    };
    const scan = summarizeScan(await call(scanUrl, key, token, { mode: 'image', imageBase64 }));

    evidence = {
      consent: { receiptVersionsBefore: receiptVersions, v2ReceiptBefore, before, ackHttpStatus: ack.status,
        afterAck, withdrawn, stale, reenabled, crossAccount },
      gates: { preAck, withdrawnElise, withdrawnScan },
      elise,
      scan,
    };
  } finally {
    await fetch(`${rest}/style_chat_sessions?id=eq.${sessionId}`, { method: 'DELETE', headers: restHeaders }).catch(() => {});
  }

  let query = { ok: false, rows: [] };
  let logs = parseActivationRows([]);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    query = await queryLogs(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_ACCESS_TOKEN, startIso);
    logs = parseActivationRows(query.rows);
    if (logs.elise.length >= 1 && logs.imageMission.length >= 1) break;
  }
  evidence.logs = logs;

  const report = {
    probe: 'gemini-consent-activation-canary-v1',
    environment: 'staging',
    startedAt: startIso,
    logQuery: { ok: query.ok, httpStatus: query.httpStatus, rowCount: query.rows.length },
    evidence,
    verdict: evaluate(evidence),
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
    const failure = { probe: 'gemini-consent-activation-canary-v1', error: String(error?.code || error?.name || 'error') };
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(failure, null, 2)}\n`);
    process.stderr.write(`probe failed: ${failure.error}\n`);
    process.exit(1);
  });
}

module.exports = { evaluate, sealText, summarizeScan };
