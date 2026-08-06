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
// See services/library.js for the sizing rationale. Device pixels, not dp: the
// Closet grid card renders at ~176dp and Android ships at up to 3.5x.
const THUMB_WIDTH   = 640;
const THUMB_COMPRESS = 0.88;
const IMAGE_WIDTH   = 1440;

/**
 * Record schema version — serialization must not depend on any feature flag.
 *
 * v2 adds STRUCTURED FASHION TAXONOMY (brand, clothing type, subtype, primary and
 * secondary colours, material, size) alongside the category v1 already had.
 * Before it, promotion could only preserve a category and folded the rest into
 * the title string — which made the title the sole storage for machine-readable
 * facts and left "Acme Bomber" as the only trace that a brand and a subtype had
 * ever been identified. Nothing downstream may parse a title to recover them.
 */
export const CLOSET_ITEM_SCHEMA_VERSION = 2;

/** Highest schema version this build knows how to read. */
export const CLOSET_ITEM_MAX_SUPPORTED_SCHEMA_VERSION = 2;

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
 * Bounded, de-duplicated scalar list.
 *
 * The bounds match services/closetCandidateSchema.js exactly (60 characters, 8
 * entries). A shorter limit here would silently truncate taxonomy the candidate
 * store had already accepted, which is the same class of quiet loss this whole
 * phase exists to remove. Non-strings and empty strings are dropped rather than
 * coerced, and de-duplication is case-insensitive so a retry cannot grow a list.
 */
function cleanTextArray(value, max = 60, limit = 8) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const text = cleanText(entry, max);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Structured taxonomy vocabulary ───────────────────────────────────────────

/**
 * The committed taxonomy fields, named ONCE.
 *
 * Every consumer — the record builder, the repair path, promotion's read-back
 * verification and the read projection — works from this list, so a field can
 * never be preserved by one of them and quietly dropped by another.
 */
export const CLOSET_ITEM_TAXONOMY_FIELDS = Object.freeze([
  'category',
  'clothingType',
  'subtype',
  'brand',
  'primaryColor',
  'secondaryColors',
  'material',
  'size',
]);

const CLOSET_ITEM_TAXONOMY_LIST_FIELDS = Object.freeze(['secondaryColors', 'material']);

/** Bounds are the candidate store's, field for field. See cleanTextArray. */
const CLOSET_ITEM_TAXONOMY_BOUNDS = Object.freeze({
  category: 80,
  clothingType: 80,
  subtype: 80,
  brand: 120,
  primaryColor: 60,
  secondaryColors: 60,
  material: 60,
  size: 40,
});

/**
 * ONE normalizer, so the builder and the repair path cannot drift into
 * disagreeing about what a valid brand or colour list is.
 */
function normalizeClosetTaxonomyValue(field, value) {
  const max = CLOSET_ITEM_TAXONOMY_BOUNDS[field];
  if (!max) return null;
  return CLOSET_ITEM_TAXONOMY_LIST_FIELDS.includes(field)
    ? cleanTextArray(value, max, 8)
    : cleanText(value, max);
}

