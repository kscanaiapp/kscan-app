import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBatch, type BatchItemResult } from './batch';
import { explainConfidence } from './confidenceExplain';
import { ELIGIBILITY_CONFIDENCE_THRESHOLD } from './eligibility';
import { baselineCaseBySha, MANDATORY_EASY_FORENSIC_CASES, PHASE41_EASY_MEDIUM_BASELINE, PREVIOUSLY_ELIGIBLE_CASES } from './phase41Baseline';
import { repoRoot } from './realFixtureCatalog';
import { attributeRejection } from './rejectionAttribution';
import type { Phase4ProductInput } from './types';

/**
 * Phase 4.2 §21/§42/§43/§44/§45 — runs the FULL asset pipeline over the
 * real corpus and produces the repair evidence:
 *
 *   - the §43 pipeline-driven repair rate,
 *   - the §45 previously-eligible regression check,
 *   - the §44 forensic disposition of the four original EASY failures,
 *   - the §20 EXTRACTION_UNRELIABLE cause breakdown.
 *
 * BEFORE/AFTER without checking out old code. The only behavioural change
 * P42-001 made is which component count feeds the segmentation confidence
 * term. Both counts are now recorded on every manifest
 * (`segmentationEvidence`), so the PRE-REPAIR outcome is recomputable
 * exactly, on the same bytes, in the same run — which is a stronger
 * comparison than running two builds against two separately-fetched
 * corpora, since the source imagery is guaranteed identical.
 *
 * The four original EASY cases are re-identified by SOURCE SHA256, not by
 * product ref or URL: refs are run-local and URLs were deliberately never
 * committed. A re-fetched image whose bytes hash to a baseline value IS
 * that case; one that does not, is not. There is no fuzzy matching.
 */

interface CachedCorpus {
  products: { productRef: string; visual: string; imageUrls: string[] }[];
}

