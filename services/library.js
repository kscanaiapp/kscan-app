/**
 * K-SCAN local Style Library — scan persistence via expo-file-system.
 *
 * Storage layout (all paths under FileSystem.documentDirectory/kscan_library/):
 *   kscan_library/kscan_library.json  — JSON array of SavedScan objects, newest first
 *   kscan_library/images/<mediaAssetId>.jpg     — persistent scan image
 *   kscan_library/thumbnails/<mediaAssetId>.jpg — persistent 160px-wide JPEG thumbnails
 *
 * ACCOUNT ISOLATION
 * The manifest is one file holding three logical partitions:
 *   - authenticated actor A records (ownerId === 'A')
 *   - authenticated actor B records (ownerId === 'B')
 *   - ownerless signed-out records  (ownerId === null)
 * Each partition has its own independent 25-record maximum. Ownerless records
 * are visible, mutable and evictable ONLY from the signed-out projection; an
 * authenticated actor can neither see them nor claim, upload, evict or delete
 * them.
 *
 * Ownership is never chosen by a UI caller. Every write carries an actor
 * request (actorId + actorEpoch + requestId) and ownership is derived from it
 * by services/actorContext.resolveWriteAuthority. Stale contexts fail closed.
 *
 * All functions are safe to call in fire-and-forget fashion; they never throw.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { saveScanToCloud, softDeleteCloudSavedScan } from './savedScansCloud';
import { normalizePurchaseOptions } from './dressingRoomCommerce';
import { resolveWriteAuthority, isActorRequestCurrent } from './actorContext';
import { hydrateScanHistory } from './identificationSnapshot';

const LIB_DIR      = FileSystem.documentDirectory + 'kscan_library/';
const LIBRARY_PATH = LIB_DIR + 'kscan_library.json';
// Staging and retention paths for the atomic manifest swap. Same idiom as
// services/privateSavedLookStore.ts, which already governs a manifest of this
// shape — Recent Scans is not getting a bespoke storage engine of its own.
const LIBRARY_TEMP_PATH   = LIBRARY_PATH + '.tmp';
const LIBRARY_BACKUP_PATH = LIBRARY_PATH + '.bak';
const IMAGES_DIR   = LIB_DIR + 'images/';
const THUMBS_DIR   = LIB_DIR + 'thumbnails/';
const MAX_SCANS     = 25; // per partition, not per manifest
// px. Sized in DEVICE PIXELS against the largest surface that renders it, not in
// pt: the Library grid card is ~176pt wide and iOS ships at 3x, so a 160px
// derivative was being upscaled 3x. Patterns are high-frequency detail —
// stripes and plaid alias into mush at 160px and no amount of upscaling restores
// them. 640 covers 176pt x 3.5. Must stay >= the candidate value in
// services/closetCandidateMedia.js, which promotion copies from.
const THUMB_WIDTH   = 640;
const THUMB_COMPRESS = 0.88;
const IMAGE_WIDTH   = 1440; // px — room-upload friendly, still compact

// Serializes every manifest mutation so concurrent saves/deletes cannot
// interleave a read-modify-write. The write itself is now an atomic
// stage-verify-swap (see persistLibrary), so serialization and durability are
// no longer the same concern.
let libraryMutationQueue = Promise.resolve();

let mediaAssetCounter = 0;

// ── Internal helpers ──────────────────────────────────────────────────────────

export function normalizeOwnerId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeActorIdArg(actorId) {
  return typeof actorId === 'string' && actorId.trim() ? actorId.trim() : null;
}

/**
 * Actor visibility contract.
 *   actorId === undefined -> unfiltered (internal complete-manifest reads only)
 *   actorId === null      -> signed-out projection: ownerless records only
 *   actorId === '<uuid>'  -> that authenticated actor's records only
 */
export function isVisibleToActor(scan, actorId) {
  if (actorId === undefined) return true;
  if (!scan || typeof scan !== 'object') return false;
  const ownerId = normalizeOwnerId(scan.ownerId);
  if (actorId === null) return ownerId === null;
  return ownerId === normalizeActorIdArg(actorId);
}

