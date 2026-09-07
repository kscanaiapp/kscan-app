import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE,
  checkVariantConsistency,
  dominantGarmentColor,
} from '../src/variantConsistency';
import { selectBestSourceImage } from '../src/imageSelection';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import { createImage, setPixel, type RgbaImage } from '../src/pixels';
import type { DecodedSource } from '../src/codec';

/**
 * Phase 4.2 §55 — PRODUCT / VARIANT INTEGRITY.
 *
 * The hazard this suite exists to pin: every real product carries
 * `variantId: null` and `variantAuthoritative: false` (measured 490/490), so
 * `groupByVariant`'s ambiguity guard never fires — while §12 authorizes
 * substituting an alternate image for the hero. Without a further control, a
 * different colourway's photo could become the Live asset for this product's
 * identity, price and purchase link.
 */

const WHITE_BG: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];
const RED: [number, number, number] = [196, 40, 40];
const NAVY: [number, number, number] = [26, 34, 64];

function garment(color: [number, number, number], overrides: Record<string, unknown> = {}): RgbaImage {
  return generateSyntheticGarment({
    seed: 7,
    backgroundColor: WHITE_BG,
    garmentColor: color,
    ...overrides,
  }).image;
}

function speckle(img: RgbaImage, count = 120, seed = 99): RgbaImage {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < count; i++) {
    const x = 2 + (next() % Math.floor((img.width - 4) / 3)) * 3;
    const y = 2 + (next() % Math.floor((img.height * 0.18) / 3)) * 3;
    setPixel(img, x, y, 40, 40, 40, 255);
  }
  return img;
}

function candidate(ref: string, image: RgbaImage): { ref: string; decoded: DecodedSource } {
  return { ref, decoded: { image, sha256: 'sha-' + ref, format: 'png', byteLength: image.data.length } };
}

// ── THRESHOLD CALIBRATION (§26: derived from evidence, not invented) ─────

test('CALIBRATION: same colourway under nuisance variation stays well below the threshold', () => {
  const hero = garment(BLUE);
  const sameButSpeckled = speckle(garment(BLUE), 150);
  const sameButTilted = garment(BLUE, { tiltDegrees: 6 });
  const sameDifferentSeed = generateSyntheticGarment({ seed: 31, backgroundColor: WHITE_BG, garmentColor: BLUE }).image;

  const distances = [sameButSpeckled, sameButTilted, sameDifferentSeed].map((alt) => {
    const r = checkVariantConsistency(hero, alt, false);
    assert.equal(r.verdict, 'CONSISTENT', 'same colourway must read CONSISTENT: ' + r.rationale);
    return r.distance as number;
  });

  const worst = Math.max(...distances);
  assert.ok(
    worst < VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE,
    'same-colourway distances must sit below the threshold; worst=' + worst,
  );
  // Margin check: the threshold must not be sitting right on top of the
  // same-colourway population, or nuisance variation would start tripping it.
  assert.ok(worst < VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE * 0.8, 'threshold must keep margin over nuisance variation; worst=' + worst);
});

test('CALIBRATION: different colourways sit far ABOVE the threshold', () => {
  const hero = garment(BLUE);
  for (const [label, other] of [
    ['red', RED],
    ['navy', NAVY],
  ] as const) {
    const r = checkVariantConsistency(hero, garment(other as [number, number, number]), false);
    assert.equal(r.verdict, 'INCONSISTENT', label + ' must read INCONSISTENT');
    assert.ok(
      (r.distance as number) > VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE * 1.5,
      label + ' must clear the threshold with margin; distance=' + r.distance,
    );
  }
});

test('CALIBRATION: the two populations are actually separated (the threshold has somewhere to live)', () => {
  const hero = garment(BLUE);
  const sameWorst = Math.max(
    checkVariantConsistency(hero, speckle(garment(BLUE), 150), false).distance as number,
    checkVariantConsistency(hero, garment(BLUE, { tiltDegrees: 6 }), false).distance as number,
  );
  const differentBest = Math.min(
    checkVariantConsistency(hero, garment(RED), false).distance as number,
    checkVariantConsistency(hero, garment(NAVY), false).distance as number,
  );
  assert.ok(
    differentBest > sameWorst * 2,
    'populations must be clearly separated: same-worst=' + sameWorst + ' different-best=' + differentBest,
  );
  assert.ok(
    VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE > sameWorst && VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE < differentBest,
    'the configured threshold must lie strictly inside the gap [' + sameWorst + ', ' + differentBest + ']',
  );
});

