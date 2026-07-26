/**
 * K Scan Closet — durable, actor-scoped device-local owned-inventory store.
 *
 * DOMAIN BOUNDARY (see docs/closet-testing-bundle.md):
 *   Recent Scan = historical fashion discovery + retailer-neutral commerce.
 *   Closet      = explicitly owned inventory. NO commerce, ever.
 *
 * This store is deliberately SEPARATE from services/library.js:
 *   - its own manifest      kscan_closet/kscan_closet.json
 *   - its own media roots   kscan_closet/images/ , kscan_closet/thumbnails/
 *   - NO 25-item eviction cap (Recent Scan's MAX_SCANS must never evict Closet)
 *
 * The disjoint media roots are the mechanism that guarantees independent
 * lifecycle: services/library.js#unlinkUnreferencedMedia only ever receives
 * candidate paths under kscan_library/, and this module only ever receives
 * candidates under kscan_closet/. Neither can unlink the other's files, so
 * deleting or evicting a Recent Scan can never strand a Closet image and
 * vice-versa. Promotion therefore COPIES media; it never moves or references
 * the source scan's file.
 *
 * Ownership is derived from the captured actor request via resolveWriteAuthority
 * and is never chosen by the caller — identical to the Recent Scan contract.
 *
 * Testing-phase scope: device-local only. No cloud transit, no image upload,
 * no synchronization. Records are plain JSON and remain readable regardless of
 * whether the CLOSET_* feature flags are still enabled.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { resolveWriteAuthority, isActorRequestCurrent } from './actorContext';
import {
  createMediaAssetId,
  canonicalizeMediaPath,
  unlinkUnreferencedMedia,
} from './library';

const CLOSET_DIR    = FileSystem.documentDirectory + 'kscan_closet/';
const CLOSET_PATH   = CLOSET_DIR + 'kscan_closet.json';
const IMAGES_DIR    = CLOSET_DIR + 'images/';
const THUMBS_DIR    = CLOSET_DIR + 'thumbnails/';
const THUMB_WIDTH   = 160;
const IMAGE_WIDTH   = 1440;

/** Record schema version — serialization must not depend on any feature flag. */
export const CLOSET_ITEM_SCHEMA_VERSION = 1;

export const CLOSET_ORIGINS = ['direct_intake', 'recent_scan'];

let closetMutationQueue = Promise.resolve();
let closetItemCounter = 0;

// ── Internal helpers ──────────────────────────────────────────────────────────

async function ensureDirs() {
  try {
    await FileSystem.makeDirectoryAsync(IMAGES_DIR, { intermediates: true });
    await FileSystem.makeDirectoryAsync(THUMBS_DIR, { intermediates: true });
  } catch { /* non-fatal — directory may already exist */ }
}

async function persistCloset(items) {
  await FileSystem.makeDirectoryAsync(CLOSET_DIR, { intermediates: true }).catch(() => null);
  await FileSystem.writeAsStringAsync(
    CLOSET_PATH,
    JSON.stringify(items),
    { encoding: FileSystem.EncodingType.UTF8 }
  );
}

function cleanText(value, max = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, max);
}

/**
 * COMMERCE EXCLUSION BOUNDARY.
 *
 * Every persisted field is enumerated here explicitly. This is an allowlist by
 * construction: an unknown key on the draft is dropped rather than carried, so
 * a future Recent Scan field (a new retailer payload, a provider blob, a signed
 * URL) cannot leak into the Closet record simply by existing upstream.
 *
 * Never replace this with a spread-then-delete of known commerce keys.
 */
