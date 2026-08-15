#!/usr/bin/env node
'use strict';

/**
 * Governed S7 Closet Intelligence live probe (staging only).
 *
 * This file is executed only from reviewed default-branch source while the
 * candidate ref is provenance-only. It authenticates as the protected ACTIVE
 * synthetic user, creates bounded RLS-scoped fixtures, invokes the deployed
 * stylechat-generate function, and emits sanitized booleans/counts only.
 * Raw prompts, model replies, Closet metadata, tokens, emails, prices, URLs and
 * retailer fields never enter the report or logs.
 */

const fs = require('node:fs');
const authority = require('../scripts/lib/environment-authority.js');
const {
  assertNotProductionUrl,
  maskLine,
  signInSyntheticUser,
} = require('../scripts/synthetic-auth.js');

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const REPORT_PATH = process.env.S7_REPORT_PATH || 's7-closet-intelligence-probe-report.json';
const RUN = String(process.env.KSCAN_S7_PROBE_RUN_ID || `s7-${process.pid}`).slice(0, 80);
const STAGES = Object.freeze([
  'retrieval',
  'compatibility',
  'wardrobe_gap',
  'purchase_advice',
  'multi_look',
  'rollback_multi',
]);
const FLAG_KEYS = Object.freeze([
  'adviceIntentsV1',
  'closetRetrievalV1',
  'compatibilityScoringV1',
  'wardrobeGapV1',
  'purchaseAdviceV1',
  'multiLookV1',
]);

function expectedCapabilities(stage) {
  const enabledThrough = {
    retrieval: 1,
    compatibility: 2,
    wardrobe_gap: 3,
    purchase_advice: 4,
    multi_look: 5,
    rollback_multi: 4,
  }[stage];
  if (enabledThrough === undefined) throw new Error('UNKNOWN_STAGE');
  return Object.fromEntries(FLAG_KEYS.map((key, index) => [key, index <= enabledThrough]));
}

function exactCapabilities(actual, expected) {
  return actual &&
    FLAG_KEYS.every((key) => typeof actual[key] === 'boolean' && actual[key] === expected[key]) &&
    Object.keys(actual).every((key) => FLAG_KEYS.includes(key));
}

function safeRuntimeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = new Set([
    'adviceIntent',
    'closetInventoryState',
    'ownedClosetCandidateCount',
    'recentScanCandidateCount',
    'compatibilityScoringRan',
    'compatibilityWarningCodes',
    'wardrobeGapEvidence',
    'wardrobeGapCount',
    'purchaseVerdict',
    'purchaseReasonCodes',
    'multiLookCount',
    'multiLookUngroundedCandidateCount',
    'multiLookRepeatedWithinLookCount',
  ]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  return value;
}

function normalizeBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

