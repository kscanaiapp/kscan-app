// Mirror Selfie extraction telemetry (Build 2.5 Step 3).
//
// A THIN BUCKETING LAYER over the existing dual-allowlist sink in
// services/closetTelemetry.ts. No second telemetry system is introduced: the
// event names and property names added there are the whole surface, and this
// module exists only to make the buckets impossible to get wrong at a call
// site.
//
// WHAT CAN NEVER BE EMITTED FROM THIS PIPELINE, and is asserted absent by test:
//
//   a URI or file path         the crops are pictures of the user's clothes
//   a filename                 gallery filenames leak dates and device models
//   image or crop dimensions   precise enough to fingerprint a source image
//   person or crop coordinates the shape of a body in a frame
//   extractionSessionId        joins two events into a session trail
//   cropKey                    same, at crop granularity
//   an actor id                 identity
//   raw detector output        unbounded, vendor-shaped, unreviewable
//
// The sink's own SAFE_STRING scrub rejects every URI and path form by shape, so
// this is defence in depth rather than the only guard — but the allowlist here
// is what makes the intent legible at the call sites.

import { emitClosetCandidateEvent } from '../closetTelemetry';
import type { MirrorExtractionErrorCode, MirrorSourceType } from '../../types/mirrorExtraction';

/**
 * Crop-count buckets.
 *
 * `9_plus` is a distinct bucket on purpose. Nine or more crops is the case the
 * eight-item staging limit will have to partition in Step 4, so collapsing it
 * into `6-8` would hide the only signal that tells us how often that matters.
 */
export type MirrorCropCountBucket = '0' | '1' | '2-3' | '4-5' | '6-8' | '9_plus';

export function bucketMirrorCropCount(count: number): MirrorCropCountBucket {
  if (!(count > 0)) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 5) return '4-5';
  if (count <= 8) return '6-8';
  return '9_plus';
}

export type MirrorSourceCountBucket = '1' | '2-3' | '4_plus';

export function bucketMirrorSourceCount(count: number): MirrorSourceCountBucket {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  return '4_plus';
}

/**
 * Duration buckets.
 *
 * No existing bounded duration convention was found in the repository — the
 * `latencyBucket` property is spelled per-module — so the ladder specified by
 * the Step 3 addendum is used verbatim rather than a new one being invented.
 */
export type MirrorDurationBucket =
  | 'under_5s'
  | '5_to_15s'
  | '15_to_30s'
  | '30_to_60s'
  | 'over_60s';

export function bucketMirrorDuration(durationMs: number): MirrorDurationBucket {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 5_000) return 'under_5s';
  if (ms < 15_000) return '5_to_15s';
  if (ms < 30_000) return '15_to_30s';
  if (ms < 60_000) return '30_to_60s';
  return 'over_60s';
}

export function emitMirrorSourceSelected(input: {
  sourceType: MirrorSourceType;
  sourceCount: number;
}): void {
  emitClosetCandidateEvent('mirror_selfie_source_selected', {
    sourceType: input.sourceType,
    sourceCountBucket: bucketMirrorSourceCount(input.sourceCount),
  });
}

export function emitMirrorValidationCompleted(input: {
  outcome: 'accepted' | 'rejected';
  errorCode?: MirrorExtractionErrorCode | null;
}): void {
  emitClosetCandidateEvent('mirror_selfie_validation_completed', {
    outcome: input.outcome,
    errorCode: input.errorCode ?? null,
  });
}

export function emitMirrorExtractionCompleted(input: {
  outcome: 'extracted' | 'no_person' | 'ambiguous_people' | 'no_regions' | 'unsupported' | 'failed';
  personCountBucket: '0' | '1' | '2_plus';
  cropCount: number;
  reviewCount: number;
  durationMs: number;
  extractionSupported: boolean;
  personSelectionRequired: boolean;
  errorCode?: MirrorExtractionErrorCode | null;
}): void {
  emitClosetCandidateEvent('mirror_selfie_extraction_completed', {
    outcome: input.outcome,
    personCountBucket: input.personCountBucket,
    cropCountBucket: bucketMirrorCropCount(input.cropCount),
    reviewCountBucket: bucketMirrorCropCount(input.reviewCount),
    durationBucket: bucketMirrorDuration(input.durationMs),
    extractionSupported: input.extractionSupported,
    personSelectionRequired: input.personSelectionRequired,
    errorCode: input.errorCode ?? null,
  });
}

export function emitMirrorExtractionCancelled(input: {
  status: string;
  cropCount: number;
}): void {
  emitClosetCandidateEvent('mirror_selfie_extraction_cancelled', {
    status: input.status,
    cropCountBucket: bucketMirrorCropCount(input.cropCount),
  });
}

export function emitMirrorCropReviewCompleted(input: {
  cropCount: number;
  selectedCount: number;
  outcome: 'accepted' | 'zero_selected' | 'cancelled';
}): void {
  emitClosetCandidateEvent('mirror_selfie_crop_review_completed', {
    cropCountBucket: bucketMirrorCropCount(input.cropCount),
    selectedCountBucket: bucketMirrorCropCount(input.selectedCount),
    outcome: input.outcome,
  });
}