function buildClosetRecord(draft, ownerId, now) {
  closetItemCounter = (closetItemCounter + 1) % 0x100000;
  const id =
    typeof draft.id === 'string' && draft.id
      ? draft.id
      : `closet_${Date.now().toString(36)}_${closetItemCounter.toString(36)}_${Math.floor(
          Math.random() * 0x100000000
        ).toString(36)}`;

  const origin = CLOSET_ORIGINS.includes(draft.origin) ? draft.origin : 'direct_intake';

  return {
    schemaVersion: CLOSET_ITEM_SCHEMA_VERSION,
    id,
    ownerId,
    imageUri: draft.imageUri ?? null,
    thumbnailUri: draft.thumbnailUri ?? null,
    title: cleanText(draft.title) || 'Closet item',
    category: cleanText(draft.category, 80),
    notes: cleanText(draft.notes, 500),
    origin,
    sourceLocalScanId: cleanText(draft.sourceLocalScanId),
    sourceSavedScanId: cleanText(draft.sourceSavedScanId),
    sourceLineageId: cleanText(draft.sourceLineageId, 300),
    clientRequestId: cleanText(draft.clientRequestId, 300),
    createdAt: now,
    updatedAt: now,
  };
}

function enqueueClosetMutation(operation) {
  const result = closetMutationQueue.then(operation, operation);
  closetMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readAllCloset() {
  const info = await FileSystem.getInfoAsync(CLOSET_PATH);
  if (!info.exists) return [];
  const raw = await FileSystem.readAsStringAsync(CLOSET_PATH);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item) => item && typeof item === 'object');
}

function isVisibleToActor(item, actorId) {
  if (actorId === undefined) return true;
  const ownerId =
    typeof item.ownerId === 'string' && item.ownerId.trim() ? item.ownerId : null;
  if (actorId === null) return ownerId === null;
  return ownerId === actorId;
}

/**
 * No-overwrite media write into a Closet-owned path. A deliberately injected
 * collision mints a fresh asset id rather than clobbering an existing file.
 */
async function moveToFreshClosetPath(sourceUri, dir, seedAssetId) {
  // Fail closed on a missing/blank producer URI rather than depending on the
  // platform's moveAsync to throw. A manipulator that resolves with no usable
  // uri must never become a "successful" durable item.
  if (typeof sourceUri !== 'string' || !sourceUri.trim()) return null;
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

/**
 * Derive a Closet-OWNED image + thumbnail from any source URI.
 *
 * ImageManipulator always writes a fresh file into the OS cache, which is then
 * moved into Closet storage. The source URI is therefore never moved, never
 * consumed, and never referenced by the resulting record — which is what makes
 * promotion non-destructive to the originating Recent Scan.
 */
async function deriveClosetMedia(sourceUri) {
  await ensureDirs();
  let imageUri = null;
  let thumbnailUri = null;

  try {
    const full = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: IMAGE_WIDTH } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
    );
    imageUri = await moveToFreshClosetPath(full.uri, IMAGES_DIR, createMediaAssetId());
  } catch {
    imageUri = null;
  }

  // A Closet item with no durable image is not a usable owned-inventory record.
  if (!imageUri) return { ok: false, imageUri: null, thumbnailUri: null };

  try {
    const thumb = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
    );
    thumbnailUri = await moveToFreshClosetPath(thumb.uri, THUMBS_DIR, createMediaAssetId());
  } catch {
    thumbnailUri = null; // thumbnail failure is non-fatal
  }

  return { ok: true, imageUri, thumbnailUri };
}

/**
 * Remove media created by a FAILED attempt.
 *
 * Reference-aware against the complete post-mutation manifest (every actor
 * partition plus the ownerless one), so a retry can never unlink media that a
 * previously committed Closet item still references.
 */
