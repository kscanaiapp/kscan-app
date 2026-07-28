/**
 * Candidate-owned media lifecycle and exact content hashing.
 *
 * MEDIA ROOT SEPARATION IS THE MECHANISM, not a convention. Three stores each own
 * a disjoint subtree:
 *
 *   kscan_library/            Recent Scans          services/library.js
 *   kscan_closet/             committed Closet      services/closetLibrary.js
 *   kscan_closet_candidates/  staged candidates     THIS MODULE
 *
 * Reference-aware unlinking only ever receives candidate paths from here, and
 * `assertCandidateOwnedPath` re-checks the prefix immediately before deletion. So
 * candidate cleanup structurally cannot remove a committed Closet image or a
 * Recent Scan image, and the picker-owned original is never a deletion candidate
 * at all.
 *
 * DIMENSIONS ARE THE REPOSITORY'S PROVEN PRODUCTION VALUES (1440px / q0.9 full,
 * 160px / q0.8 thumbnail), identical to services/closetLibrary.js. They are NOT
 * re-derived here and are deliberately not replaced with a new 1024x1024 standard:
 * a candidate is promoted into a committed Closet item in Build 2, and a candidate
 * derivative smaller than the Closet's own would silently downgrade every promoted
 * item's media.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ExpoCrypto from 'expo-crypto';
import { createMediaAssetId, canonicalizeMediaPath } from './library';
import { CLOSET_CANDIDATE_CONTENT_HASH_VERSION } from '../types/closetCandidate';

export const CANDIDATE_DIR = FileSystem.documentDirectory + 'kscan_closet_candidates/';
export const CANDIDATE_MANIFEST_PATH = CANDIDATE_DIR + 'kscan_closet_candidates.json';
/** Staging and retention paths for the atomic manifest swap. */
export const CANDIDATE_MANIFEST_TEMP_PATH = CANDIDATE_MANIFEST_PATH + '.tmp';
export const CANDIDATE_MANIFEST_BACKUP_PATH = CANDIDATE_MANIFEST_PATH + '.bak';
export const CANDIDATE_IMAGES_DIR = CANDIDATE_DIR + 'images/';
export const CANDIDATE_THUMBS_DIR = CANDIDATE_DIR + 'thumbnails/';

/** Identical to the committed Closet. See the module note above. */
const IMAGE_WIDTH = 1440;
const THUMB_WIDTH = 160;

/**
 * Source-image ceiling. Above this we refuse before decoding: a manipulator
 * decode of an enormous image is the step that actually runs the device out of
 * memory, so the guard has to sit in front of it rather than catch it.
 */
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Absolute floor for free space, regardless of how small the image is. */
export const MIN_FREE_STORAGE_BYTES = 100 * 1024 * 1024;

/** Multiple of estimated output that must be free before we write anything. */
export const STORAGE_HEADROOM_MULTIPLIER = 3;

/**
 * Fallback output estimate when the source size cannot be read.
 *
 * Deliberately generous. Under-estimating means we approve a write that then
 * half-completes and leaves a partial file; over-estimating only means we ask
 * for more headroom than we strictly need.
 */
export const FALLBACK_ESTIMATED_OUTPUT_BYTES = 3 * 1024 * 1024;

// ── Path ownership ───────────────────────────────────────────────────────────

/**
 * A canonical path containing a `..` segment.
 *
 * `canonicalizeMediaPath` normalizes the scheme, the separators and the case —
 * it does NOT resolve relative segments, and it must not start to: it is the
 * shared identity function for media references across three stores, and making
 * it resolve paths would change what "the same asset" means for all of them.
 *
 * That leaves a prefix check exposed to exactly one shape:
 *
 *     kscan_closet_candidates/images/../../kscan_closet/images/x.jpg
 *
 * which starts with the candidate root as a STRING and resolves outside it as a
 * PATH. No writer in this repository can produce one — candidate media paths are
 * built from a minted asset id — but a hand-edited or corrupted manifest can, and
 * the file that traversal reaches is a committed Closet image. Rejected here, once,
 * for every caller.
 */
