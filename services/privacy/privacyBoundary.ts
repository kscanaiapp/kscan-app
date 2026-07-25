// Unified privacy boundary for every image-egress route.
//
// One shared entry point sits in front of base64 conversion, Edge Function
// invocation, and Storage upload. It returns exactly two states:
//   SANITIZED_AND_VERIFIED — sanitized artifact + truthful proof
//   BLOCKED               — typed failure; nothing may dispatch
// There is no third state and no fallback that transmits the original image.
//
// Until on-device license-plate detection exists, the gate is closed and
// every image route fails closed by design.

import {
  cleanupNativeSanitizedImage,
  detectAndMaskFacesLocal,
  isNativeFaceEngineLinked,
} from './nativeFaceEngine';
import { PLATE_DETECTION_SUPPORTED, detectPlates } from './plateDetection';
import {
  buildBlockedProof,
  buildProofFromResults,
  type PrivacyProof,
} from './privacyProof';
import {
  deletePrivacyArtifact,
  isOwnedPrivacyArtifactUri,
} from './privacyArtifactStore';
import { MaterializeError, materializeImageForPrivacy } from './uriMaterializer';

export const PRIVACY_DISPATCH_BLOCKED_MESSAGE =
  'Image processing is unavailable until on-device face and license-plate masking can be verified.';

const PIPELINE_SANITIZER_VERSION = 'privacy-boundary-1.0.0';

export type PrivacyBoundaryErrorCode =
  | 'PLATE_CAPABILITY_MISSING'
  | 'FACE_ENGINE_UNAVAILABLE'
  | 'SOURCE_ACCESS_FAILED'
  | 'FACE_PROCESSING_FAILED'
  | 'PLATE_PROCESSING_FAILED'
  | 'VERIFICATION_FAILED';

export class PrivacyDispatchBlockedError extends Error {
  code: PrivacyBoundaryErrorCode;

  constructor(code: PrivacyBoundaryErrorCode, message: string = PRIVACY_DISPATCH_BLOCKED_MESSAGE) {
    super(message);
    this.name = 'PrivacyDispatchBlockedError';
    this.code = code;
  }
}

export type PrivacyBoundaryResult =
  | {
      status: 'SANITIZED_AND_VERIFIED';
      sanitizedUri: string;
      proof: PrivacyProof;
      /** Removes the sanitized artifact. Idempotent; call in finally. */
      cleanup: () => Promise<void>;
    }
  | {
      status: 'BLOCKED';
      errorCode: PrivacyBoundaryErrorCode;
      reason: string;
      userMessage: string;
      proof: PrivacyProof;
    };

/**
 * Synchronous dispatch gate consulted by every image-egress seam before any
 * base64 conversion, Edge invocation, or Storage upload.
 *
 * available = face engine linked AND plate detector available AND local
 * masking available AND output verification available. Masking and
 * verification ship inside the native face engine, so its linked state
 * carries those two terms. Plate detection is unsupported in this build,
 * therefore this returns false.
 */
export function isImageDispatchAllowed(): boolean {
  return PLATE_DETECTION_SUPPORTED && isNativeFaceEngineLinked();
}

function blocked(
  errorCode: PrivacyBoundaryErrorCode,
  reason: string,
): PrivacyBoundaryResult {
  return {
    status: 'BLOCKED',
    errorCode,
    reason,
    userMessage: PRIVACY_DISPATCH_BLOCKED_MESSAGE,
    proof: buildBlockedProof(PIPELINE_SANITIZER_VERSION),
  };
}

/**
 * Full privacy preparation for one image source (content:// or file://).
 *
 * Order: capability gate → materialize into app-private cache → local face
 * detection + irreversible masking → local plate detection → proof. The
 * materialized original is always removed in finally. On any failure every
 * created artifact is removed and the result is BLOCKED.
 */
export async function prepareImageForDispatch(
  sourceUri: string,
): Promise<PrivacyBoundaryResult> {
  // Cheapest checks first: a missing capability blocks before any file work.
  if (!PLATE_DETECTION_SUPPORTED) {
    return blocked(
      'PLATE_CAPABILITY_MISSING',
      'On-device license-plate detection is not available in this build.',
    );
  }
  if (!isNativeFaceEngineLinked()) {
    return blocked(
      'FACE_ENGINE_UNAVAILABLE',
      'The native face-masking engine is not present in this binary.',
    );
  }

  let materializedUri: string | null = null;
  let sanitizedUri: string | null = null;
  try {
    try {
      const materialized = await materializeImageForPrivacy(sourceUri);
      materializedUri = materialized.uri;
    } catch (err) {
      const reason =
        err instanceof MaterializeError ? `${err.code}: ${err.message}` : String(err);
      return blocked('SOURCE_ACCESS_FAILED', reason);
    }

    const faceResult = await detectAndMaskFacesLocal({ imageUri: materializedUri });
    if (!faceResult) {
      return blocked('FACE_ENGINE_UNAVAILABLE', 'Native face engine call was unavailable.');
    }
    if (faceResult.status !== 'success' && faceResult.status !== 'no_faces') {
      return blocked(
        'FACE_PROCESSING_FAILED',
        `${faceResult.errorCode ?? 'UNKNOWN'}: ${faceResult.failureReason ?? 'Face processing failed.'}`,
      );
    }
    if (!faceResult.sanitizedUri) {
      return blocked('VERIFICATION_FAILED', 'No verified sanitized output was produced.');
    }
    sanitizedUri = faceResult.sanitizedUri;

    const plateResult = await detectPlates({ imageUri: sanitizedUri });
    if (!plateResult.supported || !plateResult.performed || plateResult.failure) {
      return blocked(
        'PLATE_PROCESSING_FAILED',
        plateResult.failure?.reason ?? 'Plate detection did not complete.',
      );
    }

    const proof = buildProofFromResults(faceResult, plateResult);
    if (!proof.processingCompleted || !proof.outputVerified) {
      return blocked('VERIFICATION_FAILED', 'Privacy proof does not attest a completed run.');
    }

    const stableSanitizedUri = sanitizedUri;
    sanitizedUri = null; // Ownership transfers to the caller's cleanup handle.
    return {
      status: 'SANITIZED_AND_VERIFIED',
      sanitizedUri: stableSanitizedUri,
      proof,
      cleanup: async () => {
        await cleanupNativeSanitizedImage(stableSanitizedUri);
        if (isOwnedPrivacyArtifactUri(stableSanitizedUri)) {
          await deletePrivacyArtifact(stableSanitizedUri);
        }
      },
    };
  } finally {
    // The materialized original never outlives processing, and a sanitized
    // artifact from a failed run never survives either.
    await deletePrivacyArtifact(materializedUri);
    if (sanitizedUri) {
      await cleanupNativeSanitizedImage(sanitizedUri);
      await deletePrivacyArtifact(sanitizedUri);
    }
  }
}
