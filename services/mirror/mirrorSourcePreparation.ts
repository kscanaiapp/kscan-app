// Mirror Selfie source preparation (Build 2.5 Step 3).
//
// Turns a picker-owned URI into two app-owned, metadata-free, upright JPEGs:
//
//   normalized source   long edge <= 1440   crops are cut from THIS
//   inference image     long edge <=  896   detection is run on THIS
//
// ORDER IS THE CONTRACT, not a style preference:
//
//   1. read the external file's size          (cheap reject before any decode)
//   2. re-encode into app-owned storage       (copy + EXIF bake + strip, one op)
//   3. validate the RESULT's dimensions       (only now do we know them)
//   4. derive the bounded inference image     (from the normalized copy)
//
// WHY 2 IS ONE OPERATION. expo-image-manipulator decodes applying the source
// EXIF orientation, then writes a fresh JPEG with no orientation tag and no
// inherited metadata. Copying the file first and rotating it afterwards would
// mean an unrotated original briefly sits in our storage, and a separate rotate
// would apply the orientation a SECOND time on top of a baked one. The existing
// candidate pipeline made the same call for the same reason —
// services/closetCandidateMedia.js:246.
//
// WHY DIMENSION VALIDATION COMES AFTER. The picker does not reliably report
// dimensions for every source, and a gallery image may have been edited,
// re-compressed or rotated by another app. The only dimensions worth trusting
// are the ones our own decode produced.
//
// THE EXTERNAL FILE IS NEVER TOUCHED. It is opened read-only, exactly once, by
// the manipulator. It is never moved, never deleted, never rewritten.

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import {
  MIRROR_INFERENCE_MAX_EDGE,
  MIRROR_MAX_SOURCE_BYTES,
  MIRROR_MIN_SOURCE_EDGE,
  MIRROR_NORMALIZED_SOURCE_MAX_EDGE,
  MIRROR_CROP_QUALITY,
} from '../../types/mirrorExtraction';
import type { MirrorExtractionErrorCode } from '../../types/mirrorExtraction';
import {
  createMirrorSourcePath,
  ensureMirrorSessionDirs,
  isMirrorSessionOwnedUri,
  mirrorSourceDir,
} from './mirrorSessionStorage';
import { inspectJpegBase64, isMetadataFreeJpeg } from './jpegMetadata';

export type PreparedMirrorSource = {
  /** App-owned, upright, metadata-free. Crops are cut from this. */
  normalizedUri: string;
  normalizedWidth: number;
  normalizedHeight: number;
  /** Bounded copy fed to the detector. Same aspect ratio as the above. */
  inferenceUri: string;
  inferenceWidth: number;
  inferenceHeight: number;
};

export type PrepareMirrorSourceResult =
  | { kind: 'ok'; source: PreparedMirrorSource }
  | { kind: 'rejected'; errorCode: MirrorExtractionErrorCode };

type Deps = {
  FileSystem?: typeof FileSystem;
  ImageManipulator?: typeof ImageManipulator;
  /** Test seam only; production always inspects real bytes. */
  verifyMetadata?: boolean;
};

/**
 * Resize op that never UPSCALES.
 *
 * expo-image-manipulator's `resize` scales in both directions, so passing a
 * width larger than the source enlarges it — spending bytes and memory to
 * invent detail. An image already inside the ceiling is re-encoded without a
 * resize op at all, which still bakes orientation and still strips metadata.
 */
function boundingResizeOps(
  width: number,
  height: number,
  maxEdge: number,
): Array<{ resize: { width?: number; height?: number } }> {
  if (!(width > 0) || !(height > 0)) return [];
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return [];
  return width >= height ? [{ resize: { width: maxEdge } }] : [{ resize: { height: maxEdge } }];
}

/**
 * Read a bounded prefix of a JPEG and confirm it carries no identifying
 * metadata. Fail-closed: unreadable or unparseable counts as dirty.
 *
 * 64 KiB is generously past the segment chain — EXIF with a thumbnail rarely
 * exceeds 64 KiB and everything metadata-bearing precedes the scan data.
 */
