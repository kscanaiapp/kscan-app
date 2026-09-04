import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBatch, type BatchItemResult } from './batch';
import { applyCorrection, type CorrectionRequest } from './correction';
import { buildGateEReport } from './report';
import { generateSyntheticFixtureSet } from './syntheticFixtures';
import { realAuthorizedFixtureProducts, repoRoot } from './realFixtureCatalog';
import { loadSourceImage } from './sourceLoad';

async function main() {
  const root = repoRoot();
  const generatedOutputRoot = join(root, 'fixtures', 'vto-phase4', 'generated');
  const evidenceRoot = join(root, 'evidence', 'vto-phase4-assets');
  const syntheticInputDir = join(root, 'vto-phase4-pipeline', 'fixtures-input', 'synthetic');

  mkdirSync(generatedOutputRoot, { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });

  console.log('[phase4] generating synthetic fixture set...');
  const synthetic = generateSyntheticFixtureSet(syntheticInputDir);

  console.log('[phase4] loading authorized real fixture catalog...');
  const real = realAuthorizedFixtureProducts();

  const allProducts = [...synthetic.products, ...real];
  console.log(`[phase4] running batch over ${allProducts.length} product records (${synthetic.products.length} synthetic, ${real.length} authorized-fixture)...`);

  const batchResult = await runBatch(allProducts, {
    concurrency: 4,
    outputRoot: generatedOutputRoot,
    hintsByRef: synthetic.hintsByRef,
    persist: true,
  });

  writeFileSync(join(evidenceRoot, 'batch-run-report.json'), JSON.stringify(batchResult, null, 2));

  const gateE = buildGateEReport(batchResult.items);
  writeFileSync(join(evidenceRoot, 'gate-e-economics.json'), JSON.stringify(gateE, null, 2));
  writeFileSync(join(evidenceRoot, 'gate-e-economics.md'), renderGateEMarkdown(gateE, batchResult.items));

  console.log('[phase4] running correction demonstration...');
  runCorrectionDemo(batchResult.items, synthetic.hintsByRef, evidenceRoot);

  console.log('[phase4] done.');
  console.log(`  batch report:    ${join(evidenceRoot, 'batch-run-report.json')}`);
  console.log(`  gate E report:   ${join(evidenceRoot, 'gate-e-economics.md')}`);
  console.log(`  generated assets: ${generatedOutputRoot}`);
}

