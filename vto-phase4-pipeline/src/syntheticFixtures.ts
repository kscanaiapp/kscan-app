import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writePngFile } from './codec';
import type { FidelityReferenceHints } from './fidelity';
import { generateSyntheticGarment, SOFT_KNIT_PRESET, STRUCTURED_PRESET, type SyntheticGarmentSpec } from './syntheticGarment';
import { createImage } from './pixels';
import type { Phase4ProductInput } from './types';

export interface SyntheticFixtureSet {
  products: Phase4ProductInput[];
  hintsByRef: Map<string, FidelityReferenceHints>;
}

const LIGHT_BLUE: [number, number, number] = [176, 205, 234];
const NAVY: [number, number, number] = [26, 34, 64];
const WHITE_BG: [number, number, number] = [248, 248, 248];
const LOGO_RED: [number, number, number] = [196, 40, 40];

function baseProduct(overrides: Partial<Phase4ProductInput>): Phase4ProductInput {
  return {
    productRef: 'unset',
    retailer: 'phase4-synthetic-retailer',
    variantId: null,
    variantAuthoritative: false,
    category: 'top',
    title: null,
    brand: null,
    images: [],
    evidenceClass: 'SYNTHETIC',
    ...overrides,
  };
}

/**
 * Generates the full task-section-9 representation matrix (Easy/Medium/Hard
 * x plain/logo/patterned/dark/light/soft-knit/structured/multi-image/
 * variant) as procedurally-drawn, reproducible PNGs — plus two
 * source-acquisition edge cases (too-small, unsupported-category). All
 * fill/logo colors are recorded as `FidelityReferenceHints` so product
 * fidelity metrics have a real, non-fabricated ground truth for this
 * evidence class only (task section 36).
 */
