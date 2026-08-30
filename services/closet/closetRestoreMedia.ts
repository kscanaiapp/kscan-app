// Build 34 / Track B / Phase B2C — private Closet media restore.
//
// Downloads the two deterministic objects a remote Closet row's media
// already occupies (never a folder, never a prefix, never another item's
// media) and writes them into an account-scoped, non-authoritative local
// cache. This module never uploads, never mutates a cloud row, and never
// touches the ORIGINAL local Closet media roots (kscan_closet/images,
// kscan_closet/thumbnails) — those belong to services/closetLibrary.js and
// this device's own user-originated captures.

import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '../supabaseClient';
import { CLOSET_MEDIA_BUCKET } from './closetSyncContract';

const RESTORE_CACHE_ROOT = FileSystem.documentDirectory + 'kscan_closet/remote-cache/';
const SIGNED_URL_TTL_SECONDS = 60;

/** Filesystem-safe form of an owner id. Owner ids here are always Supabase
 *  auth UUIDs (K+ requires an authenticated actor), but this stays defensive
 *  rather than assuming the shape. */
function slugifyOwnerId(ownerId: string): string {
  return ownerId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function ownerCacheDir(ownerId: string): string {
  return `${RESTORE_CACHE_ROOT}${slugifyOwnerId(ownerId)}/`;
}

export interface ClosetRestoreMediaCachePaths {
  primary: string;
  thumbnail: string;
}

/** The two deterministic LOCAL cache destinations for one server item's
 *  media, mirroring the server's own deterministic paths one-for-one. */
export function buildClosetRestoreMediaCachePaths(
  ownerId: string,
  serverItemId: string,
): ClosetRestoreMediaCachePaths {
  const dir = ownerCacheDir(ownerId);
  return {
    primary: `${dir}${serverItemId}-primary.jpg`,
    thumbnail: `${dir}${serverItemId}-thumb.jpg`,
  };
}

async function ensureOwnerCacheDir(ownerId: string): Promise<void> {
  await FileSystem.makeDirectoryAsync(ownerCacheDir(ownerId), { intermediates: true }).catch(() => null);
}

/**
 * Download one object to a caller-chosen final destination.
 *
 * Downloads to a temp path first and only replaces the existing destination
 * once the new file is confirmed non-empty on disk — the old cached file (if
 * any) is never removed until the replacement has actually arrived (Addendum
 * J: "do not delete the old usable cache before the new authorized media has
 * successfully arrived").
 */
async function downloadObjectTo(
  storagePath: string,
  destPath: string,
): Promise<{ ok: boolean; detail?: string }> {
  const { data, error } = await supabase.storage
    .from(CLOSET_MEDIA_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    return { ok: false, detail: 'signed_url_failed' };
  }

  const tempPath = `${destPath}.download-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`;
  try {
    const result = await FileSystem.downloadAsync(data.signedUrl, tempPath);
    if (!result || result.status !== 200) {
      await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => null);
      return { ok: false, detail: 'download_failed' };
    }
    const info = await FileSystem.getInfoAsync(tempPath).catch(() => ({ exists: false, size: 0 }) as any);
    if (!info?.exists || !info.size) {
      await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => null);
      return { ok: false, detail: 'download_empty' };
    }
    // Old cache is retired ONLY now that the replacement is verified on disk.
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => null);
    await FileSystem.moveAsync({ from: tempPath, to: destPath });
    return { ok: true };
  } catch {
    await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => null);
    return { ok: false, detail: 'download_threw' };
  }
}

export interface ClosetRestoreMediaDownloadResult {
  ok: boolean;
  primaryUri?: string;
  thumbnailUri?: string;
  detail?: string;
}

/**
 * Hydrate one item's cached media. Facts outrank pixels (section 28): a
 * caller must never treat this result as a reason to touch the item's facts,
 * and a failure here leaves the item exactly as usable as it already was.
 *
 * The thumbnail is best-effort, matching B2A/B2B's own rule that a missing
 * thumbnail must never fail an otherwise-good primary image.
 */
export async function hydrateClosetRestoreMedia(input: {
  ownerId: string;
  serverItemId: string;
  primaryStoragePath: string;
  thumbnailStoragePath: string | null;
}): Promise<ClosetRestoreMediaDownloadResult> {
  await ensureOwnerCacheDir(input.ownerId);
  const dest = buildClosetRestoreMediaCachePaths(input.ownerId, input.serverItemId);

  const primary = await downloadObjectTo(input.primaryStoragePath, dest.primary);
  if (!primary.ok) return { ok: false, detail: primary.detail };

  let thumbnailUri: string | undefined;
  if (input.thumbnailStoragePath) {
    const thumbnail = await downloadObjectTo(input.thumbnailStoragePath, dest.thumbnail);
    if (thumbnail.ok) thumbnailUri = dest.thumbnail;
  }

  return { ok: true, primaryUri: dest.primary, thumbnailUri };
}

/** Authoritative single-item cleanup: tombstone reconciled, or replaced by a
 *  newer authoritative object at the same deterministic path. Never called
 *  for a merely-absent-from-one-page reason. */
export async function deleteClosetRestoreMediaCacheEntry(
  ownerId: string,
  serverItemId: string,
): Promise<void> {
  const paths = buildClosetRestoreMediaCachePaths(ownerId, serverItemId);
  await FileSystem.deleteAsync(paths.primary, { idempotent: true }).catch(() => null);
  await FileSystem.deleteAsync(paths.thumbnail, { idempotent: true }).catch(() => null);
}

/** Authoritative account-scoped cleanup: account deletion only. Ordinary
 *  logout/account switch relies on the same structural per-owner-directory
 *  isolation the B2B sync sidecar uses, not an eager wipe — see the B2C
 *  operational guide. */
export async function purgeClosetRestoreMediaCacheForOwner(ownerId: string): Promise<void> {
  const dir = ownerCacheDir(ownerId);
  await FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => null);
}

/** Test seam only. */
export const __closetRestoreMediaInternals = { RESTORE_CACHE_ROOT, ownerCacheDir, slugifyOwnerId };