/** True when a stored taxonomy value is absent — null, or an empty list. */
export function isAbsentClosetTaxonomyValue(value) {
  if (Array.isArray(value)) return value.length === 0;
  return value === null || value === undefined || value === '';
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
    // INTERNAL PROVENANCE (Build 2, Phase 3). The staged ClosetCandidate this
    // item was promoted from, scoped by ownerId like every other field here.
    //
    // Not user-facing, not editable (updateClosetItem patches title/category/
    // notes only), optional on every pre-Build-2 record, and the key the
    // promotion coordinator asks "has this actor already committed this
    // candidate?" with. It is deliberately NOT globally unique: two actors may
    // legitimately hold items whose provenance strings collide, and the manifest
    // is one file shared by every actor partition, so every lookup pairs it with
    // the owner.
    sourceCandidateId: cleanText(draft.sourceCandidateId, 120),
    imageUri: draft.imageUri ?? null,
    thumbnailUri: draft.thumbnailUri ?? null,
    title: cleanText(draft.title) || 'Closet item',

    // STRUCTURED FASHION TAXONOMY (v2). Machine-readable, each field storing one
    // fact. The title is a display label built FROM these; it is never the place
    // they live, and nothing may parse it to get them back.
    //
    // Bounds are the candidate store's, field for field. Absent stays absent:
    // a missing brand is null, never "Unknown", and a missing colour is never
    // read off the material list.
    category: normalizeClosetTaxonomyValue('category', draft.category),
    clothingType: normalizeClosetTaxonomyValue('clothingType', draft.clothingType),
    subtype: normalizeClosetTaxonomyValue('subtype', draft.subtype),
    brand: normalizeClosetTaxonomyValue('brand', draft.brand),
    primaryColor: normalizeClosetTaxonomyValue('primaryColor', draft.primaryColor),
    secondaryColors: normalizeClosetTaxonomyValue('secondaryColors', draft.secondaryColors),
    material: normalizeClosetTaxonomyValue('material', draft.material),
    size: normalizeClosetTaxonomyValue('size', draft.size),

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

// ── Schema migration and reconstruction (v2) ─────────────────────────────────

/**
 * v1 -> v2: structured taxonomy.
 *
 * Nothing is invented and nothing is derived. A v1 record has never carried a
 * brand, a subtype or a colour, and the title it does carry is a display string
 * that may or may not contain one — parsing it would manufacture facts the store
 * never recorded. Every new field therefore resolves to its canonical empty
 * value through the allowlist builder.
 */
function migrateClosetItemV1ToV2(raw) {
  return { ...raw, schemaVersion: 2 };
}

const CLOSET_ITEM_MIGRATIONS = Object.freeze({
  0: migrateClosetItemV1ToV2,
  1: migrateClosetItemV1ToV2,
});

/**
 * Read one persisted Closet record safely.
 *
 * LAZY, NEVER EAGER. Migration happens on the READ path and the result is not
 * written back: a v1 record on disk stays a v1 record until something has a real
 * reason to rewrite it. Rewriting the whole manifest merely to add empty fields
 * would touch every record the user owns to change nothing they can see.
 *
 * Fails CLOSED and never throws:
 *   - a non-object, or a record with no usable id, is rejected
 *   - a FUTURE schemaVersion is rejected rather than guessed at, because reading
 *     a newer record with older rules is how fields get silently dropped
 *   - the record is reconstructed through the allowlist, so an unknown key on
 *     disk is not carried into memory and cannot be written back
 *
 * A rejected record is skipped by the reader. It is never repaired in place and
 * never deleted — `readAllCloset` keeps returning the RAW array to every writer,
 * so a record this function cannot interpret still survives the next write.
 */
export function migrateClosetItemRecord(rawRecord) {
  try {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
      return { ok: false, reason: 'closet_store_corrupt' };
    }

    const declared = rawRecord.schemaVersion;
    let version =
      typeof declared === 'number' && Number.isFinite(declared) && declared >= 0
        ? Math.floor(declared)
        : 1;
    if (version > CLOSET_ITEM_MAX_SUPPORTED_SCHEMA_VERSION) {
      return { ok: false, reason: 'closet_store_future_schema' };
    }

    const migratedFrom = version;
    let working = rawRecord;
    while (version < CLOSET_ITEM_SCHEMA_VERSION) {
      const step = CLOSET_ITEM_MIGRATIONS[version];
      if (typeof step !== 'function') return { ok: false, reason: 'closet_store_corrupt' };
      working = step(working);
      const next =
        typeof working?.schemaVersion === 'number' ? Math.floor(working.schemaVersion) : NaN;
      if (!Number.isFinite(next) || next <= version) {
        return { ok: false, reason: 'closet_store_corrupt' };
      }
      version = next;
    }

    // Identity is not something a reader may mint. A record with no id cannot be
    // addressed, updated or deleted, so it is not a record.
    const id = cleanText(working.id, 200);
    if (!id) return { ok: false, reason: 'closet_store_corrupt' };

    const ownerId =
      typeof working.ownerId === 'string' && working.ownerId.trim()
        ? working.ownerId.trim()
        : null;
    const record = buildClosetRecord({ ...working, id }, ownerId, working.updatedAt);

    // Fields the builder stamps rather than carries. Re-asserted from the record
    // on disk so reconstruction cannot restart a lifetime or resurrect a
    // soft-deleted row.
    record.createdAt = typeof working.createdAt === 'string' ? working.createdAt : record.createdAt;
    record.updatedAt = typeof working.updatedAt === 'string' ? working.updatedAt : record.createdAt;
    record.imageUri = working.imageUri ?? null;
    record.thumbnailUri = working.thumbnailUri ?? null;
    if (working.deletedAt) record.deletedAt = working.deletedAt;

    return { ok: true, record, migratedFrom };
  } catch {
    return { ok: false, reason: 'closet_store_corrupt' };
  }
}

/** Reconstructed record, or null when it cannot be interpreted. Never throws. */
function hydrateClosetItem(rawRecord) {
  const migrated = migrateClosetItemRecord(rawRecord);
  return migrated.ok ? migrated.record : null;
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

// ── Stable promotion media destination (Build 2, Phase 3) ────────────────────

/** Filesystem-safe form of an opaque id. Lossless for uuids and minted ids. */
function slugifyIdentity(value, max) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max);
}

/** FNV-1a. Not a security primitive — it only disambiguates slugified ids. */
function identityChecksum(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash ^ value.charCodeAt(index)) * 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * THE STABLE COMMITTED-MEDIA DESTINATION for a candidate promotion.
 *
 *     same actor + same source candidate  ->  same logical destination
 *
 * Derived from the promotion identity and NOTHING else: not the category, the
 * colour, the brand, the source URI, the batch position, the taxonomy, or the
 * clock. A retry after an interrupted attempt therefore resolves to the file the
 * previous attempt already wrote instead of minting a new random asset id and
 * leaving the old one behind on every attempt.
 *
 * The owner is part of the NAME rather than of a directory, because the two
 * media roots are flat and shared by every actor partition. Both components are
 * slugified (lossless for a uuid and for the minted candidate id shape) and the
 * checksum is taken over the RAW pair, so two identities that slugify alike
 * still resolve to different files.
 */