function enqueueLibraryMutation(operation) {
  const result = libraryMutationQueue.then(operation, operation);
  libraryMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureDirs() {
  try {
    // intermediates: true creates LIB_DIR and child dirs in one call
    await FileSystem.makeDirectoryAsync(IMAGES_DIR, { intermediates: true });
    await FileSystem.makeDirectoryAsync(THUMBS_DIR, { intermediates: true });
  } catch { /* non-fatal — directory may already exist */ }
}

/**
 * Replace the manifest atomically.
 *
 * The previous implementation wrote the serialized array straight over
 * LIBRARY_PATH. That is a whole-library hazard, not a one-record one: the
 * manifest is a single JSON document, so a write interrupted midway (device
 * out of space, process killed, I/O error) leaves truncated JSON on disk,
 * readAllLibrary's JSON.parse throws, and the catch returns [] — every
 * committed scan reads as gone, and the next successful save cements the loss.
 * Reproduced deterministically; see recentScanPersistenceIntegrity.test.js.
 *
 * Staging + verify + swap makes the failure atomic instead: an interrupted
 * write can only ever damage the temp file, and the live manifest is replaced
 * by a rename once its replacement is known to be complete and readable. On a
 * failed swap the retained backup is put back, so the caller's existing
 * rollback path sees an intact library rather than a half-updated one.
 *
 * Throws on failure — deliberately. Every caller already treats a throw as
 * "this write did not commit" and unwinds accordingly.
 */
async function persistLibrary(scans) {
  // Ensure LIB_DIR exists before writing (first-run safety)
  await FileSystem.makeDirectoryAsync(LIB_DIR, { intermediates: true }).catch(() => null);
  const payload = JSON.stringify(scans);

  // Stage. A stale temp from an earlier failure is never appended to or reused.
  await FileSystem.deleteAsync(LIBRARY_TEMP_PATH, { idempotent: true }).catch(() => null);
  await FileSystem.writeAsStringAsync(LIBRARY_TEMP_PATH, payload, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  // Verify before the swap. A short write that does not itself throw is the
  // exact case a length-blind rename would promote into the live manifest.
  const verified = await FileSystem.readAsStringAsync(LIBRARY_TEMP_PATH, {
    encoding: FileSystem.EncodingType.UTF8,
  }).catch(() => null);
  if (verified !== payload) {
    await FileSystem.deleteAsync(LIBRARY_TEMP_PATH, { idempotent: true }).catch(() => null);
    throw new Error('kscan_library_manifest_unverified');
  }

  // Retain the current manifest as the recovery copy, then swap.
  //
  // Only a manifest that still READS is worth retaining. readAllLibrary
  // already treats an unparseable live manifest as "unusable, fall back to
  // the retained copy" — so promoting that same unusable file over the
  // retained copy destroys the only good history we have. That is not
  // hypothetical: with a corrupt live manifest and a good backup, one failed
  // rename then restores the corrupt file and leaves no backup at all, and
  // the next read reports an empty library. Retention is skipped rather than
  // performed blindly; the existing (good) backup stays exactly where it is.
  const current = await FileSystem.getInfoAsync(LIBRARY_PATH).catch(() => ({ exists: false }));
  const currentIsUsable = current?.exists ? await manifestReads(LIBRARY_PATH) : false;
  if (current?.exists && currentIsUsable) {
    await FileSystem.deleteAsync(LIBRARY_BACKUP_PATH, { idempotent: true }).catch(() => null);
    await FileSystem.moveAsync({ from: LIBRARY_PATH, to: LIBRARY_BACKUP_PATH });
  } else if (current?.exists) {
    // Unreadable: discard it instead of letting it displace the good backup.
    await FileSystem.deleteAsync(LIBRARY_PATH, { idempotent: true }).catch(() => null);
  }
  try {
    await FileSystem.moveAsync({ from: LIBRARY_TEMP_PATH, to: LIBRARY_PATH });
  } catch (error) {
    // Put the previous verified manifest back rather than leaving no manifest.
    const backup = await FileSystem.getInfoAsync(LIBRARY_BACKUP_PATH).catch(() => ({ exists: false }));
    if (backup?.exists) {
      await FileSystem.moveAsync({ from: LIBRARY_BACKUP_PATH, to: LIBRARY_PATH }).catch(() => null);
    }
    throw error;
  }
}

/**
 * Whether a manifest file on disk still parses as a scan array.
 *
 * The same usability bar readAllLibrary applies when it decides whether to
 * trust a file or fall through to the retained copy. Never throws.
 */
async function manifestReads(uri) {
  try {
    return Array.isArray(JSON.parse(await FileSystem.readAsStringAsync(uri)));
  } catch {
    return false;
  }
}

/**
 * Promote a staged or retained manifest when the primary is missing.
 *
 * Only reachable if the process died inside the swap window above. Returns
 * whether a promotion happened; never throws.
 */
async function recoverMissingManifest() {
  const primary = await FileSystem.getInfoAsync(LIBRARY_PATH).catch(() => ({ exists: false }));
  if (primary?.exists) return false;
  for (const candidate of [LIBRARY_TEMP_PATH, LIBRARY_BACKUP_PATH]) {
    const info = await FileSystem.getInfoAsync(candidate).catch(() => ({ exists: false }));
    if (!info?.exists) continue;
    // Only promote a candidate that actually parses as a manifest.
    try {
      const raw = await FileSystem.readAsStringAsync(candidate);
      if (!Array.isArray(JSON.parse(raw))) continue;
    } catch {
      continue;
    }
    try {
      await FileSystem.moveAsync({ from: candidate, to: LIBRARY_PATH });
      return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

/**
 * Complete, normalized, UNFILTERED manifest. Reference-aware media deletion and
 * partition arithmetic must use this — never the current actor's visible list,
 * which would treat another actor's surviving reference as absent.
 */
async function readAllLibrary() {
  try {
    await recoverMissingManifest();
    // Per-record hydration (Phase 2B.2). Recent Scans legitimately holds V2, V1,
    // unversioned legacy and — after any past partial write — corrupt entries in
    // one array. The previous `.map()` let a single throwing record fall through
    // to the outer catch and return an EMPTY history, which reads to the user as
    // "all my scans are gone". Each record is now isolated: a failure drops only
    // that record, order is preserved, and nothing is rewritten on read.
    //
    // Document-level damage is a separate failure from record-level damage. A
    // manifest that does not parse at all is not "no scans" — it is a manifest
    // we cannot read, so the last verified copy is preferred over reporting an
    // empty history. Reading never rewrites either file.
    for (const path of [LIBRARY_PATH, LIBRARY_BACKUP_PATH]) {
      const info = await FileSystem.getInfoAsync(path).catch(() => ({ exists: false }));
      if (!info?.exists) continue;
      let parsed;
      try {
        parsed = JSON.parse(await FileSystem.readAsStringAsync(path));
      } catch {
        continue; // corrupt document — fall through to the retained copy
      }
      if (!Array.isArray(parsed)) continue;
      const { records } = hydrateScanHistory(parsed, (scan) => (
        scan && typeof scan === 'object' && !Array.isArray(scan) ? hydrateSavedScan(scan) : null
      ));
      return records;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Globally collision-resistant media asset identity.
 *
 * The legacy `scan_<Date.now()>_<4-digit random>` record id is not collision
 * safe enough to double as a writable media path: two actors can produce the
 * same id and silently overwrite each other's image. Media identity is
 * therefore separate from record identity, and creation is no-overwrite.
 */
export function createMediaAssetId() {
  mediaAssetCounter = (mediaAssetCounter + 1) % 0x100000;
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(36);
  return `m_${Date.now().toString(36)}_${mediaAssetCounter.toString(36)}_${rand()}${rand()}`;
}

/**
 * No-overwrite media write. If the destination already exists — including a
 * deliberately injected collision — a fresh identity is minted rather than
 * clobbering a file another actor's record may reference.
 */
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

async function generateThumbnail(photoUri, assetId) {
  try {
    await ensureDirs();
    const result = await ImageManipulator.manipulateAsync(
      photoUri,
      [{ resize: { width: THUMB_WIDTH } }],
      // q0.8 is fine on a 1440px image and wrong on a thumbnail: the same
      // quantization covers far more of the frame, so a patterned weave picks up
      // visible block artifacts exactly where the detail matters.
      { compress: THUMB_COMPRESS, format: ImageManipulator.SaveFormat.JPEG }
    );
    // Move out of OS cache into app-owned persistent storage
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

/**
 * Canonical comparable form for a local media path, so `file://a/b.jpg` and
 * `/a/b.jpg` are recognised as the same asset when counting references.
 */
export function canonicalizeMediaPath(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return null;
  let out = uri.trim();
  out = out.replace(/^file:\/\//i, '');
  out = out.replace(/\\/g, '/');
  out = out.replace(/\/{2,}/g, '/');
  return out.toLowerCase();
}

/**
 * Reference-aware unlink. A media file is removed only when NO surviving record
 * in the complete post-mutation manifest — across every authenticated partition
 * AND the ownerless partition — still references it.
 *
 * Stage 1 deliberately does not introduce a media-reference database.
 * Returns the paths whose unlink failed, so callers can report partial failure.
 */
export async function unlinkUnreferencedMedia(candidatePaths, survivingScans) {
  const referenced = new Set();
  for (const scan of survivingScans) {
    if (!scan || typeof scan !== 'object') continue;
    for (const uri of [scan.imageUri, scan.thumbnailUri]) {
      const canonical = canonicalizeMediaPath(uri);
      if (canonical) referenced.add(canonical);
    }
  }
  const seen = new Set();
  const failures = [];
  for (const path of candidatePaths) {
    const canonical = canonicalizeMediaPath(path);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    if (referenced.has(canonical)) continue; // another record still needs it
    try {
      await FileSystem.deleteAsync(path, { idempotent: true });
    } catch {
      failures.push(path);
    }
  }
  return failures;
}

/**
 * Select the durable commerce snapshot for a scan.
 *
 * Precedence is deliberate and must not be widened to `products`:
 * scanIdentificationMapper maps `similarityMatches` → `products` (the catalog
 * "similar items" shelf) and `recommendedProducts` → `purchaseOptions` (live
 * commerce). Falling back to `products` would relabel similarity matches as
 * purchase options. The `recommendedProducts` fallback covers the older
 * backend shape where no `similarityMatches` field exists and the mapper
 * leaves `purchaseOptions` undefined.
 */
export function selectPurchaseOptionsSnapshot(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const raw = Array.isArray(analysis.purchaseOptions)
    ? analysis.purchaseOptions
    : Array.isArray(analysis.recommendedProducts)
      ? analysis.recommendedProducts
      : [];
  return normalizePurchaseOptions(raw);
}

/**
 * Content fingerprint of a commerce snapshot, used to decide whether a shelf
 * still needs to be written.
 *
 * Must not be reduced to a count: v127 enrichment replaces offers in place
 * rather than appending, so an enriched shelf has the same length as the
 * discovery shelf it upgraded. Keying on length alone therefore treats the
 * better data as already-persisted and drops it. The fields here are exactly
 * the ones enrichment can improve.
 */
export function purchaseOptionsFingerprint(options) {
  if (!Array.isArray(options) || options.length === 0) return '';
  return options
    .map((option) => {
      if (!option || typeof option !== 'object') return '';
      return [option.productUrl, option.price, option.imageUrl, option.title]
        .map((field) => (typeof field === 'string' ? field : ''))
        .join('|');
    })
    .join('~');
}

/**
 * Re-normalize a persisted scan on read so legacy records (saved before the
 * commerce snapshot or before ownership existed), null, and malformed payloads
 * all hydrate into the canonical shape. Idempotent.
 *
 * A record with no ownerId hydrates to ownerId null — legacy ownerless — and is
 * never claimed by whoever happens to be signed in.
 */
export function hydrateSavedScan(scan) {
  if (!scan || typeof scan !== 'object') return scan;
  const stored = Array.isArray(scan.purchaseOptions)
    ? scan.purchaseOptions
    : Array.isArray(scan.purchase_options)
      ? scan.purchase_options
      : [];
  return {
    ...scan,
    ownerId: normalizeOwnerId(scan.ownerId),
    purchaseOptions: normalizePurchaseOptions(stored),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load saved scans visible to `actorId`.
 *   loadLibrary(undefined) -> unfiltered; reserved for internal callers
 *   loadLibrary(null)      -> ownerless records only (signed-out projection)
 *   loadLibrary('uid')     -> that authenticated actor's records only
 */
export async function loadLibrary(actorId = undefined) {
  try {
    const all = await readAllLibrary();
    if (actorId === undefined) return all;
    return all.filter(scan => isVisibleToActor(scan, actorId));
  } catch {
    return [];
  }
}

/** Complete unfiltered manifest — internal and test use. */
export async function loadCompleteLibrary() {
  return readAllLibrary();
}

/**
 * Remove media created solely for an operation that was then rejected.
 * Reference-checked against the complete manifest so a path that a surviving
 * record (any actor) already references is never unlinked.
 */
/**
 * Which UI path produced this identification (IMG-008 snapshot provenance).
 *
 * A caller that knows its own entry point supplies it. Otherwise the scan
 * source gives the only honest approximation available here, and anything
 * unrecognised stays `unknown` rather than being guessed at.
 */
const VALID_ENTRY_PATHS = new Set([
  'scanner_camera',
  'scanner_gallery',
  'elise_gallery',
  'elise_camera',
  'scanner_handoff',
  'unknown',
]);

function resolveEntryPath(entryPath, source) {
  if (VALID_ENTRY_PATHS.has(entryPath)) return entryPath;
  if (source === 'camera' || source === 'scan') return 'scanner_camera';
  if (source === 'upload') return 'scanner_gallery';
  return 'unknown';
}

async function cleanupRejectedMedia(paths) {
  const candidates = paths.filter(Boolean);
  if (candidates.length === 0) return [];
  try {
    const all = await readAllLibrary();
    return await unlinkUnreferencedMedia(candidates, all);
  } catch {
    return candidates; // report failure; never let stale state commit instead
  }
}

/**
 * Save a successful scan to the local library under the actor that owns the
 * capturing request.
 *
 * @param {object} opts
 * @param {string} opts.photoUri     - original capture URI (may be temp cache)
 * @param {object} opts.analysis     - { result, metadata, products } from useKScan
 * @param {string} [opts.source]     - 'scan' | 'camera' | 'upload' | 'fixture'
 * @param {object} opts.actorRequest - { actorId, epoch, requestId } captured before the async work
 * @param {string|null} [opts.ownerId] - optional echo of the expected owner; must agree
 * @returns {SavedScan|null} the saved object, or null when rejected or on failure
 */
export async function saveScan({ photoUri, analysis, source, actorRequest, ownerId, entryPath }) {
  // Pre-flight authority check: reject before spending work on media.
  const preAuthority = resolveWriteAuthority(actorRequest, ownerId);
  if (!preAuthority.ok) return null;

  let imageUri = null;
  let thumbnailUri = null;
  try {
    const id = 'scan_' + Date.now() + '_' + Math.floor(Math.random() * 9999);

    // Local image persistence is best-effort; existing library behavior remains local.
    imageUri = await persistScanImage(photoUri, createMediaAssetId());
    // Thumbnail generation is best-effort; missing thumbnail shows placeholder
    thumbnailUri = await generateThumbnail(photoUri, createMediaAssetId());

    // Re-validate AFTER the async media work: the actor may have changed while
    // the image was being written, and a stale result must not commit.
    const authority = resolveWriteAuthority(actorRequest, ownerId);
    if (!authority.ok) {
      await cleanupRejectedMedia([imageUri, thumbnailUri]);
      return null;
    }
    const owner = authority.ownerId;

    /** @type {SavedScan} */
    const scan = {
      id,
      createdAt: new Date().toISOString(),
      ownerId: owner,         // null === ownerless signed-out partition
      imageUri,               // null if persistence failed; legacy scans may not have it
      thumbnailUri,          // null if generation failed
      // Legacy display shape. Kept for backward compatibility with every
      // existing reader, but no longer blanked out: material, style tags and
      // confidence were hardcoded to null/[] here even when the model had
      // supplied them (IMG-008).
      attributes: {
        category:          analysis.metadata?.category   ?? '',
        silhouette:        analysis.metadata?.silhouette ?? '',
        color_palette:     analysis.metadata?.color      ?? '',
        material_estimate: analysis.metadata?.materialEstimate ?? analysis.metadata?.material ?? null,
        // Pattern (BUG-11). The mapper has always produced this and the legacy
        // attribute block silently dropped it, so a reopened scan could never
        // show a pattern and the cloud consumers that read metadata.pattern
        // always read null. Absent stays null — never invented.
        pattern:           analysis.metadata?.pattern ?? null,
        style_tags:        Array.isArray(analysis.metadata?.styleTags) ? analysis.metadata.styleTags.slice() : [],
        confidence_score:  typeof analysis.metadata?.confidenceScore === 'number'
          ? analysis.metadata.confidenceScore
          : null,
      },
      // Durable versioned identification. The row and this record already
      // accept arbitrary JSON, so the rich result is preserved without any
      // schema or RLS change. Absent for saves that never ran identification
      // (e.g. a direct Elise attachment), which hydrate from the legacy fields.
      ...(analysis.identificationSnapshot
        ? {
            identificationSnapshot: {
              ...analysis.identificationSnapshot,
              source: {
                ...analysis.identificationSnapshot.source,
                entryPath: resolveEntryPath(entryPath, source),
              },
            },
          }
        : {}),
      // Durable fashion-identification-v2 envelope (Phase 2B.2). Written only
      // when the Scanner V2 path produced a validated result; every legacy and
      // Elise save omits it, so a record never claims a contract it did not use.
      // Carries no Base64, evidence id, candidate id, detection digest, bounds,
      // local URI or raw provider output — see identificationSnapshot.ts.
      ...(analysis.identificationSnapshotV2
        ? { identificationSnapshotV2: analysis.identificationSnapshotV2 }
        : {}),
      result:   analysis.result   ?? '',
      products: Array.isArray(analysis.products) ? analysis.products : [],
      // Durable commerce snapshot. Without this the live purchase options exist
      // only in transient Scanner state and are gone when the scan is reopened.
      purchaseOptions: selectPurchaseOptionsSnapshot(analysis),
      source:   source || 'scan',
    };

    const committed = await enqueueLibraryMutation(async () => {
      // Last-moment check inside the serialized section.
      if (!isActorRequestCurrent(actorRequest)) return false;

      const existing = await readAllLibrary();
      const updated  = [scan, ...existing];

      // Per-partition retention: only the owner's own partition evicts, so an
      // authenticated actor can never evict another actor's or an ownerless record.
      const partition = updated.filter(item => normalizeOwnerId(item.ownerId) === owner);
      const evicted = partition.slice(MAX_SCANS);

      if (evicted.length > 0) {
        const evictedSet = new Set(evicted);
        const survivors = updated.filter(item => !evictedSet.has(item));
        await unlinkUnreferencedMedia(
          evicted.flatMap(item => [item.imageUri, item.thumbnailUri]).filter(Boolean),
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
    // cloud failure must never rollback the local scan. Ownerless records are
    // never uploaded.
    if (owner) {
      saveScanToCloud(scan).catch(() => null);
    }
    return scan;
  } catch {
    await cleanupRejectedMedia([imageUri, thumbnailUri]);
    return null;
  }
}

/**
 * Attach commerce that arrived after the scan was already saved (v127).
 *
 * v127 decouples commerce from scan completion, so the scan row is written
 * before purchase options exist. This updates that SAME record rather than
 * creating a second one — the record id is the join, and a scan whose id is not
 * present is simply not updated.
 *
 * Ownership is enforced exactly as elsewhere: the write runs inside the
 * serialized mutation queue and is rejected if the actor changed while commerce
 * was in flight, so late commerce can never land on another actor's record.
 *
 * Idempotent by construction: purchase options are replaced, never appended, so
 * a duplicate hydration or a retry cannot double the shelf.
 */
export async function attachScanPurchaseOptions(id, purchaseOptions, { actorRequest } = {}) {
  if (!id) return false;
  const normalized = normalizePurchaseOptions(
    Array.isArray(purchaseOptions) ? purchaseOptions : [],
  );
  // Nothing to attach. Writing an empty array would clear a shelf that a
  // previous hydration had legitimately filled.
  if (normalized.length === 0) return false;

  try {
    return await enqueueLibraryMutation(async () => {
      if (actorRequest !== undefined && !isActorRequestCurrent(actorRequest)) return false;

      const existing = await readAllLibrary();
      const index = existing.findIndex((item) => item && item.id === id);
      if (index === -1) return false;

      const target = existing[index];
      if (actorRequest !== undefined) {
        const owner = normalizeOwnerId(normalizeActorIdArg(actorRequest.actorId));
        // A record belongs to exactly one partition; late commerce may not
        // cross from the ownerless projection into an owned record or back.
        if (normalizeOwnerId(target.ownerId) !== owner) return false;
      }

      const updated = existing.slice();
      updated[index] = { ...target, purchaseOptions: normalized };
      await persistLibrary(updated);

      // Mirror the save path: cloud sync is fire-and-forget and its failure
      // never rolls back the committed local write.
      if (normalizeOwnerId(target.ownerId)) {
        saveScanToCloud(updated[index]).catch(() => null);
      }
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Delete a scan owned by / visible to the requesting actor. Both the record id
 * AND the actor must match: an authenticated actor can never delete an
 * ownerless record, and the signed-out projection can never delete an owned one.
 */
export async function deleteScan(id, { actorRequest, actorId } = {}) {
  try {
    let scopedActor;
    if (actorRequest !== undefined) {
      if (!isActorRequestCurrent(actorRequest)) return false;
      scopedActor = normalizeActorIdArg(actorRequest.actorId);
    } else if (actorId !== undefined) {
      scopedActor = normalizeActorIdArg(actorId);
    } else {
      return false; // fail closed: no unscoped deletes
    }

    const initial = await readAllLibrary();
    const initialTarget = initial.find(s => s.id === id && isVisibleToActor(s, scopedActor));
    if (!initialTarget) return false;

    // Ownerless records are never represented in the cloud, so only an
    // authenticated owner attempts a cloud soft-delete.
    if (scopedActor) {
      const cloudResult = await softDeleteCloudSavedScan({ localId: id });
      if (
        cloudResult &&
        !cloudResult.ok &&
        cloudResult.reason !== 'disabled' &&
        cloudResult.reason !== 'unauthenticated'
      ) {
        return false;
      }
    }

    return await enqueueLibraryMutation(async () => {
      const library = await readAllLibrary();
      const target = library.find(s => s.id === id && isVisibleToActor(s, scopedActor));
      if (!target) return false;
      const survivors = library.filter(s => s !== target);
      await unlinkUnreferencedMedia(
        [target.imageUri, target.thumbnailUri].filter(Boolean),
        survivors,
      );
      await persistLibrary(survivors);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Account-deletion local cleanup. Removes only records owned by the captured
 * owner id, preserves ownerless records and every other actor's records, and
 * unlinks media reference-aware. Idempotent and safe to retry.
 *
 * Never purges the ownerless partition: a missing/blank captured owner fails
 * closed rather than deleting device-local history.
 *
 * @returns {{ok: boolean, removed: number, mediaFailures: string[]}}
 */
export async function purgeLocalScansForOwner(capturedOwnerId) {
  const owner = normalizeOwnerId(capturedOwnerId);
  if (!owner) return { ok: false, removed: 0, mediaFailures: [] };
  try {
    return await enqueueLibraryMutation(async () => {
      const library = await readAllLibrary();
      const doomed = library.filter(s => normalizeOwnerId(s.ownerId) === owner);
      if (doomed.length === 0) return { ok: true, removed: 0, mediaFailures: [] };
      const survivors = library.filter(s => normalizeOwnerId(s.ownerId) !== owner);
      const mediaFailures = await unlinkUnreferencedMedia(
        doomed.flatMap(s => [s.imageUri, s.thumbnailUri]).filter(Boolean),
        survivors,
      );
      await persistLibrary(survivors);
      return { ok: mediaFailures.length === 0, removed: doomed.length, mediaFailures };
    });
  } catch {
    return { ok: false, removed: 0, mediaFailures: [] };
  }
}
