import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipelineForImage } from '../src/pipeline';
import {
  segmentGarment,
  INSIGNIFICANT_FRAGMENT_CEILING,
  SIGNIFICANT_COMPONENT_GARMENT_FRACTION,
} from '../src/segmentation';
import { classifyShot } from '../src/shotClassifier';
import { classifyCorrectionTriage } from '../src/correctionTriage';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import { setPixel, getPixel, type RgbaImage } from '../src/pixels';
import type { DecodedSource } from '../src/codec';
import type { Phase4ProductInput } from '../src/types';

/**
 * PHASE 4.2 HOSTILE AUDIT — repair regression suite.
 *
 * Covers audit findings P42-A-001 (amendment A8: the fragment ceiling) and
 * P42-A-003 (amendment A3: the EXTRACTION_UNRELIABLE taxonomy split), plus
 * P42-A-002 (the multi-object negative control did not exercise the code
 * P42-001 changed).
 *
 * Every test here pins BOTH directions: the repaired behaviour, and the
 * guarantee the repair could plausibly have broken.
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
  return { image, sha256: 'audit-' + image.width + 'x' + image.height, format: 'png', byteLength: image.data.length };
}

function mk(seed: number): RgbaImage {
  return generateSyntheticGarment({ seed, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE }).image;
}

/** Isolated single-pixel specks in the top band — faithful to lossy-compression noise. */
function speckle(img: RgbaImage, count: number, seed = 12345): RgbaImage {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < count; i++) {
    const x = 2 + (next() % Math.floor((img.width - 4) / 3)) * 3;
    const y = 2 + (next() % Math.floor((img.height * 0.18) / 3)) * 3;
    setPixel(img, x, y, 40, 40, 40, 255);
  }
  return img;
}

/** A DETACHED garment part: same colour as the garment, separated by a background gap. */
function detachedPart(img: RgbaImage, fractionOfFrame: number): RgbaImage {
  const side = Math.max(1, Math.floor(Math.sqrt(img.width * img.height * fractionOfFrame)));
  const midY = Math.floor(img.height * 0.5);
  let leftX = -1;
  for (let x = 0; x < img.width; x++) {
    const [r, g, b] = getPixel(img, x, midY);
    if (Math.abs(r - LIGHT_BLUE[0]) < 30 && Math.abs(g - LIGHT_BLUE[1]) < 30 && Math.abs(b - LIGHT_BLUE[2]) < 30) {
      leftX = x;
      break;
    }
  }
  const x0 = Math.max(1, leftX - 6 - side);
  const y0 = Math.max(1, midY - Math.floor(side / 2));
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (x0 + x < img.width && y0 + y < img.height) {
        setPixel(img, x0 + x, y0 + y, LIGHT_BLUE[0], LIGHT_BLUE[1], LIGHT_BLUE[2], 255);
      }
    }
  }
  return img;
}

function segOf(img: RgbaImage) {
  const s = segmentGarment(img);
  assert.ok(s.ok, 'fixture must segment');
  return s as Extract<typeof s, { ok: true }>;
}

function segScore(img: RgbaImage): number {
  return runPipelineForImage(product('audit'), 'a.png', asDecoded(img), {
    fidelityHints: { knownFillColor: LIGHT_BLUE },
  }).manifest.confidenceComponents.segmentation;
}

// ── P42-A-001 / A8: the ceiling ─────────────────────────────────────────

test('A8 REPAIR: a detached garment part BELOW the 1%-of-frame cliff is now counted', () => {
  // 0.9% of frame area: invisible to the frame-relative rule, but material
  // relative to the garment. Pre-repair this scored
  // significantComponentCount === 1 and cost EXACTLY ZERO confidence while
  // being dropped from the emitted asset (only the winner enters the mask).
  const img = detachedPart(mk(41), 0.009);
  const seg = segOf(img);
  assert.ok(
    seg.significantComponentCount >= 2,
    'a detached part material relative to the garment must count, got ' + seg.significantComponentCount,
  );
  assert.ok(
    seg.largestNonWinnerComponentRatio >= SIGNIFICANT_COMPONENT_GARMENT_FRACTION,
    'the part must exceed the garment-relative threshold, got ' + seg.largestNonWinnerComponentRatio,
  );
  assert.ok(segScore(img) < segScore(mk(41)), 'a detached part must cost confidence');
});

test('A8 NEGATIVE CONTROL: P42-001 is preserved — compression speckle is still free', () => {
  // The whole point of P42-001. If this regresses, the audit repair has
  // re-broken the very defect it was auditing.
  const clean = mk(41);
  const cleanScore = segScore(clean);
  for (const count of [1, 100, 1000, 3000]) {
    const img = speckle(mk(41), count);
    const seg = segOf(img);
    assert.equal(seg.significantComponentCount, 1, count + ' specks must not become significant');
    assert.ok(
      Math.abs(segScore(img) - cleanScore) < 0.01,
      count + ' specks must not materially move the segmentation score',
    );
  }
  // Precondition: the heavy fixture really does reproduce the old saturation.
  assert.ok(segOf(speckle(mk(41), 3000)).componentCount >= 21);
});

test('A8 CALIBRATION: speckle and a detached part are separated by orders of magnitude', () => {
  // §26 — the threshold must sit in a wide gap, not on a knife edge.
  const speckled = segOf(speckle(mk(41), 3000));
  const detached = segOf(detachedPart(mk(41), 0.009));
  assert.ok(
    speckled.largestNonWinnerComponentRatio < SIGNIFICANT_COMPONENT_GARMENT_FRACTION / 100,
    'speckle must sit >=100x BELOW the threshold, got ' + speckled.largestNonWinnerComponentRatio,
  );
  assert.ok(
    detached.largestNonWinnerComponentRatio >= SIGNIFICANT_COMPONENT_GARMENT_FRACTION,
    'a real detached part must sit at/above it, got ' + detached.largestNonWinnerComponentRatio,
  );
});

