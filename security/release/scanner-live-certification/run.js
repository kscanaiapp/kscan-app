#!/usr/bin/env node
'use strict';

/**
 * Governed live Scanner certification runner (Staging only).
 *
 *   node security/release/scanner-live-certification/run.js --phase P1 [--dry-local]
 *
 * Live mode needs the same environment as the existing live probes, plus a typed
 * confirmation. It signs in the EXISTING synthetic accounts (never creates one),
 * masks every token the instant it is received, reads what the campaign has already
 * spent, and refuses to send a request that would breach the owner-approved caps.
 *
 * `--dry-local` runs the identical pipeline against an in-process mock edge on a
 * loopback port: zero credentials, zero network egress, zero cost. It proves the
 * harness mechanics only and its output is labelled as such.
 */

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { createBudget, COMMERCE_ONLY } = require('./lib/budget');
const { assertTarget, createRecorder, LiveEdgeError } = require('./lib/liveEdge');
const { loadCorpus, prepareAll } = require('./lib/fixtures');
const { assertEvidencePrivacy, summarize } = require('./lib/report');
const { decodeJwtSub, mergePrior, readLedger } = require('./lib/campaignUsage');
const phases = require('./lib/phases');
const scoring = require('./lib/scoring');

const CONFIRM_PHRASE = 'RUN-SCANNER-LIVE';
const REPORT_SCHEMA = 'scanner-live-certification-report-1';

const REQUIRED_LIVE_ENV = Object.freeze([
  'SUPABASE_STAGING_PROJECT_REF',
  'SUPABASE_STAGING_URL',
  'SUPABASE_STAGING_PUBLISHABLE_KEY',
  'STAGING_SYNTHETIC_ACTIVE_EMAIL',
  'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
]);

const PHASE_FIXTURES = {
  P1: ['O', 'T', 'D', 'J', 'F', 'A', 'X', 'N'],
  P2: ['O', 'D'],
  P3: ['O', 'D', 'F', 'A', 'N'],
  P4: ['O', 'D'],
  P5: ['O', 'D'],
  P6: ['A', 'D', 'N', 'O'],
  R1: [],
};

class RunnerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

function parseArgs(argv) {
  const args = { phase: null, dryLocal: false, mockFunnelOff: false, mockTimeoutFirst: 0, out: 'scanner-live-certification-report.json', actors: 'A' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--phase') args.phase = argv[++i];
    else if (a === '--dry-local') args.dryLocal = true;
    else if (a === '--mock-funnel-off') args.mockFunnelOff = true;
    else if (a === '--mock-timeout-first') args.mockTimeoutFirst = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--actor') args.actors = argv[++i];
    else throw new RunnerError(`unknown argument ${a}`, 'ARGS');
  }
  if (!args.phase || !PHASE_FIXTURES[args.phase]) {
    throw new RunnerError(`--phase must be one of ${Object.keys(PHASE_FIXTURES).join(', ')}`, 'ARGS');
  }
  if (!['A', 'B'].includes(args.actors)) throw new RunnerError('--actor must be A or B', 'ARGS');
  if ((args.mockFunnelOff || args.mockTimeoutFirst) && !args.dryLocal) throw new RunnerError('--mock-* flags only apply to --dry-local', 'ARGS');
  if (!Number.isInteger(args.mockTimeoutFirst) || args.mockTimeoutFirst < 0) throw new RunnerError('--mock-timeout-first must be a non-negative integer', 'ARGS');
  return args;
}

function intEnv(env, name) {
  if (env[name] === undefined || env[name] === '') return null;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < 0) throw new RunnerError(`${name} must be a non-negative integer`, 'ARGS');
  return n;
}

function explicitPrior(env) {
  const imageMode = intEnv(env, 'PRIOR_IMAGE_MODE');
  const commerceOnly = intEnv(env, 'PRIOR_COMMERCE_ONLY');
  if (imageMode === null || commerceOnly === null) return null;
  return {
    imageMode,
    commerceOnly,
    imageModePerActorToday: { A: intEnv(env, 'PRIOR_ACTOR_A_TODAY') ?? 0, B: intEnv(env, 'PRIOR_ACTOR_B_TODAY') ?? 0 },
  };
}

