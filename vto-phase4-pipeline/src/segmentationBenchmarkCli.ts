import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './realFixtureCatalog';
import {
  DETERMINISTIC_PATH,
  polygonToMask,
  runSegmentationBenchmark,
  summarizeBenchmark,
  type BenchmarkCase,
  type SegmentationPath,
} from './segmentationBenchmark';
import { classifyShot } from './shotClassifier';
import { generateSyntheticGarment, SOFT_KNIT_PRESET, STRUCTURED_PRESET } from './syntheticGarment';
import { loadLocalSegmentationModel } from './localSegmentationModel';

/**
 * Phase 4.2 §28-§34 — runs PATH A (deterministic) and, when one is actually
 * installed, PATH B (a single local model candidate) over ground-truth
 * fixtures and writes the comparison evidence.
 *
 * §31: metrics are computed ONLY where real ground truth exists — the
 * synthetic generator's own garment polygon. No IoU is ever reported for a
 * real product photo, because no ground-truth mask exists for one.
 */

const WHITE: [number, number, number] = [248, 248, 248];
const OFF_WHITE: [number, number, number] = [238, 236, 232];
const LIGHT_GREY: [number, number, number] = [214, 214, 218];
const BLUE: [number, number, number] = [176, 205, 234];
const NAVY: [number, number, number] = [26, 34, 64];
const RED: [number, number, number] = [196, 40, 40];
const CREAM: [number, number, number] = [240, 232, 214];

interface CaseSpec {
  id: string;
  shotClass: 'EASY' | 'MEDIUM' | 'HARD';
  spec: Parameters<typeof generateSyntheticGarment>[0];
}

/**
 * Deliberately spans the same visual strata the real corpus is queried
 * across (plain / logo / patterned / dark / light / soft-knit / structured)
 * plus the nuisance factors measured on real imagery: background noise,
 * tilt, and low resolution.
 */
const CASE_SPECS: CaseSpec[] = [
  { id: 'easy-plain-light', shotClass: 'EASY', spec: { seed: 101, backgroundColor: WHITE, garmentColor: BLUE } },
  { id: 'easy-plain-dark', shotClass: 'EASY', spec: { seed: 102, backgroundColor: WHITE, garmentColor: NAVY } },
  { id: 'easy-logo', shotClass: 'EASY', spec: { seed: 103, backgroundColor: WHITE, garmentColor: BLUE, logo: { color: RED } } },
  { id: 'easy-stripes-h', shotClass: 'EASY', spec: { seed: 104, backgroundColor: WHITE, garmentColor: BLUE, stripes: { color: NAVY, orientation: 'horizontal' } } },
  { id: 'easy-stripes-v', shotClass: 'EASY', spec: { seed: 105, backgroundColor: WHITE, garmentColor: CREAM, stripes: { color: NAVY, orientation: 'vertical' } } },
  { id: 'easy-softknit', shotClass: 'EASY', spec: { seed: 106, backgroundColor: WHITE, garmentColor: CREAM, preset: SOFT_KNIT_PRESET } },
  { id: 'easy-structured', shotClass: 'EASY', spec: { seed: 107, backgroundColor: WHITE, garmentColor: BLUE, preset: STRUCTURED_PRESET } },
  { id: 'easy-offwhite-bg', shotClass: 'EASY', spec: { seed: 108, backgroundColor: OFF_WHITE, garmentColor: NAVY } },
  { id: 'easy-lowres', shotClass: 'EASY', spec: { seed: 109, canvasWidth: 200, canvasHeight: 230, backgroundColor: WHITE, garmentColor: BLUE } },
  { id: 'easy-lightgarment-on-white', shotClass: 'EASY', spec: { seed: 110, backgroundColor: LIGHT_GREY, garmentColor: CREAM } },

  { id: 'medium-noisy-bg', shotClass: 'MEDIUM', spec: { seed: 111, backgroundColor: WHITE, garmentColor: BLUE, backgroundNoise: 16 } },
  { id: 'medium-noisier-bg', shotClass: 'MEDIUM', spec: { seed: 112, backgroundColor: WHITE, garmentColor: NAVY, backgroundNoise: 26 } },
  { id: 'medium-tilt', shotClass: 'MEDIUM', spec: { seed: 113, backgroundColor: WHITE, garmentColor: BLUE, tiltDegrees: 8 } },
  { id: 'medium-tilt-noise', shotClass: 'MEDIUM', spec: { seed: 114, backgroundColor: WHITE, garmentColor: CREAM, tiltDegrees: 6, backgroundNoise: 14 } },
  { id: 'medium-softknit-noise', shotClass: 'MEDIUM', spec: { seed: 115, backgroundColor: OFF_WHITE, garmentColor: CREAM, preset: SOFT_KNIT_PRESET, backgroundNoise: 18 } },

  { id: 'hard-modelworn', shotClass: 'HARD', spec: { seed: 116, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true } },
  { id: 'hard-modelworn-noise', shotClass: 'HARD', spec: { seed: 117, backgroundColor: WHITE, garmentColor: NAVY, addSkinBlob: true, backgroundNoise: 20 } },
];

