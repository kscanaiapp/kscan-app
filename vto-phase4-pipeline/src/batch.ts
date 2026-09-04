import type { FidelityReferenceHints } from './fidelity';
import { selectBestSourceImage, type ImageCandidateEvaluation } from './imageSelection';
import { persistAsset, type PersistResult } from './assetStore';
import { runPipelineForImage } from './pipeline';
import { loadSourceImage } from './sourceLoad';
import { resolveEligibility } from './eligibility';
import { buildAssetManifest } from './manifestBuilder';
import { groupByVariant } from './variantResolution';
import type { Phase4AssetManifest, Phase4ProductInput } from './types';

export interface BatchItemResult {
  productRef: string;
  variantId: string | null;
  variantAmbiguous: boolean;
  selectedImageRef: string | null;
  evaluatedImages: ImageCandidateEvaluation[];
  manifest: Phase4AssetManifest | null;
  persistResult: PersistResult | null;
  retryCount: number;
  totalDurationMs: number;
}

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
 * Retries only around I/O (source acquisition) — never around a terminal
 * product-level rejection (task section 42). `loadSourceImage` is
 * synchronous (no real network I/O exists in this session — see
 * sourceLoad.ts), so this is a synchronous retry loop; it is exported and
 * exercised directly by an injected always-failing loader in
 * `__tests__/batch.test.ts` to prove the retry-count/bounded-retry
 * behavior without depending on a real flaky filesystem.
 */
export function loadWithRetry(ref: { ref: string; origin: 'local-fixture' }, maxRetries: number, loader: typeof loadSourceImage = loadSourceImage): { result: ReturnType<typeof loadSourceImage>; retryCount: number } {
  let attempt = 0;
  let result = loader(ref);
  while (!result.ok && result.rejection.message.includes('decode failed') && attempt < maxRetries) {
    attempt++;
    result = loader(ref);
  }
  return { result, retryCount: attempt };
}

export async function runBatch(products: readonly Phase4ProductInput[], options: BatchOptions): Promise<BatchRunResult> {
  const concurrency = options.concurrency ?? 4;
  const maxRetries = options.maxRetries ?? 2;
  const persist = options.persist ?? true;
  const startedAt = new Date().toISOString();
  const batchStart = Date.now();

  const groups = groupByVariant(products);
  const tasks: (() => Promise<BatchItemResult>)[] = [];

  for (const group of groups) {
    if (group.ambiguous) {
      for (const entry of group.entries) {
        tasks.push(() => processAmbiguousEntry(entry));
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
      const representative = entries[0];
      const images = entries.flatMap((e) => e.images);
      tasks.push(() => processVariant({ ...representative, variantId }, images, options, maxRetries, persist));
    }
  }

  const items = await runWithConcurrency(tasks, concurrency);
  const finishedAt = new Date().toISOString();

  return { items, startedAt, finishedAt, totalDurationMs: Date.now() - batchStart };
}

async function processAmbiguousEntry(entry: Phase4ProductInput): Promise<BatchItemResult> {
  const start = Date.now();
  const firstImage = entry.images[0];
  const loaded = firstImage ? loadSourceImage(firstImage) : null;

  const rejection = { code: 'VARIANT_AMBIGUOUS' as const, message: `productRef "${entry.productRef}" has multiple non-authoritative variant labels — cannot safely attribute this image to a specific variant`, stage: 'classification' as const };
  const confidenceComponents = { shotClassification: 0, segmentation: 0, anchorCompleteness: 0, geometryValidity: 0, sourceQuality: 0, productFidelity: 0 };

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
    qa: null,
    eligibility: resolveEligibility(confidenceComponents, rejection),
    rejection,
    ksgarment: null,
    anchorEvidence: [],
    stageTimings: [],
  });

  return {
    productRef: entry.productRef,
    variantId: entry.variantId,
    variantAmbiguous: true,
    selectedImageRef: firstImage?.ref ?? null,
    evaluatedImages: [],
    manifest,
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

  const loadOutcomes = images.map((ref) => {
    const { result, retryCount: rc } = loadWithRetry(ref, maxRetries);
    retryCount += rc;
    return { ref, result };
  });

  const decodedCandidates = loadOutcomes.filter((o) => o.result.ok).map((o) => ({ ref: o.ref.ref, decoded: (o.result as { ok: true; decoded: import('./codec').DecodedSource }).decoded }));

  if (decodedCandidates.length === 0) {
    const firstFailure = loadOutcomes[0]?.result as { ok: false; rejection: import('./types').Rejection } | undefined;
    const rejection = firstFailure?.rejection ?? { code: 'SOURCE_INVALID' as const, message: 'no candidate images available', stage: 'source_acquisition' as const };
    const confidenceComponents = { shotClassification: 0, segmentation: 0, anchorCompleteness: 0, geometryValidity: 0, sourceQuality: 0, productFidelity: 0 };
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
      qa: null,
      eligibility: resolveEligibility(confidenceComponents, rejection),
      rejection,
      ksgarment: null,
      anchorEvidence: [],
      stageTimings: [],
    });
    return { productRef: representative.productRef, variantId: representative.variantId, variantAmbiguous: false, selectedImageRef: null, evaluatedImages: [], manifest, persistResult: null, retryCount, totalDurationMs: Date.now() - start };
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
    persistResult,
    retryCount,
    totalDurationMs: Date.now() - start,
  };
}

