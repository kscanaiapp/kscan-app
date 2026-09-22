// Receipt & Purchase Intelligence V1 — the on-device minimization boundary.
//
// PRIVACY PATH B (docs/receipt-intelligence/00-phase0-decision-log.md):
//
//     USER-SELECTED IMAGE -> REQUIRED LINE-ITEM CROP -> METADATA STRIP -> PROVIDER
//
// No on-device text redaction exists in this app. The crop is therefore the
// deliberate data-minimization step: the customer frames the purchased items
// and leaves out addresses, contact details and payment information. The UI
// says so, and nothing here claims that a crop guarantees PII is gone.
//
// METADATA STRIP: the crop is re-encoded by expo-image-manipulator, which
// decodes to a bitmap and writes a fresh JPEG (iOS `UIImage.jpegData`, Android
// `Bitmap.compress`). EXIF, GPS, device and timestamp metadata from the source
// are not carried into the output.
//
// BOUNDS (BLOCK-RPI-32): a crop that would exceed the height or size bound is
// REFUSED with `file_too_large`. It is never truncated.
//
// TEMP LIFECYCLE (BLOCK-RPI-35):
//   location  cacheDirectory/kscan_purchase_import/ (app-private, OS-purgeable)
//   contents  the customer's picked image, copied in, and nothing else. The
//             cropped JPEG exists only long enough to be read as base64.
//   cleanup   discardPurchaseImportArtifacts() on completion, cancellation,
//             terminal failure, actor switch and screen exit, and
//             sweepPurchaseImportArtifacts() on every feature entry, which
//             covers abandonment (a killed app) as well.
// Nothing is written to the Closet, Recent Scans, Inspiration, Saved Looks or
// Dressing Rooms, and nothing survives past the next entry to this feature.

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import {
  PURCHASE_IMPORT_JPEG_QUALITY,
  PURCHASE_IMPORT_MAX_EDGE_PX,
  PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES,
  PURCHASE_IMPORT_TARGET_WIDTH,
} from './purchaseImportContract';
import type { PurchaseImportErrorClass } from './purchaseImportErrors';

export const PURCHASE_IMPORT_TEMP_DIRNAME = 'kscan_purchase_import/';

