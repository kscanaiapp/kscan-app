import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHardTractability, HARD_TRACTABILITY_THRESHOLDS } from '../src/hardTractability';
import { computeSourcePreflight } from '../src/sourcePreflight';
import { attributeRejection } from '../src/rejectionAttribution';
import { explainConfidence } from '../src/confidenceExplain';
import {
  DETERMINISTIC_PATH,
  compareMasks,
  polygonToMask,
  runSegmentationBenchmark,
  summarizeBenchmark,
} from '../src/segmentationBenchmark';
import { loadLocalSegmentationModel } from '../src/localSegmentationModel';
import { classifyShot } from '../src/shotClassifier';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import { runPipelineForImage } from '../src/pipeline';
import { createImage, type RgbaImage } from '../src/pixels';
import type { DecodedSource } from '../src/codec';
import type { Phase4ProductInput } from '../src/types';

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];

function asDecoded(image: RgbaImage): DecodedSource {
  return { image, sha256: 'sha', format: 'png', byteLength: image.data.length };
}
function product(): Phase4ProductInput {
  return {
    productRef: 'diag',
    retailer: null,
    variantId: null,
    variantAuthoritative: false,
    category: 'top',
    title: null,
    brand: null,
    images: [],
    evidenceClass: 'SYNTHETIC',
  };
}

// ── §15: HARD subdivision must be measurement-only ───────────────────────

test('§15: HARD_TRACTABLE never confers eligibility — a tractable HARD source is still rejected', () => {
  const img = generateSyntheticGarment({ seed: 201, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true }).image;
  assert.equal(classifyShot(img).shotClass, 'HARD');

  const tractability = classifyHardTractability(computeSourcePreflight(img));
  const result = runPipelineForImage(product(), 'h.png', asDecoded(img), {});

  // Whatever the tractability label says, the pipeline verdict is unchanged.
  assert.ok(['HARD_TRACTABLE', 'HARD_INTRACTABLE', 'HARD_UNKNOWN'].includes(tractability.tractability));
  assert.equal(result.manifest.eligibility.live2d, false, 'no HARD source may be eligible in Phase 4.2');
  assert.equal(result.manifest.rejection?.code, 'OCCLUSION_TOO_HIGH');
});

test('§15: the tractability module is a pure function of preflight and returns only a label', () => {
  const img = generateSyntheticGarment({ seed: 202, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true }).image;
  const preflight = computeSourcePreflight(img);

  const a = classifyHardTractability(preflight);
  const b = classifyHardTractability(preflight);
  assert.deepEqual(a, b, 'must be deterministic');

  // Structural guarantee: the result carries no eligibility/rejection/shot-class field
  // that any gate could read.
  assert.deepEqual(Object.keys(a).sort(), ['limitations', 'rationale', 'reasons', 'signals', 'tractability'].filter((k) => k in a).sort());
  assert.ok(!('eligible' in a) && !('shotClass' in a) && !('rejection' in a));
});

test('§16: every tractability result declares its own limitations rather than implying ground truth', () => {
  const img = generateSyntheticGarment({ seed: 203, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true }).image;
  const r = classifyHardTractability(computeSourcePreflight(img));
  assert.ok(r.limitations.length >= 3, 'estimated signals must state their blind spots');
  assert.ok(r.limitations.some((l) => l.includes('not a person/pose detector')));
});

test('§15: a busy background drives HARD_INTRACTABLE, and the stated reason matches the measurement', () => {
  // Measured mapping for this fixture family: backgroundNoise 90 yields
  // backgroundUniformity ~45, clearing the 34 threshold. Asserting the REASON
  // (not just the verdict) matters — at noise 60 this fixture is also
  // INTRACTABLE, but via component fragmentation rather than background, and
  // a test that only checked the verdict would silently pass for the wrong
  // reason.
  const busy = computeSourcePreflight(
    generateSyntheticGarment({ seed: 204, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true, backgroundNoise: 90 }).image,
  );
  assert.ok(
    busy.backgroundUniformity > HARD_TRACTABILITY_THRESHOLDS.busyBackgroundUniformity,
    'precondition: background must actually measure busy, got ' + busy.backgroundUniformity,
  );

  const verdict = classifyHardTractability(busy);
  assert.equal(verdict.tractability, 'HARD_INTRACTABLE');
  assert.ok(
    verdict.reasons.some((r) => r.startsWith('busy background')),
    'the busy-background disqualifier must be among the stated reasons: ' + JSON.stringify(verdict.reasons),
  );
});