function runCorrectionDemo(items: BatchItemResult[], hintsByRef: Map<string, import('./fidelity').FidelityReferenceHints>, evidenceRoot: string) {
  const correctionsPath = join(evidenceRoot, 'corrections.jsonl');
  if (!existsSync(correctionsPath)) writeFileSync(correctionsPath, '');

  // Demo 1: a MEDIUM item that classified as EXTRACTION_UNRELIABLE/HARD-adjacent gets a SHOT_CLASS_OVERRIDE retry.
  const hardCandidate = items.find((i) => i.manifest?.rejection?.code === 'OCCLUSION_TOO_HIGH' || i.manifest?.rejection?.code === 'EXTRACTION_UNRELIABLE');
  if (hardCandidate && hardCandidate.selectedImageRef && hardCandidate.manifest) {
    const loaded = loadSourceImage({ ref: hardCandidate.selectedImageRef, origin: 'local-fixture' });
    if (loaded.ok) {
      const productStub = {
        productRef: hardCandidate.productRef,
        retailer: null,
        variantId: hardCandidate.variantId,
        variantAuthoritative: false,
        category: 'top',
        title: null,
        brand: null,
        images: [{ ref: hardCandidate.selectedImageRef, origin: 'local-fixture' as const }],
        evidenceClass: hardCandidate.manifest.evidenceClass,
      };
      const request: CorrectionRequest = {
        type: 'SHOT_CLASS_OVERRIDE',
        reason: 'operator-agent review: verifying whether forcing MEDIUM-path extraction changes the outcome for this HARD-classified source',
        operator: 'automated-agent',
        shotClassOverride: 'MEDIUM',
      };
      const outcome = applyCorrection(hardCandidate.manifest, productStub, hardCandidate.selectedImageRef, loaded.decoded, request);
      appendFileSync(correctionsPath, JSON.stringify(outcome.logEntry) + '\n');
    }
  }

  // Demo 2: an ANCHORS_INCOMPLETE or EXTRACTION_UNRELIABLE item gets an ELIGIBILITY_OVERRIDE (never against a fidelity failure).
  const borderline = items.find((i) => i.manifest?.rejection?.code === 'ANCHORS_INCOMPLETE' || i.manifest?.rejection?.code === 'EXTRACTION_UNRELIABLE');
  if (borderline?.manifest) {
    const request: CorrectionRequest = {
      type: 'ELIGIBILITY_OVERRIDE',
      reason: 'operator-agent review: borderline confidence, manually confirmed garment shape is usable',
      operator: 'automated-agent',
      eligibilityOverrideValue: true,
    };
    const outcome = applyCorrection(borderline.manifest, { productRef: borderline.productRef, retailer: null, variantId: borderline.variantId, variantAuthoritative: false, category: 'top', title: null, brand: null, images: [], evidenceClass: borderline.manifest.evidenceClass }, '', { image: { width: 0, height: 0, data: new Uint8ClampedArray() }, format: 'png', sha256: '', byteLength: 0 }, request);
    appendFileSync(correctionsPath, JSON.stringify(outcome.logEntry) + '\n');
  }

  // Demo 3: attempt (and prove refusal of) an ELIGIBILITY_OVERRIDE against a real PRODUCT_FIDELITY_FAILED, if one exists.
  const fidelityFailure = items.find((i) => i.manifest?.rejection?.code === 'PRODUCT_FIDELITY_FAILED' || i.manifest?.rejection?.code === 'PATTERN_UNRECOVERABLE');
  if (fidelityFailure?.manifest) {
    const request: CorrectionRequest = {
      type: 'ELIGIBILITY_OVERRIDE',
      reason: 'operator-agent review: attempting override to demonstrate the fidelity guard refuses it',
      operator: 'automated-agent',
      eligibilityOverrideValue: true,
    };
    const outcome = applyCorrection(fidelityFailure.manifest, { productRef: fidelityFailure.productRef, retailer: null, variantId: fidelityFailure.variantId, variantAuthoritative: false, category: 'top', title: null, brand: null, images: [], evidenceClass: fidelityFailure.manifest.evidenceClass }, '', { image: { width: 0, height: 0, data: new Uint8ClampedArray() }, format: 'png', sha256: '', byteLength: 0 }, request);
    appendFileSync(correctionsPath, JSON.stringify(outcome.logEntry) + '\n');
  }
}

function renderGateEMarkdown(report: ReturnType<typeof buildGateEReport>, items: BatchItemResult[]): string {
  const lines: string[] = [];
  lines.push('# VTO Phase 4 — Gate E Economics (this session\'s evidence)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Evidence class counts');
  lines.push('```json');
  lines.push(JSON.stringify(report.evidenceClassCounts, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`## Headline (N=${report.totalItems}, ${report.sampleSizeCaveat})`);
  lines.push('');
  lines.push(`- Fully automatic success rate: ${(report.fullyAutomaticSuccessRate * 100).toFixed(1)}% (${report.fullyAutomaticSuccessCount}/${report.totalItems - report.variantAmbiguousCount})`);
  lines.push(`- Rejection rate: ${(report.rejectionRate * 100).toFixed(1)}%`);
  lines.push(`- Variant-ambiguous (excluded from success/rejection rates above): ${report.variantAmbiguousCount}`);
  lines.push(`- Manual correction minutes/SKU: ${report.manualCorrectionMinutes} (see evidence/vto-phase4-assets/corrections.jsonl for automated-agent correction latency, which is NOT human time)`);
  lines.push('');
  lines.push('## Rejection reason distribution');
  lines.push('```json');
  lines.push(JSON.stringify(report.rejectionByCode, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Success rate by shot class');
  lines.push('```json');
  lines.push(JSON.stringify(report.byShotClass, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Success rate by garment family');
  lines.push('```json');
  lines.push(JSON.stringify(report.byGarmentFamily, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Success/rejection by evidence class (never mixed into one distribution above)');
  lines.push('```json');
  lines.push(JSON.stringify(report.byEvidenceClass, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Product fidelity');
  lines.push('```json');
  lines.push(JSON.stringify(report.productFidelity, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Runtime distribution');
  lines.push('```json');
  lines.push(JSON.stringify(report.runtime, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Per-item detail');
  lines.push('| productRef | variantId | evidenceClass | shotClass | eligible | rejection | durationMs |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const item of items) {
    const m = item.manifest;
    lines.push(
      `| ${item.productRef} | ${item.variantId ?? '-'} | ${m?.evidenceClass ?? '-'} | ${m?.shotClassification.shotClass ?? '-'} | ${m?.eligibility.live2d ?? '-'} | ${m?.rejection?.code ?? '-'} | ${item.totalDurationMs} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
