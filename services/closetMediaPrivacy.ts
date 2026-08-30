// Build 34 / Track B / Phase B2A — on-device Closet media privacy boundary.
//
// THE ONE ENTRY POINT B2B MAY CALL to turn a local Closet image into
// cloud-eligible artifacts. It returns exactly two states:
//
//   SAFE    — a sanitized primary AND a sanitized thumbnail exist on disk,
//             both derived from the SAME verified sanitized source, plus the
//             privacy proof that attests the run actually happened.
//   BLOCKED — a machine-readable reason and NO cloud-eligible artifact.
//
// There is deliberately no third state, and no path anywhere in this file
// returns the caller's original image as a cloud-eligible artifact. If any
// step fails — module missing, detector unavailable, decode, masking,
// verification, encoding, thumbnail — the answer is BLOCKED and the Closet
// item simply stays local. That is the whole point of the phase: B1C proved
// the cloud contract, but the pre-existing sanitizer was a passthrough, so
// nothing may be uploaded until this boundary can prove a real run.
//
// WHAT THIS FILE DOES NOT DO: it performs no upload, opens no network
// connection, and imports nothing from Supabase. The entire transformation is
// local and is testable with networking unavailable (B2A scope rule).
//
// PII screening/masking itself lives in the native engine behind
// services/privacy/privacyBoundary.ts#prepareImageForDispatch. This module
// owns only the Closet-specific part: deriving B1C's two canonical artifacts
// from the sanitized output, and reporting an explicit safe/blocked verdict.

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import {
  prepareImageForDispatch,
  type PrivacyBoundaryErrorCode,
} from './privacy/privacyBoundary';
import type { PrivacyProof } from './privacy/privacyProof';
import {
  createArtifactPath,
  deletePrivacyArtifact,
  ensurePrivacyArtifactDir,
} from './privacy/privacyArtifactStore';

// ── Canonical Closet media contract ─────────────────────────────────────────
//
// Inherited, not invented. The primary width and the JPEG/size bounds match
// services/closetLibrary.js (IMAGE_WIDTH) and services/savedScanMedia.ts
// (content type + 5 MB ceiling), which is also what B1C recorded as the cloud
// contract.
//
// THIS THUMBNAIL WIDTH IS THE CLOUD-SYNC DERIVATIVE, NOT THE LOCAL UI ASSET.
// B1C (feature/backend-build34-closet-media-v1, services/closetMedia.ts) is
// the authority for what B2B may upload, and it declares 160 — this module
// conforms to that, not to any client-side rendering choice.
//
// This client line's own services/closetLibrary.js separately renders the
// LOCAL Closet UI thumbnail at 640, and that file is intentionally NOT
// touched by this correction: it governs on-device display, a different
// concept with a different lifecycle than the artifact this module hands to
// B2B for cloud upload. A prior pass of this file used 640 here too, treating
// the two as one concept; that was the defect — B1C's cloud contract must
// not be reinterpreted to match a client rendering preference.
export const CLOSET_MEDIA_PRIMARY_WIDTH = 1440;
export const CLOSET_MEDIA_THUMBNAIL_WIDTH = 160;
export const CLOSET_MEDIA_PRIMARY_QUALITY = 0.86;
export const CLOSET_MEDIA_THUMBNAIL_QUALITY = 0.8;
export const CLOSET_MEDIA_CONTENT_TYPE = 'image/jpeg';
export const CLOSET_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export const CLOSET_MEDIA_SANITIZER_VERSION = 'closet-media-privacy-1.0.0';

/**
 * Machine-readable blocked reasons. B2B maps these to retry/UX behaviour; they
 * are a closed vocabulary on purpose so no raw exception text ever reaches a
 * user-facing surface.
 */
export type ClosetMediaBlockedReason =
  | 'sanitizer_unavailable'
  | 'face_detector_unavailable'
  | 'face_sanitization_failed'
  | 'plate_detector_unavailable'
  /** A plate-shaped region was found. Build 34 blocks rather than masks. */
  | 'plate_detected'
  | 'detector_failed'
  | 'masking_failed'
  | 'metadata_strip_failed'
  | 'unsupported_format'
  | 'decode_failed'
  | 'memory_or_decode_failure'
  | 'primary_failed'
  | 'thumbnail_failed'
  | 'cancelled'
  | 'unexpected_native_result';

export interface ClosetMediaArtifact {
  /** file:// URI inside the app-private privacy namespace. Never the source. */
  uri: string;
  width: number;
  height: number;
  byteLength: number;
}