function hasTraversalSegment(canonicalPath) {
  let decoded = canonicalPath;
  for (let pass = 0; pass < 4; pass += 1) {
    const normalized = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (normalized.split('/').includes('..')) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return false;
      decoded = next.toLowerCase();
    } catch {
      // Malformed escaping is not a path this deletion boundary can own safely.
      return true;
    }
  }
  // Retain fail-closed behaviour for unusually deep percent encoding.
  return /%(?:25)*(?:2e|2f|5c)/i.test(decoded);
}

/**
 * True only for a path inside the candidate media roots.
 *
 * Defence in depth against the one catastrophic bug in this area: passing a
 * committed-Closet or Recent-Scan path into candidate cleanup. Prefix comparison
 * uses the canonical form so `file://` and casing differences cannot slip past,
 * and a path that could climb back out of the root is refused outright.
 */
export function isCandidateOwnedPath(uri) {
  const canonical = canonicalizeMediaPath(uri);
  if (!canonical) return false;
  if (hasTraversalSegment(canonical)) return false;
  const imagesRoot = canonicalizeMediaPath(CANDIDATE_IMAGES_DIR);
  const thumbsRoot = canonicalizeMediaPath(CANDIDATE_THUMBS_DIR);
  if (!imagesRoot || !thumbsRoot) return false;
  return canonical.startsWith(imagesRoot) || canonical.startsWith(thumbsRoot);
}

async function ensureDirs() {
  try {
    await FileSystem.makeDirectoryAsync(CANDIDATE_IMAGES_DIR, { intermediates: true });
    await FileSystem.makeDirectoryAsync(CANDIDATE_THUMBS_DIR, { intermediates: true });
  } catch {
    /* non-fatal — directory may already exist */
  }
}

// ── Storage preflight ────────────────────────────────────────────────────────

function estimateOutputBytes(sourceBytes) {
  if (typeof sourceBytes !== 'number' || !Number.isFinite(sourceBytes) || sourceBytes <= 0) {
    return FALLBACK_ESTIMATED_OUTPUT_BYTES;
  }
  // Full derivative is bounded by the source in practice; the thumbnail is
  // negligible next to it. Never estimate BELOW the fallback for a large source.
  return Math.max(Math.min(sourceBytes, FALLBACK_ESTIMATED_OUTPUT_BYTES), 256 * 1024);
}

/**
 * Validate the source and establish that persistence can safely be attempted.
 *
 * `freeSpaceKnown: false` is an honest outcome, not a failure: some platforms and
 * some test environments do not expose free space. The caller then relies on the
 * unresolved-candidate cap, the source-size guard, and catching the write itself —
 * which is why every write path below still cleans up its own partial files.
 *
 * @returns {Promise<{ok: true, sourceBytes: number|null, freeSpaceKnown: boolean}
 *                 | {ok: false, errorCode: string}>}
 */
export async function preflightCandidateStorage(sourceUri, deps = {}) {
  const fs = deps.FileSystem ?? FileSystem;

  if (typeof sourceUri !== 'string' || !sourceUri.trim()) {
    return { ok: false, errorCode: 'candidate_media_unreadable' };
  }

  let sourceBytes = null;
  try {
    const info = await fs.getInfoAsync(sourceUri, { size: true });
    if (!info?.exists) return { ok: false, errorCode: 'candidate_media_unreadable' };
    if (typeof info.size === 'number' && Number.isFinite(info.size) && info.size >= 0) {
      sourceBytes = info.size;
    }
  } catch {
    // A source we cannot even stat is not a source we should decode.
    return { ok: false, errorCode: 'candidate_media_unreadable' };
  }

  if (sourceBytes !== null && sourceBytes > MAX_SOURCE_IMAGE_BYTES) {
    return { ok: false, errorCode: 'candidate_media_unsupported' };
  }

  const required = Math.max(
    MIN_FREE_STORAGE_BYTES,
    estimateOutputBytes(sourceBytes) * STORAGE_HEADROOM_MULTIPLIER,
  );

  let freeSpaceKnown = false;
  try {
    if (typeof fs.getFreeDiskStorageAsync === 'function') {
      const free = await fs.getFreeDiskStorageAsync();
      if (typeof free === 'number' && Number.isFinite(free) && free >= 0) {
        freeSpaceKnown = true;
        if (free < required) {
          return { ok: false, errorCode: 'candidate_storage_insufficient' };
        }
      }
    }
  } catch {
    // Inspection failure is not insufficiency. Fall through to the cap-and-catch
    // strategy rather than refusing intake on a diagnostic that did not answer.
    freeSpaceKnown = false;
  }

  return { ok: true, sourceBytes, freeSpaceKnown };
}

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * No-overwrite write into a candidate-owned path. A deliberately injected
 * collision mints a fresh asset id rather than clobbering an existing file.
 *
 * Mirrors services/closetLibrary.js#moveToFreshClosetPath, including the
 * fail-closed guard on a blank producer URI: a manipulator that resolves with no
 * usable uri must never become a "successful" candidate.
 */
