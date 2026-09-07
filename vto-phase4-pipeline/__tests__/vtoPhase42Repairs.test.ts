import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipelineForImage } from '../src/pipeline';
import { segmentGarment } from '../src/segmentation';
import { classifyShot } from '../src/shotClassifier';
import { computeSourcePreflight } from '../src/sourcePreflight';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import { setPixel, type RgbaImage } from '../src/pixels';
import type { DecodedSource } from '../src/codec';
import type { Phase4ProductInput } from '../src/types';

/**
 * Phase 4.2 — P42-001 regression suite.
 *
 * DEFECT: the `segmentation` confidence component multiplied `fillRatio` by
 * `1 - min(1, (componentCount - 1) * 0.05)`, where `componentCount` counted
 * EVERY connected foreground component including single-pixel speckle from
 * lossy compression. At >= 21 components the penalty saturates and the
 * component becomes EXACTLY 0; because overall confidence is the MIN of the
 * six components, that forced `REJECTED:EXTRACTION_UNRELIABLE` regardless of
 * mask quality.
 *
 * Measured on the real 490-product corpus: 21 of 49 addressable (EASY /
 * MEDIUM) images carried >= 21 components. One had 4487 components with a
 * single SIGNIFICANT one; another had 114 components, 1 significant, and
 * largestComponentRatio 0.9977.
 *
 * The tests below pin BOTH directions: speckle must stop being fatal, and
 * every guarantee that speckle-insensitivity could plausibly have weakened
 * must still hold.
 */

const WHITE_BG: [number, number, number] = [248, 248, 248];
const LIGHT_BLUE: [number, number, number] = [176, 205, 234];