export type ClosetMediaSanitizationResult =
  | {
      status: 'SAFE';
      primary: ClosetMediaArtifact;
      thumbnail: ClosetMediaArtifact;
      mimeType: typeof CLOSET_MEDIA_CONTENT_TYPE;
      sanitizerVersion: string;
      /** Truthful attestation from the native run. Never hardcoded. */
      proof: PrivacyProof;
      privacyScanCompleted: true;
      metadataStripped: true;
      /** Removes BOTH derivatives. Idempotent; call once B2B has uploaded. */
      cleanup: () => Promise<void>;
    }
  | {
      status: 'BLOCKED';
      reason: ClosetMediaBlockedReason;
      /** Non-user-facing diagnostic. Never contains image content or a path. */
      detail: string;
      privacyScanCompleted: boolean;
      proof: PrivacyProof;
    };

/**
 * Boundary failures are already typed; this only narrows them to the closed
 * vocabulary B2B consumes. Anything unrecognized maps to the most conservative
 * reason rather than being passed through verbatim.
 */
function mapBoundaryError(code: PrivacyBoundaryErrorCode): ClosetMediaBlockedReason {
  switch (code) {
    case 'PLATE_CAPABILITY_MISSING':
      return 'plate_detector_unavailable';
    case 'FACE_ENGINE_UNAVAILABLE':
      return 'face_detector_unavailable';
    case 'SOURCE_ACCESS_FAILED':
      return 'decode_failed';
    case 'FACE_PROCESSING_FAILED':
      return 'face_sanitization_failed';
    case 'PLATE_DETECTED':
      return 'plate_detected';
    case 'PLATE_PROCESSING_FAILED':
      return 'detector_failed';
    case 'VERIFICATION_FAILED':
      return 'masking_failed';
    default:
      return 'unexpected_native_result';
  }
}

function isLocalImageUri(uri: unknown): uri is string {
  return typeof uri === 'string' && (uri.startsWith('file://') || uri.startsWith('content://'));
}

async function measure(uri: string): Promise<number> {
  // This module imports the LEGACY expo-file-system API (see the top-of-file
  // note), whose InfoOptions is `{ md5?: boolean }` only -- `size` is not an
  // opt-in there the way it is on the new API; the legacy FileInfo shape
  // returns `size` unconditionally whenever `exists` is true. Passing
  // `{ size: true }` against that type never changed what came back, but it
  // does not typecheck, and this was the one call site in this file `tsc`
  // had never actually been run against.
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return 0;
  const size = (info as { size?: number }).size;
  return typeof size === 'number' ? size : 0;
}

/**
 * Encode one derivative from an ALREADY-SANITIZED source into the privacy
 * namespace.
 *
 * `sanitizedSourceUri` is the only thing this ever reads. The caller must
 * never pass the user's original here — that is the thumbnail-leak class of
 * bug this pipeline exists to prevent, and it is asserted in the tests.
 */
async function encodeDerivative(
  sanitizedSourceUri: string,
  width: number,
  quality: number,
): Promise<ClosetMediaArtifact> {
  // ImageManipulator re-encodes from decoded pixels, which is what actually
  // drops EXIF/GPS/camera metadata; it does not copy a metadata block across.
  const rendered = await ImageManipulator.manipulateAsync(
    sanitizedSourceUri,
    [{ resize: { width } }],
    { compress: quality, format: ImageManipulator.SaveFormat.JPEG },
  );
  if (!rendered?.uri) throw new Error('encoder produced no output');

  await ensurePrivacyArtifactDir();
  const destination = createArtifactPath('sanitized', 'jpg');
  await FileSystem.moveAsync({ from: rendered.uri, to: destination });

  // From here the derivative lives inside the privacy cache. sanitizeClosetMedia
  // only learns about it once this function RETURNS one — its own cleanup
  // handles primary/thumbnail by reference, so anything this function creates
  // and then fails to return would otherwise be an orphaned artifact no outer
  // path can reach. Every failure from here must clean up `destination` itself
  // before rethrowing. This never touches sanitizedSourceUri or the caller's
  // original image — only the derivative this call just wrote.
  try {
    const byteLength = await measure(destination);
    if (byteLength <= 0) throw new Error('encoded artifact is empty');
    if (byteLength > CLOSET_MEDIA_MAX_BYTES) {
      throw new Error('encoded artifact exceeds the contract size ceiling');
    }
    return {
      uri: destination,
      width: rendered.width ?? width,
      height: rendered.height ?? 0,
      byteLength,
    };
  } catch (err) {
    await deletePrivacyArtifact(destination);
    throw err;
  }
}

function blockedResult(
  reason: ClosetMediaBlockedReason,
  detail: string,
  proof: PrivacyProof,
  privacyScanCompleted = false,
): ClosetMediaSanitizationResult {
  return { status: 'BLOCKED', reason, detail, privacyScanCompleted, proof };
}