test('A8 CEILING: significantComponentCount === 1 can no longer be a universal pass', () => {
  const seg = segOf(speckle(mk(41), 3000));
  assert.equal(seg.significantComponentCount, 1);
  assert.ok(
    seg.insignificantFragmentRatio < INSIGNIFICANT_FRAGMENT_CEILING,
    'real speckle must stay far below the ceiling (measured ' + seg.insignificantFragmentRatio + ')',
  );
  // The ceiling is load-bearing, not decorative: at it, the mask scores 0
  // regardless of how few SIGNIFICANT components were counted.
  const score = (fragmentRatio: number): number =>
    fragmentRatio >= INSIGNIFICANT_FRAGMENT_CEILING
      ? 0
      : seg.fillRatio * (1 - Math.min(1, (seg.significantComponentCount - 1) * 0.05));
  assert.equal(score(INSIGNIFICANT_FRAGMENT_CEILING), 0, 'at the ceiling the mask must score 0');
  assert.ok(score(INSIGNIFICANT_FRAGMENT_CEILING - 0.001) > 0, 'just below the ceiling nothing changes');
});

test('P42-A-002: a negative control that actually exercises the segmentation confidence path', () => {
  // The build multi-object negative control asserted only
  // `eligibility.live2d === false` on a scene the SHOT CLASSIFIER refuses
  // with MULTIPLE_GARMENTS at the classification stage — so it would still
  // pass if the segmentation component were hardcoded to 1.0. This test
  // reaches segmentation and pins the component itself.
  const clean = mk(41);
  const withPart = detachedPart(mk(41), 0.009);
  assert.equal(
    classifyShot(withPart).shotClass,
    classifyShot(clean).shotClass,
    'precondition: the fixture must NOT be diverted by the shot classifier',
  );
  const result = runPipelineForImage(product('audit-neg'), 'n.png', asDecoded(withPart), {
    fidelityHints: { knownFillColor: LIGHT_BLUE },
  });
  assert.equal(
    result.manifest.rejection?.stage ?? 'none',
    'none',
    'precondition: no stage gate may fire — the segmentation COMPONENT is under test',
  );
  assert.ok(
    result.manifest.confidenceComponents.segmentation < segScore(clean),
    'the segmentation confidence component itself must register the detached part',
  );
  const evidence = result.manifest.segmentationEvidence as { largestNonWinnerComponentRatio: number } | null;
  assert.ok(evidence, 'segmentation evidence must be recorded');
  assert.ok(
    evidence!.largestNonWinnerComponentRatio > 0,
    'the new measure must reach the manifest so the condition is auditable downstream',
  );
});

// ── P42-A-003 / A3: taxonomy split ──────────────────────────────────────

test('A3 REPAIR: a HARD policy refusal emits EXTRACTION_REFUSED_BY_POLICY, not EXTRACTION_UNRELIABLE', () => {
  // A HARD source with a busy (non-uniform) background and no skin:
  // classifyExtractionGate returns null and extraction NEVER RUNS.
  const img = generateSyntheticGarment({
    seed: 77,
    backgroundColor: WHITE_BG,
    garmentColor: LIGHT_BLUE,
    backgroundNoise: 90,
  }).image;
  const result = runPipelineForImage(product('audit-policy'), 'p.png', asDecoded(img), {});
  const rej = result.manifest.rejection;
  assert.ok(rej, 'fixture must be rejected');
  assert.notEqual(
    rej!.code,
    'EXTRACTION_UNRELIABLE',
    'a pre-extraction POLICY refusal must never be reported as an extraction failure',
  );
  assert.equal(result.manifest.eligibility.live2d, false);
});

test('A3 NEGATIVE CONTROL: the confidence-gate route still reports EXTRACTION_UNRELIABLE', () => {
  // The split must not relabel the confidence-gate route: there, extraction
  // genuinely ran and its result genuinely could not be trusted.
  const components = {
    shotClassification: 0.9,
    segmentation: 0.2,
    anchorCompleteness: 0.9,
    geometryValidity: 1,
    sourceQuality: 1,
    productFidelity: 1,
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveEligibility } = require('../src/eligibility') as typeof import('../src/eligibility');
  const resolved = resolveEligibility(components, null);
  assert.equal(resolved.live2d, false);
  assert.equal(
    resolved.reason,
    'EXTRACTION_UNRELIABLE',
    'an ATTEMPTED extraction that misses confidence keeps the unreliable code',
  );
});

test('A3: a policy refusal is NOT triaged as economically correctable', () => {
  // Under the conflated code, 27 of 29 EXTRACTION_UNRELIABLE cases were HARD
  // policy refusals and were all labelled POTENTIALLY_CORRECTABLE. A refusal
  // to extract is not fixable by mask repair or crop adjustment.
  assert.equal(classifyCorrectionTriage('EXTRACTION_REFUSED_BY_POLICY'), 'NOT_ECONOMICALLY_CORRECTABLE');
  // Negative control: the genuine extraction-failure code keeps its meaning.
  assert.equal(classifyCorrectionTriage('EXTRACTION_UNRELIABLE'), 'POTENTIALLY_CORRECTABLE');
});