function restHeaders(key, token, extra) {
  return {
    apikey: key,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

function closetContext(inventoryState, items) {
  return {
    contractVersion: 'closet_intelligence_context_v1',
    inventoryState,
    items: items || [],
  };
}

function closetItem(ref, category, extras) {
  return {
    ref,
    title: `Synthetic ${category}`,
    category,
    primaryColor: 'navy',
    secondaryColors: [],
    materials: ['cotton'],
    ...(extras || {}),
  };
}

function activeFocus(category, color) {
  return {
    source: 'camera',
    visualContext: {
      source: 'scan',
      title: 'Synthetic current item',
      category,
      colors: [color],
      materials: ['cotton'],
      confidence: 0.8,
    },
  };
}

async function jsonResponse(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchUser(ctx) {
  const res = await fetch(`${ctx.base}/auth/v1/user`, {
    headers: restHeaders(ctx.key, ctx.token),
  });
  const body = await jsonResponse(res);
  if (!res.ok || !body?.id) throw Object.assign(new Error('AUTH_USER_FAILED'), { status: res.status });
  return body.id;
}

async function createSession(ctx) {
  const res = await fetch(`${ctx.rest}/style_chat_sessions`, {
    method: 'POST',
    headers: restHeaders(ctx.key, ctx.token, { Prefer: 'return=representation' }),
    body: JSON.stringify({
      user_id: ctx.actorId,
      title: `S7 probe ${RUN}`,
      mode: 'general',
    }),
  });
  const rows = await jsonResponse(res);
  const id = Array.isArray(rows) ? rows[0]?.id : rows?.id;
  if (!res.ok || !id) throw Object.assign(new Error('SESSION_CREATE_FAILED'), { status: res.status });
  return id;
}

async function deleteSession(ctx) {
  if (!ctx.sessionId) return;
  await fetch(`${ctx.rest}/style_chat_sessions?id=eq.${encodeURIComponent(ctx.sessionId)}`, {
    method: 'DELETE',
    headers: restHeaders(ctx.key, ctx.token, { Prefer: 'return=minimal' }),
  }).catch(() => null);
}

async function createRecentScans(ctx, count, withCommerce) {
  const rows = Array.from({ length: count }, (_, index) => ({
    user_id: ctx.actorId,
    local_id: `${RUN}-recent-${index + 1}`,
    title: `RECENT_ONLY_CANARY_${index + 1}`,
    scan_type: 'camera',
    source: 'mobile',
    analysis_result: {
      metadata: {
        category: index % 2 ? 'pants' : 'jacket',
        color_palette: index % 2 ? ['black'] : ['navy'],
        material_estimate: ['cotton'],
      },
    },
    products: withCommerce ? [{ id: 'commerce-canary', retailer: 'Neutral Fixture', price: 99 }] : [],
    purchase_options: withCommerce
      ? [{ retailer: 'Neutral Fixture', price: 99, url: 'https://example.invalid/fixture' }]
      : [],
    metadata: { s7_probe: RUN },
  }));
  const res = await fetch(`${ctx.rest}/saved_scans`, {
    method: 'POST',
    headers: restHeaders(ctx.key, ctx.token, { Prefer: 'return=representation' }),
    body: JSON.stringify(rows),
  });
  const body = await jsonResponse(res);
  if (!res.ok || !Array.isArray(body) || body.length !== count) {
    throw Object.assign(new Error('RECENT_FIXTURE_CREATE_FAILED'), { status: res.status });
  }
  return body.map((row) => row.id).filter(Boolean);
}

async function readRecentCommerce(ctx, id) {
  const res = await fetch(
    `${ctx.rest}/saved_scans?id=eq.${encodeURIComponent(id)}&select=products,purchase_options`,
    { headers: restHeaders(ctx.key, ctx.token) },
  );
  const rows = await jsonResponse(res);
  if (!res.ok || !Array.isArray(rows) || rows.length !== 1) {
    throw Object.assign(new Error('RECENT_FIXTURE_READ_FAILED'), { status: res.status });
  }
  return rows[0];
}

async function softDeleteRecentScans(ctx) {
  if (!ctx.recentIds.length) return;
  const encoded = ctx.recentIds.map((id) => `"${id}"`).join(',');
  await fetch(`${ctx.rest}/saved_scans?id=in.(${encodeURIComponent(encoded)})`, {
    method: 'PATCH',
    headers: restHeaders(ctx.key, ctx.token, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  }).catch(() => null);
}

async function countWearEvents(ctx) {
  const res = await fetch(`${ctx.rest}/wardrobe_wear_events?select=id`, {
    method: 'HEAD',
    headers: restHeaders(ctx.key, ctx.token, { Prefer: 'count=exact' }),
  });
  if (!res.ok) throw Object.assign(new Error('WEAR_COUNT_FAILED'), { status: res.status });
  const range = res.headers.get('content-range') || '*/0';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

async function invoke(ctx, message, context, activeContext) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(`${ctx.base}/functions/v1/stylechat-generate`, {
      method: 'POST',
      headers: restHeaders(ctx.key, ctx.token, { 'x-kscan-s7-probe': '1' }),
      body: JSON.stringify({
        sessionId: ctx.sessionId,
        message,
        closetIntelligenceContext: context,
        ...(activeContext ? { activeContext } : {}),
      }),
    });
    const body = await jsonResponse(res);
    if (res.status === 429 && attempt === 0) {
      const retryAfter = Math.max(1, Math.min(70, Number(res.headers.get('retry-after')) || 60));
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    if (!res.ok || !body || body.status === 'burst_limit' || body.status === 'limit_reached') {
      throw Object.assign(new Error('STYLECHAT_REQUEST_FAILED'), { status: res.status });
    }
    const capabilities = body.closetIntelligenceCapabilities;
    const runtime = safeRuntimeEvidence(body.closetIntelligenceRuntimeEvidence);
    if (!exactCapabilities(capabilities, ctx.expectedCapabilities)) {
      throw new Error('CAPABILITY_STATE_MISMATCH');
    }
    if (!runtime) throw new Error('RUNTIME_EVIDENCE_MISSING');
    return {
      capabilities,
      runtime,
      // Held in memory for behavioral assertions only; never returned/reported.
      text: typeof body.message?.content === 'string' ? body.message.content : '',
    };
  }
  throw new Error('STYLECHAT_REQUEST_FAILED');
}

function assertion(id, passed, detail) {
  return { id, passed: Boolean(passed), detail };
}

async function runRetrieval(ctx) {
  ctx.recentIds = await createRecentScans(ctx, 12, false);
  const historyOnly = await invoke(
    ctx,
    'Build an outfit from my Closet only. Do not shop.',
    closetContext('complete', []),
  );
  const forbiddenOwnership = /(?:you own|already have|your closet).{0,100}recent_only_canary|recent_only_canary.{0,100}(?:you own|already have|your closet)/i;
  const owned = await invoke(
    ctx,
    'Build an outfit from my Closet only. Do not shop.',
    closetContext('complete', [closetItem('closet_1', 'jacket')]),
  );
  await softDeleteRecentScans(ctx);
  const removed = await invoke(
    ctx,
    'Build an outfit from my Closet only. Do not shop.',
    closetContext('complete', []),
  );
  return [
    assertion('RECENT_SCAN_NOT_OWNED_RUNTIME',
      historyOnly.runtime.ownedClosetCandidateCount === 0 &&
      historyOnly.runtime.recentScanCandidateCount === 12 &&
      !forbiddenOwnership.test(historyOnly.text),
      '12 Recent Scans; 0 owned Closet candidates'),
    assertion('COMMITTED_CLOSET_APPEARS_RUNTIME',
      owned.runtime.ownedClosetCandidateCount === 1,
      '1 committed Closet candidate'),
    assertion('CLOSET_REMOVAL_FRESH_RUNTIME',
      removed.runtime.ownedClosetCandidateCount === 0,
      'next request sees 0 committed Closet candidates'),
    assertion('DELETED_RECENT_SCAN_NO_CLOSET_EFFECT_RUNTIME',
      removed.runtime.recentScanCandidateCount === 0 &&
      removed.runtime.ownedClosetCandidateCount === 0,
      'soft-deleted history contributes neither recent nor owned coverage'),
  ];
}

async function runCompatibility(ctx) {
  const result = await invoke(
    ctx,
    'Which items in my Closet work together?',
    closetContext('complete', [
      closetItem('closet_1', 'jacket'),
      closetItem('closet_2', 'pants', { primaryColor: null, materials: [] }),
      closetItem('closet_3', 'shoes', { clothingType: 'jacket', primaryColor: null }),
    ]),
  );
  const warnings = Array.isArray(result.runtime.compatibilityWarningCodes)
    ? result.runtime.compatibilityWarningCodes
    : [];
  return [
    assertion('COMPATIBILITY_RUNTIME',
      result.runtime.compatibilityScoringRan === true,
      'effective compatibility path ran'),
    assertion('COMPATIBILITY_MISSING_FIELDS_RUNTIME',
      warnings.includes('vague_candidate_color'),
      'missing color remained an explicit warning'),
    assertion('COMPATIBILITY_CONTRADICTION_RUNTIME',
      warnings.includes('contradictory_category_metadata'),
      'contradictory category/type degraded to warning'),
    assertion('COMPATIBILITY_NO_FALSE_PRECISION_RUNTIME',
      !/\b(?:compatibility|confidence|score)[^.!?]{0,20}\d+(?:\.\d+)?%/i.test(result.text),
      'model output exposed no compatibility percentage'),
  ];
}

async function runWardrobeGap(ctx) {
  ctx.recentIds = await createRecentScans(ctx, 12, false);
  const partial = await invoke(
    ctx,
    'What am I missing to complete this look?',
    closetContext('partial', [closetItem('closet_1', 'jacket')]),
  );
  const empty = await invoke(
    ctx,
    'What am I missing to complete this look?',
    closetContext('complete', []),
  );
  const unavailable = await invoke(
    ctx,
    'What am I missing to complete this look?',
    closetContext('unavailable', []),
  );
  return [
    assertion('WARDROBE_GAP_PARTIAL_IS_UNKNOWN_RUNTIME',
      partial.runtime.wardrobeGapEvidence === 'insufficient' &&
      partial.runtime.wardrobeGapCount === 0,
      'partial inventory produced insufficient evidence and 0 inferred gaps'),
    assertion('WARDROBE_GAP_EMPTY_IS_COMPLETE_RUNTIME',
      empty.runtime.wardrobeGapEvidence === 'complete' &&
      empty.runtime.wardrobeGapCount > 0,
      'authoritative empty Closet produced complete-snapshot gaps'),
    assertion('WARDROBE_GAP_RECENT_SCAN_NOT_COVERAGE_RUNTIME',
      empty.runtime.recentScanCandidateCount === 12 &&
      empty.runtime.ownedClosetCandidateCount === 0 &&
      empty.runtime.wardrobeGapCount > 0,
      '12 unowned Recent Scans did not inflate Closet coverage'),
    assertion('WARDROBE_GAP_UNAVAILABLE_IS_UNKNOWN_RUNTIME',
      unavailable.runtime.closetInventoryState === 'unavailable' &&
      unavailable.runtime.wardrobeGapEvidence === 'insufficient' &&
      unavailable.runtime.wardrobeGapCount === 0,
      'unavailable device Closet produced insufficient evidence, not empty'),
  ];
}

async function runPurchaseAdvice(ctx) {
  ctx.recentIds = await createRecentScans(ctx, 1, true);
  const commerceBefore = await readRecentCommerce(ctx, ctx.recentIds[0]);
  const wearBefore = await countWearEvents(ctx);
  const result = await invoke(
    ctx,
    'Should I buy this jacket?',
    closetContext('complete', []),
    activeFocus('jacket', 'navy'),
  );
  const commerceAfter = await readRecentCommerce(ctx, ctx.recentIds[0]);
  const wearAfter = await countWearEvents(ctx);
  const textHasFabricatedCommerce = /https?:\/\/|\$\s*\d|\b(?:retailer|store)\s*:\s*\w/i.test(result.text);
  return [
    assertion('PURCHASE_RECENT_SCAN_NOT_OWNED_DUPLICATE_RUNTIME',
      result.runtime.purchaseVerdict !== 'skip' &&
      !result.runtime.purchaseReasonCodes.includes('owned_near_duplicate'),
      'Recent Scan similarity did not suppress purchase as owned'),
    assertion('PURCHASE_NO_INVENTED_COMMERCE_RUNTIME',
      !textHasFabricatedCommerce,
      'no URL, price, or retailer field invented'),
    assertion('PURCHASE_RETAILER_NEUTRAL_RUNTIME',
      result.runtime.purchaseReasonCodes.includes('retailer_neutral'),
      'purchase reasoning remained retailer-neutral'),
    assertion('INTELLIGENCE_DOES_NOT_MUTATE_COMMERCE_RUNTIME',
      JSON.stringify(commerceBefore) === JSON.stringify(commerceAfter),
      'Recent Scan products and purchase_options unchanged'),
    assertion('INTELLIGENCE_DOES_NOT_CREATE_WEAR_RUNTIME',
      wearBefore === wearAfter,
      'wear event count unchanged'),
  ];
}

async function runMultiLook(ctx) {
  const result = await invoke(
    ctx,
    'Give me three ways to style my Closet pieces.',
    closetContext('complete', [
      closetItem('closet_1', 'jacket'),
      closetItem('closet_2', 'shirt', { primaryColor: 'white' }),
      closetItem('closet_3', 'pants', { primaryColor: 'black' }),
      closetItem('closet_4', 'shoes', { primaryColor: 'black' }),
      closetItem('closet_5', 'bag', { primaryColor: 'brown' }),
    ]),
  );
  const afterRemoval = await invoke(
    ctx,
    'Give me three ways to style my Closet pieces.',
    closetContext('complete', [
      closetItem('closet_1', 'jacket'),
      closetItem('closet_2', 'shirt', { primaryColor: 'white' }),
      closetItem('closet_3', 'pants', { primaryColor: 'black' }),
      closetItem('closet_4', 'shoes', { primaryColor: 'black' }),
    ]),
  );
  const insufficient = await invoke(
    ctx,
    'Give me three ways to style my Closet pieces.',
    closetContext('partial', [closetItem('closet_1', 'jacket')]),
  );
  return [
    assertion('MULTI_LOOK_RUNTIME',
      result.runtime.multiLookCount >= 2 && result.runtime.multiLookCount <= 3,
      'generated 2-3 grounded distinct looks'),
    assertion('MULTI_LOOK_NO_INVENTED_OWNERSHIP_RUNTIME',
      result.runtime.ownedClosetCandidateCount === 5 &&
      result.runtime.multiLookUngroundedCandidateCount === 0,
      'all and only 5 supplied Closet candidates were owned'),
    assertion('MULTI_LOOK_DELETED_GARMENT_FRESH_RUNTIME',
      afterRemoval.runtime.ownedClosetCandidateCount === 4 &&
      afterRemoval.runtime.multiLookUngroundedCandidateCount === 0,
      'removed fifth garment was absent on the next grounded request'),
    assertion('MULTI_LOOK_NO_IMPOSSIBLE_REUSE_RUNTIME',
      result.runtime.multiLookRepeatedWithinLookCount === 0 &&
      afterRemoval.runtime.multiLookRepeatedWithinLookCount === 0,
      'no generated look repeated the same Closet item within itself'),
    assertion('MULTI_LOOK_INSUFFICIENT_EVIDENCE_RUNTIME',
      insufficient.runtime.wardrobeGapEvidence === 'insufficient' &&
      insufficient.runtime.multiLookCount === 0,
      'partial Closet state generated no multi-look output'),
  ];
}

async function runRollback(ctx) {
  const result = await invoke(
    ctx,
    'Give me three ways to style my Closet pieces.',
    closetContext('complete', [closetItem('closet_1', 'jacket')]),
  );
  return [assertion(
    'MULTI_LOOK_ROLLBACK_RUNTIME',
    result.capabilities.multiLookV1 === false && result.runtime.multiLookCount === 0,
    'governed rollback readback OFF and runtime produced 0 multi-looks',
  )];
}

async function run() {
  const stage = process.env.KSCAN_S7_PROBE_STAGE || '';
  if (!STAGES.includes(stage)) throw new Error('UNKNOWN_STAGE');
  const projectRef = process.env.SUPABASE_STAGING_PROJECT_REF || '';
  const base = normalizeBase(process.env.SUPABASE_STAGING_URL);
  const key = process.env.SUPABASE_STAGING_PUBLISHABLE_KEY || '';
  const email = process.env.STAGING_SYNTHETIC_ACTIVE_EMAIL || '';
  const password = process.env.STAGING_SYNTHETIC_ACTIVE_PASSWORD || '';
  if (!base || !key || !email || !password) throw new Error('MISSING_STAGING_AUTHORITY');
  if (projectRef !== STAGING_REF || projectRef === PRODUCTION_REF) throw new Error('TARGET_REFUSED');
  authority.assertExpectedEnvironment('staging', projectRef);
  assertNotProductionUrl(base);
  if (!base.includes(projectRef)) throw new Error('TARGET_MISMATCH');

  const auth = await signInSyntheticUser(base, key, email, password);
  if (!auth.ok) throw Object.assign(new Error('SYNTHETIC_AUTH_FAILED'), { status: auth.status });
  console.error(maskLine(auth.accessToken));

  const ctx = {
    stage,
    base,
    rest: `${base}/rest/v1`,
    key,
    token: auth.accessToken,
    actorId: null,
    sessionId: null,
    recentIds: [],
    expectedCapabilities: expectedCapabilities(stage),
  };
  let assertions = [];
  try {
    ctx.actorId = await fetchUser(ctx);
    ctx.sessionId = await createSession(ctx);
    if (stage === 'retrieval') assertions = await runRetrieval(ctx);
    if (stage === 'compatibility') assertions = await runCompatibility(ctx);
    if (stage === 'wardrobe_gap') assertions = await runWardrobeGap(ctx);
    if (stage === 'purchase_advice') assertions = await runPurchaseAdvice(ctx);
    if (stage === 'multi_look') assertions = await runMultiLook(ctx);
    if (stage === 'rollback_multi') assertions = await runRollback(ctx);
  } finally {
    await softDeleteRecentScans(ctx);
    await deleteSession(ctx);
  }

  const report = {
    verdict: assertions.length > 0 && assertions.every((entry) => entry.passed) ? 'PASS' : 'FAIL',
    stage,
    target: 'staging',
    project_ref: projectRef,
    run_id: RUN,
    expected_capabilities: ctx.expectedCapabilities,
    assertions,
  };
  return report;
}

module.exports = {
  STAGES,
  FLAG_KEYS,
  expectedCapabilities,
  exactCapabilities,
  safeRuntimeEvidence,
  closetContext,
  run,
};

if (require.main === module) {
  run()
    .then((report) => {
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({
        verdict: report.verdict,
        stage: report.stage,
        assertions: report.assertions,
      }, null, 2));
      process.exit(report.verdict === 'PASS' ? 0 : 1);
    })
    .catch((error) => {
      const status = Number.isFinite(error?.status) ? ` http=${error.status}` : '';
      console.error(`S7 probe failed: ${error?.message || 'UNKNOWN'}${status}`);
      process.exit(1);
    });
}