async function moveToFreshCandidatePath(sourceUri, dir, seedAssetId, fs) {
  if (typeof sourceUri !== 'string' || !sourceUri.trim()) return null;
  let assetId = seedAssetId;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const destPath = dir + assetId + '.jpg';
    const existing = await fs.getInfoAsync(destPath).catch(() => ({ exists: false }));
    if (!existing?.exists) {
      await fs.moveAsync({ from: sourceUri, to: destPath });
      const persisted = await fs.getInfoAsync(destPath).catch(() => ({ exists: false }));
      if (persisted?.exists) return destPath;
      // A move that resolves without a readable destination is not ownership.
      // The caller will fail intake rather than acknowledging a phantom file.
      return null;
    }
    assetId = createMediaAssetId();
  }
  return null;
}

/** Best-effort removal of a manipulator temp file. Never throws. */
async function discardTemp(uri, fs) {
  if (typeof uri !== 'string' || !uri.trim()) return;
  try {
    await fs.deleteAsync(uri, { idempotent: true });
  } catch {
    /* a stranded cache file is not a reason to fail intake */
  }
}

/**
 * Derive a candidate-OWNED image + thumbnail from any source URI.
 *
 * The full derivative and the thumbnail are produced SEQUENTIALLY and each temp
 * output is released before the next decode, so two full-resolution bitmaps are
 * never resident at once.
 *
 * ORIENTATION: expo-image-manipulator applies the source EXIF orientation while
 * decoding and writes an upright JPEG with no orientation tag. No explicit rotate
 * operation is added — adding one would apply the rotation a second time.
 *
 * The picker-owned `sourceUri` is read only. It is never moved, consumed, or
 * referenced by the resulting record.
 */
export async function deriveCandidateMedia(sourceUri, deps = {}) {
  const fs = deps.FileSystem ?? FileSystem;
  const manipulator = deps.ImageManipulator ?? ImageManipulator;

  await ensureDirs();

  let imageUri = null;
  let thumbnailUri = null;

  try {
    const full = await manipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: IMAGE_WIDTH } }],
      { compress: 0.9, format: manipulator.SaveFormat.JPEG },
    );
    imageUri = await moveToFreshCandidatePath(
      full?.uri,
      CANDIDATE_IMAGES_DIR,
      createMediaAssetId(),
      fs,
    );
    if (!imageUri) await discardTemp(full?.uri, fs);
  } catch {
    imageUri = null;
  }

  // A candidate with no durable image cannot be classified, reviewed or promoted.
  if (!imageUri) {
    return { ok: false, errorCode: 'candidate_media_normalization_failed' };
  }

  try {
    const thumb = await manipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: 0.8, format: manipulator.SaveFormat.JPEG },
    );
    thumbnailUri = await moveToFreshCandidatePath(
      thumb?.uri,
      CANDIDATE_THUMBS_DIR,
      createMediaAssetId(),
      fs,
    );
    if (!thumbnailUri) await discardTemp(thumb?.uri, fs);
  } catch {
    thumbnailUri = null; // thumbnail failure is non-fatal, matching the Closet
  }

  return { ok: true, imageUri, thumbnailUri };
}