function latencyOf(entries, predicate) {
  return summarize(entries.filter((e) => e.outcome === 'ok' && predicate(e)).map((e) => e.latencyMs));
}

function collectFindings(results) {
  const out = [];
  for (const r of results) for (const f of r.findings ?? []) out.push({ flow: r.label, ...f });
  return out;
}

/** Aggregate predeclared identification metrics over every identified item. */
function aggregateIdentification(results) {
  const items = results.flatMap((r) => r.items ?? []).filter((i) => i.identificationScore);
  const detections = results.flatMap((r) => {
    if (r.detection?.perPhoto) return r.detection.perPhoto.map((p) => p.detectionScore);
    if (r.detection?.evidence) return [r.detection.evidence.detectionScore];
    return [];
  });
  const frac = (n, d) => (d ? n / d : null);
  const required = detections.reduce((n, d) => n + d.required, 0);
  const requiredDetected = detections.reduce((n, d) => n + d.requiredDetected, 0);
  const fashionPhotos = detections.filter((d) => !d.nonFashion);
  return {
    itemsScored: items.length,
    primaryCategoryCorrect: frac(items.filter((i) => i.identificationScore.categoryCorrect).length, items.length),
    subtypeAcceptable: frac(items.filter((i) => i.identificationScore.subtypeAcceptable).length, items.length),
    primaryColorAcceptable: frac(items.filter((i) => i.identificationScore.colorAcceptable).length, items.length),
    criticalMisidentifications: items.filter((i) => i.identificationScore.critical).map((i) => `${i.imageId}:${i.boundGarmentKey}`),
    ungroundedBrandClaims: items.flatMap((i) => i.identificationScore.ungroundedBrandClaims.map((c) => `${i.imageId}:${i.boundGarmentKey}`)),
    overconfidentWrong: items.filter((i) => i.identificationScore.overconfidentWrong).map((i) => `${i.imageId}:${i.boundGarmentKey}`),
    requiredGarmentRecall: frac(requiredDetected, required),
    extraFalseCandidatesPerFashionPhoto: frac(fashionPhotos.reduce((n, d) => n + d.extraFalseCandidates, 0), fashionPhotos.length),
    nonFashionFalseCandidates: detections.reduce((n, d) => n + d.nonFashionFalseCandidates, 0),
    distractorAsGarment: detections.reduce((n, d) => n + d.distractorAsGarment, 0),
    missedRequired: detections.flatMap((d) => d.missedRequired.map((k) => `${d.imageId}:${k}`)),
    candidateIdentityDrift: items.filter((i) => i.candidateIdentityDrift?.drift).map((i) => i.itemId),
  };
}

function aggregateCommerceFacts(results) {
  const items = results.flatMap((r) => r.items ?? []);
  return {
    itemsWithCommerceRequest: items.filter((i) => i.commerce.requests > 0).length,
    itemsWithOffers: items.filter((i) => i.offers.length > 0).length,
    brokenDestinations: items.reduce((n, i) => n + i.offers.filter((o) => !scoring.destinationValid(o)).length, 0),
    insanePrices: items.reduce((n, i) => n + i.offers.filter((o) => !scoring.priceSane(o)).length, 0),
    duplicateDestinations: items.reduce((n, i) => n + i.offerQuality.duplicateDestinations, 0),
    orderChanged: items.filter((i) => !i.offerOrderPreserved).map((i) => i.itemId),
    precheckIncompatibleTop3: items.filter((i) => i.offerPrecheck.slice(0, 3).some((p) => p.titleIncompatible)).map((i) => `${i.imageId}:${i.boundGarmentKey}`),
    retailerShareTop5: (() => {
      const counts = {};
      let total = 0;
      for (const i of items) for (const o of i.offers.slice(0, 5)) { const k = o.retailer ?? o.destination?.host ?? 'unknown'; counts[k] = (counts[k] ?? 0) + 1; total += 1; }
      return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => [k, total ? Number((n / total).toFixed(3)) : 0]));
    })(),
  };
}

