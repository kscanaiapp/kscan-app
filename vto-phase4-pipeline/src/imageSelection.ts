import type { DecodedSource } from './codec';
import { classifyShot } from './shotClassifier';
import { checkVariantConsistency, type VariantConsistencyResult } from './variantConsistency';
import type { ShotClass } from './types';

export interface ImageCandidate {
  ref: string;
  decoded: DecodedSource;
}

export interface ImageCandidateEvaluation {
  ref: string;
  shotClass: ShotClass;
  confidence: number;
  width: number;
  height: number;
}

export interface SelectionResult {
  selected: ImageCandidate;
  reason: string;
  evaluated: ImageCandidateEvaluation[];
  /** Index 0 is the HERO — the image the Commerce record leads with. */
  heroRef: string;
  /** True when an ALTERNATE image was chosen over the hero (§13 rescue). */
  rescuedByAlternate: boolean;
  /**
   * Populated whenever an alternate outranked the hero, i.e. whenever a
   * substitution was actually considered. Null when the hero won outright,
   * because no substitution arose to check.
   */
  variantConsistency: VariantConsistencyResult | null;
  /** True when a better-ranked alternate was REFUSED on variant-safety grounds and the hero was kept. */
  variantSubstitutionRefused: boolean;
}

export interface SelectionOptions {
  /** Mirrors `Phase4ProductInput.variantAuthoritative`. Nothing real sets it today. */
  variantAuthoritative?: boolean;
}

const SHOT_CLASS_RANK: Record<ShotClass, number> = { EASY: 3, MEDIUM: 2, HARD: 1, UNSUPPORTED: 0 };

/**
 * Task section 13: "Products may contain multiple images... do not simply
 * take imageUrls[0]." Candidates are scored by (1) shot-class rank, (2)
 * classifier confidence, (3) resolution — front-facing/single-garment/
 * minimal-occlusion signals are exactly what the shot classifier already
 * measures, so scoring reuses it rather than a second bespoke heuristic.
 */
export function selectBestSourceImage(candidates: readonly ImageCandidate[], options: SelectionOptions = {}): SelectionResult {
  if (candidates.length === 0) {
    throw new Error('selectBestSourceImage requires at least one candidate');
  }

  const evaluated: (ImageCandidateEvaluation & { candidate: ImageCandidate })[] = candidates.map((c) => {
    const result = classifyShot(c.decoded.image);
    return {
      ref: c.ref,
      shotClass: result.shotClass,
      confidence: result.confidence,
      width: c.decoded.image.width,
      height: c.decoded.image.height,
      candidate: c,
    };
  });

  const sorted = [...evaluated].sort((a, b) => {
    const rankDiff = SHOT_CLASS_RANK[b.shotClass] - SHOT_CLASS_RANK[a.shotClass];
    if (rankDiff !== 0) return rankDiff;
    const confDiff = b.confidence - a.confidence;
    if (Math.abs(confDiff) > 1e-9) return confDiff;
    return b.width * b.height - a.width * a.height;
  });

  const hero = candidates[0];
  const winner = sorted[0];
  const evaluatedPublic = evaluated.map(({ candidate: _c, ...rest }) => rest);

  // The hero won outright — no substitution was ever proposed, so there is
  // nothing to variant-check.
  if (winner.candidate.ref === hero.ref) {
    return {
      selected: winner.candidate,
      reason: `hero image is best of ${candidates.length} candidate(s): shotClass=${winner.shotClass} confidence=${winner.confidence.toFixed(2)} resolution=${winner.width}x${winner.height}`,
      evaluated: evaluatedPublic,
      heroRef: hero.ref,
      rescuedByAlternate: false,
      variantConsistency: null,
      variantSubstitutionRefused: false,
    };
  }

  // An ALTERNATE outranked the hero. Phase 4.2 §55: with no authoritative
  // variant identity, an alternate may only stand in for the hero when the
  // two agree on dominant garment colour — otherwise this would silently
  // attach a different colourway's photo to this product's identity, price
  // and purchase link. On refusal we keep the HERO (the Commerce record's
  // own lead image), never a third candidate: falling through to the next
  // best alternate would just repeat the same unsafe substitution.
  const consistency = checkVariantConsistency(hero.decoded.image, winner.candidate.decoded.image, options.variantAuthoritative === true);

  if (!consistency.substitutionAllowed) {
    return {
      selected: hero,
      reason: `alternate (shotClass=${winner.shotClass}) outranked the hero but was REFUSED on variant safety: ${consistency.rationale} Keeping the hero image.`,
      evaluated: evaluatedPublic,
      heroRef: hero.ref,
      rescuedByAlternate: false,
      variantConsistency: consistency,
      variantSubstitutionRefused: true,
    };
  }

  return {
    selected: winner.candidate,
    reason: `alternate image rescued this product: shotClass=${winner.shotClass} confidence=${winner.confidence.toFixed(2)} resolution=${winner.width}x${winner.height}; variant safety: ${consistency.rationale}`,
    evaluated: evaluatedPublic,
    heroRef: hero.ref,
    rescuedByAlternate: true,
    variantConsistency: consistency,
    variantSubstitutionRefused: false,
  };
}
