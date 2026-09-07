/**
 * Ownership namespace for VTO's transient person-image derivatives.
 *
 * WHY THIS EXISTS. The lifecycle in vtoRequestStore is sound while the process
 * lives: selection replaces and releases the previous photo, the actor
 * boundary releases everything, and an explicit reset deletes what it owns.
 * But the ownership list is MODULE MEMORY. A crash, an OOM kill, or a swipe-up
 * while a generation is in flight erases the list and leaves the actual cache
 * files behind -- a recognizable photo of the user, sitting in the cache with
 * nothing left that knows it is there.
 *
 * WHY A NAMESPACE AND NOT A SWEEP OF THE EXISTING CACHE. expo-image-manipulator
 * writes its output into a directory it shares with every other manipulated
 * image in the app -- Scanner captures, Closet intake, Elise attachments,
 * mirror crops. Sweeping that directory would delete other features' live
 * files. So VTO ADOPTS its derivatives into a directory it alone writes to,
 * and the sweep is scoped to that directory and nothing else. Photo-library
 * originals, Closet media, and Scanner media are all outside it by
 * construction: this module can only name paths under `namespaceDir()`.
 *
 * WHY "NOT CREATED BY THIS PROCESS" AND NOT A TTL. The question the sweep has
 * to answer is "is this file still referenced?", and a clock answers a
 * different one. A TTL short enough to catch a recent orphan also deletes the
 * photo of a user who picked it forty minutes ago and is still in the session;
 * a TTL long enough to be safe leaves the orphan on disk for hours. The
 * process-local registry answers the real question exactly: on a cold start it
 * is empty, so every file present was left by a previous process and is by
 * definition an orphan; if the sweep is ever reached again in the same process
 * (a root remount, a dev fast-refresh) the live files are in the registry and
 * are skipped. No clock, no guessing, and idempotent by construction.
 *
 * Everything here fails soft. A cache that cannot be created, moved into, read,
 * or deleted degrades to the previous behaviour -- it never propagates an error
 * into a user flow, and never blocks startup.
 */

import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';

export const VTO_MEDIA_NAMESPACE = 'kscan-vto-media';

/** Kinds are prefixes only; they carry no source-image information. */
export type VtoMediaKind = 'person' | 'payload';

const KIND_PREFIX: Record<VtoMediaKind, string> = {
  person: 'vtoperson',
  payload: 'vtopayload',
};

/** Bound on one sweep so a pathological cache cannot stall app startup. */
const SWEEP_MAX_DELETIONS = 200;

/** Derivatives this process created. See the header for why this, not a TTL. */
const processOwned = new Set<string>();

/** Null (never a throw) when the platform gives us no cache directory. */
export function vtoMediaDirectory(): string | null {
  const base = FileSystem.cacheDirectory;
  if (!base || typeof base !== 'string') return null;
  return `${base}${VTO_MEDIA_NAMESPACE}/`;
}

/** True only for a path inside the namespace this module owns. */
export function isOwnedVtoMediaUri(uri: string | null | undefined): boolean {
  if (!uri || typeof uri !== 'string') return false;
  const dir = vtoMediaDirectory();
  if (!dir) return false;
  return uri.startsWith(dir);
}

async function ensureVtoMediaDirectory(): Promise<string | null> {
  const dir = vtoMediaDirectory();
  if (!dir) return null;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // Already present, or a race with another adopt. Either is fine; the
    // move below is the operation that actually has to succeed.
  }
  return dir;
}

function extensionOf(uri: string): string {
  const match = /\.([a-z0-9]{1,5})(?:\?|#|$)/i.exec(uri);
  return match ? match[1].toLowerCase() : 'jpg';
}

/**
 * Move a freshly created derivative into the VTO namespace and return its new
 * URI, so the store's in-memory ownership is backed by an ownership the
 * filesystem itself records.
 *
 * FAILS SOFT TO THE INPUT. If the cache directory is unavailable or the move
 * fails, the ORIGINAL uri is returned unchanged: the try-on still works, that
 * one file simply is not sweepable. Returning the original is also why this is
 * safe to call on a uri that is already adopted -- it is registered and
 * returned as-is rather than moved onto itself.
 */
export async function adoptVtoMediaFile(
  uri: string | null | undefined,
  kind: VtoMediaKind,
): Promise<string | null | undefined> {
  if (!uri || typeof uri !== 'string') return uri;
  if (isOwnedVtoMediaUri(uri)) {
    processOwned.add(uri);
    return uri;
  }
  const dir = await ensureVtoMediaDirectory();
  if (!dir) return uri;

  let name: string;
  try {
    name = `${KIND_PREFIX[kind]}-${Crypto.randomUUID()}.${extensionOf(uri)}`;
  } catch {
    return uri;
  }
  const destination = `${dir}${name}`;
  try {
    await FileSystem.moveAsync({ from: uri, to: destination });
  } catch {
    return uri;
  }
  processOwned.add(destination);
  return destination;
}

/** Forget a URI this process created. Called after the file is deleted, so a
 *  later sweep does not keep skipping a name that no longer exists. */
export function forgetVtoMediaFile(uri: string | null | undefined): void {
  if (uri && typeof uri === 'string') processOwned.delete(uri);
}

/**
 * Delete VTO derivatives this process did NOT create -- i.e. everything a
 * previous process left behind.
 *
 * Bounded, idempotent (a second run finds nothing left to do), and silent on
 * every failure. Scoped to the namespace directory: it reads that directory
 * and deletes entries by name within it, so there is no path by which it can
 * reach a photo-library original, Closet media, or another feature's cache.
 */
export async function sweepOrphanedVtoMedia(options?: {
  maxDeletions?: number;
}): Promise<{ scanned: number; deleted: number }> {
  const maxDeletions = options?.maxDeletions ?? SWEEP_MAX_DELETIONS;
  const summary = { scanned: 0, deleted: 0 };
  const dir = vtoMediaDirectory();
  if (!dir) return summary;

  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info?.exists || !info?.isDirectory) return summary;
  } catch {
    return summary;
  }

  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return summary;
  }

  for (const name of names) {
    if (summary.deleted >= maxDeletions) break;
    summary.scanned += 1;
    const uri = `${dir}${name}`;
    if (processOwned.has(uri)) continue; // live in this process
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      summary.deleted += 1;
    } catch {
      // A file that will not delete is skipped; the sweep never crashes.
    }
  }
  return summary;
}

export const __vtoMediaCacheInternals = {
  getProcessOwned: () => [...processOwned],
  reset: () => processOwned.clear(),
};