async function cleanupRejectedClosetMedia(paths) {
  const candidates = paths.filter(Boolean);
  if (candidates.length === 0) return [];
  try {
    return await unlinkUnreferencedMedia(candidates, await readAllCloset());
  } catch {
    return candidates;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load Closet items for an actor. Returns [] on any error.
 * @param {string|null|undefined} [actorId] — null selects the ownerless
 *   device-local partition; undefined returns every partition (tests only).
 */
export async function loadCloset(actorId = undefined) {
  try {
    await closetMutationQueue;
    const parsed = await readAllCloset();
    return parsed
      .filter((item) => !item.deletedAt && isVisibleToActor(item, actorId))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  } catch {
    return [];
  }
}

/**
 * Create a durable Closet item from a local image URI.
 *
 * @param {object} opts
 * @param {string} opts.sourceUri     — camera/gallery/scan image URI (NOT consumed)
 * @param {object} opts.draft         — non-commerce ClosetItemDraft fields
 * @param {{actorId: string|null, epoch: number, requestId: string}} opts.actorRequest
 * @param {string|null} [opts.ownerId] — optional echo of the expected owner
 * @returns {Promise<{ok: true, item: object, deduped: boolean} | {ok: false, reason: string}>}
 */
export async function createClosetItem({ sourceUri, draft, actorRequest, ownerId }) {
  const preAuthority = resolveWriteAuthority(actorRequest, ownerId);
  if (!preAuthority.ok) return { ok: false, reason: preAuthority.reason };

  // PLATFORM DIVERGENCE — mirrors services/library.js#saveScan.
  // Android has never supported signed-out durable writes. Fail closed here so
  // the shared authority helper cannot import the iOS ownerless contract by
  // accident. iOS keeps its durable ownerless partition.
  if (Platform.OS === 'android' && preAuthority.ownerId === null) {
    return { ok: false, reason: 'android_requires_authenticated_actor' };
  }

  if (typeof sourceUri !== 'string' || !sourceUri.trim()) {
    return { ok: false, reason: 'missing_source_media' };
  }

  // Idempotency pre-check: a committed item for this lineage short-circuits
  // before any media work, so a double tap cannot duplicate an item or spend
  // a second image write.
  const lineage = cleanText(draft?.sourceLineageId, 300);
  if (lineage) {
    const existing = await findClosetItemByLineage(lineage, preAuthority.ownerId);
    if (existing) return { ok: true, item: existing, deduped: true };
  }

  let imageUri = null;
  let thumbnailUri = null;
  try {
    const media = await deriveClosetMedia(sourceUri);
    if (!media.ok) return { ok: false, reason: 'media_persist_failed' };
    imageUri = media.imageUri;
    thumbnailUri = media.thumbnailUri;

    // Re-validate AFTER the async media work: the actor may have changed while
    // the image was written. A stale authenticated write is REJECTED outright
    // and is never downgraded into the ownerless partition.
    const authority = resolveWriteAuthority(actorRequest, ownerId);
    if (!authority.ok) {
      await cleanupRejectedClosetMedia([imageUri, thumbnailUri]);
      return { ok: false, reason: authority.reason };
    }
    if (Platform.OS === 'android' && authority.ownerId === null) {
      await cleanupRejectedClosetMedia([imageUri, thumbnailUri]);
      return { ok: false, reason: 'android_requires_authenticated_actor' };
    }

    const now = new Date().toISOString();
    const record = buildClosetRecord(draft ?? {}, authority.ownerId, now);
    record.imageUri = imageUri;
    record.thumbnailUri = thumbnailUri;

    const committed = await enqueueClosetMutation(async () => {
      // Last-moment check inside the serialized section.
      if (!isActorRequestCurrent(actorRequest)) return null;

      const existing = await readAllCloset();

      // Idempotency commit-check: another in-flight promotion for the same
      // lineage may have committed while this one was writing media.
      if (record.sourceLineageId) {
        const dupe = existing.find(
          (item) =>
            !item.deletedAt &&
            item.sourceLineageId === record.sourceLineageId &&
            (item.ownerId || null) === (record.ownerId || null)
        );
        if (dupe) return { item: dupe, deduped: true };
      }

      await persistCloset([record, ...existing]);
      return { item: record, deduped: false };
    });

    if (!committed) {
      await cleanupRejectedClosetMedia([imageUri, thumbnailUri]);
      return { ok: false, reason: 'stale_actor_context' };
    }

    // Lost the idempotency race: drop the media this attempt created. The
    // surviving record's own media is protected by the reference-aware scan.
    if (committed.deduped) {
      await cleanupRejectedClosetMedia([imageUri, thumbnailUri]);
    }

    return { ok: true, item: committed.item, deduped: committed.deduped };
  } catch {
    await cleanupRejectedClosetMedia([imageUri, thumbnailUri]);
    return { ok: false, reason: 'unexpected_error' };
  }
}

/** Idempotency lookup: owner + stable source lineage. */
export async function findClosetItemByLineage(sourceLineageId, ownerId) {
  const lineage = cleanText(sourceLineageId, 300);
  if (!lineage) return null;
  try {
    await closetMutationQueue;
    const items = await readAllCloset();
    return (
      items.find(
        (item) =>
          !item.deletedAt &&
          item.sourceLineageId === lineage &&
          (item.ownerId || null) === (ownerId ?? null)
      ) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Update approved editable metadata on a Closet item. Media and lineage are
 * immutable here; ownership is re-derived and never taken from the caller.
 */
export async function updateClosetItem(id, patch, { actorRequest, ownerId } = {}) {
  const authority = resolveWriteAuthority(actorRequest, ownerId);
  if (!authority.ok) return { ok: false, reason: authority.reason };

  return enqueueClosetMutation(async () => {
    if (!isActorRequestCurrent(actorRequest)) {
      return { ok: false, reason: 'stale_actor_context' };
    }
    const items = await readAllCloset();
    const index = items.findIndex(
      (item) => item.id === id && isVisibleToActor(item, authority.ownerId)
    );
    if (index === -1) return { ok: false, reason: 'not_found' };

    const next = {
      ...items[index],
      updatedAt: new Date().toISOString(),
    };
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'title')) {
      next.title = cleanText(patch.title) || next.title;
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'category')) {
      next.category = cleanText(patch.category, 80);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'notes')) {
      next.notes = cleanText(patch.notes, 500);
    }

    const updated = items.slice();
    updated[index] = next;
    await persistCloset(updated);
    return { ok: true, item: next };
  }).catch(() => ({ ok: false, reason: 'unexpected_error' }));
}

/**
 * Delete a Closet item and unlink its media reference-aware.
 *
 * Only Closet-owned paths are ever passed as unlink candidates, so this can
 * never remove media belonging to a Recent Scan.
 */
export async function deleteClosetItem(id, { ownerId } = {}) {
  try {
    return await enqueueClosetMutation(async () => {
      const items = await readAllCloset();
      const target = items.find(
        (item) => item.id === id && isVisibleToActor(item, ownerId)
      );
      if (!target) return false;

      const survivors = items.filter((item) => item !== target);
      await unlinkUnreferencedMedia(
        [target.thumbnailUri, target.imageUri].filter(Boolean),
        survivors
      );
      await persistCloset(survivors);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Owner-scoped purge primitive for account deletion. Removes only records owned
 * by the captured owner id, preserves ownerless records and every other actor,
 * and unlinks media reference-aware. Idempotent and safe to retry.
 *
 * DELIBERATELY UNWIRED at deletion submission, matching the Recent Scan
 * primitive: terminal purge waits for confirmed server-side purge.
 */
export async function purgeLocalClosetForOwner(capturedOwnerId) {
  const owner =
    typeof capturedOwnerId === 'string' && capturedOwnerId.trim()
      ? capturedOwnerId.trim()
      : null;
  if (!owner) return { ok: false, removed: 0, mediaFailures: [] };
  try {
    return await enqueueClosetMutation(async () => {
      const items = await readAllCloset();
      const doomed = items.filter((item) => (item.ownerId || null) === owner);
      if (doomed.length === 0) return { ok: true, removed: 0, mediaFailures: [] };
      const survivors = items.filter((item) => (item.ownerId || null) !== owner);
      const mediaFailures = await unlinkUnreferencedMedia(
        doomed.flatMap((item) => [item.imageUri, item.thumbnailUri]).filter(Boolean),
        survivors
      );
      await persistCloset(survivors);
      return { ok: mediaFailures.length === 0, removed: doomed.length, mediaFailures };
    });
  } catch {
    return { ok: false, removed: 0, mediaFailures: [] };
  }
}

/** Test seam only. Not used by production code. */
export const __closetInternals = {
  CLOSET_DIR,
  CLOSET_PATH,
  IMAGES_DIR,
  THUMBS_DIR,
  buildClosetRecord,
  canonicalizeMediaPath,
};