// ── Exact content hashing ────────────────────────────────────────────────────

/** Exact byte length encoded by a Base64 string, without decoding it. */
export function base64ByteLength(base64) {
  if (typeof base64 !== 'string') return null;
  const clean = base64.replace(/[\r\n]/g, '');
  if (!clean) return 0;
  if (clean.length % 4 !== 0) return null;
  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  return (clean.length / 4) * 3 - padding;
}

/**
 * SHA-256 over the NORMALIZED candidate image.
 *
 * The digest is taken over the Base64 encoding of the candidate-owned JPEG's
 * bytes. Base64 is a bijection over byte strings, so equal digests mean equal
 * normalized bytes — the equality semantics are exactly those of hashing the raw
 * bytes, and this avoids decoding a multi-megabyte Base64 string into a JS typed
 * array on the device just to hand it straight back to a native digest.
 *
 * HASHED AFTER NORMALIZATION, DELIBERATELY. Hashing the source would make the
 * signal depend on picker-side re-encoding and EXIF the user cannot see; hashing
 * the URI string would compare filenames rather than pictures.
 *
 * WHAT A MATCH MEANS: exact normalized byte equality. WHAT IT DOES NOT MEAN: a
 * visually similar garment, the same real-world product, or the same SKU.
 */
export async function computeCandidateContentHash(candidateImageUri, deps = {}) {
  const fs = deps.FileSystem ?? FileSystem;
  const crypto = deps.Crypto ?? ExpoCrypto;

  if (typeof candidateImageUri !== 'string' || !candidateImageUri.trim()) {
    return { ok: false, errorCode: 'candidate_hash_failed' };
  }

  try {
    const base64 = await fs.readAsStringAsync(candidateImageUri, {
      encoding: fs.EncodingType?.Base64 ?? 'base64',
    });
    if (typeof base64 !== 'string' || !base64) {
      return { ok: false, errorCode: 'candidate_hash_failed' };
    }

    const digest = await crypto.digestStringAsync(
      crypto.CryptoDigestAlgorithm?.SHA256 ?? 'SHA-256',
      base64,
      { encoding: crypto.CryptoEncoding?.HEX ?? 'hex' },
    );
    if (typeof digest !== 'string' || !digest.trim()) {
      return { ok: false, errorCode: 'candidate_hash_failed' };
    }

    const byteLength = base64ByteLength(base64);
    return {
      ok: true,
      contentHash: digest.trim().toLowerCase(),
      contentHashVersion: CLOSET_CANDIDATE_CONTENT_HASH_VERSION,
      normalizedByteLength: byteLength === null ? null : byteLength,
    };
  } catch {
    return { ok: false, errorCode: 'candidate_hash_failed' };
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Reference-aware unlink of candidate media.
 *
 * Two guards, not one:
 *   1. `isCandidateOwnedPath` — a non-candidate path is DROPPED, never deleted.
 *      This is what makes it impossible for a caller mistake to reach a committed
 *      Closet image, a Recent Scan image, or the picker-owned original.
 *   2. reference check against the COMPLETE surviving manifest (every actor
 *      partition plus the ownerless one), so a shared reference — two candidates
 *      that resolved to the same media — is never unlinked from under the survivor.
 *
 * Idempotent, and never throws. Returns the paths that could not be removed.
 */
export async function unlinkUnreferencedCandidateMedia(
  candidatePaths,
  survivingRecords,
  deps = {},
) {
  const fs = deps.FileSystem ?? FileSystem;
  const referenced = new Set();
  for (const record of Array.isArray(survivingRecords) ? survivingRecords : []) {
    if (!record || typeof record !== 'object') continue;
    for (const uri of [record.candidateImageUri, record.candidateThumbnailUri]) {
      const canonical = canonicalizeMediaPath(uri);
      if (canonical) referenced.add(canonical);
    }
  }

  const seen = new Set();
  const failures = [];
  for (const path of Array.isArray(candidatePaths) ? candidatePaths : []) {
    if (!isCandidateOwnedPath(path)) continue;
    const canonical = canonicalizeMediaPath(path);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    if (referenced.has(canonical)) continue;
    try {
      await fs.deleteAsync(path, { idempotent: true });
    } catch {
      failures.push(path);
    }
  }
  return failures;
}

/**
 * Bounded orphan sweep over the candidate media roots.
 *
 * WHY THIS EXISTS: every other cleanup path is reference-driven — it can only
 * remove a file some record still points at. Files whose record is gone are
 * therefore unreachable by definition: media orphaned by a crash between the
 * manifest write and the unlink, by an unlink that returned a failure nobody
 * retried, or by a record that could not be migrated. Without a directory scan
 * they accumulate for the life of the install.
 *
 * SAFETY RULES, in the order they matter:
 *   - The caller must pass `manifestComplete: true`. A sweep driven by a partial
 *     read would treat every record it could not interpret as absent and delete
 *     media that is still owned. Refusing is the correct behaviour.
 *   - Only the candidate-owned image and thumbnail roots are enumerated. The
 *     committed Closet and Recent Scan roots are never listed, let alone deleted
 *     from, and every path is re-checked with `isCandidateOwnedPath` anyway.
 *   - A file younger than the grace period is kept: it may belong to an intake
 *     that is mid-flight and has not yet been written into the manifest.
 *   - Enumeration is optional. When the platform has no `readDirectoryAsync`,
 *     the sweep reports `skipped` rather than guessing.
 *
 * Never throws. Returns a scrubbed, bounded result.
 */
export const CANDIDATE_ORPHAN_GRACE_MS = 10 * 60 * 1000;

export async function sweepOrphanedCandidateMedia(survivingRecords, options = {}) {
  const fs = options.FileSystem ?? FileSystem;
  if (options.manifestComplete !== true) {
    return { ok: false, skipped: true, reason: 'manifest_incomplete', deleted: 0, failed: 0 };
  }
  if (typeof fs.readDirectoryAsync !== 'function') {
    return { ok: false, skipped: true, reason: 'unsupported', deleted: 0, failed: 0 };
  }

  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const graceMs =
    typeof options.graceMs === 'number' ? options.graceMs : CANDIDATE_ORPHAN_GRACE_MS;

  const referenced = new Set();
  for (const record of Array.isArray(survivingRecords) ? survivingRecords : []) {
    if (!record || typeof record !== 'object') continue;
    for (const uri of [record.candidateImageUri, record.candidateThumbnailUri]) {
      const canonical = canonicalizeMediaPath(uri);
      if (canonical) referenced.add(canonical);
    }
  }

  let deleted = 0;
  let failed = 0;
  for (const dir of [CANDIDATE_IMAGES_DIR, CANDIDATE_THUMBS_DIR]) {
    let entries;
    try {
      entries = await fs.readDirectoryAsync(dir);
    } catch {
      // A root that does not exist yet has nothing to sweep.
      continue;
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry !== 'string' || !entry) continue;
      const path = dir + entry;
      // Belt and braces: the path was built from a candidate root, and is still
      // re-verified before anything is deleted.
      if (!isCandidateOwnedPath(path)) continue;
      const canonical = canonicalizeMediaPath(path);
      if (!canonical || referenced.has(canonical)) continue;

      // In-progress intake protection.
      try {
        const info = await fs.getInfoAsync(path);
        const modifiedMs =
          typeof info?.modificationTime === 'number' ? info.modificationTime * 1000 : null;
        if (modifiedMs !== null && nowMs - modifiedMs < graceMs) continue;
      } catch {
        continue;
      }

      try {
        await fs.deleteAsync(path, { idempotent: true });
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { ok: true, skipped: false, deleted, failed };
}

/** Test seam only. Not used by production code. */
export const __closetCandidateMediaInternals = {
  IMAGE_WIDTH,
  THUMB_WIDTH,
  estimateOutputBytes,
  moveToFreshCandidatePath,
  ensureDirs,
};
