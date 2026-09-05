import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBatch, type BatchItemResult } from './batch';
import { classifyCorrectionTriage } from './correctionTriage';
import { shortSideBucket } from './sourceAdequacy';
import { repoRoot } from './realFixtureCatalog';
import type { Phase4ProductInput, RejectionCode, SystemErrorCode } from './types';

/**
 * Phase 4.1 Gate E real-catalog cohort runner (addendum §24-§29). Owner
 * direction (2026-09-05, addendum §A1): legal/terms documentation is
 * DEFERRED UNTIL BUILD COMPLETION and is explicitly NOT an engineering
 * Gate E blocker for this transient internal-evaluation lane. This is not
 * a claim that rights are affirmatively cleared — see
 * docs/vto-phase4-gate-e-rights.md for the full, unmodified record of what
 * this lane's own review could and could not establish, and the owner
 * direction recorded in docs/vto-phase4-gate-e-results.md.
 *
 * Uses ONLY the existing, already-deployed, already-authorized Commerce
 * path (`product-search-deals`, staging, zero database access — see
 * docs/vto-phase4-gate-e-access-probe.md). No new retailer integration, no
 * scraping, no widened API scope (§8/§24).
 *
 * Transient lifecycle (§19/§34, reaffirmed §A1): FETCH -> LOCAL PROCESSING
 * -> METRICS -> DELETE. `persist: false` means the pipeline's own
 * derived-asset writer (`assetStore.ts`) is never invoked for this run —
 * no texture.png/alpha.png is ever written to disk for any real product,
 * accepted or not. Only numeric evidence (hashes, dimensions, formats,
 * classifications, timings) is written to the committed evidence files;
 * no product title, store name, or raw image URL is committed anywhere.
 */

const STAGING_FUNCTION_URL = 'https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/product-search-deals';

interface QueryStratum {
  visual: string;
  query: string;
}

/** Top-category only (garmentContract.ts: only 'top' maps to a Live template family) — matches docs/vto-phase4-corpus-request.md's own recommendation to concentrate on top-category products. */
const QUERY_STRATA: QueryStratum[] = [
  { visual: 'plain', query: 'mens plain crew neck t-shirt' },
  { visual: 'plain', query: 'womens plain cotton t-shirt' },
  { visual: 'plain', query: 'mens plain v-neck t-shirt' },
  { visual: 'plain', query: 'womens plain fitted tee' },
  { visual: 'logo', query: 'mens graphic logo t-shirt' },
  { visual: 'logo', query: 'womens graphic print tee' },
  { visual: 'logo', query: 'mens brand logo t-shirt' },
  { visual: 'patterned', query: 'mens striped t-shirt' },
  { visual: 'patterned', query: 'womens floral print top' },
  { visual: 'patterned', query: 'mens plaid flannel shirt' },
  { visual: 'dark', query: 'black cotton t-shirt mens' },
  { visual: 'dark', query: 'navy t-shirt womens' },
  { visual: 'light', query: 'white cotton t-shirt womens' },
  { visual: 'light', query: 'cream colored t-shirt mens' },
  { visual: 'softknit', query: 'merino wool crew neck sweater mens' },
  { visual: 'softknit', query: 'cashmere sweater womens' },
  { visual: 'softknit', query: 'knit pullover sweater mens' },
  { visual: 'structured', query: 'oxford button down shirt mens' },
  { visual: 'structured', query: 'poplin blouse womens' },
  { visual: 'structured', query: 'polo shirt mens cotton' },
  { visual: 'structured', query: 'henley shirt mens' },
];

interface RawCommerceProduct {
  product_id?: string;
  product_title?: string;
  store_name?: string;
  product_photos?: string[];
}

