#!/usr/bin/env node
'use strict';

/**
 * Build 35 feature live probe (Staging only): the bounded paid evaluation of
 * OC-01 (find / refine / compare across SEPARATE HTTP requests), Corporate
 * Intelligence v2 on the same turns, and Scanner VRI-03 H1/H2(/H3/H4).
 *
 * BUDGET (owner-approved, Addendum A5): at most 12 billable model/provider
 * calls and $5. Billable calls are counted from the functions' own
 * metadata-only telemetry (planner calls, Gemini attempts, shopping provider
 * calls); a scenario runs only when its expected calls fit the remaining
 * envelope. The OC-01 trio runs back to back because product references
 * expire after 30 seconds.
 *
 * SAFETY: Staging only (refuses the production ref/URL). Signs in the existing
 * governed synthetic account; creates ONE chat session and deletes it at the
 * end. Reads only the repository's approved qa_fixtures image. Elise reply
 * text is sealed to an operator public key (this repository is public); the
 * report otherwise holds public product facts (titles, merchant labels,
 * hostnames, listed prices), counts, codes, durations and token totals.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');
const { assertStagingOnly, assertEvidencePrivacy } = require('./run-elise-dominant-garment-live-probe');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'assets', 'qa_fixtures', 'top.jpg');
const REPORT_FILE = 'build35-feature-live-probe-report.json';
const MAX_BILLABLE = 12;
const MAX_USD = 5;
// Repository-pinned paid-tier prices (supabase/functions/_shared/vri03/benchmark/budgetGuard.ts).
const PRICE = { 'gemini-3.6-flash': { input: 1.5, output: 7.5 }, 'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 } };
// Conservative per-query estimate for the shopping providers (no per-call price is exposed to the probe).
const SHOPPING_USD_PER_CALL = 0.002;
const CAPABILITY_HEADER = { 'X-KScan-Client-Capabilities': 'oc01-products-v1' };

const SEAL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA0l0S9woKc2LmY9DsYnZW
NHPtLVPm8kpGROlkeW6V1Oi/8yAjBAmDg7F/3LhJVeJXEiMmmPAq1cx/5unoZBC/
O0jEZdHDrRfROX7OhJhgJ/raXcNPRG6XuPb6j/LSaFEtDciPdd9KgTHxGB3YBBdq
SczEtpj2omE9NgV7SHFa5E6dIA/mf0MtD6eemX5dbyZ40KKIvLvqx7VpIHZo7/0k
5XQbrFg5mu+23Q1ziU8eGrhDu7XyUmqQy2PFgJarN2ifZf3eNEuAu8RY46toUqth
+Y5RmqsqT/kwWVHtlwzwdvdyDdhED2Jkkdtkrd+LaAem/syg/oRaA0WOjdbSeu9F
cobaBQ5rSiWY66iNRZFGrLqyLznsMINJWfkgAxG1JIv/LBZleJhhbksdGrr8aB1f
gZDpL0ZsfJMElvbqJp+LRYnz/GRth039+OVthp469egOPBN9pFlwI62PqRxvkhxM
WB0GI9L6Th/fcjr9iQb8t0FNoW2SGZp25/9mJ394hh+xAgMBAAE=
-----END PUBLIC KEY-----`;

function seal(text) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(text ?? ''), 'utf8'), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt({ key: SEAL_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { alg: 'RSA-OAEP-256+A256GCM', wrappedKey: wrappedKey.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') };
}

const SHORT = (v, n = 120) => (typeof v === 'string' ? v.slice(0, n) : typeof v === 'number' || typeof v === 'boolean' ? v : null);
const hostOf = (u) => { try { return new URL(String(u)).hostname; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, key, token, body, extraHeaders = {}) {
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { httpStatus: res.status, body: json, elapsedMs: Date.now() - startedAt };
}

function summarizeElise(r) {
  const b = r.body && typeof r.body === 'object' ? r.body : {};
  const c = b.commerceResults && typeof b.commerceResults === 'object' ? b.commerceResults : null;
  return {
    httpStatus: r.httpStatus,
    elapsedMs: r.elapsedMs,
    status: SHORT(b.status, 30),
    errorCode: SHORT(b.errorCode, 60),
    replyLength: typeof b.message?.content === 'string' ? b.message.content.length : 0,
    replySealed: seal(b.message?.content ?? ''),
    hasWhyThisWorks: typeof b.message?.why_this_works === 'string',
    commerce: c ? {
      version: SHORT(c.version, 30),
      kind: SHORT(c.kind, 20),
      status: SHORT(c.status, 30),
      reasonCode: SHORT(c.reasonCode, 60),
      products: (Array.isArray(c.products) ? c.products : []).slice(0, 8).map((p) => ({
        number: p?.number,
        title: SHORT(p?.title, 100),
        merchant: SHORT(p?.merchant, 60),
        host: hostOf(p?.productUrl),
        https: typeof p?.productUrl === 'string' && p.productUrl.startsWith('https://'),
        listedPrice: SHORT(p?.listedPrice, 24),
        currency: SHORT(p?.currency, 3),
        source: SHORT(p?.source, 20),
        hasImage: typeof p?.imageUrl === 'string',
        ownershipLabel: Boolean(p?.ownershipIdentity),
      })),
    } : null,
  };
}

function summarizeScan(r) {
  const b = r.body && typeof r.body === 'object' ? r.body : {};
  const ident = b.identification && typeof b.identification === 'object' ? b.identification : {};
  const identification = {};
  for (const [k, v] of Object.entries(ident)) {
    if (['string', 'number', 'boolean'].includes(typeof v) && !/id$/i.test(k)) identification[k] = SHORT(v, 80);
    else if (Array.isArray(v)) identification[k] = v.slice(0, 6).map((x) => SHORT(x, 60));
  }
  const listing = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 8).map((p) => ({
    title: SHORT(p?.title ?? p?.name, 90),
    retailer: SHORT(p?.retailer ?? p?.source ?? p?.merchant, 40),
    host: hostOf(p?.url ?? p?.link ?? p?.productUrl),
    price: SHORT(p?.price ?? p?.priceText, 20),
    matchTier: SHORT(p?.matchTier ?? p?.commerceMatch?.tier, 20),
  }));
  return {
    httpStatus: r.httpStatus,
    elapsedMs: r.elapsedMs,
    status: SHORT(b.status, 30),
    errorCode: SHORT(b.errorCode, 60),
    identification,
    identificationKeys: Object.keys(ident).slice(0, 60),
    purchaseOptions: listing(b.purchaseOptions),
    recommendedProducts: listing(b.recommendedProducts),
    similarityMatches: listing(b.similarityMatches),
    shoppingMeta: b.shoppingMeta && typeof b.shoppingMeta === 'object'
      ? Object.fromEntries(Object.entries(b.shoppingMeta).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, SHORT(v, 60)]))
      : null,
  };
}

async function queryLogs(projectRef, token, startIso) {
  const markers = ['oc01 ', 'oc01_tool', 'oc01_prose', 'ci_v2 ', 'ci_v2_flag', '[shopping] provider=', 'vri03_gemini_usage', 'vri03_commerce', '[stylechat-generate] ok ', 'gemini_start'];
  const where = markers.map((m) => `event_message like '%${m.replace(/'/g, "''")}%'`).join(' or ');
  const sql = `select timestamp, event_message from logs where source = 'function_logs' and timestamp >= parseDateTimeBestEffort('${startIso}') and (${where}) order by timestamp asc limit 400`;
  const url = new URL(`https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs`);
  url.searchParams.set('sql', sql);
  url.searchParams.set('iso_timestamp_start', startIso);
  url.searchParams.set('iso_timestamp_end', new Date(Date.now() + 60_000).toISOString());
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { ok: false, httpStatus: res.status, rows: [] };
  const body = await res.json().catch(() => ({}));
  return { ok: true, httpStatus: res.status, rows: Array.isArray(body?.result) ? body.result : [] };
}

const jsonAfter = (msg, marker) => {
  const i = msg.indexOf(marker);
  if (i < 0) return null;
  const j = msg.indexOf('{', i);
  if (j < 0) return null;
  try { return JSON.parse(msg.slice(j)); } catch { return null; }
};
const kv = (msg) => Object.fromEntries([...msg.matchAll(/([a-z0-9_]+)=([^\s]+)/gi)].map((m) => [m[1], m[2]]));

/** Metadata-only telemetry → ledger of billable calls and token totals. */
function ledgerFrom(rows) {
  const oc01 = []; const ci = []; const shopping = []; const scanUsage = []; const vriCommerce = []; const prose = []; const eliseOk = [];
  for (const row of rows) {
    const m = String(row.event_message ?? '');
    if (m.includes('[stylechat-generate] oc01 ')) { const j = jsonAfter(m, 'oc01 '); if (j) oc01.push(j); }
    else if (m.includes('oc01_prose')) { const j = jsonAfter(m, 'oc01_prose'); if (j) prose.push(j); }
    else if (m.includes('[stylechat-generate] ci_v2 ')) { const j = jsonAfter(m, 'ci_v2 '); if (j) ci.push(j); }
    else if (m.includes('[shopping] provider=')) shopping.push(kv(m));
    else if (m.includes('vri03_gemini_usage')) scanUsage.push(kv(m));
    else if (m.includes('vri03_commerce')) vriCommerce.push(kv(m));
    else if (m.includes('[stylechat-generate] ok ')) { const k = kv(m); eliseOk.push({ elapsedMs: Number(k.elapsedMs), retried: k.retried, fallback: k.fallback, tokens: Number(k.tokens) }); }
  }
  // CI-v2 logs once per finalization pass; the LAST pass of a request carries its full usage.
  const ciByPass = ci.filter((c, i) => i === ci.length - 1 || ci[i + 1].finalizationPasses <= c.finalizationPasses);
  const plannerCalls = oc01.reduce((n, o) => n + (o.plannerCalls ?? 0), 0);
  const eliseGemini = ciByPass.reduce((n, c) => n + (c.providerAttempts ?? 0), 0);
  const shoppingCalls = shopping.filter((s) => s.status !== '0' || (s.error && s.error !== 'no_key')).length;
  const scanGemini = scanUsage.reduce((n, s) => n + Number(s.attempts ?? 0), 0);
  const tokens = {
    plannerPrompt: oc01.reduce((n, o) => n + (o.plannerPromptTokens ?? 0), 0),
    plannerOutput: oc01.reduce((n, o) => n + (o.plannerOutputTokens ?? 0), 0),
    elisePrompt: ciByPass.reduce((n, c) => n + (c.promptTokens ?? 0), 0),
    eliseOutput: ciByPass.reduce((n, c) => n + (c.outputTokens ?? 0) + (c.thoughtsTokens ?? 0), 0),
    scanPrompt: scanUsage.reduce((n, s) => n + Number(s.prompt_tokens ?? 0), 0),
    scanOutput: scanUsage.reduce((n, s) => n + Number(s.output_tokens ?? 0) + Number(s.thoughts_tokens ?? 0), 0),
  };
  const p = PRICE['gemini-3.6-flash'];
  const usd = ((tokens.plannerPrompt + tokens.elisePrompt + tokens.scanPrompt) * p.input
    + (tokens.plannerOutput + tokens.eliseOutput + tokens.scanOutput) * p.output) / 1e6 + shoppingCalls * SHOPPING_USD_PER_CALL;
  return {
    billable: plannerCalls + eliseGemini + shoppingCalls + scanGemini,
    breakdown: { plannerCalls, eliseGemini, shoppingCalls, scanGemini },
    tokens,
    estimatedUsd: Math.round(usd * 10000) / 10000,
    oc01, ci: ciByPass, prose, shopping, scanUsage, vriCommerce, eliseOk,
  };
}