export function closetPromotionMediaAssetId(ownerId, sourceCandidateId) {
  const candidateId = cleanText(sourceCandidateId, 120);
  if (!candidateId) return null;
  const owner =
    typeof ownerId === 'string' && ownerId.trim() ? ownerId.trim() : 'device-local';
  return `cand_${slugifyIdentity(owner, 48)}_${slugifyIdentity(candidateId, 72)}_${identityChecksum(
    `${owner}|${candidateId}`
  )}`;
}

/**
 * The two committed-media paths a promotion identity resolves to.
 *
 * Exported so the Phase 4 recovery coordinator can PROTECT the destinations an
 * in-flight promotion has reserved without knowing where the Closet media roots
 * are. The asset id is derived by `closetPromotionMediaAssetId` and nothing else
 * may choose it, which is what keeps "the file this promotion will write" and
 * "the file the sweep must not delete" the same string by construction.
 */
export function closetPromotionMediaPaths(ownerId, sourceCandidateId) {
  const assetId = closetPromotionMediaAssetId(ownerId, sourceCandidateId);
  if (!assetId) return null;
  return {
    imageUri: IMAGES_DIR + assetId + '.jpg',
    thumbnailUri: THUMBS_DIR + assetId + '.jpg',
  };
}

/**
 * Which committed item, if any, owns each media path in the WHOLE manifest.
 *
 * Every actor partition plus the ownerless one, for the same reason
 * `unlinkUnreferencedMedia` spans them: this map is what decides whether a file
 * already sitting at a stable destination is another item's media (fail closed)
 * or this promotion identity's own leftover (verify and reuse).
 */
async function collectClosetMediaOwners() {
  const owners = new Map();
  let items = [];
  try {
    items = await readAllCloset();
  } catch {
    // A manifest we cannot read cannot prove a destination is free. Callers
    // treat an empty map as "unknown", and the write below fails closed on any
    // pre-existing file it cannot attribute.
    return { ok: false, owners };
  }
  for (const item of items) {
    for (const uri of [item.imageUri, item.thumbnailUri]) {
      const canonical = canonicalizeMediaPath(uri);
      if (!canonical) continue;
      if (owners.has(canonical)) continue;
      owners.set(canonical, {
        itemId: item.id ?? null,
        ownerId: item.ownerId ?? null,
        sourceCandidateId: item.sourceCandidateId ?? null,
      });
    }
  }
  return { ok: true, owners };
}

/**
 * Place a freshly produced derivative at its STABLE destination.
 *
 * The rules, in the order they are applied:
 *
 *   1. A destination referenced by a committed item with a DIFFERENT identity is
 *      a conflict, and the write FAILS CLOSED. It is never overwritten, and the
 *      promotion never falls back to a random path — a fallback would silently
 *      restore the "new file on every retry" behaviour this exists to remove.
 *   2. A destination referenced by an item with THIS identity is that item's own
 *      media. It is reused as-is (the redundant temp is discarded). This is the
 *      window where a concurrent attempt committed first; the serialized commit
 *      check then dedups this attempt onto that item.
 *   3. An UNREFERENCED file at the destination is a leftover from an interrupted
 *      attempt by this same identity — no other identity can address this path.
 *      It is verified by CONTENT, not by existence: identical bytes are reused,
 *      anything else is replaced.
 *   4. A move that does not leave a readable file is not ownership, and is
 *      reported as a failure rather than acknowledged.
 */
async function placeAtStableClosetPath(producedUri, dir, assetId, context) {
  if (typeof producedUri !== 'string' || !producedUri.trim()) {
    return { ok: false, reason: 'media_persist_failed' };
  }
  const destPath = dir + assetId + '.jpg';
  const canonical = canonicalizeMediaPath(destPath);
  const owner = canonical ? context.owners.get(canonical) : null;

  if (owner) {
    const sameIdentity =
      (owner.ownerId ?? null) === (context.ownerId ?? null) &&
      owner.sourceCandidateId === context.sourceCandidateId;
    if (!sameIdentity) {
      await discardClosetTemp(producedUri);
      return { ok: false, reason: 'media_destination_conflict' };
    }
    const existing = await FileSystem.getInfoAsync(destPath).catch(() => ({ exists: false }));
    if (existing?.exists) {
      await discardClosetTemp(producedUri);
      return { ok: true, path: destPath, reused: true };
    }
  } else if (!context.ownersKnown) {
    // We could not read the manifest, so we cannot attribute an existing file.
    const existing = await FileSystem.getInfoAsync(destPath).catch(() => ({ exists: false }));
    if (existing?.exists) {
      await discardClosetTemp(producedUri);
      return { ok: false, reason: 'media_destination_conflict' };
    }
  }

  const existing = await FileSystem.getInfoAsync(destPath).catch(() => ({ exists: false }));
  if (existing?.exists) {
    if (await sameFileBytes(destPath, producedUri)) {
      await discardClosetTemp(producedUri);
      return { ok: true, path: destPath, reused: true };
    }
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => null);
  }

  try {
    await FileSystem.moveAsync({ from: producedUri, to: destPath });
  } catch {
    return { ok: false, reason: 'media_persist_failed' };
  }
  const persisted = await FileSystem.getInfoAsync(destPath).catch(() => ({ exists: false }));
  if (!persisted?.exists) return { ok: false, reason: 'media_persist_failed' };
  return { ok: true, path: destPath, reused: false };
}

