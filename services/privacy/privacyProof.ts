// Versioned internal privacy proof for the unified pipeline.
//
// Every field is derived from an actual processing result. Nothing here may
// be hardcoded to a success value; the builders below are the only producers.
// The proof describes the sanitized artifact, never the source image, and the
// currently transmitted client privacy field remains the truthful
// `localPrivacyFiltered: false` in scanIdentification until the owner
// authorizes a backend-contract change.

import type { NativeFaceMaskResult } from '../../modules/kscan-pii-native/src/KScanPiiNative.types';
import type { PlateDetectionResult } from './plateDetection';

export const PRIVACY_PROOF_VERSION = 'privacy-proof-1.0.0';

export interface PrivacyProof {
  proofVersion: string;
  sanitizerVersion: string;
  faceDetectionPerformed: boolean;
  facesDetected: number;
  facesMasked: number;
  plateDetectionPerformed: boolean;
  platesDetected: number;
  platesMasked: number;
  metadataStripped: boolean;
  outputVerified: boolean;
  processingCompleted: boolean;
}

/** Proof for a blocked run: nothing succeeded, nothing may dispatch. */
export function buildBlockedProof(sanitizerVersion: string): PrivacyProof {
  return {
    proofVersion: PRIVACY_PROOF_VERSION,
    sanitizerVersion,
    faceDetectionPerformed: false,
    facesDetected: 0,
    facesMasked: 0,
    plateDetectionPerformed: false,
    platesDetected: 0,
    platesMasked: 0,
    metadataStripped: false,
    outputVerified: false,
    processingCompleted: false,
  };
}

/**
 * Derive the proof strictly from the native face result and the plate
 * result. Face success comes only from the native result; plate success
 * comes only from a performed plate detection (impossible while the detector
 * is unsupported).
 */
export function buildProofFromResults(
  face: NativeFaceMaskResult,
  plate: PlateDetectionResult,
): PrivacyProof {
  const faceSucceeded = face.status === 'success' || face.status === 'no_faces';
  // A `no_faces` run still produces a real re-encoded, metadata-stripped
  // artifact (see nativeFaceEngine); it is verified output exactly like a
  // `success` run, not a lesser case that should fail outputVerified.
  const outputVerified = faceSucceeded && !!face.sanitizedUri;
  const plateCompleted = plate.supported && plate.performed && !plate.failure;
  return {
    proofVersion: PRIVACY_PROOF_VERSION,
    sanitizerVersion: face.sanitizerVersion,
    faceDetectionPerformed: faceSucceeded,
    facesDetected: face.facesDetected,
    facesMasked: face.facesMasked,
    plateDetectionPerformed: plateCompleted,
    platesDetected: plate.regionsDetected,
    // B2A: masked count comes from what the engine actually OBSCURED, not from
    // detection having completed. The previous form reported regionsAccepted
    // whenever the screen ran, which would have claimed masking on a build
    // that detected plates and never redacted them.
    platesMasked: plateCompleted ? plate.regionsMasked : 0,
    // The native pipeline re-encodes to PNG from a decoded bitmap; metadata
    // survives only if the native run did not produce a sanitized output.
    metadataStripped: outputVerified,
    outputVerified,
    processingCompleted: faceSucceeded && outputVerified && plateCompleted,
  };
}
