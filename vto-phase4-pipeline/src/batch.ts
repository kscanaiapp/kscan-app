import type { FidelityReferenceHints } from './fidelity';
import { selectBestSourceImage, type ImageCandidateEvaluation } from './imageSelection';
import { persistAsset, type PersistResult } from './assetStore';
import { runPipelineForImage } from './pipeline';
import { loadSourceImage, type LoadResult } from './sourceLoad';
import { explainConfidence } from './confidenceExplain';
import { resolveEligibility } from './eligibility';
import { buildAssetManifest } from './manifestBuilder';
import { groupByVariant } from './variantResolution';
import type { Phase4ProductInput, SystemError } from './types';

export interface BatchItemResult {
  productRef: string;
  variantId: string | null;
  variantAmbiguous: boolean;
  selectedImageRef: string | null;
  evaluatedImages: ImageCandidateEvaluation[];
  manifest: Phase4AssetManifestOrNull;
  /**
   * Gate E certification repair (GATE-E-INT-002, addendum §10-§13): the
   * third terminal state alongside `manifest.eligibility.live2d` and
   * `manifest.rejection`. Exactly one of {eligible, rejected, systemError}
   * holds for every item — `manifest` is null iff `systemError` is set,
   * since a system error means no manifest could be built at all.
   */
  systemError: SystemError | null;
  persistResult: PersistResult | null;
  retryCount: number;
  totalDurationMs: number;
}

// Local alias purely to keep the interface above readable without a second import line.
type Phase4AssetManifestOrNull = import('./types').Phase4AssetManifest | null;

export interface BatchOptions {
  concurrency?: number;
  outputRoot: string;
  hintsByRef?: Map<string, FidelityReferenceHints>;
  maxRetries?: number;
  persist?: boolean;
}

export interface BatchRunResult {
  items: BatchItemResult[];
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
}

/** Bounded-concurrency async pool (task section 41). No distributed infra — a local worker pool is sufficient. */
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Retries only around transient source-acquisition failures — never around
 * a terminal product-level rejection, and never around a deterministic
 * decode/format problem that a retry cannot fix (task section 42; addendum
 * §48 carries this forward for the real-fetch path). `SOURCE_FETCH_FAILED`
 * (network blip, transient upstream 5xx) is always worth one more attempt.
 * `DECODE_FAILED` is retried too, because for an `https-fetch` origin a
 * truncated/corrupted download IS plausibly transient (a fresh GET may
 * succeed); for a `local-fixture` origin this retries pointlessly against
 * the same on-disk bytes (bounded and harmless, matching this function's
 * pre-Phase-4.1 behavior). `UNSUPPORTED_IMAGE_FORMAT` and `INVALID_INPUT`
 * are never retried — the format/shape will not change.
 */
export async function loadWithRetry(
  ref: { ref: string; origin: 'local-fixture' | 'https-fetch' },
  maxRetries: number,
  loader: typeof loadSourceImage = loadSourceImage,
): Promise<{ result: LoadResult; retryCount: number }> {
  let attempt = 0;
  let result = await loader(ref);
  while (
    !result.ok &&
    result.kind === 'systemError' &&
    (result.systemError.code === 'SOURCE_FETCH_FAILED' || result.systemError.code === 'DECODE_FAILED') &&
    attempt < maxRetries
  ) {
    attempt++;
    result = await loader(ref);
  }
  return { result, retryCount: attempt };
}

const EMPTY_CONFIDENCE = { shotClassification: 0, segmentation: 0, anchorCompleteness: 0, geometryValidity: 0, sourceQuality: 0, productFidelity: 0 };
const UNKNOWN_SOURCE_ADEQUACY = { classification: 'UNKNOWN' as const, sourceWidth: 0, sourceHeight: 0, shortSidePx: 0, longSidePx: 0, garmentBoundingWidthPx: null, garmentBoundingHeightPx: null, garmentOccupancyRatio: null, reason: 'item did not reach source decode' };

function systemErrorItem(
  product: { productRef: string; variantId: string | null },
  systemError: SystemError,
  start: number,
  extra: Partial<Pick<BatchItemResult, 'selectedImageRef' | 'evaluatedImages' | 'variantAmbiguous' | 'retryCount'>> = {},
): BatchItemResult {
  return {
    productRef: product.productRef,
    variantId: product.variantId,
    variantAmbiguous: extra.variantAmbiguous ?? false,
    selectedImageRef: extra.selectedImageRef ?? null,
    evaluatedImages: extra.evaluatedImages ?? [],
    manifest: null,
    systemError,
    persistResult: null,
    retryCount: extra.retryCount ?? 0,
    totalDurationMs: Date.now() - start,
  };
}

/**
 * Minimal shape validation for a product RECORD itself (addendum §11/§20:
 * `INVALID_INPUT`) — checked before grouping so one malformed record can
 * never affect any other record's processing, and never silently vanishes
 * (addendum §14/§15 batch-completeness invariant).
 */