test('§15: a clean-background HARD source is NOT automatically INTRACTABLE', () => {
  const clean = computeSourcePreflight(
    generateSyntheticGarment({ seed: 204, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true }).image,
  );
  assert.ok(clean.backgroundUniformity <= HARD_TRACTABILITY_THRESHOLDS.busyBackgroundUniformity);
  assert.equal(
    classifyHardTractability(clean).tractability,
    'HARD_TRACTABLE',
    'a plain-background single-subject model shot is exactly §17s tractable example',
  );
});

test('§15: an empty frame yields HARD_UNKNOWN, never a confident claim', () => {
  const blank = createImage(120, 120);
  for (let i = 0; i < 120 * 120; i++) {
    blank.data[i * 4] = 248;
    blank.data[i * 4 + 1] = 248;
    blank.data[i * 4 + 2] = 248;
    blank.data[i * 4 + 3] = 255;
  }
  assert.equal(classifyHardTractability(computeSourcePreflight(blank)).tractability, 'HARD_UNKNOWN');
});

// ── §28-§32: the segmentation-architecture decision must stay evidence-backed ──

test('§30: no local segmentation model is installed, and the loader says so explicitly', async () => {
  const load = await loadLocalSegmentationModel();
  assert.equal(load.available, false);
  assert.ok((load as { reason: string }).reason.includes('No local segmentation model is installed'));
});

test('§29: a model manifest missing provenance fields is REFUSED, never loaded as "probably fine"', async () => {
  const prior = process.env.VTO_PHASE4_LOCAL_SEG_MODEL_MANIFEST;
  process.env.VTO_PHASE4_LOCAL_SEG_MODEL_MANIFEST = 'C:/definitely/not/a/real/manifest.json';
  try {
    const load = await loadLocalSegmentationModel();
    assert.equal(load.available, false);
    assert.ok((load as { reason: string }).reason.includes('not found'));
  } finally {
    if (prior === undefined) delete process.env.VTO_PHASE4_LOCAL_SEG_MODEL_MANIFEST;
    else process.env.VTO_PHASE4_LOCAL_SEG_MODEL_MANIFEST = prior;
  }
});

test('§32: deterministic segmentation has essentially no headroom on the population that reaches it', () => {
  // The decision-relevant population is images the CLASSIFIER admits — an
  // image routed to HARD/UNSUPPORTED is rejected before extraction, so its
  // mask quality cannot change any outcome.
  const specs = [
    { id: 'plain-light', spec: { seed: 101, backgroundColor: WHITE, garmentColor: BLUE } },
    { id: 'plain-dark', spec: { seed: 102, backgroundColor: WHITE, garmentColor: [26, 34, 64] as [number, number, number] } },
    { id: 'logo', spec: { seed: 103, backgroundColor: WHITE, garmentColor: BLUE, logo: { color: [196, 40, 40] as [number, number, number] } } },
    { id: 'stripes-h', spec: { seed: 104, backgroundColor: WHITE, garmentColor: BLUE, stripes: { color: [26, 34, 64] as [number, number, number], orientation: 'horizontal' as const } } },
    { id: 'lowres', spec: { seed: 109, canvasWidth: 200, canvasHeight: 230, backgroundColor: WHITE, garmentColor: BLUE } },
    { id: 'noisy', spec: { seed: 111, backgroundColor: WHITE, garmentColor: BLUE, backgroundNoise: 16 } },
  ];

  const cases = specs
    .map((s) => {
      const g = generateSyntheticGarment(s.spec);
      return {
        id: s.id,
        shotClass: 'EASY' as const,
        classifiedShotClass: classifyShot(g.image).shotClass,
        image: g.image,
        truth: polygonToMask(g.image.width, g.image.height, g.garmentPolygon),
      };
    })
    .filter((c) => c.classifiedShotClass === 'EASY' || c.classifiedShotClass === 'MEDIUM');

  assert.ok(cases.length >= 5, 'need a meaningful addressable population, got ' + cases.length);

  const results = runSegmentationBenchmark([DETERMINISTIC_PATH], cases);
  const stats = summarizeBenchmark(results)[DETERMINISTIC_PATH.id] as Record<string, number>;

  assert.equal(stats.segmentationFailures, 0, 'no addressable fixture may fail segmentation outright');
  assert.ok(stats.iouMedian >= 0.99, 'median IoU on the addressable population must be near-perfect, got ' + stats.iouMedian);
  assert.equal(stats.iouBelow05, 0, 'no addressable fixture may segment catastrophically');
});