/**
 * Exact byte equality, via the Base64 encoding of both files.
 *
 * Base64 is a bijection over byte strings, so equal encodings mean equal bytes —
 * the same equality semantics the candidate content hash relies on, without
 * adding a digest dependency to this module. Any read failure answers `false`,
 * so an unverifiable file is replaced rather than trusted.
 */
async function sameFileBytes(left, right) {
  try {
    const encoding = FileSystem.EncodingType?.Base64 ?? 'base64';
    const [a, b] = await Promise.all([
      FileSystem.readAsStringAsync(left, { encoding }),
      FileSystem.readAsStringAsync(right, { encoding }),
    ]);
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    return a === b;
  } catch {
    return false;
  }
}

/** Best-effort removal of a manipulator temp file. Never throws. */
async function discardClosetTemp(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    /* a stranded cache file is not a reason to fail a promotion */
  }
}

/**
 * Derive a Closet-OWNED image + thumbnail from any source URI.
 *
 * ImageManipulator always writes a fresh file into the OS cache, which is then
 * moved into Closet storage. The source URI is therefore never moved, never
 * consumed, and never referenced by the resulting record — which is what makes
 * promotion non-destructive to the originating Recent Scan or candidate.
 *
 * `stable` switches the destination from a fresh random asset id to the
 * identity-derived one. It is set ONLY from a promotion identity the caller
 * already resolved, never from a caller-supplied filename.
 */
async function deriveClosetMedia(sourceUri, stable = null) {
  await ensureDirs();
  let imageUri = null;
  let thumbnailUri = null;
  let failure = 'media_persist_failed';

  try {
    const full = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: IMAGE_WIDTH } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
    );
    if (stable) {
      const placed = await placeAtStableClosetPath(full?.uri, IMAGES_DIR, stable.assetId, stable);
      imageUri = placed.ok ? placed.path : null;
      if (!placed.ok) failure = placed.reason;
    } else {
      imageUri = await moveToFreshClosetPath(full.uri, IMAGES_DIR, createMediaAssetId());
    }
  } catch {
    imageUri = null;
  }

  // A Closet item with no durable image is not a usable owned-inventory record.
  if (!imageUri) return { ok: false, reason: failure, imageUri: null, thumbnailUri: null };

  try {
    const thumb = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: THUMB_COMPRESS, format: ImageManipulator.SaveFormat.JPEG }
    );
    if (stable) {
      // A thumbnail conflict is NOT fatal, exactly as a thumbnail failure is not:
      // the item still owns a full image, and refusing the whole promotion over a
      // single derivative would be a worse answer than showing no thumbnail.
      const placed = await placeAtStableClosetPath(thumb?.uri, THUMBS_DIR, stable.assetId, stable);
      thumbnailUri = placed.ok ? placed.path : null;
    } else {
      thumbnailUri = await moveToFreshClosetPath(thumb.uri, THUMBS_DIR, createMediaAssetId());
    }
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
 * True only for a path inside the COMMITTED Closet media roots.
 *
 * The mirror image of services/closetCandidateMedia.js#isCandidateOwnedPath, and
 * the check that lets a caller prove a committed item owns its media rather than
 * pointing at a candidate-domain or Recent Scan file.
 */
export function isClosetOwnedMediaPath(uri) {
  const canonical = canonicalizeMediaPath(uri);
  if (!canonical) return false;
  // A `..` segment starts inside the root as a STRING and resolves outside it as
  // a PATH. `canonicalizeMediaPath` normalizes scheme, separators and case but
  // deliberately does not resolve relative segments — it is the shared asset
  // identity function for three stores — so the prefix check refuses them here.
  // Mirrors services/closetCandidateMedia.js#isCandidateOwnedPath exactly.
  let decoded = canonical;
  for (let pass = 0; pass < 4; pass += 1) {
    const normalized = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (normalized.split('/').includes('..')) return false;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next.toLowerCase();
    } catch {
      // Malformed escaping is not a path this deletion boundary can own safely.
      return false;
    }
  }
  if (/%(?:25)*(?:2e|2f|5c)/i.test(decoded)) return false;
  const imagesRoot = canonicalizeMediaPath(IMAGES_DIR);
  const thumbsRoot = canonicalizeMediaPath(THUMBS_DIR);
  if (!imagesRoot || !thumbsRoot) return false;
  return canonical.startsWith(imagesRoot) || canonical.startsWith(thumbsRoot);
}

/**
 * Read-back verification for a committed item's media.
 *
 * Both halves matter: the reference must be a Closet-owned path (so the item is
 * not quietly borrowing a candidate's file), and the bytes must actually be there
 * (so "committed" is not just a manifest entry). Fails closed on any error.
 */