function loadCorpus(cachePath: string): CachedCorpus {
  if (!existsSync(cachePath)) {
    console.error('[slice] corpus cache not found at ' + cachePath + '.');
    console.error('[slice] Run `npm run catalog:characterize` with CATALOG_CORPUS_CACHE set to populate it.');
    console.error('[slice] This runner deliberately does NOT query the provider itself: the provider rate limit is a scarce resource (measured: HTTP 429 after ~28 requests), and re-querying for every analysis pass would waste it.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(cachePath, 'utf-8')) as CachedCorpus;
}

/**
 * Recomputes what the PRE-P42-001 pipeline would have concluded for an item,
 * from evidence recorded on the manifest itself.
 */
function preRepairOutcome(item: BatchItemResult): { eligible: boolean; segmentationScore: number } | null {
  const m = item.manifest;
  if (!m || !m.segmentationEvidence) return null;
  const evidence = m.segmentationEvidence;
  const legacySegmentation = Math.max(
    0,
    Math.min(1, evidence.fillRatio * (1 - Math.min(1, (evidence.componentCount - 1) * 0.05))),
  );
  const legacyComponents = { ...m.confidenceComponents, segmentation: legacySegmentation };
  const legacyOverall = explainConfidence(legacyComponents).overall;

  // A stage rejection is unaffected by the confidence term, so it stands.
  const stageRejected = m.rejection !== null && !m.rejection.message.startsWith('overall confidence');
  return {
    eligible: !stageRejected && legacyOverall >= ELIGIBILITY_CONFIDENCE_THRESHOLD,
    segmentationScore: legacySegmentation,
  };
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}
function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

async function main() {
  const cachePath = process.env.CATALOG_CORPUS_CACHE ?? '';
  if (!cachePath) {
    console.error('[slice] CATALOG_CORPUS_CACHE must point at a corpus cache produced by catalog:characterize.');
    process.exit(1);
  }
  const corpus = loadCorpus(cachePath);
  const limit = Number(process.env.SLICE_LIMIT ?? corpus.products.length);
  const concurrency = Number(process.env.SLICE_CONCURRENCY ?? 6);

  const products: Phase4ProductInput[] = corpus.products.slice(0, limit).map((p) => ({
    productRef: p.productRef,
    retailer: null,
    variantId: null,
    variantAuthoritative: false,
    category: 'top',
    title: null,
    brand: null,
    // §11/§12: every authoritative candidate, not just the hero.
    images: p.imageUrls.map((ref) => ({ ref, origin: 'https-fetch' as const })),
    evidenceClass: 'READ_ONLY_REAL_PRODUCT',
  }));
  const visualByRef = new Map(corpus.products.map((p) => [p.productRef, p.visual]));

  console.log('[slice] running the full pipeline over ' + products.length + ' real products (persist: false — no derived asset is written for any real product)...');
  const scratch = mkdtempSync(join(tmpdir(), 'phase42-slice-'));
  let batch;
  try {
    batch = await runBatch(products, { outputRoot: scratch, concurrency, maxRetries: 1, persist: false });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const items = batch.items;
  const withManifest = items.filter((i) => i.manifest !== null);
  const eligible = withManifest.filter((i) => i.manifest!.eligibility.live2d);
  const systemErrors = items.filter((i) => i.systemError !== null);

  const addressable = withManifest.filter((i) => {
    const c = i.manifest!.shotClassification.shotClass;
    return c === 'EASY' || c === 'MEDIUM';
  });
  const addressableEligible = addressable.filter((i) => i.manifest!.eligibility.live2d);

  // ── §42/§43: pipeline-driven repair rate ──
  const rows = items.map((item) => {
    const m = item.manifest;
    const attribution = m ? attributeRejection(m, null) : null;
    const pre = preRepairOutcome(item);
    return {
      productRef: item.productRef,
      visual: visualByRef.get(item.productRef) ?? null,
      sourceSha256: m?.source.sha256 ?? null,
      imageCandidates: item.evaluatedImages.length,
      selectedIsHero: item.evaluatedImages.length <= 1 ? true : null,
      shotClass: m?.shotClassification.shotClass ?? null,
      result: m?.eligibility.live2d
        ? 'LIVE2D_ELIGIBLE'
        : m?.rejection
          ? 'REJECTED:' + m.rejection.code
          : item.systemError
            ? 'SYSTEM_ERROR:' + item.systemError.code
            : 'UNKNOWN',
      rejectionMessage: m?.rejection?.message ?? null,
      limitingComponents: m?.confidenceExplanation.limitingComponents ?? null,
      confidenceComponents: m?.confidenceComponents ?? null,
      overallConfidence: m?.confidenceExplanation.overall ?? null,
      segmentationEvidence: m?.segmentationEvidence ?? null,
      attributionCause: attribution?.cause ?? null,
      attributionGate: attribution?.gate ?? null,
      attribution: attribution?.attribution ?? null,
      attributionRationale: attribution?.rationale ?? null,
      preRepairEligible: pre?.eligible ?? null,
      preRepairSegmentationScore: pre?.segmentationScore ?? null,
      baselineCase: m ? (baselineCaseBySha(m.source.sha256)?.baselineProductRef ?? null) : null,
      totalDurationMs: item.totalDurationMs,
      stageTimings: m?.stageTimings ?? [],
    };
  });

  // The §43 denominator: addressable failures the implementation caused.
  // Measured PRE-repair, so the repair cannot shrink its own denominator.
  const preRepairAddressableFailures = rows.filter(
    (r) => (r.shotClass === 'EASY' || r.shotClass === 'MEDIUM') && r.preRepairEligible === false,
  );
  const pipelineDrivenPreFailures = preRepairAddressableFailures.filter((r) => {
    // A pre-repair failure is pipeline-driven when it either IS now repaired
    // (proving the implementation caused it), or is still failing for a
    // pipeline-owned reason.
    if (r.result === 'LIVE2D_ELIGIBLE') return true;
    return r.attribution === 'PIPELINE_DRIVEN';
  });
  const repaired = pipelineDrivenPreFailures.filter((r) => r.result === 'LIVE2D_ELIGIBLE');

  // ── §45: previously-eligible regression ──
  const previouslyEligibleShas = new Set(PREVIOUSLY_ELIGIBLE_CASES.map((c) => c.sourceSha256));
  const previouslyEligibleFound = rows.filter((r) => r.sourceSha256 && previouslyEligibleShas.has(r.sourceSha256));
  const stillEligible = previouslyEligibleFound.filter((r) => r.result === 'LIVE2D_ELIGIBLE');
  const regressed = previouslyEligibleFound.filter((r) => r.result !== 'LIVE2D_ELIGIBLE');

  // ── §21/§44: the four mandatory EASY forensic cases ──
  const forensics = MANDATORY_EASY_FORENSIC_CASES.map((c) => {
    const row = rows.find((r) => r.sourceSha256 === c.sourceSha256);
    if (!row) {
      return {
        baselineProductRef: c.baselineProductRef,
        sourceSha256: c.sourceSha256,
        phase41Outcome: c.outcome,
        reIdentified: false,
        note: 'Not present in this corpus draw. The source URL was deliberately never committed, so this case can only be re-identified when the same product reappears in a provider query and its bytes hash to the recorded sha256.',
      };
    }
    return {
      baselineProductRef: c.baselineProductRef,
      sourceSha256: c.sourceSha256,
      phase41Outcome: c.outcome,
      reIdentified: true,
      phase42Result: row.result,
      shotClass: row.shotClass,
      confidenceComponents: row.confidenceComponents,
      overallConfidence: row.overallConfidence,
      limitingComponents: row.limitingComponents,
      segmentationEvidence: row.segmentationEvidence,
      attributionCause: row.attributionCause,
      attribution: row.attribution,
      attributionRationale: row.attributionRationale,
      preRepairEligible: row.preRepairEligible,
      preRepairSegmentationScore: row.preRepairSegmentationScore,
      rejectionMessage: row.rejectionMessage,
    };
  });

  // ── §20: EXTRACTION_UNRELIABLE broken down ──
  const extractionUnreliable = rows.filter((r) => r.result === 'REJECTED:EXTRACTION_UNRELIABLE');
  const extractionUnreliableBreakdown = {
    total: extractionUnreliable.length,
    byGate: countBy(extractionUnreliable.map((r) => r.attributionGate ?? 'unknown')),
    byCause: countBy(extractionUnreliable.map((r) => r.attributionCause ?? 'unknown')),
    byShotClass: countBy(extractionUnreliable.map((r) => r.shotClass ?? 'unknown')),
    byAttribution: countBy(extractionUnreliable.map((r) => r.attribution ?? 'unknown')),
  };

  const summary = {
    schema: 'vto-phase4-2-addressable-slice/1',
    generatedAt: new Date().toISOString(),
    corpus: {
      products: products.length,
      corpusCache: cachePath,
      note: 'Same corpus as catalog-characterization; the pipeline is run over it here rather than only characterizing it.',
    },
    boundaries: { productionMutation: false, stagingMutation: false, derivedAssetsWritten: false, externalCvCalls: 0, generativeCalls: 0 },
    terminalAccounting: {
      nIn: products.length,
      nOut: items.length,
      eligible: eligible.length,
      rejected: withManifest.filter((i) => i.manifest!.rejection !== null).length,
      systemErrors: systemErrors.length,
      systemErrorsByCode: countBy(systemErrors.map((i) => i.systemError!.code)),
    },
    shotClassDistribution: countBy(withManifest.map((i) => i.manifest!.shotClassification.shotClass)),
    rejectionByCode: countBy(
      withManifest.filter((i) => i.manifest!.rejection).map((i) => i.manifest!.rejection!.code),
    ),
    addressableSlice: {
      total: addressable.length,
      eligible: addressableEligible.length,
      successPct: pct(addressableEligible.length, addressable.length),
    },
    beforeAfter: {
      note: 'PRE-repair outcomes are recomputed from segmentationEvidence recorded on the same manifests, so both sides are measured on byte-identical sources in one run.',
      preRepairEligible: rows.filter((r) => r.preRepairEligible === true).length,
      postRepairEligible: eligible.length,
      preRepairAddressableEligible: addressable.length - preRepairAddressableFailures.length,
      postRepairAddressableEligible: addressableEligible.length,
    },
    pipelineDrivenRepair: {
      denominatorDefinition:
        'Addressable (EASY/MEDIUM) products that FAILED under the pre-repair pipeline and whose failure is attributable to the implementation (§42). Measured pre-repair so a repair cannot shrink its own denominator.',
      preRepairAddressableFailures: preRepairAddressableFailures.length,
      pipelineDrivenFailures: pipelineDrivenPreFailures.length,
      repairedToEligible: repaired.length,
      repairRatePct: pct(repaired.length, pipelineDrivenPreFailures.length),
      target: 70,
      targetMet: pct(repaired.length, pipelineDrivenPreFailures.length) >= 70,
      stillFailingByCause: countBy(
        pipelineDrivenPreFailures.filter((r) => r.result !== 'LIVE2D_ELIGIBLE').map((r) => r.attributionCause ?? 'unknown'),
      ),
    },
    previouslyEligibleRegression: {
      baselineCount: PREVIOUSLY_ELIGIBLE_CASES.length,
      reIdentifiedInThisCorpus: previouslyEligibleFound.length,
      stillEligible: stillEligible.length,
      regressed: regressed.length,
      regressedRefs: regressed.map((r) => r.baselineCase),
      note: 'Only cases whose source bytes reappear in this corpus draw can be checked. Cases not re-identified are reported as such, never assumed still passing.',
    },
    originalEasyForensics: forensics,
    extractionUnreliableBreakdown,
    attributionDistribution: countBy(rows.map((r) => r.attribution ?? 'none')),
    causeDistribution: countBy(rows.map((r) => r.attributionCause ?? 'none')),
    baselineCoverage: {
      baselineCases: PHASE41_EASY_MEDIUM_BASELINE.length,
      reIdentified: rows.filter((r) => r.baselineCase !== null).length,
    },
    performance: {
      totalDurationMs: batch.totalDurationMs,
      perItemMsMedian: (() => {
        const sorted = items.map((i) => i.totalDurationMs).sort((a, b) => a - b);
        return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      })(),
      perItemMsP95: (() => {
        const sorted = items.map((i) => i.totalDurationMs).sort((a, b) => a - b);
        return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : 0;
      })(),
      concurrency,
    },
  };

  const evidenceRoot = join(repoRoot(), 'evidence', 'vto-phase4-2');
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, 'addressable-slice-summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(evidenceRoot, 'addressable-slice-results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  console.log('');
  console.log('[slice] ── RESULTS ──');
  console.log('  N-in/N-out              : ' + products.length + '/' + items.length);
  console.log('  LIVE2D_ELIGIBLE         : ' + eligible.length + ' (' + pct(eligible.length, items.length) + '%)');
  console.log('  SYSTEM_ERROR            : ' + systemErrors.length);
  console.log('  addressable slice       : ' + addressableEligible.length + '/' + addressable.length + ' (' + summary.addressableSlice.successPct + '%)');
  console.log('  pre-repair addressable  : ' + summary.beforeAfter.preRepairAddressableEligible + '/' + addressable.length);
  console.log('  pipeline-driven repaired: ' + repaired.length + '/' + pipelineDrivenPreFailures.length + ' (' + summary.pipelineDrivenRepair.repairRatePct + '%, target 70%)');
  console.log('  previously eligible     : ' + stillEligible.length + ' still eligible, ' + regressed.length + ' regressed (' + previouslyEligibleFound.length + ' re-identified)');
  console.log('  original EASY forensics : ' + forensics.filter((f) => f.reIdentified).length + '/4 re-identified');
  console.log('  evidence -> ' + evidenceRoot);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
