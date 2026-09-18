/**
 * K-SCAN local Style Library — scan persistence via expo-file-system.
 *
 * Storage is scoped per signed-in account. Before scoping, every account on a
 * device shared one library: after User A signed out and User B signed in,
 * User B saw User A's scan photos and style reads, could delete them, and could
 * upload them into their own Dressing Rooms — turning a local leak into a
 * server-side cross-account write. Sign-out cleared the Supabase session but
 * never this data.
 *
 * Storage layout (all paths under FileSystem.documentDirectory/kscan_library/):
 *   <scope>/kscan_library.json  — JSON array of SavedScan objects, newest first
 *   <scope>/images/<id>.jpg     — persistent scan image for explicit room upload
 *   <scope>/thumbnails/<id>.jpg — persistent 160px-wide JPEG thumbnails
 *
 * <scope> is `u_<user id>` for a signed-in account, or `anonymous` when there is
 * no session. A pre-scoping library is migrated once into the scope of whoever
 * is signed in at upgrade time, then removed so it cannot reach another account.
 *
 * All functions are safe to call in fire-and-forget fashion; they never throw.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { supabase } from './supabaseClient';

const LIB_ROOT     = FileSystem.documentDirectory + 'kscan_library/';
const MAX_SCANS     = 25;
const THUMB_WIDTH   = 160; // px — small square-ish card thumbnail
const IMAGE_WIDTH   = 1440; // px — room-upload friendly, still compact

// Pre-scoping locations, read once during migration and then deleted.
const LEGACY_LIBRARY_PATH = LIB_ROOT + 'kscan_library.json';
const LEGACY_IMAGES_DIR   = LIB_ROOT + 'images/';
const LEGACY_THUMBS_DIR   = LIB_ROOT + 'thumbnails/';

const ANONYMOUS_SCOPE = 'anonymous';

// ── Scope resolution ──────────────────────────────────────────────────────────

/** Path-safe scope key. Supabase user ids are UUIDs; anything else is sanitized. */
function scopeKeyForOwner(ownerId) {
  if (!ownerId || typeof ownerId !== 'string') return ANONYMOUS_SCOPE;
  const safe = ownerId.replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? `u_${safe}` : ANONYMOUS_SCOPE;
}

async function resolveOwnerId() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.user?.id ?? null;
  } catch {
    // No session storage available — fall back to the device-local scope rather
    // than risking a read of another account's library.
    return null;
  }
}

function buildScope(scopeKey) {
  const dir = `${LIB_ROOT}${scopeKey}/`;
  return {
    key: scopeKey,
    dir,
    libraryPath: dir + 'kscan_library.json',
    imagesDir: dir + 'images/',
    thumbsDir: dir + 'thumbnails/',
  };
}

const migratedScopes = new Set();