export async function verifyClosetItemMedia(item) {
  const uri = item && typeof item === 'object' ? item.imageUri : null;
  if (!isClosetOwnedMediaPath(uri)) return false;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info?.exists === true;
  } catch {
    return false;
  }
}

/**
 * Outcome codes for a typed Closet read.
 *
 * `RECOVERED_WITH_ITEMS` / `RECOVERED_EMPTY` exist in the contract but are NOT
 * produced by any current code path, and that is a property of the store rather
 * than an oversight: `persistCloset` writes the committed manifest directly and
 * keeps no `.bak`, so there is nothing to recover FROM. (The candidate store, by
 * contrast, does write-verify-swap with a backup — see
 * services/closetCandidateLibrary.js.) The codes are carried here so a caller's
 * exhaustive handling stays correct if this store ever gains that durability,
 * and `readClosetManifest` is the single place that would set `recovered`.
 * Giving the committed Closet a backup is a Build 2 durability change and is
 * deliberately out of Phase 2 scope.
 */
export const CLOSET_LOAD_CODES = Object.freeze({
  SUCCESS_WITH_ITEMS: 'SUCCESS_WITH_ITEMS',
  SUCCESS_EMPTY: 'SUCCESS_EMPTY',
  RECOVERED_WITH_ITEMS: 'RECOVERED_WITH_ITEMS',
  RECOVERED_EMPTY: 'RECOVERED_EMPTY',
  READ_FAILED: 'READ_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  FUTURE_SCHEMA: 'FUTURE_SCHEMA',
  ACTOR_CHANGED: 'ACTOR_CHANGED',
});

/**
 * Read + interpret the manifest once, reporting WHY rather than just what.
 *
 * Separated from `loadClosetTyped` only so the raw-read failure and the
 * per-record interpretation failure stay distinguishable; the caller collapses
 * them into a single outcome.
 */
async function readClosetManifest() {
  let parsed;
  try {
    parsed = await readAllCloset();
  } catch {
    // A read or JSON failure. Reported, never repaired and never truncated on
    // disk — a transient fault must not cost the user their Closet.
    return { read: false, raw: [], records: [], skipped: 0, futureSchema: 0, recovered: false };
  }

  const records = [];
  let skipped = 0;
  let futureSchema = 0;
  for (const item of parsed) {
    const migrated = migrateClosetItemRecord(item);
    if (migrated.ok) {
      // VALIDATED, NOT TRANSFORMED. The RAW persisted record is kept, never
      // `migrated.record`: reconstructing through the allowlist here would strip
      // fields this store does not own but other subsystems legitimately read
      // off a committed record — the candidate store's exact-hash duplicate
      // check being the live example. Canonical shape for a SCREEN is the
      // projection's job (services/closetItemProjection.ts), which is where the
      // UI boundary actually is.
      //
      // A record that fails is SKIPPED here and left untouched on disk, because
      // every writer reads the complete raw array and so cannot drop it.
      records.push(item);
      continue;
    }
    skipped += 1;
    if (migrated.reason === 'closet_store_future_schema') futureSchema += 1;
  }
  return { read: true, raw: parsed, records, skipped, futureSchema, recovered: false };
}

/**
 * Load Closet items for an actor WITH a typed outcome.
 *
 * THE SINGLE SOURCE OF TRUTH for reading the committed Closet. `loadCloset`
 * below is a thin compatibility wrapper over this function, so there is exactly
 * one read implementation rather than two that can drift.
 *
 * WHY THIS EXISTS: `loadCloset` answers `[]` for an empty Closet and for a
 * failed read alike, so a caller cannot tell "you own nothing" from "we could
 * not look". That is fine for a list screen and wrong for anything that must
 * explain itself to the user.
 *
 * PARTIAL INTERPRETATION IS STILL SUCCESS. When some records are readable and
 * others are not, the readable ones are returned with `ok: true` and the count
 * surfaced in `skipped` — matching the pre-existing behavior exactly. Only a
 * manifest that yielded NOTHING despite containing entries is a failure.
 *
 * @param {string|null|undefined} [actorId] — null selects the ownerless
 *   device-local partition; undefined returns every partition (tests only).
 * @param {{actorRequest?: object}} [options] — when supplied, the captured
 *   actor request is revalidated after the await and a stale one is refused.
 * @returns {Promise<{ok: boolean, items: object[], code: string,
 *   recovered: boolean, skipped: number, message: string|null}>}
 */