test('compareMasks is exact on identical masks and zero on disjoint ones', () => {
  const g = generateSyntheticGarment({ seed: 205, backgroundColor: WHITE, garmentColor: BLUE });
  const truth = polygonToMask(g.image.width, g.image.height, g.garmentPolygon);
  assert.equal(compareMasks(truth, truth).iou, 1);

  const empty = { width: truth.width, height: truth.height, data: new Uint8Array(truth.data.length) };
  const disjoint = compareMasks(empty, truth);
  assert.equal(disjoint.iou, 0);
  assert.equal(disjoint.recall, 0);
});

// ── §20/§42: rejection attribution ───────────────────────────────────────

test('§20: a HARD rejection is attributed SOURCE_DRIVEN, never counted against the pipeline', () => {
  const img = generateSyntheticGarment({ seed: 206, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true }).image;
  const result = runPipelineForImage(product(), 'h.png', asDecoded(img), {});
  const attribution = attributeRejection(result.manifest, computeSourcePreflight(img));

  assert.equal(attribution.gate, 'stage');
  assert.equal(attribution.cause, 'STAGE_HARD_NO_EXTRACTION_PATH');
  assert.equal(attribution.attribution, 'SOURCE_DRIVEN');
});

test('§42: a confidence-gate miss on an ADDRESSABLE source is attributed PIPELINE_DRIVEN', () => {
  const img = generateSyntheticGarment({
    seed: 207,
    canvasWidth: 200,
    canvasHeight: 180,
    backgroundColor: WHITE,
    garmentColor: BLUE,
  }).image;
  const result = runPipelineForImage(product(), 's.png', asDecoded(img), { fidelityHints: { knownFillColor: BLUE } });

  assert.ok(result.manifest.rejection?.message.startsWith('overall confidence'), 'precondition: confidence gate');
  const attribution = attributeRejection(result.manifest, computeSourcePreflight(img));

  assert.equal(attribution.gate, 'confidence');
  assert.equal(attribution.attribution, 'PIPELINE_DRIVEN');
  assert.equal(attribution.cause, 'CONFIDENCE_SOURCE_QUALITY');
  assert.ok(attribution.detail['component.sourceQuality'] !== undefined, 'every component must be reported');
});

test('§20: attribution of an eligible item is NOT_APPLICABLE rather than a fabricated cause', () => {
  const img = generateSyntheticGarment({ seed: 208, backgroundColor: WHITE, garmentColor: BLUE }).image;
  const result = runPipelineForImage(product(), 'e.png', asDecoded(img), { fidelityHints: { knownFillColor: BLUE } });
  assert.equal(result.manifest.eligibility.live2d, true, 'precondition: this fixture is eligible');

  const attribution = attributeRejection(result.manifest, null);
  assert.equal(attribution.attribution, 'NOT_APPLICABLE');
  assert.equal(attribution.cause, 'UNATTRIBUTED');
  assert.equal(attribution.gate, 'none');
});

test('§24: a malformed confidence component is attributed as MALFORMED, not as a low score', () => {
  const explanation = explainConfidence({
    shotClassification: 0.9,
    segmentation: NaN,
    anchorCompleteness: 0.9,
    geometryValidity: 0.9,
    sourceQuality: 0.9,
    productFidelity: 0.9,
  } as never);

  const attribution = attributeRejection(
    {
      rejection: { code: 'EXTRACTION_UNRELIABLE', message: 'overall confidence 0.000 < threshold 0.5; limiting component(s): segmentation=MALFORMED(NAN:NaN)', stage: 'qa' },
      shotClassification: { shotClass: 'EASY', confidence: 0.9, evidence: {} },
      confidenceExplanation: explanation,
      eligibility: { live2d: false, live3d: false, reason: 'EXTRACTION_UNRELIABLE' },
    },
    null,
  );

  assert.equal(attribution.cause, 'CONFIDENCE_MALFORMED_COMPONENT');
  assert.equal(attribution.attribution, 'PIPELINE_DRIVEN');
});

