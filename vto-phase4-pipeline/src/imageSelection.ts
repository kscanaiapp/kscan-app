import type { DecodedSource } from './codec';
import { classifyShot } from './shotClassifier';
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
}

const SHOT_CLASS_RANK: Record<ShotClass, number> = { EASY: 3, MEDIUM: 2, HARD: 1, UNSUPPORTED: 0 };

/**
 * Task section 13: "Products may contain multiple images... do not simply
 * take imageUrls[0]." Candidates are scored by (1) shot-class rank, (2)
 * classifier confidence, (3) resolution — front-facing/single-garment/
 * minimal-occlusion signals are exactly what the shot classifier already
 * measures, so scoring reuses it rather than a second bespoke heuristic.
 */
export function selectBestSourceImage(candidates: readonly ImageCandidate[]): SelectionResult {
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

  const winner = sorted[0];
  return {
    selected: winner.candidate,
    reason: `best of ${candidates.length} candidate(s): shotClass=${winner.shotClass} confidence=${winner.confidence.toFixed(2)} resolution=${winner.width}x${winner.height}`,
    evaluated: evaluated.map(({ candidate: _c, ...rest }) => rest),
  };
}