async function getScope() {
  const scope = buildScope(scopeKeyForOwner(await resolveOwnerId()));
  await migrateLegacyLibrary(scope);
  return scope;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function ensureDirs(scope) {
  try {
    // intermediates: true creates the scope dir and child dirs in one call
    await FileSystem.makeDirectoryAsync(scope.imagesDir, { intermediates: true });
    await FileSystem.makeDirectoryAsync(scope.thumbsDir, { intermediates: true });
  } catch { /* non-fatal — directory may already exist */ }
}

async function exists(path) {
  try {
    const info = await FileSystem.getInfoAsync(path);
    return Boolean(info?.exists);
  } catch {
    return false;
  }
}

/**
 * Move a pre-scoping library into the current scope exactly once, then remove
 * the legacy copy so the next account to sign in cannot read it.
 */
async function migrateLegacyLibrary(scope) {
  if (migratedScopes.has(scope.key)) return;
  migratedScopes.add(scope.key);

  try {
    if (!(await exists(LEGACY_LIBRARY_PATH))) return;

    // Never overwrite a scope that already has its own library.
    if (await exists(scope.libraryPath)) {
      await FileSystem.deleteAsync(LEGACY_LIBRARY_PATH, { idempotent: true }).catch(() => null);
      return;
    }

    await ensureDirs(scope);

    const raw = await FileSystem.readAsStringAsync(LEGACY_LIBRARY_PATH);
    const parsed = JSON.parse(raw);
    const legacyScans = Array.isArray(parsed) ? parsed : [];

    const migrated = [];
    for (const scan of legacyScans) {
      const next = { ...scan };
      for (const [field, destDir] of [['imageUri', scope.imagesDir], ['thumbnailUri', scope.thumbsDir]]) {
        const from = scan?.[field];
        if (typeof from !== 'string' || !from) continue;
        const destPath = destDir + String(scan.id) + '.jpg';
        try {
          await FileSystem.moveAsync({ from, to: destPath });
          next[field] = destPath;
        } catch {
          next[field] = null; // media lost; the record still opens
        }
      }
      migrated.push(next);
    }

    await FileSystem.writeAsStringAsync(scope.libraryPath, JSON.stringify(migrated), {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    // A failed migration must not block the library; fall through to an empty one.
  } finally {
    await FileSystem.deleteAsync(LEGACY_LIBRARY_PATH, { idempotent: true }).catch(() => null);
    await FileSystem.deleteAsync(LEGACY_IMAGES_DIR, { idempotent: true }).catch(() => null);
    await FileSystem.deleteAsync(LEGACY_THUMBS_DIR, { idempotent: true }).catch(() => null);
  }
}

async function persistLibrary(scope, scans) {
  await FileSystem.makeDirectoryAsync(scope.dir, { intermediates: true }).catch(() => null);
  await FileSystem.writeAsStringAsync(
    scope.libraryPath,
    JSON.stringify(scans),
    { encoding: FileSystem.EncodingType.UTF8 }
  );
}

async function generateThumbnail(scope, photoUri, id) {
  try {
    await ensureDirs(scope);
    const result = await ImageManipulator.manipulateAsync(
      photoUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
    );
    const destPath = scope.thumbsDir + id + '.jpg';
    // Move out of OS cache into app-owned persistent storage
    await FileSystem.moveAsync({ from: result.uri, to: destPath });
    return destPath;
  } catch {
    return null; // thumbnail failure is non-fatal
  }
}

async function persistScanImage(scope, photoUri, id) {
  try {
    await ensureDirs(scope);
    const result = await ImageManipulator.manipulateAsync(
      photoUri,
      [{ resize: { width: IMAGE_WIDTH } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
    );
    const destPath = scope.imagesDir + id + '.jpg';
    await FileSystem.moveAsync({ from: result.uri, to: destPath });
    return destPath;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load the signed-in account's saved scans. Returns [] on any error, and never
 * returns another account's scans.
 */
export async function loadLibrary() {
  try {
    const scope = await getScope();
    if (!(await exists(scope.libraryPath))) return [];
    const raw    = await FileSystem.readAsStringAsync(scope.libraryPath);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Save a successful scan to the signed-in account's local library.
 *
 * @param {object} opts
 * @param {string} opts.photoUri   - original capture URI (may be temp cache)
 * @param {object} opts.analysis   - { result, metadata, products } from useKScan
 * @returns {SavedScan|null}  the saved object, or null on complete failure
 */
export async function saveScan({ photoUri, analysis }) {
  try {
    const scope = await getScope();
    const id = 'scan_' + Date.now() + '_' + Math.floor(Math.random() * 9999);

    // Local image persistence is best-effort; existing library behavior remains local.
    const imageUri = await persistScanImage(scope, photoUri, id);
    // Thumbnail generation is best-effort; missing thumbnail shows placeholder
    const thumbnailUri = await generateThumbnail(scope, photoUri, id);

    /** @type {SavedScan} */
    const scan = {
      id,
      createdAt: new Date().toISOString(),
      imageUri,               // null if persistence failed; legacy scans may not have it
      thumbnailUri,          // null if generation failed
      attributes: {
        category:          analysis.metadata?.category   ?? '',
        silhouette:        analysis.metadata?.silhouette ?? '',
        color_palette:     analysis.metadata?.color      ?? '',
        // scan-identify returns these; persist them instead of dropping them so
        // a reopened Style Library scan carries the same read as the live card.
        material_estimate: analysis.metadata?.material ?? null,
        style_tags:        Array.isArray(analysis.metadata?.styleTags)
          ? analysis.metadata.styleTags
          : [],
        confidence_score:  typeof analysis.metadata?.categoryConfidence === 'number'
          ? analysis.metadata.categoryConfidence
          : null,
      },
      result:   analysis.result   ?? '',
      products: Array.isArray(analysis.products) ? analysis.products : [],
      source:   'scan',
    };

    const existing = await loadLibrary();
    const updated  = [scan, ...existing];

    // Enforce 25-scan cap; delete thumbnail files for evicted scans
    if (updated.length > MAX_SCANS) {
      const evicted = updated.splice(MAX_SCANS);
      await Promise.all(
        evicted
          .filter(s => s.thumbnailUri)
          .map(s =>
            FileSystem.deleteAsync(s.thumbnailUri, { idempotent: true }).catch(() => null)
          )
      );
      await Promise.all(
        evicted
          .filter(s => s.imageUri)
          .map(s =>
            FileSystem.deleteAsync(s.imageUri, { idempotent: true }).catch(() => null)
          )
      );
    }

    await persistLibrary(scope, updated);
    return scan;
  } catch {
    return null;
  }
}

/**
 * Delete a scan and its media from the signed-in account's library.
 * Returns true on success.
 */
export async function deleteScan(id) {
  try {
    const scope   = await getScope();
    const library = await loadLibrary();
    const target  = library.find(s => s.id === id);
    if (target?.thumbnailUri) {
      await FileSystem.deleteAsync(target.thumbnailUri, { idempotent: true }).catch(() => null);
    }
    if (target?.imageUri) {
      await FileSystem.deleteAsync(target.imageUri, { idempotent: true }).catch(() => null);
    }
    await persistLibrary(scope, library.filter(s => s.id !== id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the signed-in account's local library entirely, media included.
 *
 * Called when an account is deleted so a "deleted" user's scan photos and style
 * reads do not remain readable on the device.
 */
export async function clearLibrary() {
  try {
    const scope = await getScope();
    await FileSystem.deleteAsync(scope.dir, { idempotent: true }).catch(() => null);
    migratedScopes.delete(scope.key);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: scope key derivation is the isolation boundary. */
export const __testing = { scopeKeyForOwner, buildScope, LIB_ROOT, ANONYMOUS_SCOPE };