export async function verifyJpegIsMetadataFree(
  uri: string,
  deps: { FileSystem?: typeof FileSystem } = {},
): Promise<boolean> {
  const fs = deps.FileSystem ?? FileSystem;
  try {
    const base64 = await fs.readAsStringAsync(uri, {
      encoding: 'base64',
      position: 0,
      length: 64 * 1024,
    } as any);
    return isMetadataFreeJpeg(inspectJpegBase64(base64));
  } catch {
    return false;
  }
}

/**
 * Prepare one source image for extraction.
 *
 * @param sourceUri  picker-owned URI. Read only. Never modified.
 */
export async function prepareMirrorSource(
  input: {
    extractionSessionId: string;
    sourceUri: string;
    /**
     * Dimensions as reported by the picker (ImagePickerAsset.width/height).
     *
     * LOAD-BEARING, not a hint. Without them the normalization resize has to be
     * applied blind, and a blind `resize: { width: 1440 }` UPSCALES a small
     * photo — after which the minimum-size guard is measuring an enlarged copy
     * and can never fire. With them we reject an unusably small source before
     * any decode, and we only ever resize downward.
     *
     * When absent the pipeline still works, but the minimum-size check runs
     * against the produced copy and can only be too lenient, never too strict.
     */
    sourceWidth?: number | null;
    sourceHeight?: number | null;
  },
  deps: Deps = {},
): Promise<PrepareMirrorSourceResult> {
  const fs = deps.FileSystem ?? FileSystem;
  const manipulator = deps.ImageManipulator ?? ImageManipulator;
  const verifyMetadata = deps.verifyMetadata !== false;
  const { extractionSessionId, sourceUri } = input ?? ({} as any);

  if (typeof sourceUri !== 'string' || !sourceUri.trim()) {
    return { kind: 'rejected', errorCode: 'mirror_source_unreadable' };
  }

  // (1) Cheap rejects, BEFORE any decode. A decode of a 48MP file is the step
  // that actually exhausts device memory, so the guard sits in front of it.
  try {
    const info = await fs.getInfoAsync(sourceUri);
    if (!info?.exists) {
      return { kind: 'rejected', errorCode: 'mirror_source_unreadable' };
    }
    if (typeof info.size === 'number' && info.size > MIRROR_MAX_SOURCE_BYTES) {
      return { kind: 'rejected', errorCode: 'mirror_source_too_large' };
    }
    if (typeof info.size === 'number' && info.size === 0) {
      return { kind: 'rejected', errorCode: 'mirror_source_unreadable' };
    }
  } catch {
    return { kind: 'rejected', errorCode: 'mirror_source_unreadable' };
  }

  // (1b) Reject an unusably small source BEFORE decoding it, using the picker's
  // own dimensions. Doing it here rather than after normalization is what makes
  // the check meaningful — see the sourceWidth note above.
  const declaredWidth = Number(input?.sourceWidth) || 0;
  const declaredHeight = Number(input?.sourceHeight) || 0;
  const dimensionsKnown = declaredWidth > 0 && declaredHeight > 0;
  if (dimensionsKnown && Math.min(declaredWidth, declaredHeight) < MIRROR_MIN_SOURCE_EDGE) {
    return { kind: 'rejected', errorCode: 'mirror_source_too_small' };
  }

  if (!(await ensureMirrorSessionDirs(extractionSessionId, { FileSystem: fs }))) {
    return { kind: 'rejected', errorCode: 'mirror_session_storage_failed' };
  }

  // (2) Copy + orientation bake + metadata strip, in ONE decode.
  //
  // The resize op is emitted only when it would SHRINK the image, and is
  // carried in the same call so the native decoder can subsample rather than
  // materialize a 50-megapixel bitmap and then throw most of it away.
  const normalizeOps = dimensionsKnown
    ? boundingResizeOps(declaredWidth, declaredHeight, MIRROR_NORMALIZED_SOURCE_MAX_EDGE)
    : [{ resize: { width: MIRROR_NORMALIZED_SOURCE_MAX_EDGE } }];

  let normalized: { uri?: string; width?: number; height?: number };
  try {
    normalized = await manipulator.manipulateAsync(sourceUri, normalizeOps, {
      compress: MIRROR_CROP_QUALITY,
      format: manipulator.SaveFormat.JPEG,
    });
  } catch {
    // A decode failure here is any of: unsupported format, corrupt file, or an
    // image the platform refuses. They are indistinguishable from JS and all
    // mean the same thing to the user.
    return { kind: 'rejected', errorCode: 'mirror_source_unsupported' };
  }

  if (!normalized?.uri) {
    return { kind: 'rejected', errorCode: 'mirror_source_unsupported' };
  }

  // The manipulator writes into the OS cache. Move it under session ownership
  // so cleanup can reach it and so nothing outside the session owns our source.
  const normalizedUri = createMirrorSourcePath(extractionSessionId);
  try {
    await fs.moveAsync({ from: normalized.uri, to: normalizedUri });
  } catch {
    await safeDelete(fs, normalized.uri);
    return { kind: 'rejected', errorCode: 'mirror_session_storage_failed' };
  }

  const normalizedWidth = Number(normalized.width) || 0;
  const normalizedHeight = Number(normalized.height) || 0;

  // (3) Validate what we actually produced.
  if (!(normalizedWidth > 0) || !(normalizedHeight > 0)) {
    await purgeSource(fs, extractionSessionId);
    return { kind: 'rejected', errorCode: 'mirror_source_dimensions_invalid' };
  }
  // Second minimum-size gate, for the case where the picker gave us nothing to
  // check up front. It measures the produced copy, so if the blind resize
  // enlarged a small photo this can only be too LENIENT — never too strict.
  if (Math.min(normalizedWidth, normalizedHeight) < MIRROR_MIN_SOURCE_EDGE) {
    await purgeSource(fs, extractionSessionId);
    return { kind: 'rejected', errorCode: 'mirror_source_too_small' };
  }

  if (verifyMetadata && !(await verifyJpegIsMetadataFree(normalizedUri, { FileSystem: fs }))) {
    // The strip is the entire reason this copy exists. If it did not happen,
    // the copy is worse than useless and must not survive.
    await purgeSource(fs, extractionSessionId);
    return { kind: 'rejected', errorCode: 'mirror_source_unsupported' };
  }

  // (4) Bounded inference image, derived from the NORMALIZED copy — never from
  // the external original, which by now we have deliberately stopped touching.
  const inferenceOps = boundingResizeOps(
    normalizedWidth,
    normalizedHeight,
    MIRROR_INFERENCE_MAX_EDGE,
  );

  let inferenceUri = normalizedUri;
  let inferenceWidth = normalizedWidth;
  let inferenceHeight = normalizedHeight;

  if (inferenceOps.length > 0) {
    try {
      const inference = await manipulator.manipulateAsync(normalizedUri, inferenceOps, {
        compress: MIRROR_CROP_QUALITY,
        format: manipulator.SaveFormat.JPEG,
      });
      if (inference?.uri) {
        const ownedInference = createMirrorSourcePath(extractionSessionId);
        try {
          await fs.moveAsync({ from: inference.uri, to: ownedInference });
          inferenceUri = ownedInference;
          inferenceWidth = Number(inference.width) || 0;
          inferenceHeight = Number(inference.height) || 0;
        } catch {
          await safeDelete(fs, inference.uri);
        }
      }
    } catch {
      // Detection on the 1440 copy is slower but correct. Coordinates are
      // normalized 0..1, so the mapping is unaffected either way.
    }
  }

  if (!(inferenceWidth > 0) || !(inferenceHeight > 0)) {
    inferenceUri = normalizedUri;
    inferenceWidth = normalizedWidth;
    inferenceHeight = normalizedHeight;
  }

  return {
    kind: 'ok',
    source: {
      normalizedUri,
      normalizedWidth,
      normalizedHeight,
      inferenceUri,
      inferenceWidth,
      inferenceHeight,
    },
  };
}

async function safeDelete(fs: typeof FileSystem, uri: string | undefined): Promise<void> {
  if (!uri) return;
  try {
    await fs.deleteAsync(uri, { idempotent: true });
  } catch {
    /* a stranded cache file is not a reason to fail intake */
  }
}

async function purgeSource(fs: typeof FileSystem, extractionSessionId: string): Promise<void> {
  try {
    await fs.deleteAsync(mirrorSourceDir(extractionSessionId), { idempotent: true });
  } catch {
    /* best-effort */
  }
}

export { boundingResizeOps as __boundingResizeOpsForTests, isMirrorSessionOwnedUri };