function product(productRef: string): Phase4ProductInput {
  return {
    productRef,
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

function asDecoded(image: RgbaImage): DecodedSource {
  return { image, sha256: 'test-sha-' + image.width + 'x' + image.height, format: 'png', byteLength: image.data.length };
}

/**
 * Sprinkles `count` isolated single-pixel specks onto the BACKGROUND, using
 * a fixed LCG so the fixture is reproducible. This is a faithful stand-in
 * for what lossy WebP/JPEG compression does to a flat studio backdrop: many
 * tiny foreground components, none of them significant, none of them near
 * the garment.
 */
function addBackgroundSpeckle(img: RgbaImage, count: number, seed = 12345): RgbaImage {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < count; i++) {
    // Confine specks to the top band, which the garment polygon never occupies,
    // and space them so they cannot merge into one another (4-connectivity).
    const x = 2 + (next() % Math.floor((img.width - 4) / 3)) * 3;
    const y = 2 + (next() % Math.floor((img.height * 0.18) / 3)) * 3;
    setPixel(img, x, y, 40, 40, 40, 255);
  }
  return img;
}

// ── The defect itself ────────────────────────────────────────────────────

test('P42-001: background speckle produces many components but only one SIGNIFICANT component', () => {
  const clean = generateSyntheticGarment({ seed: 41, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE }).image;
  const speckled = addBackgroundSpeckle(
    generateSyntheticGarment({ seed: 41, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE }).image,
    120,
  );

  const seg = segmentGarment(speckled);
  assert.ok(seg.ok, 'speckled garment must still segment');
  assert.ok(seg.componentCount >= 21, 'fixture must actually reproduce the >=21 component condition, got ' + seg.componentCount);
  assert.equal(seg.significantComponentCount, 1, 'only the garment is a significant component');

  const cleanSeg = segmentGarment(clean);
  assert.ok(cleanSeg.ok);
  assert.equal(cleanSeg.significantComponentCount, 1);
});

test('P42-001 REPAIR: a clean garment with heavy background speckle is LIVE2D_ELIGIBLE', () => {
  const img = addBackgroundSpeckle(
    generateSyntheticGarment({ seed: 42, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE }).image,
    150,
  );
  const result = runPipelineForImage(product('p42-speckle'), 'speckle.png', asDecoded(img), {
    fidelityHints: { knownFillColor: LIGHT_BLUE },
  });

  const seg = segmentGarment(img);
  assert.ok(seg.ok && seg.componentCount >= 21, 'precondition: fixture triggers the old saturation');

  assert.equal(
    result.manifest.eligibility.live2d,
    true,
    'speckle must no longer force rejection — got ' + JSON.stringify(result.manifest.rejection),
  );
  assert.ok(
    result.manifest.confidenceComponents.segmentation > 0,
    'segmentation component must no longer be forced to 0 by speckle',
  );
});

test('P42-001 REPAIR: the old formula would have scored this exact fixture 0 (defect is real, not hypothetical)', () => {
  const img = addBackgroundSpeckle(
    generateSyntheticGarment({ seed: 43, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE }).image,
    150,
  );
  const seg = segmentGarment(img);
  assert.ok(seg.ok);

  const oldFormula = seg.fillRatio * (1 - Math.min(1, (seg.componentCount - 1) * 0.05));
  const newFormula = seg.fillRatio * (1 - Math.min(1, (seg.significantComponentCount - 1) * 0.05));

  assert.equal(oldFormula, 0, 'the pre-repair formula scored this 0');
  assert.ok(newFormula > 0.5, 'the repaired formula reflects the real mask quality, got ' + newFormula);
});

// ── Negative controls: what the repair must NOT have weakened ────────────

test('NEGATIVE CONTROL: a genuine multi-object scene is still penalized / rejected', () => {
  const img = generateSyntheticGarment({
    seed: 44,
    backgroundColor: WHITE_BG,
    garmentColor: LIGHT_BLUE,
    scatterExtraObjects: true,
  }).image;

  const preflight = computeSourcePreflight(img);
  assert.ok(
    preflight.significantComponentCount > 1,
    'precondition: scattered objects must be SIGNIFICANT, not speckle — got ' + preflight.significantComponentCount,
  );

  const result = runPipelineForImage(product('p42-multi'), 'multi.png', asDecoded(img), {
    fidelityHints: { knownFillColor: LIGHT_BLUE },
  });
  assert.equal(result.manifest.eligibility.live2d, false, 'a real multi-object scene must not become eligible');
});

test('NEGATIVE CONTROL (§46): a HARD model-worn source is still rejected and never eligible', () => {
  const img = addBackgroundSpeckle(
    generateSyntheticGarment({ seed: 45, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE, addSkinBlob: true }).image,
    150,
  );
  assert.equal(classifyShot(img).shotClass, 'HARD', 'precondition: fixture must classify HARD');

  const result = runPipelineForImage(product('p42-hard'), 'hard.png', asDecoded(img), {
    fidelityHints: { knownFillColor: LIGHT_BLUE },
  });
  assert.equal(result.manifest.eligibility.live2d, false, 'HARD must remain fail-closed');
  assert.equal(result.manifest.rejection?.code, 'OCCLUSION_TOO_HIGH');
  assert.equal(
    result.manifest.confidenceComponents.segmentation,
    0,
    'HARD never reaches segmentation at all, so speckle-insensitivity cannot reach it',
  );
});

test('NEGATIVE CONTROL: a blank image with speckle only is still rejected (no garment to find)', () => {
  const blank = generateSyntheticGarment({ seed: 46, backgroundColor: WHITE_BG, garmentColor: WHITE_BG }).image;
  const img = addBackgroundSpeckle(blank, 150);

  const result = runPipelineForImage(product('p42-blank'), 'blank.png', asDecoded(img), {});
  assert.equal(result.manifest.eligibility.live2d, false, 'speckle alone must never constitute a garment');
});

test('NEGATIVE CONTROL: the confidence gate still rejects when a NON-segmentation component is the limiter', () => {
  // A deliberately wrong fidelity hint drives productFidelity to 0. The
  // repair must not let a healthy segmentation score mask that.
  const img = generateSyntheticGarment({ seed: 47, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE }).image;
  const result = runPipelineForImage(product('p42-fidelity'), 'fid.png', asDecoded(img), {
    fidelityHints: { knownFillColor: [10, 200, 10] },
  });

  assert.equal(result.manifest.eligibility.live2d, false);
  assert.equal(result.manifest.rejection?.code, 'PRODUCT_FIDELITY_FAILED');
});

// ── §22-§23: the explanation must actually name the limiter ──────────────

test('every rejection carries a confidenceExplanation naming its limiting component', () => {
  const img = generateSyntheticGarment({ seed: 48, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE, addSkinBlob: true }).image;
  const result = runPipelineForImage(product('p42-explain'), 'explain.png', asDecoded(img), {});

  const explanation = result.manifest.confidenceExplanation;
  assert.ok(explanation, 'manifest must carry confidenceExplanation');
  assert.ok(explanation.limitingComponents.length > 0, 'at least one limiting component must be named');
  assert.equal(explanation.components.length, 6, 'all six components must be reported');
  assert.equal(result.manifest.eligibility.live2d, false);
});

test('a confidence-gate rejection message names the component, never a bare aggregate', () => {
  // Drives a genuine CONFIDENCE-GATE rejection (stage 'qa', set only in the
  // eligibility branch) rather than a stage-gate one: at 200x180 every stage
  // passes but `sourceQuality` (a pixel-count proxy) lands at 0.4, under the
  // 0.5 threshold.
  const img = generateSyntheticGarment({
    seed: 49,
    canvasWidth: 200,
    canvasHeight: 180,
    backgroundColor: WHITE_BG,
    garmentColor: LIGHT_BLUE,
  }).image;
  const result = runPipelineForImage(product('p42-small'), 'small.png', asDecoded(img), {
    fidelityHints: { knownFillColor: LIGHT_BLUE },
  });

  const rejection = result.manifest.rejection;
  assert.ok(rejection, 'precondition: this fixture must be rejected');
  assert.equal(rejection.code, 'EXTRACTION_UNRELIABLE');
  assert.ok(
    rejection.message.startsWith('overall confidence'),
    'precondition: must be the CONFIDENCE gate, not a stage gate — got: ' + rejection.message,
  );

  assert.ok(rejection.message.includes('limiting component(s):'), 'must name the limiter: ' + rejection.message);
  assert.ok(rejection.message.includes('sourceQuality='), 'must name the actual limiter and its value: ' + rejection.message);
  assert.deepEqual(result.manifest.confidenceExplanation.limitingComponents, ['sourceQuality']);
});

test('EVERY confidence-gate rejection in a mixed sweep names a real component (no bare aggregate survives)', () => {
  const sizes: [number, number][] = [
    [200, 180],
    [220, 200],
    [180, 170],
    [160, 150],
  ];
  let gateRejections = 0;
  for (const [w, h] of sizes) {
    const img = generateSyntheticGarment({
      seed: 50,
      canvasWidth: w,
      canvasHeight: h,
      backgroundColor: WHITE_BG,
      garmentColor: LIGHT_BLUE,
    }).image;
    const result = runPipelineForImage(product('p42-sweep-' + w), 'sweep.png', asDecoded(img), {
      fidelityHints: { knownFillColor: LIGHT_BLUE },
    });
    const rejection = result.manifest.rejection;
    if (!rejection || !rejection.message.startsWith('overall confidence')) continue;
    gateRejections++;
    assert.ok(rejection.message.includes('limiting component(s):'), w + 'x' + h + ': ' + rejection.message);
    assert.ok(
      /shotClassification=|segmentation=|anchorCompleteness=|geometryValidity=|sourceQuality=|productFidelity=/.test(rejection.message),
      w + 'x' + h + ' must name a real component: ' + rejection.message,
    );
  }
  assert.ok(gateRejections > 0, 'sweep must actually produce at least one confidence-gate rejection');
});