function validateProductInput(p: Phase4ProductInput): string | null {
  if (typeof p.productRef !== 'string' || p.productRef.trim().length === 0) return 'productRef is missing or empty';
  if (!Array.isArray(p.images)) return 'images is not an array';
  return null;
}

export async function runBatch(products: readonly Phase4ProductInput[], options: BatchOptions): Promise<BatchRunResult> {
  const concurrency = options.concurrency ?? 4;
  const maxRetries = options.maxRetries ?? 2;
  const persist = options.persist ?? true;
  const startedAt = new Date().toISOString();
  const batchStart = Date.now();

  const validProducts: Phase4ProductInput[] = [];
  const invalidResults: BatchItemResult[] = [];
  for (const p of products) {
    const problem = validateProductInput(p);
    if (problem) {
      invalidResults.push(
        systemErrorItem(
          { productRef: typeof p?.productRef === 'string' ? p.productRef : '(unknown)', variantId: p?.variantId ?? null },
          { code: 'INVALID_INPUT', message: problem, stage: 'source_acquisition' },
          Date.now(),
        ),
      );
    } else {
      validProducts.push(p);
    }
  }

  const groups = groupByVariant(validProducts);
  const tasks: (() => Promise<BatchItemResult>)[] = [];

  for (const group of groups) {
    if (group.ambiguous) {
      for (const entry of group.entries) {
        tasks.push(() => runIsolated(entry, () => processAmbiguousEntry(entry)));
      }
      continue;
    }

    const byVariant = new Map<string | null, Phase4ProductInput[]>();
    for (const entry of group.entries) {
      const list = byVariant.get(entry.variantId) ?? [];
      list.push(entry);
      byVariant.set(entry.variantId, list);
    }

    for (const [variantId, entries] of byVariant) {
      const representative = { ...entries[0], variantId };
      const images = entries.flatMap((e) => e.images);
      tasks.push(() => runIsolated(representative, () => processVariant(representative, images, options, maxRetries, persist)));
    }
  }

  const items = await runWithConcurrency(tasks, concurrency);
  const finishedAt = new Date().toISOString();

  return { items: [...invalidResults, ...items], startedAt, finishedAt, totalDurationMs: Date.now() - batchStart };
}

/**
 * Per-item isolation (Gate E certification repair GATE-E-INT-002, addendum
 * §10-§13/§A6): wraps a single item's ENTIRE processing — not just source
 * loading — so ANY unexpected throw anywhere in that item's path (pipeline
 * bug, persistence failure, a future defect not anticipated here) becomes
 * a `PIPELINE_EXCEPTION` systemError result for that one item and never
 * propagates to abort the whole batch's `Promise.all` (previously: one
 * throwing item discarded every other item's already-computed result —
 * verified empirically before this repair).
 *
 * Side-effect isolation (addendum §A6): `persistAsset` is only ever called
 * AFTER a full manifest has been computed (see `processVariant` below), so
 * a throw before that point — which is where every realistic failure
 * happens — writes nothing to disk. There is no shared batch-level
 * accumulator or index file that a failed item could partially commit to;
 * `cli.ts` writes `batch-run-report.json` once, after `runBatch` fully
 * returns, from the complete terminal `items` array.
 */
export async function runIsolated(
  product: { productRef: string; variantId: string | null },
  fn: () => Promise<BatchItemResult>,
): Promise<BatchItemResult> {
  const start = Date.now();
  try {
    return await fn();
  } catch (err) {
    return systemErrorItem(product, { code: 'PIPELINE_EXCEPTION', message: (err as Error)?.message ?? String(err), stage: 'source_acquisition' }, start);
  }
}

async function processAmbiguousEntry(entry: Phase4ProductInput): Promise<BatchItemResult> {
  const start = Date.now();
  const firstImage = entry.images[0];
  const loaded = firstImage ? await loadSourceImage(firstImage) : null;

  const rejection = { code: 'VARIANT_AMBIGUOUS' as const, message: `productRef "${entry.productRef}" has multiple non-authoritative variant labels — cannot safely attribute this image to a specific variant`, stage: 'classification' as const };
  const confidenceComponents = { ...EMPTY_CONFIDENCE };

  const manifest = buildAssetManifest({
    productRef: entry.productRef,
    retailer: entry.retailer,
    variantId: entry.variantId,
    category: entry.category,
    evidenceClass: entry.evidenceClass,
    sourceRef: firstImage?.ref ?? 'none',
    sourceSha256: loaded && loaded.ok ? loaded.decoded.sha256 : 'unavailable',
    sourceWidth: loaded && loaded.ok ? loaded.decoded.image.width : 0,
    sourceHeight: loaded && loaded.ok ? loaded.decoded.image.height : 0,
    sourceFormat: loaded && loaded.ok ? loaded.decoded.format : 'png',
    shotClassification: { shotClass: 'UNSUPPORTED', confidence: 0, evidence: { reason: 'variant_ambiguous_skip_classification' } },
    confidenceComponents,
    confidenceExplanation: explainConfidence(confidenceComponents),
    qa: null,
    eligibility: resolveEligibility(confidenceComponents, rejection),
    rejection,
    ksgarment: null,
    anchorEvidence: [],
    stageTimings: [],
    sourceAdequacy: UNKNOWN_SOURCE_ADEQUACY,
  });

  return {
    productRef: entry.productRef,
    variantId: entry.variantId,
    variantAmbiguous: true,
    selectedImageRef: firstImage?.ref ?? null,
    evaluatedImages: [],
    manifest,
    systemError: null,
    persistResult: null,
    retryCount: 0,
    totalDurationMs: Date.now() - start,
  };
}

