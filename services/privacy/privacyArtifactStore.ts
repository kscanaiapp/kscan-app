// Privacy-artifact lifecycle manager.
//
// Owns every temporary image artifact created by the privacy pipeline:
// materialized originals, sanitized outputs, partial copies, and anything a
// crashed or interrupted run left behind. All artifacts live in one
// app-private cache namespace; nothing is written to shared or public
// storage, and cache storage is not backup-eligible.

import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';

export const PRIVACY_ARTIFACT_NAMESPACE = 'kscan-privacy';

export type PrivacyArtifactKind = 'original' | 'sanitized' | 'partial';

const KIND_PREFIX: Record<PrivacyArtifactKind, string> = {
  original: 'orig',
  sanitized: 'san',
  partial: 'part',
};

const DEFAULT_STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_STALE_MAX_DELETIONS = 200;

function namespaceDir(): string {
  const base = FileSystem.cacheDirectory;
  if (!base) throw new Error('App-private cache directory is unavailable.');
  return `${base}${PRIVACY_ARTIFACT_NAMESPACE}/`;
}

export async function ensurePrivacyArtifactDir(): Promise<string> {
  const dir = namespaceDir();
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // Already exists or creation raced; ownership checks below still apply.
  }
  return dir;
}

/**
 * Build a randomized, nonsensitive artifact path inside the owned namespace.
 * The name carries no source-image information.
 */
export function createArtifactPath(kind: PrivacyArtifactKind, extension: string): string {
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `${namespaceDir()}${KIND_PREFIX[kind]}-${Crypto.randomUUID()}.${safeExt}`;
}

/** True only for file:// URIs inside the owned privacy namespace. */
export function isOwnedPrivacyArtifactUri(uri: string | null | undefined): boolean {
  if (!uri || typeof uri !== 'string') return false;
  if (!uri.startsWith('file://')) return false;
  return uri.startsWith(namespaceDir());
}

/**
 * Idempotent, ownership-guarded deletion. Never throws; returns whether the
 * artifact is gone (deleted now or already absent). Non-owned URIs are
 * rejected and never touched.
 */
export async function deletePrivacyArtifact(uri: string | null | undefined): Promise<boolean> {
  if (!uri) return true;
  if (!isOwnedPrivacyArtifactUri(uri)) return false;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    return true;
  } catch {
    return false;
  }
}

/** Delete a batch of artifacts; always attempts every entry. */
export async function deletePrivacyArtifacts(uris: Array<string | null | undefined>): Promise<void> {
  for (const uri of uris) {
    await deletePrivacyArtifact(uri);
  }
}

/**
 * Bounded stale-artifact sweep for interrupted or crashed runs. Deletes at
 * most `maxDeletions` artifacts older than `maxAgeMs`. Safe to call on every
 * app initialization; never throws.
 */
export async function sweepStalePrivacyArtifacts(options?: {
  maxAgeMs?: number;
  maxDeletions?: number;
}): Promise<{ scanned: number; deleted: number }> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
  const maxDeletions = options?.maxDeletions ?? DEFAULT_STALE_MAX_DELETIONS;
  const summary = { scanned: 0, deleted: 0 };
  let dir: string;
  try {
    dir = await ensurePrivacyArtifactDir();
  } catch {
    return summary;
  }

  let entries: string[] = [];
  try {
    entries = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return summary;
  }

  const now = Date.now();
  for (const name of entries) {
    if (summary.deleted >= maxDeletions) break;
    summary.scanned += 1;
    const uri = `${dir}${name}`;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) continue;
      const modifiedMs =
        typeof (info as { modificationTime?: number }).modificationTime === 'number'
          ? (info as { modificationTime: number }).modificationTime * 1000
          : 0;
      if (modifiedMs > 0 && now - modifiedMs < maxAgeMs) continue;
      await FileSystem.deleteAsync(uri, { idempotent: true });
      summary.deleted += 1;
    } catch {
      // Skip unreadable entries; the sweep must never crash startup.
    }
  }
  return summary;
}

/**
 * Remove every artifact in the namespace. Called on sign-out and
 * authenticated-actor change so no image artifact outlives its actor.
 * Never throws.
 */
export async function cleanupAllPrivacyArtifacts(): Promise<void> {
  try {
    const dir = namespaceDir();
    await FileSystem.deleteAsync(dir, { idempotent: true });
  } catch {
    // Best effort; the stale sweep provides the backstop.
  }
}
