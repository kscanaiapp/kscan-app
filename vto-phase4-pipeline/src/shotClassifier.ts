import type { RgbaImage } from './pixels';
import { computeForegroundMask, computeSkinRatio, estimateBackgroundColor } from './background';
import { labelConnectedComponents, largestComponent } from './components';
import type { ShotClass, ShotClassificationResult } from './types';

/**
 * Deterministic, measurement-based shot classifier. No vision model, no
 * external CV provider — per task section 17, this is the "simplest viable
 * local/batch extraction approach" for a first pipeline pass, and every
 * threshold below is explicitly a provisional starting point (task section
 * 40/15/16: "measure distributions first" before treating a number as
 * validated). Nothing here claims to detect faces, poses, or garments
 * semantically — only background uniformity, foreground connectivity, and a
 * coarse RGB skin-tone heuristic.
 */

export const SHOT_CLASSIFIER_THRESHOLDS = {
  minCoverage: 0.01,
  maxCoverage: 0.97,
  skinRatioHardFloor: 0.06,
  maxSignificantComponentsForAnalyzable: 4,
  significantComponentAreaFraction: 0.01,
  easyBackgroundUniformityMax: 14,
  easyLargestComponentRatioMin: 0.82,
  easyCoverageMin: 0.04,
  easyCoverageMax: 0.8,
  mediumBackgroundUniformityMax: 34,
  mediumLargestComponentRatioMin: 0.55,
} as const;

export function classifyShot(img: RgbaImage): ShotClassificationResult {
  const bg = estimateBackgroundColor(img);
  const mask = computeForegroundMask(img, bg);
  const totalPixels = img.width * img.height;
  const foregroundCount = mask.reduce((a, b) => a + b, 0);
  const coverage = foregroundCount / totalPixels;

  const evidence: Record<string, number | string | boolean> = {
    backgroundUniformity: round(bg.uniformity),
    coverage: round(coverage),
  };

  if (coverage < SHOT_CLASSIFIER_THRESHOLDS.minCoverage || coverage > SHOT_CLASSIFIER_THRESHOLDS.maxCoverage) {
    return finalize('UNSUPPORTED', 0.9, { ...evidence, reason: 'coverage_out_of_analyzable_range' });
  }

  const { components } = labelConnectedComponents(mask, img.width, img.height);
  const significantComponents = components.filter(
    (c) => c.size / totalPixels >= SHOT_CLASSIFIER_THRESHOLDS.significantComponentAreaFraction,
  );
  const largest = largestComponent(components);
  const largestRatio = largest ? largest.size / Math.max(1, foregroundCount) : 0;
  const skinRatio = computeSkinRatio(img, mask);

  evidence.significantComponentCount = significantComponents.length;
  evidence.largestComponentRatio = round(largestRatio);
  evidence.skinRatio = round(skinRatio);

  if (significantComponents.length > SHOT_CLASSIFIER_THRESHOLDS.maxSignificantComponentsForAnalyzable) {
    return finalize('UNSUPPORTED', 0.75, { ...evidence, reason: 'too_many_disconnected_regions' });
  }

  if (skinRatio >= SHOT_CLASSIFIER_THRESHOLDS.skinRatioHardFloor) {
    // A person is very likely present (model-worn) — HARD by task section 15's own definition, regardless of shot cleanliness.
    const confidence = Math.min(0.95, 0.55 + skinRatio);
    return finalize('HARD', confidence, { ...evidence, reason: 'skin_tone_presence_suggests_model_worn' });
  }

  if (
    bg.uniformity <= SHOT_CLASSIFIER_THRESHOLDS.easyBackgroundUniformityMax &&
    largestRatio >= SHOT_CLASSIFIER_THRESHOLDS.easyLargestComponentRatioMin &&
    coverage >= SHOT_CLASSIFIER_THRESHOLDS.easyCoverageMin &&
    coverage <= SHOT_CLASSIFIER_THRESHOLDS.easyCoverageMax &&
    significantComponents.length <= 2
  ) {
    const confidence = clamp01(
      0.6 +
        (SHOT_CLASSIFIER_THRESHOLDS.easyBackgroundUniformityMax - bg.uniformity) / 60 +
        (largestRatio - SHOT_CLASSIFIER_THRESHOLDS.easyLargestComponentRatioMin) / 2,
    );
    return finalize('EASY', confidence, { ...evidence, reason: 'uniform_background_single_compact_foreground' });
  }

  if (
    bg.uniformity <= SHOT_CLASSIFIER_THRESHOLDS.mediumBackgroundUniformityMax &&
    largestRatio >= SHOT_CLASSIFIER_THRESHOLDS.mediumLargestComponentRatioMin
  ) {
    const confidence = clamp01(0.5 + (largestRatio - SHOT_CLASSIFIER_THRESHOLDS.mediumLargestComponentRatioMin));
    return finalize('MEDIUM', confidence, { ...evidence, reason: 'moderately_uniform_background_mostly_compact_foreground' });
  }

  return finalize('HARD', 0.55, { ...evidence, reason: 'non_uniform_background_or_fragmented_foreground' });
}

function finalize(shotClass: ShotClass, confidence: number, evidence: Record<string, number | string | boolean>): ShotClassificationResult {
  return { shotClass, confidence: clamp01(confidence), evidence };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
