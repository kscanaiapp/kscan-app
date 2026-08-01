// Garment crop generation (Build 2.5 Step 3).
//
// Turns derived regions into REAL FILES on disk. Nothing here is a placeholder
// rectangle or a mocked record: each output is a JPEG the OS can open, cut from
// the app-owned normalized source, verified to carry no metadata, and readable
// until the session is cleaned.
//
// ENCODE SETTINGS ARE THE REPOSITORY'S, NOT NEW ONES. JPEG at quality 0.9 with
// a 1440px ceiling is exactly what services/closetCandidateMedia.js produces for
// every other Closet intake. A Mirror crop that arrives at deriveCandidateMedia
// in a different format or a smaller box would silently downgrade the item it
// eventually becomes.
//
// NO UPSCALING. A foot region is a small part of the frame; resizing it up to
// 1440 would spend a megabyte inventing detail that is not in the source. The
// resize op is emitted only when the crop is genuinely wider than the ceiling.
//
// THE SOURCE SELFIE IS NEVER A CROP. Crop generation only ever runs on a region
// strictly inside the normalized source, and `mirrorSourceIsNotACrop` below is
// the assertion that makes that structural rather than incidental.

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import {
  MIRROR_CROP_MAX_EDGE,
  MIRROR_CROP_QUALITY,
} from '../../types/mirrorExtraction';
import type { LocalMirrorGarmentCrop, NormalizedBounds } from '../../types/mirrorExtraction';
import type { DerivedMirrorRegion } from './mirrorGarmentRegions';
import {
  createMirrorCropPath,
  deleteMirrorSessionFile,
  isMirrorSessionOwnedUri,
} from './mirrorSessionStorage';
import { verifyJpegIsMetadataFree } from './mirrorSourcePreparation';

export type GenerateCropsInput = {
  extractionSessionId: string;
  normalizedSourceUri: string;
  normalizedWidth: number;
  normalizedHeight: number;
  sourceImageIndex: number;
  regions: DerivedMirrorRegion[];
};

export type GenerateCropsResult = {
  crops: LocalMirrorGarmentCrop[];
  /** Regions that produced no usable file. Bounded count, never a reason string. */
  failedCount: number;
};

type Deps = {
  FileSystem?: typeof FileSystem;
  ImageManipulator?: typeof ImageManipulator;
  verifyMetadata?: boolean;
  /** Checked between crops so a cancel lands mid-batch, not after it. */
  isCancelled?: () => boolean;
};

/**
 * Deterministic key for one crop within one session.
 *
 * Built ONLY from the source index, the region class and the region's ordinal
 * within that class — all of which come from the canonical region order. Same
 * image, same detector output, same keys, every time. Carries no URI, no
 * filename, no coordinate, and satisfies the Step 1 key pattern by
 * construction.
 */
export function buildCropKey(
  sourceImageIndex: number,
  regionClass: string,
  ordinalWithinClass: number,
): string {
  return `s${sourceImageIndex}_${regionClass}_${ordinalWithinClass}`;
}

/** Normalized rect → integer pixel rect inside the source, never outside it. */
export function toPixelCrop(
  bounds: NormalizedBounds,
  width: number,
  height: number,
): { originX: number; originY: number; width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const originX = Math.max(0, Math.floor(bounds.x * width));
  const originY = Math.max(0, Math.floor(bounds.y * height));
  // Ceil the extent so a thin region does not round away to nothing, then clamp
  // so the box cannot run past the last pixel.
  const cropWidth = Math.min(Math.ceil(bounds.width * width), width - originX);
  const cropHeight = Math.min(Math.ceil(bounds.height * height), height - originY);
  if (!(cropWidth > 0) || !(cropHeight > 0)) return null;
  return { originX, originY, width: cropWidth, height: cropHeight };
}

/**
 * Structural guarantee that a crop is a REGION of the source, not the source.
 *
 * A crop covering essentially the entire frame is the selfie with a new
 * filename. It is refused: passing it to Step 4 would stage a full-body photo
 * of the user as a garment candidate, which is precisely the outcome the
 * "original selfie never leaves the device" rule exists to prevent.
 */