export async function loadClosetTyped(actorId = undefined, options = {}) {
  const fail = (code, message) => ({
    ok: false,
    items: [],
    code,
    recovered: false,
    skipped: 0,
    message,
  });

  try {
    await closetMutationQueue;
    const state = await readClosetManifest();

    // Revalidated AFTER the await: the actor may have changed while reading, and
    // handing the new actor the previous actor's rows is the one outcome that
    // must never happen.
    const actorRequest = options?.actorRequest;
    if (actorRequest !== undefined && !isActorRequestCurrent(actorRequest)) {
      return fail(CLOSET_LOAD_CODES.ACTOR_CHANGED, 'The signed-in account changed.');
    }

    if (!state.read) {
      return fail(CLOSET_LOAD_CODES.READ_FAILED, "We couldn't load your Closet.");
    }

    // Every entry was unreadable. Distinguish "a newer app wrote this" from
    // "this is damaged", because only one of them is a corruption.
    if (state.records.length === 0 && state.raw.length > 0) {
      return state.futureSchema > 0
        ? fail(
            CLOSET_LOAD_CODES.FUTURE_SCHEMA,
            'Your Closet was saved by a newer version of K Scan.',
          )
        : fail(CLOSET_LOAD_CODES.VALIDATION_FAILED, "We couldn't read your Closet.");
    }

    const items = state.records
      .filter((item) => !item.deletedAt && isVisibleToActor(item, actorId))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

    const empty = items.length === 0;
    const code = state.recovered
      ? empty
        ? CLOSET_LOAD_CODES.RECOVERED_EMPTY
        : CLOSET_LOAD_CODES.RECOVERED_WITH_ITEMS
      : empty
        ? CLOSET_LOAD_CODES.SUCCESS_EMPTY
        : CLOSET_LOAD_CODES.SUCCESS_WITH_ITEMS;

    return {
      ok: true,
      items,
      code,
      recovered: state.recovered,
      skipped: state.skipped,
      message: null,
    };
  } catch {
    // Never throws into a caller. No exception text and no filesystem path is
    // exposed: `message` is user-facing copy, not a diagnostic.
    return fail(CLOSET_LOAD_CODES.READ_FAILED, "We couldn't load your Closet.");
  }
}

/**
 * Load Closet items for an actor. Returns [] on any error.
 *
 * COMPATIBILITY SURFACE, unchanged for every existing caller. It now delegates
 * to `loadClosetTyped` and discards the outcome, which is exactly the old
 * contract: the items on success, `[]` on failure or emptiness.
 *
 * @param {string|null|undefined} [actorId] — null selects the ownerless
 *   device-local partition; undefined returns every partition (tests only).
 */
