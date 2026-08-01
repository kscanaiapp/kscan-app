// Mirror Selfie session media store (Build 2.5 Step 3).
//
// A FOURTH, DELIBERATELY SHORT-LIVED MEDIA ROOT. The repository already owns
// three disjoint media subtrees under documentDirectory:
//
//   kscan_library/            Recent Scans        services/library.js
//   kscan_closet/             committed Closet    services/closetLibrary.js
//   kscan_closet_candidates/  staged candidates   services/closetCandidateMedia.js
//
// Mirror sessions are none of those. They are PRE-staging scratch: a normalized
// selfie that must die as soon as the user finishes choosing, and crop files
// that must outlive backgrounding but not the candidate clock.
//
// WHY cacheDirectory AND NOT documentDirectory. The other three roots hold
// media the user believes they own. A Mirror session holds a photo of the
// user's body that they have not yet agreed to keep. Cache storage is
// app-private, is not backup-eligible, and is reclaimable by the OS under
// pressure — every one of which is the correct default for this content. The
// existing privacy pipeline made the same call for the same reason (see
// services/privacy/privacyArtifactStore.ts).
//
// WHY NOT REUSE privacyArtifactStore DIRECTLY. That store is flat and
// artifact-scoped; it has no notion of a session, so it cannot delete a whole
// session atomically or expire one as a unit. Mirror needs both. The namespace
// convention, the ownership-guarded deletion and the never-throw discipline are
// copied from it deliberately.
//
// STRUCTURE:
//   <cache>/kscan_mirror_sessions/
//     <extractionSessionId>/
//       normalized_source/<random>.jpg    deleted at crop-selection accept
//       crops/<random>.jpg                retained until Step 4 resolves
//
// The session id is the directory name, which is safe ONLY because
// isValidMirrorSessionId() restricts it to [A-Za-z0-9_-]{1,128} — no separator,
// no dot segment, no traversal. That check is not advisory; every function here
// refuses a session id that fails it.

import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { isValidMirrorSessionId, MIRROR_SESSION_MAX_TTL_MS } from '../../types/mirrorExtraction';

export const MIRROR_SESSION_NAMESPACE = 'kscan_mirror_sessions';
export const MIRROR_NORMALIZED_SOURCE_DIR = 'normalized_source';
export const MIRROR_CROPS_DIR = 'crops';

/** Bound on a single reconciliation sweep, mirroring the privacy store's cap. */
export const MIRROR_STALE_MAX_DELETIONS = 100;

function requireCacheRoot(): string {
  const base = FileSystem.cacheDirectory;
  if (!base) throw new Error('App-private cache directory is unavailable.');
  return base;
}

/** `<cache>/kscan_mirror_sessions/` */
export function mirrorSessionsRoot(): string {
  return `${requireCacheRoot()}${MIRROR_SESSION_NAMESPACE}/`;
}

/** `<cache>/kscan_mirror_sessions/<id>/` — throws on a malformed id. */
export function mirrorSessionDir(extractionSessionId: string): string {
  if (!isValidMirrorSessionId(extractionSessionId)) {
    throw new Error('Invalid Mirror extraction session id.');
  }
  return `${mirrorSessionsRoot()}${extractionSessionId}/`;
}

export function mirrorSourceDir(extractionSessionId: string): string {
  return `${mirrorSessionDir(extractionSessionId)}${MIRROR_NORMALIZED_SOURCE_DIR}/`;
}

export function mirrorCropsDir(extractionSessionId: string): string {
  return `${mirrorSessionDir(extractionSessionId)}${MIRROR_CROPS_DIR}/`;
}

/**
 * Mint a session id. `Crypto.randomUUID()` with hyphens kept — already inside
 * the allowlisted alphabet, so no reshaping is needed and none is done.
 */
export function createMirrorSessionId(deps: { Crypto?: typeof Crypto } = {}): string {
  const crypto = deps.Crypto ?? Crypto;
  return crypto.randomUUID();
}

/**
 * True only for a file:// URI inside THIS session's subtree.
 *
 * The one catastrophic bug in this area is handing a Closet, candidate or
 * Recent Scan path to a Mirror delete. That cannot happen: those roots live
 * under documentDirectory and this prefix is under cacheDirectory, and the
 * traversal check refuses anything that could climb back out.
 */
export function isMirrorSessionOwnedUri(
  uri: string | null | undefined,
  extractionSessionId?: string,
): boolean {
  if (!uri || typeof uri !== 'string') return false;
  if (!uri.startsWith('file://')) return false;
  if (uri.replace(/\\/g, '/').split('/').includes('..')) return false;
  if (/%(?:25)*(?:2e|2f|5c)/i.test(uri)) return false;
  let root: string;
  try {
    root = extractionSessionId ? mirrorSessionDir(extractionSessionId) : mirrorSessionsRoot();
  } catch {
    return false;
  }
  return uri.startsWith(root);
}

async function ensureDir(dir: string): Promise<boolean> {
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return true;
  } catch {
    // Already present is the common case and is not a failure. A genuine
    // failure surfaces at the first write instead, where it has a real path.
    return true;
  }
}

