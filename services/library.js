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
import { resolveWriteAuthority, isActorRequestCurrent } from './actorContext';

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

let mediaAssetCounter = 0;

/**
 * Globally collision-resistant media asset identity.
 *
 * The record id (`scan_<Date.now()>_<4-digit random>`) is not collision safe
 * enough to double as a writable media path: two actors can produce the same id
 * and silently overwrite each other's image. Media identity is therefore
 * separate from record identity, and creation is no-overwrite.
 */
export function createMediaAssetId() {
  mediaAssetCounter = (mediaAssetCounter + 1) % 0x100000;
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(36);
  return `m_${Date.now().toString(36)}_${mediaAssetCounter.toString(36)}_${rand()}${rand()}`;
}

/** No-overwrite media write; a deliberately injected collision mints a fresh id. */
async function moveToFreshMediaPath(sourceUri, dir, seedAssetId) {
  let assetId = seedAssetId;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const destPath = dir + assetId + '.jpg';
    const existing = await FileSystem.getInfoAsync(destPath).catch(() => ({ exists: false }));
    if (!existing?.exists) {
      await FileSystem.moveAsync({ from: sourceUri, to: destPath });
      return destPath;
    }
    assetId = createMediaAssetId();
  }
  return null;
}

/** Canonical comparable form so `file://a/b.JPG` and `/a/b.jpg` are one asset. */
export function canonicalizeMediaPath(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return null;
  let out = uri.trim();
  out = out.replace(/^file:\/\//i, '');
  out = out.replace(/\\/g, '/');
  out = out.replace(/\/{2,}/g, '/');
  return out.toLowerCase();
}

/**
 * Reference-aware unlink. A file is removed only when NO surviving record in the
 * complete post-mutation manifest - every authenticated partition AND the
 * ownerless partition - still references it. Never uses the visible subset.
 */
export async function unlinkUnreferencedMedia(candidatePaths, survivingScans) {
  const referenced = new Set();
  for (const scan of survivingScans) {
    if (!scan || typeof scan !== 'object') continue;
    for (const uri of [scan.imageUri, scan.thumbnailUri]) {
      const c = canonicalizeMediaPath(uri);
      if (c) referenced.add(c);
    }
  }
  const seen = new Set();
  const failures = [];
  for (const path of candidatePaths) {
    const c = canonicalizeMediaPath(path);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (referenced.has(c)) continue;
    try { await FileSystem.deleteAsync(path, { idempotent: true }); } catch { failures.push(path); }
  }
  return failures;
}

async function cleanupRejectedMedia(paths) {
  const candidates = paths.filter(Boolean);
  if (candidates.length === 0) return [];
  try { return await unlinkUnreferencedMedia(candidates, await readAllLibrary()); }
  catch { return candidates; }
}

async function generateThumbnail(photoUri, assetId) {
  try {
    await ensureDirs();
    const result = await ImageManipulator.manipulateAsync(
      photoUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
    );
    // Move out of OS cache into app-owned persistent storage, no-overwrite.
    return await moveToFreshMediaPath(result.uri, THUMBS_DIR, assetId);
  } catch {
    return null; // thumbnail failure is non-fatal
  }
}

async function persistScanImage(photoUri, assetId) {
  try {
    await ensureDirs();
    const result = await ImageManipulator.manipulateAsync(
      photoUri,
      [{ resize: { width: IMAGE_WIDTH } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
    );
    return await moveToFreshMediaPath(result.uri, IMAGES_DIR, assetId);
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
 * Ownership is derived from the captured actor request, never chosen by the
 * caller. On Android a signed-out (ownerless) durable save is rejected.
 *
 * @param {object} opts
 * @param {string} opts.photoUri   - original capture URI (may be temp cache)
 * @param {object} opts.analysis   - { result, metadata, products, purchaseOptions } from useKScan
 * @param {string} [opts.source]   - source identifier ('scan', 'camera', 'upload', 'fixture')
 * @param {{actorId: string|null, epoch: number, requestId: string}} opts.actorRequest
 *   - captured before the async work; a stale context is rejected
 * @param {string|null} [opts.ownerId] - optional echo of the expected owner; must agree
 * @returns {SavedScan|null}  the saved object, or null when rejected or on failure
 */
export async function saveScan({ photoUri, analysis, source, actorRequest, ownerId }) {
  // Pre-flight authority check: reject before spending work on media.
  const preAuthority = resolveWriteAuthority(actorRequest, ownerId);
  if (!preAuthority.ok) return null;

  let imageUri = null;
  let thumbnailUri = null;
  try {
    const id = 'scan_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
    const multiScan = normalizeMultiScanMetadata(analysis?.multiScan);

    // Local image persistence is best-effort; existing library behavior remains local.
    imageUri = await persistScanImage(photoUri, createMediaAssetId());
    // Thumbnail generation is best-effort; missing thumbnail shows placeholder
    thumbnailUri = await generateThumbnail(photoUri, createMediaAssetId());

    // Re-validate AFTER the async media work: the actor may have changed while
    // the image was written. A stale authenticated save is REJECTED outright and
    // is never downgraded into the ownerless partition.
    const authority = resolveWriteAuthority(actorRequest, ownerId);
    if (!authority.ok) {
      await cleanupRejectedMedia([imageUri, thumbnailUri]);
      return null;
    }
    const owner = authority.ownerId;

    // PLATFORM DIVERGENCE - deliberate, do not "fix" toward iOS.
    // iOS supports durable ownerless (signed-out) Recent Scans. Android does
    // NOT: the Scanner has always required an authenticated actor. Ownerless
    // rows on Android are legacy pre-ownerId records that remain readable in the
    // signed-out projection but must never be newly created. Fail closed here so
    // the shared authority helper cannot import the iOS contract by accident.
    if (owner === null) {
      await cleanupRejectedMedia([imageUri, thumbnailUri]);
      return null;
    }

    const createdAt = new Date().toISOString();
    /** @type {SavedScan} */
    const scan = {
      id,
      createdAt,
      savedAt: createdAt,
      updatedAt: createdAt,
      ownerId: owner,
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

    const committed = await enqueueLibraryMutation(async () => {
      // Last-moment check inside the serialized section.
      if (!isActorRequestCurrent(actorRequest)) return false;

      const existing = await readAllLibrary();
      const updated = [scan, ...existing];
      const newOwner = scan.ownerId || null;
      const actorEntries = updated.filter((item) => (item.ownerId || null) === newOwner);
      const evicted = actorEntries.slice(MAX_SCANS);

      if (evicted.length > 0) {
        const evictedEntries = new Set(evicted);
        const survivors = updated.filter((item) => !evictedEntries.has(item));
        // Reference-aware: never unlink a file another actor's record still uses.
        await unlinkUnreferencedMedia(
          evicted.flatMap((item) => [item.thumbnailUri, item.imageUri]).filter(Boolean),
          survivors,
        );
        await persistLibrary(survivors);
      } else {
        await persistLibrary(updated);
      }
      return true;
    });

    if (!committed) {
      await cleanupRejectedMedia([imageUri, thumbnailUri]);
      return null;
    }

    // Fire-and-forget cloud metadata sync. Local save is already committed;
    // cloud failure must never rollback the local scan.
    if (scan.ownerId) {
      saveScanToCloud(scan, undefined, scan.ownerId).catch(() => null);
    }
    return scan;
  } catch {
    await cleanupRejectedMedia([imageUri, thumbnailUri]);
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
        const survivors = library.filter((scan) => scan !== target);
        await unlinkUnreferencedMedia(
          [target.thumbnailUri, target.imageUri].filter(Boolean),
          survivors,
        );
        await persistLibrary(survivors);
      }
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Account-deletion local cleanup primitive. Removes only records owned by the
 * captured owner id, preserves ownerless records and every other actor, and
 * unlinks media reference-aware. Idempotent and safe to retry.
 *
 * DELIBERATELY UNWIRED at deletion submission: the deployed lifecycle is
 * asynchronous and restorable, so terminal purge must wait for confirmed
 * `status === 'purged' AND purged_at IS NOT NULL`.
 *
 * @returns {{ok: boolean, removed: number, mediaFailures: string[]}}
 */
export async function purgeLocalScansForOwner(capturedOwnerId) {
  const owner =
    typeof capturedOwnerId === 'string' && capturedOwnerId.trim() ? capturedOwnerId.trim() : null;
  if (!owner) return { ok: false, removed: 0, mediaFailures: [] };
  try {
    return await enqueueLibraryMutation(async () => {
      const library = await readAllLibrary();
      const doomed = library.filter((s) => (s.ownerId || null) === owner);
      if (doomed.length === 0) return { ok: true, removed: 0, mediaFailures: [] };
      const survivors = library.filter((s) => (s.ownerId || null) !== owner);
      const mediaFailures = await unlinkUnreferencedMedia(
        doomed.flatMap((s) => [s.imageUri, s.thumbnailUri]).filter(Boolean),
        survivors,
      );
      await persistLibrary(survivors);
      return { ok: mediaFailures.length === 0, removed: doomed.length, mediaFailures };
    });
  } catch {
    return { ok: false, removed: 0, mediaFailures: [] };
  }
}