export async function loadCloset(actorId = undefined) {
  const result = await loadClosetTyped(actorId);
  return result.ok ? result.items : [];
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

  // PROVENANCE IDEMPOTENCY FIRST, before any content lookup and before any media
  // work. "This actor already committed an item from this candidate" is a
  // stronger and cheaper answer than "some item has the same content", and
  // conflating the two is what would let a retry create a second item.
  const sourceCandidateId = cleanText(draft?.sourceCandidateId, 120);
  if (sourceCandidateId) {
    const promoted = await findClosetItemBySourceCandidate(
      sourceCandidateId,
      preAuthority.ownerId
    );
    if (promoted) return { ok: true, item: promoted, deduped: true };
  }

  // Idempotency pre-check: a committed item for this lineage short-circuits
  // before any media work, so a double tap cannot duplicate an item or spend
  // a second image write.
  const lineage = cleanText(draft?.sourceLineageId, 300);
  if (lineage) {
    const existing = await findClosetItemByLineage(lineage, preAuthority.ownerId);
    if (existing) return { ok: true, item: existing, deduped: true };
  }

  // A promotion writes to a STABLE, identity-derived destination; every other
  // intake keeps the fresh random asset id it has always used.
  let stable = null;
  if (sourceCandidateId) {
    const assetId = closetPromotionMediaAssetId(preAuthority.ownerId, sourceCandidateId);
    if (!assetId) return { ok: false, reason: 'media_persist_failed' };
    const attribution = await collectClosetMediaOwners();
    stable = {
      assetId,
      ownerId: preAuthority.ownerId,
      sourceCandidateId,
      owners: attribution.owners,
      ownersKnown: attribution.ok,
    };
  }

  let imageUri = null;
  let thumbnailUri = null;
  try {
    const media = await deriveClosetMedia(sourceUri, stable);
    if (!media.ok) return { ok: false, reason: media.reason ?? 'media_persist_failed' };
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

      // Provenance commit-check, ahead of the lineage one for the same reason the
      // pre-check is: another attempt for the same candidate may have committed
      // while this one was writing media.
      if (record.sourceCandidateId) {
        const promoted = existing.find(
          (item) =>
            !item.deletedAt &&
            item.sourceCandidateId === record.sourceCandidateId &&
            (item.ownerId || null) === (record.ownerId || null)
        );
        if (promoted) return { item: hydrateClosetItem(promoted) ?? promoted, deduped: true };
      }

      // Idempotency commit-check: another in-flight promotion for the same
      // lineage may have committed while this one was writing media.
      if (record.sourceLineageId) {
        const dupe = existing.find(
          (item) =>
            !item.deletedAt &&
            item.sourceLineageId === record.sourceLineageId &&
            (item.ownerId || null) === (record.ownerId || null)
        );
        if (dupe) return { item: hydrateClosetItem(dupe) ?? dupe, deduped: true };
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

/**
 * PROVENANCE LOOKUP: has this actor already committed an item originating from
 * this candidate?
 *
 * Actor-scoped, exactly like the lineage lookup. Two different actors may hold
 * items carrying the same provenance string without either being visible to the
 * other, which is why the pair — not the id alone — is the identity.
 */
export async function findClosetItemBySourceCandidate(sourceCandidateId, ownerId) {
  const candidateId = cleanText(sourceCandidateId, 120);
  if (!candidateId) return null;
  try {
    await closetMutationQueue;
    const items = await readAllCloset();
    const found = items.find(
      (item) =>
        !item.deletedAt &&
        item.sourceCandidateId === candidateId &&
        (item.ownerId || null) === (ownerId ?? null)
    );
    // Hydrated, because promotion's read-back verifies TAXONOMY on what this
    // returns: a raw v1 row would be missing the fields it is about to check.
    return found ? hydrateClosetItem(found) : null;
  } catch {
    return null;
  }
}

/** Idempotency lookup: owner + stable source lineage. */
export async function findClosetItemByLineage(sourceLineageId, ownerId) {
  const lineage = cleanText(sourceLineageId, 300);
  if (!lineage) return null;
  try {
    await closetMutationQueue;
    const items = await readAllCloset();
    const found = items.find(
      (item) =>
        !item.deletedAt &&
        item.sourceLineageId === lineage &&
        (item.ownerId || null) === (ownerId ?? null)
    );
    return found ? hydrateClosetItem(found) : null;
  } catch {
    return null;
  }
}

/**
 * Update approved editable metadata on a Closet item.
 *
 * Title, category and notes are the ONLY writable fields. Media, lineage,
 * candidate provenance and identity are immutable here — the next record is
 * spread from the persisted one and only the three approved keys are replaced,
 * so a patch naming `sourceCandidateId` changes nothing. Ownership is re-derived
 * from the captured actor and is never taken from the caller.
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
 * BACKFILL taxonomy onto an item that was committed before it could carry any.
 *
 * DELIBERATELY NOT A GENERAL UPDATE. It fills fields that are ABSENT and touches
 * nothing else: a value already on the record wins, because the record may have
 * been edited since and a promotion retry is not a licence to overwrite what the
 * user has. Nothing outside the taxonomy list can be reached at all, so identity,
 * ownership, media, provenance and lineage are untouchable here by construction.
 *
 * This exists for exactly one situation: an item promoted by Phase 3, before the
 * committed schema could store anything but a category. A retry finds it by
 * provenance and repairs it in place rather than creating a second item.
 */
export async function repairClosetItemTaxonomy(id, taxonomy, { actorRequest, ownerId } = {}) {
  const authority = resolveWriteAuthority(actorRequest, ownerId);
  if (!authority.ok) return { ok: false, reason: authority.reason };
  if (!taxonomy || typeof taxonomy !== 'object' || Array.isArray(taxonomy)) {
    return { ok: false, reason: 'nothing_to_repair' };
  }

  return enqueueClosetMutation(async () => {
    if (!isActorRequestCurrent(actorRequest)) {
      return { ok: false, reason: 'stale_actor_context' };
    }
    const items = await readAllCloset();
    const index = items.findIndex(
      (item) => item.id === id && isVisibleToActor(item, authority.ownerId)
    );
    if (index === -1) return { ok: false, reason: 'not_found' };

    const current = hydrateClosetItem(items[index]);
    if (!current) return { ok: false, reason: 'unreadable_record' };

    const filled = [];
    const next = { ...current };
    for (const field of CLOSET_ITEM_TAXONOMY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(taxonomy, field)) continue;
      if (!isAbsentClosetTaxonomyValue(next[field])) continue;
      const value = normalizeClosetTaxonomyValue(field, taxonomy[field]);
      if (isAbsentClosetTaxonomyValue(value)) continue;
      next[field] = value;
      filled.push(field);
    }

    if (filled.length === 0) return { ok: true, item: current, filled: [] };

    next.updatedAt = new Date().toISOString();
    const updated = items.slice();
    // Written back through the allowlist so the repaired row is a clean v2
    // record rather than a v1 row wearing new keys.
    updated[index] = next;
    await persistCloset(updated);
    return { ok: true, item: next, filled };
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

// ── Committed-media orphan sweep (Build 2, Phase 4) ──────────────────────────

/**
 * How recently a committed media file may have been written and still be swept.
 *
 * A file younger than this may belong to a promotion that is between its media
 * write and its manifest write. That window is short and the cost of waiting one
 * more pass is nothing, so it is kept rather than reasoned about.
 */
export const CLOSET_MEDIA_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Bounded traversal. A sweep is housekeeping, not a task the user is waiting on,
 * so it stops at a fixed budget and resumes on the next pass rather than walking
 * an arbitrarily large directory during startup.
 */
export const CLOSET_MEDIA_SWEEP_MAX_FILES = 200;

/**
 * Read the committed manifest for the SWEEP specifically.
 *
 * Different from `readAllCloset` in exactly one way, and it is the difference that
 * makes deletion safe: `readAllCloset` answers `[]` both for "there is no manifest
 * yet" and for "the manifest is not an array". To a reference-driven sweep those
 * are opposite facts — the first means every file is genuinely unreferenced, the
 * second means we have no idea what is referenced. They are separated here, and
 * anything that is not a complete, interpretable array of objects REFUSES.
 */
async function readClosetManifestForSweep() {
  let info;
  try {
    info = await FileSystem.getInfoAsync(CLOSET_PATH);
  } catch {
    return { ok: false, reason: 'manifest_unreadable' };
  }
  if (!info?.exists) return { ok: true, entries: [] };

  let parsed;
  try {
    parsed = JSON.parse(await FileSystem.readAsStringAsync(CLOSET_PATH));
  } catch {
    return { ok: false, reason: 'manifest_unreadable' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'manifest_unreadable' };
  for (const entry of parsed) {
    // One entry we cannot attribute makes the whole reference set incomplete.
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: 'manifest_incomplete' };
    }
  }
  return { ok: true, entries: parsed };
}

/**
 * Collect COMMITTED media that no committed record references.
 *
 * THE MIRROR IMAGE of services/closetCandidateMedia.js#sweepOrphanedCandidateMedia,
 * and deliberately a SEPARATE FUNCTION over a SEPARATE ROOT rather than one sweep
 * parameterised by a directory. A shared implementation is one wrong argument away
 * from enumerating the candidate root with committed rules, which is the single
 * catastrophic mistake in this area.
 *
 * The rules, in the order they matter:
 *
 *   - The manifest must be COMPLETE. A read that could not be interpreted refuses
 *     the sweep outright; it never treats "unreadable" as "unreferenced".
 *   - The reference set is built from the RAW entries, including records this
 *     build cannot migrate. A future-schema or otherwise unhydratable row still
 *     names its media, and that media is still owned. Hydrating first would drop
 *     exactly the references that most need protecting.
 *   - Deterministic destinations reserved by active atomic work are protected by
 *     the caller passing them in (see `closetPromotionMediaPaths`).
 *   - Only the two committed roots are enumerated, and every path is re-checked
 *     with `isClosetOwnedMediaPath` before anything is deleted. The candidate root
 *     is never listed, opened, or compared against.
 *   - Deletion failures are counted, never thrown, and never retried in a loop.
 *
 * Runs inside the committed mutation queue so it cannot observe a half-applied
 * write. Never throws.
 */
export async function sweepOrphanedClosetMedia(options = {}) {
  const empty = (reason) => ({
    ok: false,
    skipped: true,
    reason,
    scanned: 0,
    deleted: 0,
    failed: 0,
    retained: 0,
    truncated: false,
  });

  if (typeof FileSystem.readDirectoryAsync !== 'function') return empty('unsupported');

  try {
    return await enqueueClosetMutation(async () => {
      const state = await readClosetManifestForSweep();
      if (!state.ok) return empty(state.reason);

      const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
      const graceMs =
        typeof options.graceMs === 'number' && Number.isFinite(options.graceMs)
          ? options.graceMs
          : CLOSET_MEDIA_ORPHAN_GRACE_MS;
      const maxFiles =
        typeof options.maxFiles === 'number' && Number.isFinite(options.maxFiles) && options.maxFiles > 0
          ? Math.floor(options.maxFiles)
          : CLOSET_MEDIA_SWEEP_MAX_FILES;

      const referenced = new Set();
      for (const entry of state.entries) {
        for (const uri of [entry.imageUri, entry.thumbnailUri]) {
          const canonical = canonicalizeMediaPath(uri);
          if (canonical) referenced.add(canonical);
        }
      }
      for (const uri of Array.isArray(options.protectedPaths) ? options.protectedPaths : []) {
        const canonical = canonicalizeMediaPath(uri);
        if (canonical) referenced.add(canonical);
      }

      let scanned = 0;
      let deleted = 0;
      let failed = 0;
      let retained = 0;
      let truncated = false;

      for (const dir of [IMAGES_DIR, THUMBS_DIR]) {
        if (truncated) break;
        let entries;
        try {
          entries = await FileSystem.readDirectoryAsync(dir);
        } catch {
          // A root that does not exist yet has nothing to sweep.
          continue;
        }
        for (const name of Array.isArray(entries) ? entries : []) {
          if (typeof name !== 'string' || !name) continue;
          if (scanned >= maxFiles) {
            truncated = true;
            break;
          }
          scanned += 1;

          const path = dir + name;
          // Belt and braces: the path was built from a committed root, and is
          // still re-verified as committed-owned before anything is deleted.
          if (!isClosetOwnedMediaPath(path)) {
            retained += 1;
            continue;
          }
          const canonical = canonicalizeMediaPath(path);
          if (!canonical || referenced.has(canonical)) {
            retained += 1;
            continue;
          }

          try {
            const fileInfo = await FileSystem.getInfoAsync(path);
            const modifiedMs =
              typeof fileInfo?.modificationTime === 'number'
                ? fileInfo.modificationTime * 1000
                : null;
            if (modifiedMs !== null && nowMs - modifiedMs < graceMs) {
              retained += 1;
              continue;
            }
          } catch {
            // A file we cannot stat is a file we cannot prove is collectable.
            retained += 1;
            continue;
          }

          try {
            await FileSystem.deleteAsync(path, { idempotent: true });
            deleted += 1;
          } catch {
            failed += 1;
          }
        }
      }

      return { ok: true, skipped: false, reason: null, scanned, deleted, failed, retained, truncated };
    });
  } catch {
    return empty('unexpected_error');
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