/** Create the session subtree. Returns false only if the cache is unusable. */
export async function ensureMirrorSessionDirs(
  extractionSessionId: string,
  deps: { FileSystem?: typeof FileSystem } = {},
): Promise<boolean> {
  const fs = deps.FileSystem ?? FileSystem;
  try {
    await fs.makeDirectoryAsync(mirrorSourceDir(extractionSessionId), { intermediates: true });
    await fs.makeDirectoryAsync(mirrorCropsDir(extractionSessionId), { intermediates: true });
    return true;
  } catch {
    try {
      const info = await fs.getInfoAsync(mirrorCropsDir(extractionSessionId));
      return Boolean(info?.exists);
    } catch {
      return false;
    }
  }
}

/**
 * A fresh, randomized path inside the session. The filename carries NO source
 * information — not the original filename, not a timestamp, not a region name.
 */
export function createMirrorSourcePath(
  extractionSessionId: string,
  deps: { Crypto?: typeof Crypto } = {},
): string {
  const crypto = deps.Crypto ?? Crypto;
  return `${mirrorSourceDir(extractionSessionId)}${crypto.randomUUID()}.jpg`;
}

export function createMirrorCropPath(
  extractionSessionId: string,
  deps: { Crypto?: typeof Crypto } = {},
): string {
  const crypto = deps.Crypto ?? Crypto;
  return `${mirrorCropsDir(extractionSessionId)}${crypto.randomUUID()}.jpg`;
}

/**
 * Ownership-guarded single-file delete. Never throws. A non-owned URI is
 * refused and left alone — that is the whole point of the guard.
 */
export async function deleteMirrorSessionFile(
  uri: string | null | undefined,
  extractionSessionId: string,
  deps: { FileSystem?: typeof FileSystem } = {},
): Promise<boolean> {
  const fs = deps.FileSystem ?? FileSystem;
  if (!uri) return true;
  if (!isMirrorSessionOwnedUri(uri, extractionSessionId)) return false;
  try {
    await fs.deleteAsync(uri, { idempotent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the normalized selfie only, leaving crops intact.
 *
 * This is the retention decision made executable: once the user has accepted a
 * crop selection, the picture of their body has served its purpose and goes,
 * while the crops they chose wait for Step 4.
 */
export async function deleteMirrorNormalizedSource(
  extractionSessionId: string,
  deps: { FileSystem?: typeof FileSystem } = {},
): Promise<boolean> {
  const fs = deps.FileSystem ?? FileSystem;
  try {
    await fs.deleteAsync(mirrorSourceDir(extractionSessionId), { idempotent: true });
    return true;
  } catch {
    return false;
  }
}

/** Remove the entire session subtree in one call. Never throws. */
export async function deleteMirrorSession(
  extractionSessionId: string,
  deps: { FileSystem?: typeof FileSystem } = {},
): Promise<boolean> {
  const fs = deps.FileSystem ?? FileSystem;
  let dir: string;
  try {
    dir = mirrorSessionDir(extractionSessionId);
  } catch {
    return false;
  }
  try {
    await fs.deleteAsync(dir, { idempotent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * App-resume reconciliation.
 *
 * Removes every session directory older than the candidate TTL, plus every
 * session in `activeSessionIds`' complement that the caller declares abandoned.
 * Enumerates ONLY the Mirror namespace — never a global filesystem scan.
 *
 * Age comes from the directory's own modification time. A session whose mtime
 * cannot be read is treated as stale: an unreadable scratch directory is not
 * something to preserve, and leaving it would leak a selfie indefinitely.
 */
export async function reconcileStaleMirrorSessions(
  input: { nowMs: number; keepSessionIds?: string[]; ttlMs?: number } ,
  deps: { FileSystem?: typeof FileSystem } = {},
): Promise<{ scanned: number; deleted: number }> {
  const fs = deps.FileSystem ?? FileSystem;
  const ttlMs = input?.ttlMs ?? MIRROR_SESSION_MAX_TTL_MS;
  const keep = new Set(Array.isArray(input?.keepSessionIds) ? input.keepSessionIds : []);
  const nowMs = typeof input?.nowMs === 'number' ? input.nowMs : 0;

  let root: string;
  try {
    root = mirrorSessionsRoot();
  } catch {
    return { scanned: 0, deleted: 0 };
  }

  let entries: string[] = [];
  try {
    entries = await fs.readDirectoryAsync(root);
  } catch {
    // No namespace yet is the normal cold-start state, not an error.
    return { scanned: 0, deleted: 0 };
  }

  let deleted = 0;
  let scanned = 0;
  for (const entry of entries) {
    if (deleted >= MIRROR_STALE_MAX_DELETIONS) break;
    scanned += 1;
    // A directory name that is not a legal session id was not written by this
    // module. Refuse to delete it rather than guess.
    if (!isValidMirrorSessionId(entry)) continue;
    if (keep.has(entry)) continue;

    let ageMs = Number.POSITIVE_INFINITY;
    try {
      const info = await fs.getInfoAsync(`${root}${entry}`);
      if (info?.exists && typeof info.modificationTime === 'number') {
        // expo-file-system reports seconds.
        ageMs = nowMs - info.modificationTime * 1000;
      }
    } catch {
      ageMs = Number.POSITIVE_INFINITY;
    }

    if (ageMs >= ttlMs) {
      const removed = await deleteMirrorSession(entry, { FileSystem: fs });
      if (removed) deleted += 1;
    }
  }

  return { scanned, deleted };
}

export { ensureDir as __ensureMirrorDirForTests };
