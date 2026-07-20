/**
 * K-SCAN local Style Library — scan persistence via expo-file-system.
 *
 * Storage layout (all paths under FileSystem.documentDirectory/kscan_library/):
 *   kscan_library/kscan_library.json  — JSON array of SavedScan objects, newest first
 *   kscan_library/images/<id>.jpg      — persistent scan image for explicit room upload
 *   kscan_library/thumbnails/<id>.jpg — persistent 160px-wide JPEG thumbnails
 *
 * All functions are safe to call in fire-and-forget fashion; they never throw.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { saveScanToCloud, softDeleteCloudSavedScan } from './savedScansCloud';
import { isPurchaseOptionsSnapshot, normalizePurchaseOptions } from './purchaseOptions';

const LIB_DIR      = FileSystem.documentDirectory + 'kscan_library/';
const LIBRARY_PATH = LIB_DIR + 'kscan_library.json';
const IMAGES_DIR   = LIB_DIR + 'images/';
const THUMBS_DIR   = LIB_DIR + 'thumbnails/';
const MAX_SCANS     = 25;
const THUMB_WIDTH   = 160; // px — small square-ish card thumbnail
const IMAGE_WIDTH   = 1440; // px — room-upload friendly, still compact
const VALID_SCAN_SOURCES = new Set(['camera', 'upload', 'textscan', 'unknown']);
let libraryMutationQueue = Promise.resolve();

// ── Internal helpers ──────────────────────────────────────────────────────────

async function ensureDirs() {
  try {
    // intermediates: true creates LIB_DIR and child dirs in one call
    await FileSystem.makeDirectoryAsync(IMAGES_DIR, { intermediates: true });
    await FileSystem.makeDirectoryAsync(THUMBS_DIR, { intermediates: true });
  } catch { /* non-fatal — directory may already exist */ }
}

async function persistLibrary(scans) {
  // Ensure LIB_DIR exists before writing (first-run safety)
  await FileSystem.makeDirectoryAsync(LIB_DIR, { intermediates: true }).catch(() => null);
  await FileSystem.writeAsStringAsync(
    LIBRARY_PATH,
    JSON.stringify(scans),
    { encoding: FileSystem.EncodingType.UTF8 }
  );
}

async function readAllLibrary() {
  const info = await FileSystem.getInfoAsync(LIBRARY_PATH);
  if (!info.exists) return [];
  const raw = await FileSystem.readAsStringAsync(LIBRARY_PATH);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];

  return parsed.map((scan) => {
    const hasValidPurchaseOptions = isPurchaseOptionsSnapshot(scan.purchaseOptions);
    const purchaseOptions = normalizePurchaseOptions(scan.purchaseOptions);
    return {
      ...scan,
      products: Array.isArray(scan.products) ? scan.products.slice() : [],
      purchaseOptions,
      commerceSnapshotVersion:
        hasValidPurchaseOptions &&
        (Number(scan.commerceSnapshotVersion) >= 1 ||
          Object.prototype.hasOwnProperty.call(scan, 'purchaseOptions'))
          ? 1
          : undefined,
    };
  });
}

function enqueueLibraryMutation(operation) {
  const result = libraryMutationQueue.then(operation, operation);
  libraryMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function normalizeScanSource(source) {
  return VALID_SCAN_SOURCES.has(source) ? source : 'camera';
}

function normalizeMultiScanMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const boundedId = (candidate) => (
    typeof candidate === 'string' && candidate.trim()
      ? candidate.trim().slice(0, 200)
      : null
  );
  const groupId = boundedId(value.groupId);
  const itemId = boundedId(value.itemId);
  const sourceImageId = boundedId(value.sourceImageId);
  const sourceImageIndex = Number(value.sourceImageIndex);
  const imageCount = Number(value.imageCount);
  const itemCount = Number(value.itemCount);
  if (
    Number(value.schemaVersion) !== 1 ||
    !groupId ||
    !itemId ||
    !sourceImageId ||
    !Number.isInteger(sourceImageIndex) ||
    sourceImageIndex < 0 ||
    sourceImageIndex >= 5 ||
    !Number.isInteger(imageCount) ||
    imageCount < 1 ||
    imageCount > 5 ||
    !Number.isInteger(itemCount) ||
    itemCount < 1 ||
    itemCount > 5
  ) return null;

  return {
    schemaVersion: 1,
    groupId,
    itemId,
    sourceImageId,
    sourceImageIndex,
    imageCount,
    itemCount,
  };
}

function isVisibleToActor(scan, actorId) {
  if (actorId === undefined) return true;
  const ownerId = typeof scan.ownerId === 'string' && scan.ownerId.trim()
    ? scan.ownerId
    : null;
  // Ownerless legacy records remain device-local. They are visible only in the
  // signed-out device-local view and are never attributed to a signed-in actor.
  if (actorId === null) return ownerId === null;
  return ownerId === actorId;
}

async function generateThumbnail(photoUri, id) {
  try {
    await ensureDirs();
    const result = await ImageManipulator.manipulateAsync(
      photoUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
    );
    const destPath = THUMBS_DIR + id + '.jpg';
    // Move out of OS cache into app-owned persistent storage
    await FileSystem.moveAsync({ from: result.uri, to: destPath });
    return destPath;
  } catch {
    return null; // thumbnail failure is non-fatal
  }
}