async function processVariant(
  representative: Phase4ProductInput,
  images: Phase4ProductInput['images'],
  options: BatchOptions,
  maxRetries: number,
  persist: boolean,
): Promise<BatchItemResult> {
  const start = Date.now();
  let retryCount = 0;

  const loadOutcomes: { ref: Phase4ProductInput['images'][number]; result: LoadResult }[] = [];
  for (const ref of images) {
    const { result, retryCount: rc } = await loadWithRetry(ref, maxRetries);
    retryCount += rc;
    loadOutcomes.push({ ref, result });
  }

  const decodedCandidates = loadOutcomes
    .filter((o): o is { ref: Phase4ProductInput['images'][number]; result: Extract<LoadResult, { ok: true }> } => o.result.ok)
    .map((o) => ({ ref: o.ref.ref, decoded: o.result.decoded }));

  if (decodedCandidates.length === 0) {
    // No candidate image decoded. Prefer surfacing a system error over a
    // rejection when both classes are present among the candidates — an
    // engineering-observable failure must never be silently absorbed into
    // a catalog-quality verdict just because a sibling image degraded
    // gracefully (addendum §45: system errors are engineering defects,
    // reported separately, never hidden inside the rejection rate).
    const systemErrorOutcome = loadOutcomes.find((o): o is { ref: Phase4ProductInput['images'][number]; result: Extract<LoadResult, { ok: false; kind: 'systemError' }> } => !o.result.ok && o.result.kind === 'systemError');
    if (systemErrorOutcome || loadOutcomes.length === 0) {
      const systemError: SystemError = systemErrorOutcome
        ? systemErrorOutcome.result.systemError
        : { code: 'SOURCE_FETCH_FAILED', message: 'no candidate images available', stage: 'source_acquisition' };
      return { ...systemErrorItem(representative, systemError, start), retryCount };
    }

    const firstRejected = loadOutcomes.find((o): o is { ref: Phase4ProductInput['images'][number]; result: Extract<LoadResult, { ok: false; kind: 'rejected' }> } => !o.result.ok && o.result.kind === 'rejected');
    const rejection = firstRejected!.result.rejection;
    const confidenceComponents = { ...EMPTY_CONFIDENCE };
    const manifest = buildAssetManifest({
      productRef: representative.productRef,
      retailer: representative.retailer,
      variantId: representative.variantId,
      category: representative.category,
      evidenceClass: representative.evidenceClass,
      sourceRef: images[0]?.ref ?? 'none',
      sourceSha256: 'unavailable',
      sourceWidth: 0,
      sourceHeight: 0,
      sourceFormat: 'png',
      shotClassification: { shotClass: 'UNSUPPORTED', confidence: 0, evidence: {} },
      confidenceComponents,
      confidenceExplanation: explainConfidence(confidenceComponents),
      qa: null,
      eligibility: resolveEligibility(confidenceComponents, rejection),
      rejection,
      ksgarment: null,
      anchorEvidence: [],
      stageTimings: [],
      sourceAdequacy: UNKNOWN_SOURCE_ADEQUACY,
    });
    return { productRef: representative.productRef, variantId: representative.variantId, variantAmbiguous: false, selectedImageRef: null, evaluatedImages: [], manifest, systemError: null, persistResult: null, retryCount, totalDurationMs: Date.now() - start };
  }

  const selection = selectBestSourceImage(decodedCandidates);
  const runResult = runPipelineForImage(representative, selection.selected.ref, selection.selected.decoded, {
    fidelityHints: options.hintsByRef?.get(selection.selected.ref),
  });
  const manifest = runResult.manifest;

  const persistResult = persist ? persistAsset(options.outputRoot, manifest, runResult.texture, runResult.alphaMask) : null;

  return {
    productRef: representative.productRef,
    variantId: representative.variantId,
    variantAmbiguous: false,
    selectedImageRef: selection.selected.ref,
    evaluatedImages: selection.evaluated,
    manifest,
    systemError: null,
    persistResult,
    retryCount,
    totalDurationMs: Date.now() - start,
  };
}
