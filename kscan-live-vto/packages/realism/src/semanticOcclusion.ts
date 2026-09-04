/**
 * Semantic occlusion regions — Phase 3 Sections 10-11.
 *
 * Extends the existing binary foreground/background compositing seam
 * (`@kscan-live-vto/static-renderer`'s `compositeStaticPreview`, which
 * already layers person -> garment -> foreground mask -> UI, see
 * `docs/vto-phase3-source-authority.md`) into named regions, so the
 * compositor's decision can be expressed as "why," not just "that."
 *
 * This module defines the vocabulary and the layer-order resolution rule
 * only. It does not run any segmentation model — see
 * `PRECOMPUTED_SEMANTIC_MASK_LABEL` below and
 * docs/vto-phase3-native-blockers.md.
 */

import {
  assertValidForegroundMaskFrame,
  type ForegroundMaskFrame,
} from './foregroundMask';

export const SEMANTIC_REGIONS = ['forearm_hand', 'upper_arm', 'neck_chin', 'hair', 'background'] as const;
export type SemanticRegion = (typeof SEMANTIC_REGIONS)[number];

/** Section 10's three occlusion rules, collapsed into one total order,
 *  back-to-front (index 0 paints first / sits furthest back). */
export const OCCLUSION_LAYERS = ['BACKGROUND', 'EXISTING_CLOTHING', 'GARMENT', 'BODY'] as const;
export type OcclusionLayer = (typeof OCCLUSION_LAYERS)[number];

export const OCCLUSION_PAINT_ORDER: readonly OcclusionLayer[] = OCCLUSION_LAYERS;

export function paintOrderIndex(layer: OcclusionLayer): number {
  const index = OCCLUSION_PAINT_ORDER.indexOf(layer);
  if (index < 0) throw new RangeError(`paintOrderIndex: unknown layer ${String(layer)}`);
  return index;
}

/** True when `above` is painted after (i.e. visually on top of) `below`. */
export function occludes(above: OcclusionLayer, below: OcclusionLayer): boolean {
  return paintOrderIndex(above) > paintOrderIndex(below);
}

/** Every semantic region this program recognizes is body content, so it
 *  occupies the BODY layer -- the same rule Section 10 states three times
 *  ("body should occlude garment") applies identically to all four; only
 *  'background' differs. A region is deliberately never mapped to
 *  EXISTING_CLOTHING: this program has no way to detect the wearer's own
 *  clothing as distinct from their body, so it is conservatively treated as
 *  BODY (occludes the garment) rather than guessed at. */
export const REGION_LAYER: Readonly<Record<SemanticRegion, OcclusionLayer>> = {
  background: 'BACKGROUND',
  forearm_hand: 'BODY',
  upper_arm: 'BODY',
  neck_chin: 'BODY',
  hair: 'BODY',
};

/**
 * Required honesty label — Section 11. Every semantic mask this program
 * ships is authored/precomputed, not the output of a validated model. A
 * caller that renders a semantic mask without this exact label attached is
 * misrepresenting its provenance.
 */
export const PRECOMPUTED_SEMANTIC_MASK_LABEL = 'SEMANTIC MASK: PRECOMPUTED — MODEL NOT VALIDATED';

export interface SemanticMaskFrame {
  region: SemanticRegion;
  frame: ForegroundMaskFrame;
  /** Must equal PRECOMPUTED_SEMANTIC_MASK_LABEL whenever frame.provenance
   *  is 'PRECOMPUTED' (the only provenance this program can produce today). */
  label: string;
}

export function assertValidSemanticMaskFrame(entry: SemanticMaskFrame): void {
  if (!(SEMANTIC_REGIONS as readonly string[]).includes(entry.region)) {
    throw new RangeError(`SemanticMaskFrame.region must be one of ${SEMANTIC_REGIONS.join(', ')}, got ${String(entry.region)}`);
  }
  assertValidForegroundMaskFrame(entry.frame);
  if (entry.frame.provenance === 'PRECOMPUTED' && entry.label !== PRECOMPUTED_SEMANTIC_MASK_LABEL) {
    throw new RangeError(
      `SemanticMaskFrame with provenance PRECOMPUTED must carry the exact label "${PRECOMPUTED_SEMANTIC_MASK_LABEL}", got ${JSON.stringify(entry.label)}`,
    );
  }
}

/** A full scene: one optional frame per non-background region, e.g. a
 *  "both forearms crossing" adverse case supplies `forearm_hand` and
 *  `upper_arm` but omits `hair`/`neck_chin`. */
export type SemanticScene = Partial<Record<Exclude<SemanticRegion, 'background'>, SemanticMaskFrame>>;

export function assertValidSemanticScene(scene: SemanticScene): void {
  for (const [region, entry] of Object.entries(scene)) {
    if (!entry) continue;
    if (entry.region !== region) {
      throw new RangeError(`SemanticScene entry keyed "${region}" carries mismatched region "${entry.region}"`);
    }
    assertValidSemanticMaskFrame(entry);
  }
}

/**
 * Combines every region present in a scene into one coverage mask,
 * respecting Section 10's layer order. Because every recognized region
 * maps to the same BODY layer (see REGION_LAYER), "combine" here is a
 * per-texel maximum of coverage -- any region claiming a texel wins it for
 * the body, which is exactly what "BODY should occlude GARMENT" requires
 * regardless of which body part is present at that texel. If regions
 * mapped to different layers in the future, this is the function that
 * would need per-texel layer comparison instead of a flat max.
 */
export function combineSemanticScene(
  scene: SemanticScene,
  width: number,
  height: number,
): { coverage: Float64Array; contributingRegions: SemanticRegion[] } {
  const coverage = new Float64Array(width * height);
  const contributingRegions: SemanticRegion[] = [];
  for (const region of SEMANTIC_REGIONS) {
    if (region === 'background') continue;
    const entry = scene[region];
    if (!entry) continue;
    const { mask } = entry.frame;
    if (mask.width !== width || mask.height !== height) {
      throw new RangeError(
        `combineSemanticScene: region "${region}" mask is ${mask.width}x${mask.height}, expected ${width}x${height}`,
      );
    }
    let contributed = false;
    for (let i = 0; i < coverage.length; i += 1) {
      const v = mask.coverage[i] ?? 0;
      if (v > (coverage[i] ?? 0)) {
        coverage[i] = v;
        contributed = true;
      }
    }
    if (contributed) contributingRegions.push(region);
  }
  return { coverage, contributingRegions };
}
