/**
 * Asset QC record — Section P1-D5.
 *
 * "Do not invent target success rates before baseline data exists. After
 * an initial sample, recommend evidence-based targets." The thresholds
 * below are placeholders for exactly that reason — every one is named so
 * a reviewer can see and challenge it individually once real QC records
 * accumulate. `composeQcRecord` is deliberately mechanical (no ML
 * judgment of its own): it only aggregates stage-reported confidences
 * into one ACCEPTED/REJECTED verdict plus a human-readable reason, so a
 * human reviewing borrowed evidence can audit exactly why a garment
 * passed or failed.
 */

import type { ShotClass } from './shotClass';

export type QcVerdict = 'ACCEPTED' | 'REJECTED';

export interface QcStageConfidences {
  shotClass: ShotClass;
  shotClassConfidence: number;
  segmentationConfidence: number;
  controlPointConfidence: number;
  normalizationConfidence: number;
  /** True if a logo/pattern was detected and the pipeline flags it needs distortion review (P1-E2 logo/pattern distortion check downstream). */
  logoOrPatternDetected: boolean;
  /** Perceptual color-preservation score vs. source image, [0,1]; null if not measured this run. */
  colorPreservationScore: number | null;
  manualAdjustmentApplied: boolean;
}

export interface QcRecord {
  productId: string;
  shotClass: ShotClass;
  segmentation: number;
  controlPointQuality: number;
  normalization: number;
  logoOrPattern: 'none' | 'detected';
  colorPreservation: number | null;
  manualAdjustment: boolean;
  verdict: QcVerdict;
  reason: string;
}

export interface QcThresholds {
  minSegmentationConfidence: number;
  minControlPointConfidence: number;
  minNormalizationConfidence: number;
  minColorPreservationScore: number;
}

/** PLACEHOLDER thresholds — see file header. Not derived from evidence yet. */
export const DEFAULT_QC_THRESHOLDS: QcThresholds = {
  minSegmentationConfidence: 0.6,
  minControlPointConfidence: 0.6,
  minNormalizationConfidence: 0.6,
  minColorPreservationScore: 0.7,
};

export function composeQcRecord(
  productId: string,
  input: QcStageConfidences,
  thresholds: QcThresholds = DEFAULT_QC_THRESHOLDS,
): QcRecord {
  const failures: string[] = [];

  if (input.segmentationConfidence < thresholds.minSegmentationConfidence) {
    failures.push(
      `segmentation confidence ${input.segmentationConfidence.toFixed(2)} below ${thresholds.minSegmentationConfidence}`,
    );
  }
  if (input.controlPointConfidence < thresholds.minControlPointConfidence) {
    failures.push(
      `control-point confidence ${input.controlPointConfidence.toFixed(2)} below ${thresholds.minControlPointConfidence}`,
    );
  }
  if (input.normalizationConfidence < thresholds.minNormalizationConfidence) {
    failures.push(
      `normalization confidence ${input.normalizationConfidence.toFixed(2)} below ${thresholds.minNormalizationConfidence}`,
    );
  }
  if (
    input.colorPreservationScore !== null &&
    input.colorPreservationScore < thresholds.minColorPreservationScore
  ) {
    failures.push(
      `color preservation ${input.colorPreservationScore.toFixed(2)} below ${thresholds.minColorPreservationScore}`,
    );
  }

  const verdict: QcVerdict = failures.length === 0 ? 'ACCEPTED' : 'REJECTED';
  const reason =
    failures.length === 0
      ? input.manualAdjustmentApplied
        ? 'passed all thresholds after manual adjustment'
        : 'passed all thresholds automatically'
      : failures.join('; ');

  return {
    productId,
    shotClass: input.shotClass,
    segmentation: input.segmentationConfidence,
    controlPointQuality: input.controlPointConfidence,
    normalization: input.normalizationConfidence,
    logoOrPattern: input.logoOrPatternDetected ? 'detected' : 'none',
    colorPreservation: input.colorPreservationScore,
    manualAdjustment: input.manualAdjustmentApplied,
    verdict,
    reason,
  };
}

/**
 * Aggregate acceptance/rejection counts by shot class — the evidence base
 * Section P1-D5 asks for before any target success rate is proposed.
 */
export function summarizeQcRecords(records: readonly QcRecord[]): Record<ShotClass, { accepted: number; rejected: number }> {
  const summary: Record<string, { accepted: number; rejected: number }> = {};
  for (const record of records) {
    const bucket = (summary[record.shotClass] ??= { accepted: 0, rejected: 0 });
    if (record.verdict === 'ACCEPTED') bucket.accepted += 1;
    else bucket.rejected += 1;
  }
  return summary as Record<ShotClass, { accepted: number; rejected: number }>;
}