export function generateSyntheticFixtureSet(outputDir: string): SyntheticFixtureSet {
  mkdirSync(outputDir, { recursive: true });
  const hintsByRef = new Map<string, FidelityReferenceHints>();
  const products: Phase4ProductInput[] = [];

  const write = (name: string, spec: SyntheticGarmentSpec): { ref: string; hints: FidelityReferenceHints } => {
    const result = generateSyntheticGarment(spec);
    const ref = join(outputDir, `${name}.png`);
    writePngFile(ref, result.image);
    // A striped garment's true mean color is the ~50/50 blend of its two stripe
    // colors, not the base fill alone (fillHorizontalStripes/drawVerticalStripes
    // paint roughly half the garment area in `spec.stripes.color`) — the ground
    // truth hint must reflect what was actually drawn, not just one of its inputs.
    const knownFillColor: [number, number, number] = spec.stripes
      ? [
          (spec.garmentColor[0] + spec.stripes.color[0]) / 2,
          (spec.garmentColor[1] + spec.stripes.color[1]) / 2,
          (spec.garmentColor[2] + spec.stripes.color[2]) / 2,
        ]
      : spec.garmentColor;
    const hints: FidelityReferenceHints = { knownFillColor };
    if (spec.logo) hints.knownLogoColor = spec.logo.color;
    if (spec.stripes) hints.knownPatternOrientation = spec.stripes.orientation;
    hintsByRef.set(ref, hints);
    return { ref, hints };
  };

  // --- EASY ---
  const easyPlainLight = write('easy-plain-light', { seed: 1, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE });
  products.push(baseProduct({ productRef: 'p4-easy-plain-light', title: 'Easy plain light tee', images: [{ ref: easyPlainLight.ref, origin: 'local-fixture' }] }));

  const easyPlainDark = write('easy-plain-dark', { seed: 2, backgroundColor: WHITE_BG, garmentColor: NAVY });
  products.push(baseProduct({ productRef: 'p4-easy-plain-dark', title: 'Easy plain dark tee', images: [{ ref: easyPlainDark.ref, origin: 'local-fixture' }] }));

  const easyLogo = write('easy-logo', { seed: 3, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE, logo: { color: LOGO_RED } });
  products.push(baseProduct({ productRef: 'p4-easy-logo', title: 'Easy logo tee', images: [{ ref: easyLogo.ref, origin: 'local-fixture' }] }));

  const easyStripes = write('easy-patterned-stripes', { seed: 4, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE, stripes: { color: NAVY, orientation: 'horizontal' } });
  products.push(baseProduct({ productRef: 'p4-easy-patterned', title: 'Easy striped tee', images: [{ ref: easyStripes.ref, origin: 'local-fixture' }] }));

  const easyStructured = write('easy-structured', { seed: 5, backgroundColor: WHITE_BG, garmentColor: NAVY, preset: STRUCTURED_PRESET });
  products.push(baseProduct({ productRef: 'p4-easy-structured', title: 'Easy structured top', images: [{ ref: easyStructured.ref, origin: 'local-fixture' }] }));

  const easySoftKnit = write('easy-softknit', { seed: 6, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE, preset: SOFT_KNIT_PRESET });
  products.push(baseProduct({ productRef: 'p4-easy-softknit', title: 'Easy soft knit top', images: [{ ref: easySoftKnit.ref, origin: 'local-fixture' }] }));

  // --- MEDIUM (mild background noise + a bounded tilt) ---
  const mediumPlain = write('medium-plain', { seed: 7, backgroundColor: WHITE_BG, backgroundNoise: 27, garmentColor: LIGHT_BLUE, tiltDegrees: 8 });
  products.push(baseProduct({ productRef: 'p4-medium-plain', title: 'Medium plain tee', images: [{ ref: mediumPlain.ref, origin: 'local-fixture' }] }));

  const mediumLogo = write('medium-logo', { seed: 8, backgroundColor: WHITE_BG, backgroundNoise: 27, garmentColor: LIGHT_BLUE, logo: { color: LOGO_RED }, tiltDegrees: -6 });
  products.push(baseProduct({ productRef: 'p4-medium-logo', title: 'Medium logo tee', images: [{ ref: mediumLogo.ref, origin: 'local-fixture' }] }));

  const mediumPatterned = write('medium-patterned', { seed: 9, backgroundColor: WHITE_BG, backgroundNoise: 27, garmentColor: LIGHT_BLUE, stripes: { color: NAVY, orientation: 'vertical' }, tiltDegrees: 5 });
  products.push(baseProduct({ productRef: 'p4-medium-patterned', title: 'Medium striped tee', images: [{ ref: mediumPatterned.ref, origin: 'local-fixture' }] }));

  const mediumDark = write('medium-dark', { seed: 10, backgroundColor: WHITE_BG, backgroundNoise: 28, garmentColor: NAVY, tiltDegrees: 7 });
  products.push(baseProduct({ productRef: 'p4-medium-dark', title: 'Medium dark tee', images: [{ ref: mediumDark.ref, origin: 'local-fixture' }] }));

  const mediumLight = write('medium-light', { seed: 11, backgroundColor: WHITE_BG, backgroundNoise: 28, garmentColor: LIGHT_BLUE, tiltDegrees: -8 });
  products.push(baseProduct({ productRef: 'p4-medium-light', title: 'Medium light tee', images: [{ ref: mediumLight.ref, origin: 'local-fixture' }] }));

  // --- HARD (synthetic model-worn stand-in: skin-tone regions overlapping the garment) ---
  const hardSkin = write('hard-synthetic-worn', { seed: 12, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE, addSkinBlob: true });
  products.push(baseProduct({ productRef: 'p4-hard-synthetic-worn', title: 'Hard synthetic model-worn stand-in', images: [{ ref: hardSkin.ref, origin: 'local-fixture' }] }));

  // --- UNSUPPORTED (scattered disconnected objects, no single primary garment) ---
  const unsupportedMulti = write('unsupported-multi-object', { seed: 13, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE, scatterExtraObjects: true });
  products.push(baseProduct({ productRef: 'p4-unsupported-multi', title: 'Unsupported scattered-object scene', images: [{ ref: unsupportedMulti.ref, origin: 'local-fixture' }] }));

  // --- multiple-image product (same product+variant, two candidate images of differing quality) ---
  const multiA = write('multi-image-a-easy', { seed: 14, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE });
  const multiB = write('multi-image-b-medium', { seed: 15, backgroundColor: WHITE_BG, backgroundNoise: 22, garmentColor: LIGHT_BLUE, tiltDegrees: 10 });
  products.push(
    baseProduct({
      productRef: 'p4-multi-image-product',
      title: 'Multi-image product',
      images: [
        { ref: multiB.ref, origin: 'local-fixture' },
        { ref: multiA.ref, origin: 'local-fixture' },
      ],
    }),
  );

  // --- variant product: ambiguous (no authoritative variant identity) ---
  const variantBlack = write('variant-ambiguous-black', { seed: 16, backgroundColor: WHITE_BG, garmentColor: NAVY });
  const variantWhite = write('variant-ambiguous-white', { seed: 17, backgroundColor: WHITE_BG, garmentColor: [200, 200, 208] });
  products.push(baseProduct({ productRef: 'p4-variant-product', variantId: 'black', title: 'Variant product (black)', images: [{ ref: variantBlack.ref, origin: 'local-fixture' }] }));
  products.push(baseProduct({ productRef: 'p4-variant-product', variantId: 'white', title: 'Variant product (white)', images: [{ ref: variantWhite.ref, origin: 'local-fixture' }] }));

  // --- variant product: authoritative identity (hypothetical future Commerce capability) ---
  const variantAuthBlack = write('variant-authoritative-black', { seed: 18, backgroundColor: WHITE_BG, garmentColor: NAVY });
  const variantAuthWhite = write('variant-authoritative-white', { seed: 19, backgroundColor: WHITE_BG, garmentColor: [200, 200, 208] });
  products.push(
    baseProduct({ productRef: 'p4-variant-authoritative-product', variantId: 'black', variantAuthoritative: true, title: 'Authoritative variant (black)', images: [{ ref: variantAuthBlack.ref, origin: 'local-fixture' }] }),
  );
  products.push(
    baseProduct({ productRef: 'p4-variant-authoritative-product', variantId: 'white', variantAuthoritative: true, title: 'Authoritative variant (white)', images: [{ ref: variantAuthWhite.ref, origin: 'local-fixture' }] }),
  );

  // --- edge cases ---
  const tinyRef = join(outputDir, 'too-small.png');
  writePngFile(tinyRef, createImage(20, 20));
  products.push(baseProduct({ productRef: 'p4-too-small', title: 'Too-small source', images: [{ ref: tinyRef, origin: 'local-fixture' }] }));

  const unsupportedCategorySource = write('unsupported-category-source', { seed: 20, backgroundColor: WHITE_BG, garmentColor: LIGHT_BLUE });
  products.push(baseProduct({ productRef: 'p4-unsupported-category', category: 'dress', title: 'Unsupported-category source (otherwise Easy)', images: [{ ref: unsupportedCategorySource.ref, origin: 'local-fixture' }] }));

  return { products, hintsByRef };
}