async function runPhase(ctx, phase, results = []) {
  if (phase === 'P1') {
    for (const id of PHASE_FIXTURES.P1) {
      ctx.phaseRef.name = `P1:${id}`;
      results.push(await phases.runPhoto(ctx, id, { label: `P1-${id}` }));
      if (ctx.budget.tripped) break;
    }
  } else if (phase === 'P2') {
    ctx.phaseRef.name = 'P2';
    results.push(await phases.runBatch(ctx, { label: 'P2-two-photo', ids: ['O', 'D'], saveBeforeOffers: true, holdCommerceMs: 6000 }));
  } else if (phase === 'P3') {
    ctx.phaseRef.name = 'P3';
    results.push(await phases.runBatch(ctx, {
      label: 'P3-five-photo', ids: ['O', 'D', 'F', 'A', 'N'], failFirstSelectedFor: 'F', retryFailed: true, holdFirstCommerceMs: 3000,
    }));
  } else if (phase === 'P4') {
    ctx.phaseRef.name = 'P4e';
    results.push(await phases.runBatch(ctx, { label: 'P4e-account-change', ids: ['O', 'D'], holdCommerceMs: 6000, accountChangeAfterMs: 1500, saveAll: false }));
    if (!ctx.budget.tripped) {
      ctx.phaseRef.name = 'P4b';
      results.push(await phases.runBatch(ctx, { label: 'P4b-leave-mid-queue', ids: ['O', 'D'], leaveMidQueue: true }));
    }
  } else if (phase === 'P5') {
    ctx.phaseRef.name = 'P5';
    // Funnel OFF: selected-item answers carry offers inline and no MODE B request exists. The batch path is what ships for several photos.
    results.push(await phases.runBatch(ctx, { label: 'P5-funnel-off-two-photo', ids: ['O', 'D'] }));
  } else if (phase === 'R1') {
    ctx.phaseRef.name = 'R1';
    const source = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'build35', 'scanner', 'evidence', 'P1-report.json'), 'utf8'));
    results.push(await phases.runCommerceReplay(ctx, source));
  } else if (phase === 'P6') {
    for (const id of PHASE_FIXTURES.P6) {
      ctx.phaseRef.name = `P6:${id}`;
      results.push(await phases.runPhoto(ctx, id, { label: `P6-${id}`, identify: id === 'A' || id === 'D' }));
      if (ctx.budget.tripped) break;
    }
  }
  return results;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const corpus = loadCorpus();
  const startedAt = new Date();
  const today = startedAt.toISOString().slice(0, 10);
  const recorder = createRecorder();
  const phaseRef = { name: 'setup' };
  const { prepared, info } = prepareAll(corpus, PHASE_FIXTURES[args.phase]);

  let baseUrl;
  let publishableKey = '';
  let tokens = { A: 'dry-token', B: 'dry-token' };
  let target;
  let mock = null;
  let ledgerBefore = null;
  let subs = {};
  let prior = { imageMode: 0, commerceOnly: 0, imageModePerActorToday: {} };
  let priorSource = 'dry_local_zero';

  if (args.dryLocal) {
    const { createMockEdge } = require('./lib/mockEdge');
    mock = createMockEdge({ corpus, latency: { detection: 15, selected: 15, commerce: 15 }, funnelOff: args.mockFunnelOff, timeoutFirstCommerce: args.mockTimeoutFirst });
    for (const image of corpus.images) {
      const data = prepared.get(`file:///fixtures/${image.file}`);
      if (data) mock.register(String(data).split(',')[1], image);
    }
    baseUrl = await mock.listen();
    target = assertTarget({ baseUrl, projectRef: 'dry-local', allowLoopback: true });
  } else {
    const missing = REQUIRED_LIVE_ENV.filter((name) => !env[name]);
    if (missing.length) throw new RunnerError(`missing environment: ${missing.join(', ')}`, 'ENV');
    if (env.SCANNER_LIVE_CONFIRM !== CONFIRM_PHRASE) {
      throw new RunnerError(`refusing to spend: set SCANNER_LIVE_CONFIRM=${CONFIRM_PHRASE}`, 'CONFIRM');
    }
    baseUrl = env.SUPABASE_STAGING_URL;
    publishableKey = env.SUPABASE_STAGING_PUBLISHABLE_KEY;
    target = assertTarget({ baseUrl, projectRef: env.SUPABASE_STAGING_PROJECT_REF });

    const { signInSyntheticUser, maskLine } = require('../../scripts/synthetic-auth');
    const signIn = async (email, password) => {
      const result = await signInSyntheticUser(baseUrl, publishableKey, email, password);
      if (!result.ok) throw new RunnerError(`synthetic sign-in failed (status ${result.status})`, 'AUTH');
      console.error(maskLine(result.accessToken));
      return result.accessToken;
    };
    tokens = {};
    tokens.A = await signIn(env.STAGING_SYNTHETIC_ACTIVE_EMAIL, env.STAGING_SYNTHETIC_ACTIVE_PASSWORD);
    subs.A = decodeJwtSub(tokens.A);
    if (env.STAGING_SYNTHETIC_ACTIVE_B_EMAIL && env.STAGING_SYNTHETIC_ACTIVE_B_PASSWORD) {
      tokens.B = await signIn(env.STAGING_SYNTHETIC_ACTIVE_B_EMAIL, env.STAGING_SYNTHETIC_ACTIVE_B_PASSWORD);
      subs.B = decodeJwtSub(tokens.B);
    }
    if (!tokens[args.actors]) throw new RunnerError(`actor ${args.actors} has no credentials in this environment`, 'ENV');

    const explicit = explicitPrior(env);
    let ledger = { ok: false };
    if (env.SUPABASE_ACCESS_TOKEN && subs.A) {
      console.error(maskLine(env.SUPABASE_ACCESS_TOKEN));
      ledger = await readLedger({
        projectRef: env.SUPABASE_STAGING_PROJECT_REF, managementToken: env.SUPABASE_ACCESS_TOKEN,
        subsByActor: subs, sinceDate: env.CAMPAIGN_SINCE || '2026-10-09', today,
      }).catch(() => ({ ok: false }));
    }
    if (!explicit && !ledger.ok) {
      throw new RunnerError('cannot establish what the campaign has already spent (no explicit PRIOR_* counts and the quota ledger is unreadable); refusing to spend', 'LEDGER');
    }
    const merged = mergePrior(explicit, ledger);
    priorSource = merged.source;
    prior = { imageMode: merged.imageMode, commerceOnly: merged.commerceOnly, imageModePerActorToday: merged.imageModePerActorToday };
    ledgerBefore = ledger.ok ? ledger : null;
  }

  const budget = createBudget({
    limits: {
      imageModeTotal: corpus.budget.imageModeRequestsTotal,
      commerceOnlyTotal: corpus.budget.commerceOnlyRequestsTotal,
      imageModePerActorPerUtcDay: corpus.budget.imageModeRequestsPerActorPerUtcDay,
    },
    prior,
  });

  const ctx = {
    corpus, prepared, imageKeys: null, baseUrl, publishableKey, tokens, budget, recorder, phaseRef, target,
    fetchImpl: fetch,
  };
  ctx.imageKeys = phases.imageKeys(ctx);

  const t0 = performance.now();
  const results = [];
  let aborted = null;
  try {
    await runPhase(ctx, args.phase, results);
  } catch (error) {
    aborted = { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 300) };
  }
  const elapsedMs = Math.round(performance.now() - t0);

  // Post-run reconciliation against the server's own quota ledger (live only).
  let reconciliation = null;
  if (!args.dryLocal && ledgerBefore && env.SUPABASE_ACCESS_TOKEN) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = await readLedger({
      projectRef: env.SUPABASE_STAGING_PROJECT_REF, managementToken: env.SUPABASE_ACCESS_TOKEN,
      subsByActor: subs, sinceDate: env.CAMPAIGN_SINCE || '2026-10-09', today,
    }).catch(() => ({ ok: false }));
    if (after.ok) {
      const snap = budget.snapshot();
      reconciliation = {
        ledgerImageModeDelta: after.imageMode - ledgerBefore.imageMode,
        ledgerCommerceOnlyDelta: after.commerceOnly - ledgerBefore.commerceOnly,
        harnessImageModeSent: snap.usedThisRun.imageMode,
        harnessCommerceOnlySent: snap.usedThisRun.commerceOnly,
      };
      reconciliation.matches = reconciliation.ledgerImageModeDelta === reconciliation.harnessImageModeSent
        && reconciliation.ledgerCommerceOnlyDelta === reconciliation.harnessCommerceOnlySent;
    }
  }

  const entries = recorder.entries;
  const report = {
    schema: REPORT_SCHEMA,
    runMode: args.dryLocal ? 'DRY_LOCAL_MOCK_NOT_EVIDENCE' : 'STAGING_LIVE',
    generatedAt: new Date().toISOString(),
    phase: args.phase,
    actor: args.actors,
    source: { sha: env.GITHUB_SHA ?? null, ref: env.GITHUB_REF_NAME ?? null, runId: env.GITHUB_RUN_ID ?? null },
    thresholdsDigestSource: 'security/release/scanner-live-certification/corpus.json',
    fixtures: info,
    budget: { priorSource, ...budget.snapshot() },
    quotaLedgerReconciliation: reconciliation,
    aborted,
    elapsedMs,
    summary: {
      requests: {
        total: entries.length,
        sent: entries.filter((e) => ['ok', 'http_error', 'network_error', 'aborted'].includes(e.outcome)).length,
        imageMode: entries.filter((e) => e.kind !== COMMERCE_ONLY && ['ok', 'http_error', 'network_error', 'aborted'].includes(e.outcome)).length,
        commerceOnly: entries.filter((e) => e.kind === COMMERCE_ONLY && ['ok', 'http_error', 'network_error', 'aborted'].includes(e.outcome)).length,
        injectedFailures: entries.filter((e) => e.outcome === 'injected_network_error').length,
        budgetRefused: entries.filter((e) => e.outcome === 'budget_refused').length,
        httpErrors: entries.filter((e) => e.outcome === 'http_error').map((e) => ({ seq: e.seq, mode: e.requestMode, status: e.httpStatus })),
      },
      latencyMs: {
        detection: latencyOf(entries, (e) => e.requestMode === phases.DETECTION),
        selectedItem: latencyOf(entries, (e) => e.requestMode === phases.SELECTED),
        commerce: latencyOf(entries, (e) => e.kind === COMMERCE_ONLY),
      },
      identification: aggregateIdentification(results),
      commerceFacts: aggregateCommerceFacts(results),
      findings: collectFindings(results),
    },
    results,
    requestLog: entries.map(({ response, ...rest }) => ({ ...rest, offerCount: response?.offerCount ?? null, responseStatus: response?.status ?? null })),
  };

  assertEvidencePrivacy(report);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  if (mock) await mock.close();
  return { report, outPath };
}

if (require.main === module) {
  main().then(({ report, outPath }) => {
    console.log(`wrote ${outPath}: mode=${report.runMode} phase=${report.phase} sent=${report.summary.requests.sent} aborted=${report.aborted ? 'yes' : 'no'}`);
    process.exit(report.aborted ? 3 : 0);
  }).catch((error) => {
    console.error(`${error?.name ?? 'Error'}: ${error?.message ?? error}`);
    process.exit(error instanceof RunnerError || error instanceof LiveEdgeError ? 2 : 1);
  });
}

module.exports = {
  CONFIRM_PHRASE,
  PHASE_FIXTURES,
  REPORT_SCHEMA,
  RunnerError,
  aggregateCommerceFacts,
  aggregateIdentification,
  main,
  parseArgs,
  runPhase,
};
