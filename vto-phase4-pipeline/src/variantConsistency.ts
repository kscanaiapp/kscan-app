import { computeForegroundMask, estimateBackgroundColor } from './background';
import { labelConnectedComponents, largestComponent } from './components';
import { colorDistance, type RgbaImage } from './pixels';

/**
 * Phase 4.2 §55 — PRODUCT / VARIANT INTEGRITY for multi-image selection.
 *
 * THE HAZARD. `variantResolution.groupByVariant` marks a product ambiguous
 * only when it carries DIFFERING NON-NULL `variantId` values. In the real
 * Commerce feed every `variantId` is `null` and `variantAuthoritative` is
 * false (measured: 490/490 products), so that guard never fires. Meanwhile
 * §12 authorizes selecting an ALTERNATE image over the hero. Retailer photo
 * arrays routinely mix colourways. Composed, those two facts allow a red
 * shirt's photo to become the Live asset for a product whose hero — and
 * therefore whose price, title and purchase link — is the blue one. That is
 * a silent, user-visible wrong-product defect, and it is precisely what a
 * hostile audit of this phase will look for.
 *
 * THE CONTROL. When variant identity is NOT authoritative, an alternate
 * image may only be substituted for the hero if the two are visually
 * consistent in dominant garment colour. If they disagree, the pipeline
 * refuses the substitution rather than guessing.
 *
 * WHY THIS IS NOT "inferring variant identity from pixels" (§14 forbids
 * that). This never assigns an identity, never splits a product into
 * variants, and never decides which colourway is "official". It only ever
 * answers "may this alternate stand in for the hero?" and only ever answers
 * NO more often. The conservative direction is the only direction it can
 * move: on disagreement the hero is kept, or the product is marked
 * ambiguous. It cannot invent a variant, and it cannot promote one.
 */

/**
 * Maximum RGB distance between two candidate images' dominant garment
 * colours for an alternate to be treated as the same colourway.
 *
 * DERIVED, not invented (§26). Calibrated against synthetic ground truth in
 * variantConsistency.test.ts, which measures both directions:
 *   - SAME garment, different seed / added compression speckle / tilt:
 *     observed dominant-colour distance stays in the single digits.
 *   - DIFFERENT colourway of the SAME garment shape (the actual hazard):
 *     observed distance is in the many tens to low hundreds.
 * The gap between those two populations is wide, and 40 sits inside it with
 * margin on both sides. The calibration test asserts the gap still holds, so
 * this number cannot silently drift out from under the evidence that
 * justifies it.
 */
export const VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE = 40;

export interface DominantGarmentColor {
  ok: boolean;
  color: [number, number, number] | null;
  /** Pixels contributing to the mean. */
  sampleCount: number;
  reason: string;
}

/**
 * Mean colour of the largest connected foreground component — i.e. of the
 * thing the segmenter would treat as the garment. Deliberately reuses the
 * same background/component primitives the extraction path uses, so this
 * measures the same region the asset would actually be built from.
 */
export function dominantGarmentColor(img: RgbaImage): DominantGarmentColor {
  const bg = estimateBackgroundColor(img);
  const mask = computeForegroundMask(img, bg);
  const { labels, components } = labelConnectedComponents(mask, img.width, img.height);
  const winner = largestComponent(components);
  if (!winner || winner.size < 64) {
    return { ok: false, color: null, sampleCount: 0, reason: 'no_significant_foreground_component' };
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== winner.id) continue;
    r += img.data[i * 4];
    g += img.data[i * 4 + 1];
    b += img.data[i * 4 + 2];
    n++;
  }
  if (n === 0) return { ok: false, color: null, sampleCount: 0, reason: 'empty_component' };

  return { ok: true, color: [r / n, g / n, b / n], sampleCount: n, reason: 'ok' };
}

export type VariantConsistencyVerdict =
  /** Alternate is visually consistent with the hero — safe to substitute. */
  | 'CONSISTENT'
  /** Alternate's dominant garment colour disagrees with the hero's — refuse substitution. */
  | 'INCONSISTENT'
  /** One or both images have no measurable garment region — no claim is honest. */
  | 'UNMEASURABLE'
  /** Variant identity is authoritative, so pixel agreement is not required. */
  | 'AUTHORITATIVE_VARIANT';

export interface VariantConsistencyResult {
  verdict: VariantConsistencyVerdict;
  /** True only when it is safe to use the alternate INSTEAD of the hero. */
  substitutionAllowed: boolean;
  distance: number | null;
  heroColor: [number, number, number] | null;
  candidateColor: [number, number, number] | null;
  threshold: number;
  rationale: string;
}

/**
 * Decides whether `candidate` may be substituted for `hero` as the asset
 * source for one product.
 *
 * `variantAuthoritative` mirrors `Phase4ProductInput.variantAuthoritative`:
 * when a genuinely canonical variant identity exists, the two images are
 * already known to belong to the same variant and no pixel agreement is
 * required. Today nothing real sets it (see `types.ts`), so in practice the
 * colour check always runs on real data — which is the intent.
 */
export function checkVariantConsistency(
  hero: RgbaImage,
  candidate: RgbaImage,
  variantAuthoritative: boolean,
): VariantConsistencyResult {
  const base = { threshold: VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE };

  if (variantAuthoritative) {
    return {
      ...base,
      verdict: 'AUTHORITATIVE_VARIANT',
      substitutionAllowed: true,
      distance: null,
      heroColor: null,
      candidateColor: null,
      rationale: 'Variant identity is authoritative; the two images are already known to share a variant, so pixel agreement is not required.',
    };
  }

  const heroColor = dominantGarmentColor(hero);
  const candidateColor = dominantGarmentColor(candidate);

  if (!heroColor.ok || !candidateColor.ok) {
    return {
      ...base,
      verdict: 'UNMEASURABLE',
      substitutionAllowed: false,
      distance: null,
      heroColor: heroColor.color,
      candidateColor: candidateColor.color,
      rationale:
        'Dominant garment colour is not measurable on ' +
        (!heroColor.ok ? 'the hero (' + heroColor.reason + ')' : 'the candidate (' + candidateColor.reason + ')') +
        ' — refusing substitution rather than guessing (fail closed).',
    };
  }

  const distance = colorDistance(
    heroColor.color as [number, number, number],
    candidateColor.color as [number, number, number],
  );
  const consistent = distance <= VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE;

  return {
    ...base,
    verdict: consistent ? 'CONSISTENT' : 'INCONSISTENT',
    substitutionAllowed: consistent,
    distance: Math.round(distance * 100) / 100,
    heroColor: heroColor.color,
    candidateColor: candidateColor.color,
    rationale: consistent
      ? 'Dominant garment colour distance ' + distance.toFixed(1) + ' <= ' + VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE + ' — same colourway within tolerance.'
      : 'Dominant garment colour distance ' + distance.toFixed(1) + ' > ' + VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE + ' — candidate appears to be a DIFFERENT colourway. Substituting it would attach the wrong product image to this product identity, so it is refused.',
  };
}