// ── ADVERSARIAL: the actual leak this control exists to stop ─────────────

test('ADVERSARIAL: a HARD hero must NOT be rescued by an EASY alternate of a DIFFERENT colourway', () => {
  // The attack: the alternate is genuinely a better SHOT (clean flat lay,
  // ranks first), but it is a different colour. Ranking alone would take it.
  const heroHard = garment(BLUE, { addSkinBlob: true });
  const altEasyWrongColor = garment(RED);

  const selection = selectBestSourceImage([candidate('hero', heroHard), candidate('alt', altEasyWrongColor)]);

  assert.equal(selection.selected.ref, 'hero', 'must keep the hero rather than substitute a different colourway');
  assert.equal(selection.rescuedByAlternate, false);
  assert.equal(selection.variantSubstitutionRefused, true);
  assert.equal(selection.variantConsistency?.verdict, 'INCONSISTENT');
});

test('ADVERSARIAL: a HARD hero IS rescued by an EASY alternate of the SAME colourway', () => {
  // The legitimate case must still work, or the control would simply disable
  // the feature it is protecting.
  const heroHard = garment(BLUE, { addSkinBlob: true });
  const altEasySameColor = garment(BLUE);

  const selection = selectBestSourceImage([candidate('hero', heroHard), candidate('alt', altEasySameColor)]);

  assert.equal(selection.selected.ref, 'alt', 'a same-colourway alternate must be allowed to rescue');
  assert.equal(selection.rescuedByAlternate, true);
  assert.equal(selection.variantSubstitutionRefused, false);
  assert.equal(selection.variantConsistency?.verdict, 'CONSISTENT');
});

test('ADVERSARIAL: an unmeasurable alternate is refused, not silently accepted', () => {
  const heroHard = garment(BLUE, { addSkinBlob: true });
  // A blank canvas: no foreground component at all.
  const blank = createImage(200, 200);
  for (let i = 0; i < 200 * 200; i++) {
    blank.data[i * 4] = 248;
    blank.data[i * 4 + 1] = 248;
    blank.data[i * 4 + 2] = 248;
    blank.data[i * 4 + 3] = 255;
  }

  const r = checkVariantConsistency(heroHard, blank, false);
  assert.equal(r.verdict, 'UNMEASURABLE');
  assert.equal(r.substitutionAllowed, false, 'unmeasurable must fail CLOSED');
});

test('ADVERSARIAL: three candidates — refusal keeps the HERO, never a second unsafe alternate', () => {
  const heroHard = garment(BLUE, { addSkinBlob: true });
  const altRed = garment(RED);
  const altNavy = garment(NAVY);

  const selection = selectBestSourceImage([candidate('hero', heroHard), candidate('altRed', altRed), candidate('altNavy', altNavy)]);

  assert.equal(selection.selected.ref, 'hero', 'must fall back to the hero, not to the next-best wrong colourway');
  assert.equal(selection.variantSubstitutionRefused, true);
});

test('AUTHORITATIVE VARIANT: pixel agreement is not required when identity is genuinely canonical', () => {
  const heroHard = garment(BLUE, { addSkinBlob: true });
  const altEasyWrongColor = garment(RED);

  const selection = selectBestSourceImage(
    [candidate('hero', heroHard), candidate('alt', altEasyWrongColor)],
    { variantAuthoritative: true },
  );

  assert.equal(selection.selected.ref, 'alt');
  assert.equal(selection.variantConsistency?.verdict, 'AUTHORITATIVE_VARIANT');
});

// ── Single-image reality: the guard must be inert when there is no choice ──

test('a single-candidate product (the real-corpus case, 490/490) is never variant-checked', () => {
  const selection = selectBestSourceImage([candidate('only', garment(BLUE))]);
  assert.equal(selection.selected.ref, 'only');
  assert.equal(selection.rescuedByAlternate, false);
  assert.equal(selection.variantConsistency, null, 'no substitution arises, so no check should run');
  assert.equal(selection.variantSubstitutionRefused, false);
});

test('dominantGarmentColor reports failure rather than a fabricated colour on an empty frame', () => {
  const blank = createImage(50, 50);
  const r = dominantGarmentColor(blank);
  assert.equal(r.ok, false);
  assert.equal(r.color, null);
});