export function mirrorSourceIsNotACrop(bounds: NormalizedBounds): boolean {
  const coversWholeFrame = bounds.width >= 0.985 && bounds.height >= 0.985;
  return !coversWholeFrame;
}

export async function generateMirrorGarmentCrops(
  input: GenerateCropsInput,
  deps: Deps = {},
): Promise<GenerateCropsResult> {
  const fs = deps.FileSystem ?? FileSystem;
  const manipulator = deps.ImageManipulator ?? ImageManipulator;
  const verifyMetadata = deps.verifyMetadata !== false;
  const isCancelled = deps.isCancelled ?? (() => false);

  const crops: LocalMirrorGarmentCrop[] = [];
  let failedCount = 0;
  const ordinals = new Map<string, number>();

  for (const region of input.regions ?? []) {
    if (isCancelled()) break;

    if (!mirrorSourceIsNotACrop(region.bounds)) {
      failedCount += 1;
      continue;
    }

    const pixels = toPixelCrop(region.bounds, input.normalizedWidth, input.normalizedHeight);
    if (!pixels) {
      failedCount += 1;
      continue;
    }

    const ordinal = ordinals.get(region.regionClass) ?? 0;
    ordinals.set(region.regionClass, ordinal + 1);
    const cropKey = buildCropKey(input.sourceImageIndex, region.regionClass, ordinal);

    const ops: any[] = [{ crop: pixels }];
    if (pixels.width > MIRROR_CROP_MAX_EDGE || pixels.height > MIRROR_CROP_MAX_EDGE) {
      ops.push(
        pixels.width >= pixels.height
          ? { resize: { width: MIRROR_CROP_MAX_EDGE } }
          : { resize: { height: MIRROR_CROP_MAX_EDGE } },
      );
    }

    let produced: { uri?: string; width?: number; height?: number };
    try {
      produced = await manipulator.manipulateAsync(input.normalizedSourceUri, ops, {
        compress: MIRROR_CROP_QUALITY,
        format: manipulator.SaveFormat.JPEG,
      });
    } catch {
      failedCount += 1;
      continue;
    }

    if (!produced?.uri) {
      failedCount += 1;
      continue;
    }

    // A cancel that landed while the manipulator was running must not leave a
    // file behind. This is the "delete any late-created files" half of the
    // advisory-cancellation contract.
    if (isCancelled()) {
      await safeDelete(fs, produced.uri);
      break;
    }

    const cropUri = createMirrorCropPath(input.extractionSessionId);
    try {
      await fs.moveAsync({ from: produced.uri, to: cropUri });
    } catch {
      await safeDelete(fs, produced.uri);
      failedCount += 1;
      continue;
    }

    if (verifyMetadata && !(await verifyJpegIsMetadataFree(cropUri, { FileSystem: fs }))) {
      // Fail-closed. A crop we cannot certify as metadata-free is destroyed
      // rather than shown, because the next thing that happens to a shown crop
      // is that the user approves it for staging.
      await deleteMirrorSessionFile(cropUri, input.extractionSessionId, { FileSystem: fs });
      failedCount += 1;
      continue;
    }

    crops.push({
      cropUri,
      cropKey,
      sourceImageIndex: input.sourceImageIndex,
      regionClass: region.regionClass,
      localBounds: region.bounds,
      localConfidenceBucket: region.confidenceBucket,
      cropWidth: Number(produced.width) || pixels.width,
      cropHeight: Number(produced.height) || pixels.height,
      // Everything the extractor produced starts selected; the review step is
      // about REMOVING what is wrong, not about re-approving what is right.
      selected: true,
    });
  }

  return { crops, failedCount };
}

async function safeDelete(fs: typeof FileSystem, uri: string | undefined): Promise<void> {
  if (!uri) return;
  try {
    await fs.deleteAsync(uri, { idempotent: true });
  } catch {
    /* best-effort */
  }
}

export { isMirrorSessionOwnedUri };