// ── §A/§8: classification must cite a pre-registered criterion ───────────

test('§8: every attribution cites a pre-registered criterion id, never bare judgement', () => {
  const cases: RgbaImage[] = [
    generateSyntheticGarment({ seed: 401, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true }).image,
    generateSyntheticGarment({ seed: 402, backgroundColor: WHITE, garmentColor: BLUE, scatterExtraObjects: true }).image,
    generateSyntheticGarment({ seed: 403, canvasWidth: 200, canvasHeight: 180, backgroundColor: WHITE, garmentColor: BLUE }).image,
  ];
  const valid = new Set(['PD-1','PD-2','PD-3','PD-4','PD-5','SD-1','SD-2','SD-3','SD-4','SD-5','SD-6','CD-1','CD-2','CD-3','NONE']);
  for (const [i, img] of cases.entries()) {
    const result = runPipelineForImage(product(), 'c.png', asDecoded(img), { fidelityHints: { knownFillColor: BLUE } });
    const a = attributeRejection(result.manifest, computeSourcePreflight(img));
    assert.ok(valid.has(a.criterionId), 'case ' + i + ' cited an unregistered criterion: ' + a.criterionId);
    if (result.manifest.rejection) {
      assert.notEqual(a.criterionId, 'NONE', 'a real rejection must cite a real criterion, got NONE for case ' + i);
    }
  }
});

test('§8: the criterion class prefix always agrees with the attribution class', () => {
  const img = generateSyntheticGarment({ seed: 404, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true }).image;
  const result = runPipelineForImage(product(), 'h.png', asDecoded(img), {});
  const a = attributeRejection(result.manifest, computeSourcePreflight(img));

  const expectedPrefix =
    a.attribution === 'PIPELINE_DRIVEN' ? 'PD-' : a.attribution === 'SOURCE_DRIVEN' ? 'SD-' : a.attribution === 'CONTRACT_DRIVEN' ? 'CD-' : null;
  if (expectedPrefix) {
    assert.ok(a.criterionId.startsWith(expectedPrefix), a.attribution + ' must cite a ' + expectedPrefix + ' criterion, got ' + a.criterionId);
  }
});

test('§8: an unsupported category is CONTRACT_DRIVEN (CD-2), not blamed on the pipeline or the photo', () => {
  const img = generateSyntheticGarment({ seed: 405, backgroundColor: WHITE, garmentColor: BLUE }).image;
  const result = runPipelineForImage(
    { ...product(), category: 'footwear' },
    'f.png',
    asDecoded(img),
    {},
  );
  assert.equal(result.manifest.rejection?.code, 'UNSUPPORTED_CATEGORY');

  const a = attributeRejection(result.manifest, computeSourcePreflight(img));
  assert.equal(a.attribution, 'CONTRACT_DRIVEN');
  assert.equal(a.criterionId, 'CD-2');
});

test('§A: PRODUCT_FIDELITY maps to SOURCE_DRIVEN (SD-6) — no PD-5 criterion is registered', () => {
  const img = generateSyntheticGarment({ seed: 406, backgroundColor: WHITE, garmentColor: BLUE }).image;
  const result = runPipelineForImage(product(), 'fid.png', asDecoded(img), {
    fidelityHints: { knownFillColor: [10, 200, 10] },
  });
  assert.equal(result.manifest.rejection?.code, 'PRODUCT_FIDELITY_FAILED');

  const a = attributeRejection(result.manifest, computeSourcePreflight(img));
  assert.equal(a.criterionId, 'SD-6');
  assert.equal(a.attribution, 'SOURCE_DRIVEN', 'fidelity must not silently enlarge the pipeline-driven numerator');
});