async function fetchStratum(anonKey: string, stratum: QueryStratum, limit: number): Promise<{ stratum: QueryStratum; products: RawCommerceProduct[] }> {
  try {
    const res = await fetch(STAGING_FUNCTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${anonKey}`, apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: stratum.query, limit }),
    });
    if (!res.ok) {
      console.error(`[gate-e-cohort] query FAILED (${res.status}): ${stratum.visual}/${stratum.query}`);
      return { stratum, products: [] };
    }
    const json = (await res.json()) as { data?: { products?: RawCommerceProduct[] } };
    return { stratum, products: json.data?.products ?? [] };
  } catch (err) {
    console.error(`[gate-e-cohort] query ERROR: ${stratum.visual}/${stratum.query}: ${(err as Error).message}`);
    return { stratum, products: [] };
  }
}

async function assembleCohort(anonKey: string, targetCount: number): Promise<{ products: Phase4ProductInput[]; visualByRef: Map<string, string>; queryByRef: Map<string, string>; multiPhotoObserved: number }> {
  const seen = new Set<string>();
  const products: Phase4ProductInput[] = [];
  const visualByRef = new Map<string, string>();
  const queryByRef = new Map<string, string>();
  let sequence = 0;
  let multiPhotoObserved = 0;

  for (const stratum of QUERY_STRATA) {
    if (products.length >= targetCount) break;
    const { products: raw } = await fetchStratum(anonKey, stratum, 20);
    for (const p of raw) {
      if (!p.product_id || seen.has(p.product_id)) continue;
      if (!p.product_photos || p.product_photos.length === 0) continue;
      seen.add(p.product_id);
      if (p.product_photos.length > 1) multiPhotoObserved++;
      sequence++;
      const productRef = `real-${String(sequence).padStart(4, '0')}`;
      visualByRef.set(productRef, stratum.visual);
      queryByRef.set(productRef, stratum.query);
      products.push({
        productRef,
        retailer: null, // store_name is not populated by this provider for any observed product (see access-probe doc) — recorded as null rather than fabricated.
        variantId: null,
        variantAuthoritative: false,
        category: 'top',
        title: null, // deliberately NOT carrying the real product title into a record that flows into committed evidence
        brand: null,
        images: [{ ref: p.product_photos[0], origin: 'https-fetch' }],
        evidenceClass: 'READ_ONLY_REAL_PRODUCT',
      });
      if (products.length >= targetCount) break;
    }
    // Small pacing gap between queries — courteous to the shared staging function/upstream provider, not a rate-limit workaround.
    await new Promise((r) => setTimeout(r, 150));
  }

  return { products, visualByRef, queryByRef, multiPhotoObserved };
}

function percentileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function distributionOf(values: number[]) {
  if (values.length === 0) return { count: 0, min: 0, median: 0, p75: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0], median: percentileOf(sorted, 50), p75: percentileOf(sorted, 75), p95: percentileOf(sorted, 95), max: sorted[sorted.length - 1] };
}
function countBy<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

async function main() {
  const anonKey = process.env.GATE_E_STAGING_ANON_KEY;
  if (!anonKey) {
    console.error('[gate-e-cohort] GATE_E_STAGING_ANON_KEY is not set. Refusing to run — no real-product fetch may proceed without an explicit credential in the environment (never hardcoded in source).');
    process.exit(1);
  }
  const targetCount = Number(process.env.GATE_E_COHORT_TARGET ?? 200);

  console.log(`[gate-e-cohort] assembling cohort (target ${targetCount} real products, top category only)...`);
  const { products, visualByRef, queryByRef, multiPhotoObserved } = await assembleCohort(anonKey, targetCount);
  console.log(`[gate-e-cohort] assembled ${products.length} unique real products across ${QUERY_STRATA.length} stratified queries.`);

  const scratchDir = mkdtempSync(join(tmpdir(), 'gate-e-real-cohort-'));
  const startedAt = new Date().toISOString();
  let batchResult;
  try {
    console.log('[gate-e-cohort] running frozen pipeline against real cohort (persist: false — nothing written to disk beyond this scratch dir, deleted below)...');
    batchResult = await runBatch(products, { outputRoot: scratchDir, concurrency: 6, maxRetries: 1, persist: false });
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
  const finishedAt = new Date().toISOString();
  console.log('[gate-e-cohort] batch complete. Building evidence...');

  const items = batchResult.items;
  const totalItems = items.length;
  const eligible = items.filter((i) => i.manifest?.eligibility.live2d === true);
  const rejected = items.filter((i) => i.manifest?.rejection != null);
  const systemErrors = items.filter((i) => i.systemError != null);

  // ── Decode reliability + format distribution (addendum §A12/§18) ──
  const formatAttempted: Record<string, number> = {};
  const formatPassed: Record<string, number> = {};
  const formatFailed: Record<string, number> = {};
  const decodeDurationByFormat: Record<string, number[]> = {};
  for (const item of items) {
    // The format is only knowable post-decode (from the manifest) or, for a DECODE_FAILED/UNSUPPORTED_IMAGE_FORMAT
    // system error, from the systemError's own `format` field when available (AVIF), else unknown.
    if (item.manifest) {
      const fmt = item.manifest.source.format;
      formatAttempted[fmt] = (formatAttempted[fmt] ?? 0) + 1;
      formatPassed[fmt] = (formatPassed[fmt] ?? 0) + 1;
      const acqTiming = item.manifest.stageTimings.find((t) => t.stage === 'source_acquisition');
      if (acqTiming) {
        decodeDurationByFormat[fmt] = decodeDurationByFormat[fmt] ?? [];
        decodeDurationByFormat[fmt].push(acqTiming.durationMs);
      }
    } else if (item.systemError && (item.systemError.code === 'DECODE_FAILED' || item.systemError.code === 'UNSUPPORTED_IMAGE_FORMAT')) {
      const fmt = item.systemError.format ?? 'unknown';
      formatAttempted[fmt] = (formatAttempted[fmt] ?? 0) + 1;
      formatFailed[fmt] = (formatFailed[fmt] ?? 0) + 1;
    }
  }
  const decodeReliability: Record<string, { attempted: number; passed: number; failed: number; passRatePct: number }> = {};
  for (const fmt of new Set([...Object.keys(formatAttempted)])) {
    const attempted = formatAttempted[fmt] ?? 0;
    const passed = formatPassed[fmt] ?? 0;
    const failed = formatFailed[fmt] ?? 0;
    decodeReliability[fmt] = { attempted, passed, failed, passRatePct: attempted > 0 ? Math.round((passed / attempted) * 1000) / 10 : 0 };
  }
  const decodePerformanceByFormat: Record<string, ReturnType<typeof distributionOf>> = {};
  for (const [fmt, durations] of Object.entries(decodeDurationByFormat)) {
    decodePerformanceByFormat[fmt] = distributionOf(durations);
  }

  // ── Shot-class distribution (addendum §A11) ──
  const shotClassCounts = countBy(items.filter((i) => i.manifest).map((i) => i.manifest!.shotClassification.shotClass));

  // ── Rejection / system-error distributions ──
  const rejectionByCode = countBy(rejected.map((i) => i.manifest!.rejection!.code));
  const systemErrorByCode = countBy(systemErrors.map((i) => i.systemError!.code));

  // ── Source resolution as a first-class metric (addendum §A8) ──
  const sourceShortSides = items.filter((i) => i.manifest).map((i) => i.manifest!.sourceAdequacy.shortSidePx);
  const shortSideBucketCounts = countBy(sourceShortSides.map((s) => shortSideBucket(s)));
  const adequacyCounts = countBy(items.filter((i) => i.manifest).map((i) => i.manifest!.sourceAdequacy.classification));

  // ── EASY+MEDIUM vs overall (addendum §25/§A11) ──
  const easyMediumItems = items.filter((i) => i.manifest && (i.manifest.shotClassification.shotClass === 'EASY' || i.manifest.shotClassification.shotClass === 'MEDIUM'));
  const easyMediumEligible = easyMediumItems.filter((i) => i.manifest!.eligibility.live2d === true);

  // ── Correction triage (addendum §A15 — classification only, no minutes) ──
  const triageCounts = countBy(rejected.map((i) => classifyCorrectionTriage(i.manifest!.rejection!.code)));

  // ── Performance (addendum §33) ──
  const totalDurations = items.map((i) => i.totalDurationMs);
  const perStage: Record<string, number[]> = {};
  for (const item of items) {
    if (!item.manifest) continue;
    for (const t of item.manifest.stageTimings) {
      perStage[t.stage] = perStage[t.stage] ?? [];
      perStage[t.stage].push(t.durationMs);
    }
  }
  const perStageDistribution: Record<string, ReturnType<typeof distributionOf>> = {};
  for (const [stage, durations] of Object.entries(perStage)) perStageDistribution[stage] = distributionOf(durations);

  // ── Cohort evidence tier (addendum §A7) ──
  const evidenceTier = totalItems < 50 ? 'INSUFFICIENT_FOR_ECONOMIC_CERTIFICATION' : totalItems < 100 ? 'DIRECTIONAL_REAL_CATALOG_EVIDENCE' : 'ELIGIBLE_FOR_GATE_E_PASS_HOLD_FAIL_CONSIDERATION';

  const visualDistribution = countBy(items.map((i) => visualByRef.get(i.productRef) ?? 'unknown'));

  const summary = {
    schema: 'vto-phase4-gate-e-real-cohort-summary/1',
    generatedAt: finishedAt,
    startedAt,
    legalRightsStatus: 'OWNER DIRECTED TRANSIENT INTERNAL EVALUATION TO PROCEED USING THE EXISTING COMMERCE PATH. FINAL LEGAL/TERMS/RIGHTS REVIEW: DEFERRED TO LAUNCH READINESS. Not a claim rights are affirmatively cleared — see docs/vto-phase4-gate-e-rights.md.',
    cohort: {
      totalReal: totalItems,
      target: targetCount,
      evidenceTier,
      strataQueried: QUERY_STRATA.length,
      multiPhotoProductsObserved: multiPhotoObserved,
      visualDistribution,
    },
    automaticResults: {
      live2dEligible: eligible.length,
      live2dEligiblePct: totalItems ? Math.round((eligible.length / totalItems) * 1000) / 10 : 0,
      rejected: rejected.length,
      rejectedPct: totalItems ? Math.round((rejected.length / totalItems) * 1000) / 10 : 0,
      systemErrors: systemErrors.length,
      systemErrorsPct: totalItems ? Math.round((systemErrors.length / totalItems) * 1000) / 10 : 0,
    },
    easyMediumAutoSuccess: {
      total: easyMediumItems.length,
      eligible: easyMediumEligible.length,
      pct: easyMediumItems.length ? Math.round((easyMediumEligible.length / easyMediumItems.length) * 1000) / 10 : 0,
    },
    shotClassDistribution: shotClassCounts,
    rejectionByCode,
    systemErrorByCode,
    correctionTriage: triageCounts,
    sourceResolution: {
      shortSidePxDistribution: distributionOf(sourceShortSides),
      shortSideBucketCounts,
      sourceAdequacyCounts: adequacyCounts,
    },
    decodeReliability,
    decodePerformanceByFormatMs: decodePerformanceByFormat,
    performance: {
      totalDurationMsDistribution: distributionOf(totalDurations),
      perStageDurationMsDistribution: perStageDistribution,
    },
    retention: {
      sourceImagesTemporarilyProcessed: totalItems,
      sourceImagesRetained: 0,
      sourceImagesDeleted: totalItems,
      derivedMetadataRetained: true,
      derivedAssetsWrittenToDisk: false,
    },
    externalCvOrGenerativeCalls: 0,
  };

  const evidenceRoot = join(repoRoot(), 'evidence', 'vto-phase4-gate-e');
  mkdirSync(evidenceRoot, { recursive: true });

  const resultsLines = items.map((item) => {
    const m = item.manifest;
    return JSON.stringify({
      productRef: item.productRef,
      evidenceClass: 'READ_ONLY_REAL_PRODUCT',
      visualStratum: visualByRef.get(item.productRef) ?? null,
      pipelineVersion: m?.pipelineVersion ?? null,
      sourceHash: m?.source.sha256 ?? null,
      sourceFormat: m?.source.format ?? item.systemError?.format ?? null,
      sourceWidth: m?.source.width ?? null,
      sourceHeight: m?.source.height ?? null,
      shotClass: m?.shotClassification.shotClass ?? null,
      classificationConfidence: m?.shotClassification.confidence ?? null,
      sourceAdequacy: m?.sourceAdequacy ?? null,
      result: m?.eligibility.live2d ? 'LIVE2D_ELIGIBLE' : m?.rejection ? `REJECTED:${m.rejection.code}` : item.systemError ? `SYSTEM_ERROR:${item.systemError.code}` : 'UNKNOWN',
      rejectionReason: m?.rejection?.code ?? null,
      systemError: item.systemError,
      correctionTriage: m?.rejection ? classifyCorrectionTriage(m.rejection.code) : null,
      runtimeMs: { total: item.totalDurationMs, stages: m?.stageTimings ?? [] },
      retryCount: item.retryCount,
    });
  });
  writeFileSync(join(evidenceRoot, 'real-cohort-results.jsonl'), resultsLines.join('\n') + '\n');

  const cohortManifest = {
    schema: 'vto-phase4-gate-e-real-cohort-manifest/1',
    generatedAt: finishedAt,
    cohortFrozen: true,
    cohortSize: totalItems,
    evidenceTier,
    items: items.map((item) => ({
      productRef: item.productRef,
      visualStratum: visualByRef.get(item.productRef) ?? null,
      sourceHash: item.manifest?.source.sha256 ?? null,
      fetchTimestamp: finishedAt,
      pipelineVersion: item.manifest?.pipelineVersion ?? null,
    })),
  };
  writeFileSync(join(evidenceRoot, 'real-cohort-manifest.json'), JSON.stringify(cohortManifest, null, 2));
  writeFileSync(join(evidenceRoot, 'real-cohort-summary.json'), JSON.stringify(summary, null, 2));

  console.log('[gate-e-cohort] done.');
  console.log(`  total real products: ${totalItems}`);
  console.log(`  LIVE2D_ELIGIBLE:     ${eligible.length} (${summary.automaticResults.live2dEligiblePct}%)`);
  console.log(`  REJECTED:            ${rejected.length} (${summary.automaticResults.rejectedPct}%)`);
  console.log(`  SYSTEM_ERROR:        ${systemErrors.length} (${summary.automaticResults.systemErrorsPct}%)`);
  console.log(`  EASY+MEDIUM success: ${summary.easyMediumAutoSuccess.pct}% (${easyMediumEligible.length}/${easyMediumItems.length})`);
  console.log(`  evidence tier:       ${evidenceTier}`);
  console.log(`  evidence written to: ${evidenceRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