function buildCases(): BenchmarkCase[] {
  return CASE_SPECS.map((c) => {
    const generated = generateSyntheticGarment(c.spec);
    return {
      id: c.id,
      shotClass: c.shotClass,
      classifiedShotClass: classifyShot(generated.image).shotClass,
      image: generated.image,
      truth: polygonToMask(generated.image.width, generated.image.height, generated.garmentPolygon),
    };
  });
}

async function main() {
  const cases = buildCases();

  const paths: SegmentationPath[] = [DETERMINISTIC_PATH];
  const model = await loadLocalSegmentationModel();
  if (model.available) {
    paths.push(model.path);
    console.log('[seg-bench] PATH B available: ' + model.path.id + ' @ ' + model.path.version);
  } else {
    console.log('[seg-bench] PATH B not installed: ' + model.reason);
  }

  const results = runSegmentationBenchmark(paths, cases);
  const summary = summarizeBenchmark(results);

  // Per shot-class breakdown — the decision (§32) is class-specific, since a
  // model could plausibly win on MEDIUM while being irrelevant on EASY.
  const byClass: Record<string, Record<string, unknown>> = {};
  for (const shotClass of ['EASY', 'MEDIUM', 'HARD']) {
    byClass[shotClass] = summarizeBenchmark(results.filter((r) => r.shotClass === shotClass));
  }

  // THE DECISION-RELEVANT GROUPING (§32). Grouping by the fixture's intent
  // label answers "how good is segmentation on images I meant to be EASY";
  // grouping by the CLASSIFIED class answers "how good is segmentation on
  // the images that actually reach it", which is the only grouping that can
  // justify or reject integrating a second segmentation path. An image the
  // classifier sends to UNSUPPORTED/HARD is already rejected before
  // extraction, so its segmentation quality cannot affect any outcome.
  const byClassifiedClass: Record<string, Record<string, unknown>> = {};
  for (const shotClass of ['EASY', 'MEDIUM', 'HARD', 'UNSUPPORTED']) {
    const subset = results.filter((r) => r.classifiedShotClass === shotClass);
    if (subset.length > 0) byClassifiedClass[shotClass] = summarizeBenchmark(subset);
  }

  // Sanity: confirm the fixtures really do classify the way they are labelled,
  // so a "MEDIUM" row is not silently an EASY image.
  const classifierAgreement = cases.map((c) => ({
    caseId: c.id,
    labelled: c.shotClass,
    classified: classifyShot(c.image).shotClass,
  }));

  const evidence = {
    schema: 'vto-phase4-2-segmentation-benchmark/1',
    generatedAt: new Date().toISOString(),
    groundTruthSource:
      'Synthetic generator garmentPolygon, rasterized with the same fillPolygon that drew the garment. §31: no IoU is computed for real product photos, because no ground-truth mask exists for them (NO_REFERENCE).',
    externalSegmentationCalls: 0,
    pathsEvaluated: paths.map((p) => ({ id: p.id, version: p.version, kind: p.kind })),
    localModel: model.available
      ? model.provenance
      : { installed: false, reason: model.reason },
    overall: summary,
    byIntentLabelShotClass: byClass,
    byClassifiedShotClass: byClassifiedClass,
    addressablePathNote:
      'byClassifiedShotClass EASY+MEDIUM is the decision-relevant population: only images the classifier admits reach segmentation at all. Images classified UNSUPPORTED/HARD are rejected before extraction, so their IoU cannot change any pipeline outcome.',
    classifierAgreement,
    perCase: results,
  };

  const evidenceRoot = join(repoRoot(), 'evidence', 'vto-phase4-2');
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, 'segmentation-benchmark.json'), JSON.stringify(evidence, null, 2));

  console.log('');
  console.log('[seg-bench] ── RESULTS ──');
  for (const [pathId, stats] of Object.entries(summary)) {
    const s = stats as Record<string, number>;
    console.log('  ' + pathId);
    console.log('    cases=' + s.cases + ' segmented=' + s.segmented + ' meanIoU=' + s.meanIou + ' precision=' + s.meanPrecision + ' recall=' + s.meanRecall + ' boundary=' + s.meanBoundaryAgreement + ' meanMs=' + s.meanDurationMs);
  }
  console.log('  ── by CLASSIFIED class (decision-relevant) ──');
  for (const [shotClass, stats] of Object.entries(byClassifiedClass)) {
    console.log('  ' + shotClass + ': ' + JSON.stringify(stats));
  }
  console.log('  evidence -> ' + join(evidenceRoot, 'segmentation-benchmark.json'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