/**
 * Produce cloud-eligible Closet media from a local image, or refuse.
 *
 * Sequence:
 *   input validation
 *     → prepareImageForDispatch (native: decode → face detect+mask →
 *       plate detect+mask → output verification → truthful proof)
 *     → sanitized primary   (JPEG, from the sanitized output ONLY)
 *     → sanitized thumbnail (JPEG, from the SAME sanitized output)
 *     → SAFE | BLOCKED
 *
 * The verified sanitized intermediate is always released, on every path. On
 * any failure after the first derivative is written, the already-written
 * derivative is deleted too, so a partial pair can never be mistaken for a
 * complete one.
 *
 * @param signal optional cancellation. Checked between stages; a cancelled run
 *   returns BLOCKED and leaves no artifact behind.
 */
export async function sanitizeClosetMedia(
  localUri: string,
  options: { signal?: { aborted: boolean } } = {},
): Promise<ClosetMediaSanitizationResult> {
  const emptyProof: PrivacyProof = {
    proofVersion: 'privacy-proof-1.0.0',
    sanitizerVersion: CLOSET_MEDIA_SANITIZER_VERSION,
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

  if (!isLocalImageUri(localUri)) {
    return blockedResult('unsupported_format', 'Input is not a local image URI.', emptyProof);
  }
  if (options.signal?.aborted) {
    return blockedResult('cancelled', 'Cancelled before processing started.', emptyProof);
  }

  const boundary = await prepareImageForDispatch(localUri);
  if (boundary.status === 'BLOCKED') {
    return blockedResult(
      mapBoundaryError(boundary.errorCode),
      boundary.reason,
      boundary.proof,
      boundary.proof.processingCompleted,
    );
  }

  // From here the sanitized artifact exists and MUST be released exactly once.
  let primary: ClosetMediaArtifact | null = null;
  let thumbnail: ClosetMediaArtifact | null = null;
  try {
    if (options.signal?.aborted) {
      return blockedResult('cancelled', 'Cancelled after sanitization.', boundary.proof, true);
    }

    try {
      primary = await encodeDerivative(
        boundary.sanitizedUri,
        CLOSET_MEDIA_PRIMARY_WIDTH,
        CLOSET_MEDIA_PRIMARY_QUALITY,
      );
    } catch (err) {
      return blockedResult(
        'primary_failed',
        `Primary encoding failed: ${err instanceof Error ? err.name : 'unknown'}`,
        boundary.proof,
        true,
      );
    }

    if (options.signal?.aborted) {
      return blockedResult('cancelled', 'Cancelled before thumbnail.', boundary.proof, true);
    }

    try {
      // SAME sanitized source as the primary. Deriving this from the original
      // would republish the very PII the primary just masked.
      thumbnail = await encodeDerivative(
        boundary.sanitizedUri,
        CLOSET_MEDIA_THUMBNAIL_WIDTH,
        CLOSET_MEDIA_THUMBNAIL_QUALITY,
      );
    } catch (err) {
      return blockedResult(
        'thumbnail_failed',
        `Thumbnail encoding failed: ${err instanceof Error ? err.name : 'unknown'}`,
        boundary.proof,
        true,
      );
    }

    // The proof is the native run's own attestation. A run that does not
    // attest completion and verification cannot yield SAFE, even though two
    // files now exist on disk — file existence is not evidence of privacy.
    if (!boundary.proof.processingCompleted || !boundary.proof.outputVerified) {
      return blockedResult(
        'unexpected_native_result',
        'Privacy proof does not attest a completed, verified run.',
        boundary.proof,
        false,
      );
    }

    const safePrimary = primary;
    const safeThumbnail = thumbnail;
    primary = null; // Ownership transfers to the caller's cleanup handle.
    thumbnail = null;
    return {
      status: 'SAFE',
      primary: safePrimary,
      thumbnail: safeThumbnail,
      mimeType: CLOSET_MEDIA_CONTENT_TYPE,
      sanitizerVersion: CLOSET_MEDIA_SANITIZER_VERSION,
      proof: boundary.proof,
      privacyScanCompleted: true,
      metadataStripped: true,
      cleanup: async () => {
        await deletePrivacyArtifact(safePrimary.uri);
        await deletePrivacyArtifact(safeThumbnail.uri);
      },
    };
  } finally {
    // The verified intermediate never outlives this call, and a half-written
    // derivative pair from a failed run never survives either.
    await boundary.cleanup();
    if (primary) await deletePrivacyArtifact(primary.uri);
    if (thumbnail) await deletePrivacyArtifact(thumbnail.uri);
  }
}

/**
 * Synchronous pre-check for callers that want to hide a Closet cloud affordance
 * rather than attempt and fail. Never a substitute for the real result: B2B
 * must still branch on the returned status, because capability can change
 * between this call and the run.
 */
export { isImageDispatchAllowed as isClosetMediaSanitizationAvailable } from './privacy/privacyBoundary';