async function persistScanImage(photoUri, id) {
  try {
    await ensureDirs();
    const result = await ImageManipulator.manipulateAsync(
      photoUri,
      [{ resize: { width: IMAGE_WIDTH } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
    );
    const destPath = IMAGES_DIR + id + '.jpg';
    await FileSystem.moveAsync({ from: result.uri, to: destPath });
    return destPath;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all saved scans from local storage. Returns [] on any error.
 * @param {string|null|undefined} [actorId] - when provided, filters owned scans;
 *   null selects only ownerless device-local legacy rows.
 */
export async function loadLibrary(actorId = undefined) {
  try {
    await libraryMutationQueue;
    const parsed = await readAllLibrary();
    return parsed.filter((scan) => !scan.deletedAt && isVisibleToActor(scan, actorId));
  } catch {
    return [];
  }
}

/**
 * Save a successful scan to the local library.
 *
 * @param {object} opts
 * @param {string} opts.photoUri   - original capture URI (may be temp cache)
 * @param {object} opts.analysis   - { result, metadata, products, purchaseOptions } from useKScan
 * @param {string} [opts.source]   - source identifier ('scan', 'camera', 'upload', 'fixture')
 * @param {string|null} [opts.ownerId] - authenticated actor at save time
 * @returns {SavedScan|null}  the saved object, or null on complete failure
 */
export async function saveScan({ photoUri, analysis, source, ownerId = null }) {
  try {
    const id = 'scan_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
    const multiScan = normalizeMultiScanMetadata(analysis?.multiScan);

    // Local image persistence is best-effort; existing library behavior remains local.
    const imageUri = await persistScanImage(photoUri, id);
    // Thumbnail generation is best-effort; missing thumbnail shows placeholder
    const thumbnailUri = await generateThumbnail(photoUri, id);

    const createdAt = new Date().toISOString();
    /** @type {SavedScan} */
    const scan = {
      id,
      createdAt,
      savedAt: createdAt,
      updatedAt: createdAt,
      ownerId: typeof ownerId === 'string' && ownerId.trim() ? ownerId : null,
      imageUri,               // null if persistence failed; legacy scans may not have it
      thumbnailUri,          // null if generation failed
      attributes: {
        category:          analysis.metadata?.category   ?? '',
        silhouette:        analysis.metadata?.silhouette ?? '',
        color_palette:     analysis.metadata?.color      ?? '',
        material_estimate: null,
        style_tags:        [],
        confidence_score:  null,
      },
      result:          analysis.result   ?? '',
      products:        Array.isArray(analysis.products) ? analysis.products.slice() : [],
      purchaseOptions: normalizePurchaseOptions(analysis.purchaseOptions),
      commerceSnapshotVersion: 1,
      source:          normalizeScanSource(source),
      ...(multiScan ? { metadata: { multiScan } } : {}),
    };

    await enqueueLibraryMutation(async () => {
      const existing = await readAllLibrary();
      const updated = [scan, ...existing];
      const newOwner = scan.ownerId || null;
      const actorEntries = updated.filter((item) => (item.ownerId || null) === newOwner);
      const evicted = actorEntries.slice(MAX_SCANS);

      if (evicted.length > 0) {
        const evictedEntries = new Set(evicted);
        await Promise.all(
          evicted
            .flatMap((item) => [item.thumbnailUri, item.imageUri])
            .filter(Boolean)
            .map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => null)),
        );
        await persistLibrary(updated.filter((item) => !evictedEntries.has(item)));
      } else {
        await persistLibrary(updated);
      }
    });

    // Fire-and-forget cloud metadata sync. Local save is already committed;
    // cloud failure must never rollback the local scan.
    if (scan.ownerId) {
      saveScanToCloud(scan, undefined, scan.ownerId).catch(() => null);
    }
    return scan;
  } catch {
    return null;
  }
}

/**
 * Delete a scan and its thumbnail file. Returns true on success.
 * When cloud saved-scans are enabled, soft-delete must confirm before local
 * wipe so a stale device cannot resurrect the cloud tombstone later.
 */
export async function deleteScan(id, { ownerId, cloudId } = {}) {
  try {
    const initialLibrary = await readAllLibrary();
    const initialTarget = initialLibrary.find(
      (scan) => scan.id === id && isVisibleToActor(scan, ownerId),
    );
    if (!initialTarget && !cloudId) return false;

    const cloudResult = await softDeleteCloudSavedScan(
      cloudId ? { cloudId } : { localId: id },
      ownerId || undefined,
    );
    if (
      !cloudResult.ok &&
      cloudResult.reason !== 'disabled' &&
      cloudResult.reason !== 'unauthenticated'
    ) {
      return false;
    }

    return await enqueueLibraryMutation(async () => {
      const library = await readAllLibrary();
      const target = library.find(
        (scan) => scan.id === id && isVisibleToActor(scan, ownerId),
      );
      if (target) {
        if (target.thumbnailUri) {
          await FileSystem.deleteAsync(target.thumbnailUri, { idempotent: true }).catch(() => null);
        }
        if (target.imageUri) {
          await FileSystem.deleteAsync(target.imageUri, { idempotent: true }).catch(() => null);
        }
        await persistLibrary(library.filter((scan) => scan !== target));
      }
      return true;
    });
  } catch {
    return false;
  }
}