export function purchaseImportTempDir(): string | null {
  return FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}${PURCHASE_IMPORT_TEMP_DIRNAME}` : null;
}

/** Mime types accepted for an order confirmation or receipt image. */
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/webp']);
const ACCEPTED_EXTENSION = /\.(jpe?g|png|heic|heif|webp)$/i;

/** Crop as fractions of the source image, top-left origin. */
export type NormalizedCrop = { x: number; y: number; width: number; height: number };

/** Smallest crop accepted, as a fraction of each source dimension. */
export const MIN_CROP_FRACTION = 0.05;

export type PickedImage = {
  uri: string;
  width: number;
  height: number;
  mimeType?: string | null;
  fileName?: string | null;
};

export type StagedImage = PickedImage & { stagedUri: string };

export type PreparedImage =
  | { ok: true; base64: string; width: number; height: number; byteLength: number }
  | { ok: false; errorClass: PurchaseImportErrorClass };

/** True when a picked file looks like an image this feature accepts. */
export function isAcceptedPickedImage(image: PickedImage | null | undefined): boolean {
  if (!image || typeof image.uri !== 'string' || !image.uri) return false;
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height)) return false;
  if (image.width < 64 || image.height < 64) return false;
  const mime = typeof image.mimeType === 'string' ? image.mimeType.toLowerCase() : '';
  if (mime) return ACCEPTED_MIME.has(mime);
  // Filenames are untrusted and only ever consulted for their extension.
  const name = typeof image.fileName === 'string' ? image.fileName : image.uri;
  return ACCEPTED_EXTENSION.test(name.split('?')[0]);
}

/** Clamp a crop into the unit square and reject one that is too small to hold a line. */
export function normalizeCrop(crop: NormalizedCrop | null | undefined): NormalizedCrop | null {
  if (!crop) return null;
  const nums = [crop.x, crop.y, crop.width, crop.height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const x = Math.min(Math.max(crop.x, 0), 1);
  const y = Math.min(Math.max(crop.y, 0), 1);
  const width = Math.min(Math.max(crop.width, 0), 1 - x);
  const height = Math.min(Math.max(crop.height, 0), 1 - y);
  if (width < MIN_CROP_FRACTION || height < MIN_CROP_FRACTION) return null;
  return { x, y, width, height };
}

/** Pixel crop and output size for a source image, or a bounded refusal. */
export function planCrop(
  source: { width: number; height: number },
  crop: NormalizedCrop,
):
  | { ok: true; originX: number; originY: number; cropWidth: number; cropHeight: number; outWidth: number; outHeight: number }
  | { ok: false; errorClass: PurchaseImportErrorClass } {
  const originX = Math.floor(crop.x * source.width);
  const originY = Math.floor(crop.y * source.height);
  const cropWidth = Math.max(1, Math.min(Math.round(crop.width * source.width), source.width - originX));
  const cropHeight = Math.max(1, Math.min(Math.round(crop.height * source.height), source.height - originY));
  const outWidth = Math.min(cropWidth, PURCHASE_IMPORT_TARGET_WIDTH);
  const outHeight = Math.round(cropHeight * (outWidth / cropWidth));
  if (outHeight > PURCHASE_IMPORT_MAX_EDGE_PX) return { ok: false, errorClass: 'file_too_large' };
  return { ok: true, originX, originY, cropWidth, cropHeight, outWidth, outHeight };
}

async function deleteQuietly(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // A file that cannot be deleted now is removed by the next entry sweep.
  }
}

/**
 * Copy the picked image into this feature's own temp namespace, then remove
 * the picker's cache copy if it is inside this app's cache. The customer's
 * photo library is never touched: only a copy the picker wrote into our cache
 * is deleted.
 */
export async function stagePickedImage(image: PickedImage): Promise<StagedImage | null> {
  const dir = purchaseImportTempDir();
  if (!dir || !isAcceptedPickedImage(image)) return null;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => null);
    const name = (typeof image.fileName === 'string' && image.fileName) || image.uri;
    const extension = (ACCEPTED_EXTENSION.exec(name.split('?')[0])?.[0] ?? '.jpg').toLowerCase();
    const stagedUri = `${dir}source_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}${extension}`;
    await FileSystem.copyAsync({ from: image.uri, to: stagedUri });
    if (FileSystem.cacheDirectory && image.uri.startsWith(FileSystem.cacheDirectory) && !image.uri.startsWith(dir)) {
      await deleteQuietly(image.uri);
    }
    return { ...image, stagedUri };
  } catch {
    return null;
  }
}

/**
 * Crop, strip metadata, bound, and read as base64. The intermediate JPEG is
 * deleted before this returns, whatever the outcome.
 */
export async function prepareCroppedImage(staged: StagedImage, crop: NormalizedCrop): Promise<PreparedImage> {
  const normalized = normalizeCrop(crop);
  if (!normalized) return { ok: false, errorClass: 'invalid_file' };
  const plan = planCrop(staged, normalized);
  if (plan.ok === false) return { ok: false, errorClass: plan.errorClass };

  let outputUri: string | null = null;
  try {
    const result = await ImageManipulator.manipulateAsync(
      staged.stagedUri,
      [
        { crop: { originX: plan.originX, originY: plan.originY, width: plan.cropWidth, height: plan.cropHeight } },
        { resize: { width: plan.outWidth } },
      ],
      { compress: PURCHASE_IMPORT_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    outputUri = result?.uri ?? null;
    const base64 = typeof result?.base64 === 'string' ? result.base64 : '';
    if (!base64) return { ok: false, errorClass: 'invalid_file' };
    if (base64.length > PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES) return { ok: false, errorClass: 'file_too_large' };
    if ((result.height ?? plan.outHeight) > PURCHASE_IMPORT_MAX_EDGE_PX) return { ok: false, errorClass: 'file_too_large' };
    return {
      ok: true,
      base64,
      width: result.width ?? plan.outWidth,
      height: result.height ?? plan.outHeight,
      byteLength: Math.floor((base64.length * 3) / 4),
    };
  } catch {
    return { ok: false, errorClass: 'invalid_file' };
  } finally {
    await deleteQuietly(outputUri);
  }
}

/** Remove one session's staged source. */
export async function discardPurchaseImportArtifacts(staged: StagedImage | null | undefined): Promise<void> {
  await deleteQuietly(staged?.stagedUri);
}

/**
 * Remove EVERYTHING in this feature's temp namespace. Called on every entry
 * and exit, so a session abandoned by a crash or a force-quit is cleaned the
 * next time the customer opens the feature.
 */
export async function sweepPurchaseImportArtifacts(): Promise<void> {
  await deleteQuietly(purchaseImportTempDir());
}