async function settledLedger(env, startIso, expectedMin) {
  let last = { ok: false, rows: [] };
  for (let attempt = 0; attempt < 9; attempt += 1) {
    await sleep(10_000);
    last = await queryLogs(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_ACCESS_TOKEN, startIso);
    const l = ledgerFrom(last.rows);
    if (l.billable >= expectedMin && attempt >= 2) return { logQueryOk: last.ok, ...l };
  }
  return { logQueryOk: last.ok, ...ledgerFrom(last.rows) };
}

function decodeSub(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).sub; } catch { return null; }
}

async function run(env = process.env) {
  for (const k of ['SUPABASE_STAGING_PROJECT_REF', 'SUPABASE_STAGING_URL', 'SUPABASE_STAGING_PUBLISHABLE_KEY', 'SUPABASE_ACCESS_TOKEN', 'STAGING_SYNTHETIC_ACTIVE_EMAIL', 'STAGING_SYNTHETIC_ACTIVE_PASSWORD']) {
    if (!env[k]) throw Object.assign(new Error(`missing ${k}`), { code: 'MISSING_ENV' });
  }
  assertStagingOnly(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_STAGING_URL);
  assertNotProductionUrl(env.SUPABASE_STAGING_URL);
  process.stderr.write(`${maskLine(env.SUPABASE_ACCESS_TOKEN)}\n`);
  const base = env.SUPABASE_STAGING_URL.replace(/\/+$/, '');
  const key = env.SUPABASE_STAGING_PUBLISHABLE_KEY;
  const signIn = await signInSyntheticUser(base, key, env.STAGING_SYNTHETIC_ACTIVE_EMAIL, env.STAGING_SYNTHETIC_ACTIVE_PASSWORD);
  if (!signIn.ok) throw Object.assign(new Error('synthetic sign-in failed'), { code: 'SIGN_IN' });
  const token = signIn.accessToken;
  process.stderr.write(`${maskLine(token)}\n`);
  const userId = decodeSub(token);
  const rest = `${base}/rest/v1`;
  const restHeaders = { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const eliseUrl = `${base}/functions/v1/stylechat-generate`;
  const scanUrl = `${base}/functions/v1/scan-identify`;
  const startIso = new Date(Date.now() - 5_000).toISOString();

  const permission = await fetch(`${rest}/ai_processing_permissions?select=granted,policy_version&user_id=eq.${userId}`, { headers: restHeaders }).then((r) => r.json()).catch(() => null);
  const consent = { granted: Array.isArray(permission) && permission[0]?.granted === true, policyVersion: SHORT(permission?.[0]?.policy_version, 40) };
  if (!consent.granted) throw Object.assign(new Error('synthetic account lacks current AI consent'), { code: 'NOT_GRANTED' });

  const sessionId = crypto.randomUUID();
  await fetch(`${rest}/style_chat_sessions`, { method: 'POST', headers: { ...restHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ id: sessionId, user_id: userId, title: 'K Scan Build 35 feature probe', mode: 'general' }) });

  const scenarios = {};
  const skipped = [];
  let ledger = null;
  try {
    // ── Priority 1–3: OC-01 find → refine → compare, separate HTTP requests, CI-v2 + OC-01 ON ──
    // Mirrors the app's text send: persist the customer's message first (so the
    // server's conversation history holds it), then generate with its id.
    const elise = async (message, headers = CAPABILITY_HEADER) => {
      const saved = await fetch(`${rest}/style_chat_messages`, {
        method: 'POST', headers: { ...restHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({ session_id: sessionId, user_id: userId, sender: 'user', content: message }),
      }).then((r) => r.json()).catch(() => null);
      const sourceMessageId = Array.isArray(saved) && typeof saved[0]?.id === 'string' ? saved[0].id : undefined;
      return call(eliseUrl, key, token, { sessionId, message, requestId: `b35probe-${crypto.randomUUID()}`, ...(sourceMessageId ? { sourceMessageId } : {}) }, headers);
    };
    const t0 = Date.now();
    scenarios.oc01_find = summarizeElise(await elise('Find me a black leather bomber jacket'));
    scenarios.oc01_refine = summarizeElise(await elise('Show me ones in brown instead'));
    scenarios.oc01_compare = summarizeElise(await elise('Compare 1 and 2 for me'));
    scenarios.oc01_window_ms = Date.now() - t0;

    ledger = await settledLedger(env, startIso, 8);
    let remaining = MAX_BILLABLE - ledger.billable;

    // ── Priority 4: Corporate Intelligence v2 voice without retrieval ── (1 expected; keep 3 for Scanner)
    if (remaining >= 1 + 3) {
      scenarios.ci_v2_voice = summarizeElise(await elise('What should I wear to a gallery opening on a chilly November evening?'));
      ledger = await settledLedger(env, startIso, ledger.billable + 1);
      remaining = MAX_BILLABLE - ledger.billable;
    } else skipped.push({ scenario: 'ci_v2_voice', reason: 'BUDGET' });

    // ── Priority 5: Scanner single-item identification (H1/H2) ── (1 Gemini expected)
    if (remaining >= 1) {
      const imageBase64 = fs.readFileSync(FIXTURE).toString('base64');
      scenarios.scanner_single_item = summarizeScan(await call(scanUrl, key, token, { mode: 'image', imageBase64 }));
      ledger = await settledLedger(env, startIso, ledger.billable + 1);
      remaining = MAX_BILLABLE - ledger.billable;
      // ── Priority 6: Mode B commerce continuation (H3/H4) ── (1–2 shopping calls expected)
      const ident = scenarios.scanner_single_item.identification;
      if (remaining >= 2 && scenarios.scanner_single_item.httpStatus === 200 && ident && ident.item_type) {
        const identification = Object.fromEntries(Object.entries(ident).filter(([k]) => !['explanation', 'summary', 'description'].includes(k)));
        scenarios.scanner_commerce = summarizeScan(await call(scanUrl, key, token, { requestMode: 'commerce_only', identification }));
        ledger = await settledLedger(env, startIso, ledger.billable + 1);
      } else skipped.push({ scenario: 'scanner_commerce', reason: remaining < 2 ? 'BUDGET' : 'NO_IDENTIFICATION' });
    } else skipped.push({ scenario: 'scanner_single_item', reason: 'BUDGET' });
  } finally {
    await fetch(`${rest}/style_chat_sessions?id=eq.${sessionId}`, { method: 'DELETE', headers: restHeaders }).catch(() => {});
  }

  const s = scenarios;
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 300) });
  const ready = (x) => x?.commerce?.version === 'oc01-products-v1' && x.commerce.status === 'ready' && x.commerce.products.length > 0;
  add('oc01_find_real_merchant_results', ready(s.oc01_find) && s.oc01_find.commerce.products.every((p) => p.https && p.host),
    JSON.stringify(s.oc01_find?.commerce ? { status: s.oc01_find.commerce.status, n: s.oc01_find.commerce.products.length } : null));
  add('oc01_refine_separate_request', s.oc01_refine?.commerce?.kind === 'refine' && ['ready', 'empty'].includes(s.oc01_refine.commerce.status),
    JSON.stringify(s.oc01_refine?.commerce ? { kind: s.oc01_refine.commerce.kind, status: s.oc01_refine.commerce.status, n: s.oc01_refine.commerce.products.length } : null));
  add('oc01_compare_separate_request', s.oc01_compare?.commerce?.kind === 'compare' && s.oc01_compare.commerce.status === 'ready' && s.oc01_compare.commerce.products.length >= 2,
    JSON.stringify(s.oc01_compare?.commerce ? { status: s.oc01_compare.commerce.status, reason: s.oc01_compare.commerce.reasonCode, n: s.oc01_compare.commerce.products.length } : null));
  add('oc01_within_30s_window', (s.oc01_window_ms ?? Infinity) < 30_000, `${s.oc01_window_ms}ms`);
  add('elise_turns_succeeded', ['oc01_find', 'oc01_refine', 'oc01_compare'].every((k) => s[k]?.httpStatus === 200 && s[k]?.status === 'success' && s[k]?.replyLength > 0),
    ['oc01_find', 'oc01_refine', 'oc01_compare'].map((k) => `${k}:${s[k]?.httpStatus}/${s[k]?.status}`).join(' '));
  add('ci_v2_on_and_validated', (ledger?.ci ?? []).length > 0 && ledger.ci.every((c) => c.flag === 'on' && c.prepared === 'ok'),
    JSON.stringify((ledger?.ci ?? []).map((c) => ({ v: c.validator, origin: c.origin, fb: c.fallbackReason }))));
  add('budget_respected', (ledger?.billable ?? 0) <= MAX_BILLABLE && (ledger?.estimatedUsd ?? 0) <= MAX_USD,
    `billable=${ledger?.billable} usd=${ledger?.estimatedUsd}`);
  if (s.scanner_single_item) {
    add('scanner_single_item_ok', s.scanner_single_item.httpStatus === 200 && s.scanner_single_item.identification.item_type,
      `http=${s.scanner_single_item.httpStatus} item_type=${s.scanner_single_item.identification.item_type}`);
    add('scanner_h1_h2_applied', (ledger?.scanUsage ?? []).some((u) => u.h1 === 'true' && u.h2 === 'true'), JSON.stringify(ledger?.scanUsage ?? []));
  }
  if (s.scanner_commerce) {
    add('scanner_commerce_ok', s.scanner_commerce.httpStatus === 200, `http=${s.scanner_commerce.httpStatus}`);
  }

  const report = {
    probe: 'build35-feature-live-probe-v1',
    environment: 'staging',
    startedAt: startIso,
    finishedAt: new Date().toISOString(),
    consent,
    scenarios,
    skipped,
    ledger: ledger ? { billable: ledger.billable, breakdown: ledger.breakdown, tokens: ledger.tokens, estimatedUsd: ledger.estimatedUsd, logQueryOk: ledger.logQueryOk } : null,
    telemetry: ledger ? { oc01: ledger.oc01, ci_v2: ledger.ci, oc01_prose: ledger.prose, shopping: ledger.shopping, scanUsage: ledger.scanUsage, vri03Commerce: ledger.vriCommerce, eliseOk: ledger.eliseOk } : null,
    verdict: { pass: checks.every((c) => c.pass), checks },
  };
  assertEvidencePrivacy(report);
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** Zero-spend: summarize the last N days of shopping-provider telemetry already in Staging logs. */
async function serperHistory(env = process.env, days = 7) {
  assertStagingOnly(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_STAGING_URL);
  process.stderr.write(`${maskLine(env.SUPABASE_ACCESS_TOKEN)}
`);
  const out = {};
  for (let d = days - 1; d >= 0; d -= 1) {
    const start = new Date(Date.now() - (d + 1) * 86_400_000).toISOString();
    const end = new Date(Date.now() - d * 86_400_000).toISOString();
    const sql = "select timestamp, event_message from logs where source = 'function_logs' and event_message like '%[shopping] provider=%' order by timestamp asc limit 1000";
    const url = new URL(`https://api.supabase.com/v1/projects/${env.SUPABASE_STAGING_PROJECT_REF}/analytics/endpoints/logs`);
    url.searchParams.set('sql', sql);
    url.searchParams.set('iso_timestamp_start', start);
    url.searchParams.set('iso_timestamp_end', end);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } });
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    const rows = Array.isArray(body?.result) ? body.result : [];
    for (const row of rows) {
      const k = kv(String(row.event_message ?? ''));
      const key = `${start.slice(0, 10)}:${k.provider}`;
      const b = (out[key] ??= { calls: 0, ok: 0, timeout: 0, other: 0, latencies: [] });
      b.calls += 1;
      if (k.status === '200') b.ok += 1; else if (k.error === 'timeout') b.timeout += 1; else b.other += 1;
      if (k.status === '200') b.latencies.push(Number(k.latencyMs));
    }
  }
  const summary = Object.fromEntries(Object.entries(out).map(([k, b]) => {
    const l = b.latencies.sort((x, y) => x - y);
    const q = (p) => (l.length ? l[Math.min(l.length - 1, Math.floor(p * l.length))] : null);
    return [k, { calls: b.calls, ok: b.ok, timeout: b.timeout, other: b.other, okLatencyMedianMs: q(0.5), okLatencyMaxMs: l.length ? l[l.length - 1] : null }];
  }));
  const report = { probe: 'build35-serper-history-v1', environment: 'staging', days, summary };
  assertEvidencePrivacy(report);
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}
`);
  return report;
}

if (require.main === module && process.env.PROBE_MODE === 'serper_history') {
  serperHistory().then((r) => process.stdout.write(`${JSON.stringify(r.summary)}
`)).catch((e) => {
    process.stderr.write(`history failed: ${e.code ?? 'ERROR'}
`);
    process.exitCode = 1;
  });
} else if (require.main === module) {
  run().then((r) => {
    process.stdout.write(`verdict=${r.verdict.pass ? 'PASS' : 'FAIL'} billable=${r.ledger?.billable} usd=${r.ledger?.estimatedUsd}\n`);
    process.exitCode = r.verdict.pass ? 0 : 1;
  }).catch((e) => {
    const report = { probe: 'build35-feature-live-probe-v1', environment: 'staging', error: { code: e.code ?? 'ERROR', message: String(e.message).slice(0, 200) } };
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`probe failed: ${report.error.code}\n`);
    process.exitCode = 1;
  });
}

module.exports = { ledgerFrom, summarizeElise, summarizeScan, run };
