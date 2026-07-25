// Saved-scan remote media backing (Phase 2 — StyleChat Closet Intelligence).
//
// Idempotent saga (NOT a transaction — client filesystem, Postgres, and
// Storage cannot share one): each step is retry-safe and reuses prior
// progress instead of duplicating rows or objects.
//
//   1. ensure remote saved_scan row      (reuses existing cloud-sync path)
//   2. reserve media (media_status=pending, deterministic bucket/path)
//   3. upload sanitized JPEG to the PRIVATE style-library-images bucket at
//      {userId}/saved-scans/{savedScanId}.jpg   (existing object ⇒ reuse)
//   4. finalize row (media_status=ready, media_uploaded_at)
//
// Compensation rules (Part 4):
//   * upload ok + finalize fails  → retry finalization first; NEVER re-upload
//   * row ok + upload fails       → row stays pending/retryable; never
//                                   classified remote-media-backed; local
//                                   display + retry state preserved
//   * orphan cleanup              → only the exact proven object path, never
//                                   a folder, never another item's media
//
// Safety: authenticated user only, sanitized source image only, private
// bucket only, user-scoped deterministic path only (no user-controlled path),
// bounded size, JPEG only, no public URL ever stored, signed URLs resolved at
// display time, local file kept after success.

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { supabase } from './supabaseClient';
import { sanitizeImageBeforeUpload } from './privacyImageSanitizer';
import { isImageDispatchAllowed } from './privacy/privacyBoundary';

export const SAVED_SCAN_MEDIA_BUCKET = 'style-library-images';
export const SAVED_SCAN_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const SAVED_SCAN_MEDIA_CONTENT_TYPE = 'image/jpeg';

export type SavedScanMediaStatus = 'pending' | 'ready' | 'failed' | null;

export type SavedScanMediaResult = {
  ok: boolean;
  bucket?: string;
  path?: string;
  errorCode?: 'MEDIA_UPLOAD_FAILED' | 'MEDIA_FINALIZATION_FAILED' | 'IMAGE_REJECTED' | 'ATTACHMENT_NOT_OWNED' | 'PRIVACY_BLOCKED';
  retryable?: boolean;
};

/** Deterministic, user-scoped object path. Not user-controllable. */
export function buildSavedScanMediaPath(userId: string, savedScanId: string): string {
  return `${userId}/saved-scans/${savedScanId}.jpg`;
}

export function isRemoteMediaBacked(row: {
  media_status?: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
}): boolean {
  return (
    row.media_status === 'ready' &&
    typeof row.storage_bucket === 'string' &&
    !!row.storage_bucket &&
    typeof row.storage_path === 'string' &&
    !!row.storage_path
  );
}

function base64ToArrayBuffer(base64: string) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const value = chars.indexOf(clean[i]);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return bytes.slice(0, index).buffer;
}

function isAlreadyExistsError(error: { message?: string; statusCode?: string | number } | null): boolean {
  if (!error) return false;
  const message = String(error.message ?? '').toLowerCase();
  return (
    String(error.statusCode ?? '') === '409' ||
    message.includes('already exists') ||
    message.includes('duplicate')
  );
}

async function verifyObjectExists(bucket: string, path: string): Promise<boolean> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60);
  return !error && !!data?.signedUrl;
}

/**
 * Ensures a saved scan is remote-media-backed. Lazy: call only for explicit
 * cross-device styling actions (StyleChat attachment, remotely rendered Look,
 * room sharing), never for local list rendering.
 *
 * Idempotent: a row already `ready` with a verified object returns
 * immediately; a `pending` row with an existing object only retries
 * finalization; retries never create a second row or object.
 */
export async function ensureSavedScanMediaBacking(input: {
  savedScanId: string;
  localImageUri?: string | null;
}): Promise<SavedScanMediaResult> {
  // Zero-Knowledge gate: cloud media backing fails closed until on-device
  // face and license-plate masking is available and verified.
  if (!isImageDispatchAllowed()) {
    return { ok: false, errorCode: 'PRIVACY_BLOCKED', retryable: false };
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) return { ok: false, errorCode: 'ATTACHMENT_NOT_OWNED', retryable: false };

  // Load the row (RLS scopes to the owner; a miss means not owned/available).
  const { data: row, error: rowError } = await supabase
    .from('saved_scans')
    .select('id,user_id,image_uri,thumbnail_uri,storage_bucket,storage_path,media_status')
    .eq('id', input.savedScanId)
    .is('deleted_at', null)
    .maybeSingle();
  if (rowError || !row) return { ok: false, errorCode: 'ATTACHMENT_NOT_OWNED', retryable: false };

  const bucket = SAVED_SCAN_MEDIA_BUCKET;
  const path = buildSavedScanMediaPath(userId, input.savedScanId);

  // Already fully backed → reuse (no duplicate upload).
  if (
    isRemoteMediaBacked(row) &&
    row.storage_bucket === bucket &&
    row.storage_path === path &&
    await verifyObjectExists(bucket, path)
  ) {
    return { ok: true, bucket, path };
  }

  // Finalization-first retry: if the object already exists, never re-upload.
  if (await verifyObjectExists(bucket, path)) {
    return finalizeMediaRow(input.savedScanId, bucket, path);
  }

  // Need an upload: source is the sanitized local image.
  const localUri = input.localImageUri || row.image_uri || row.thumbnail_uri;
  if (!localUri || !/^(file|content):\/\//i.test(String(localUri))) {
    return { ok: false, errorCode: 'MEDIA_UPLOAD_FAILED', retryable: true };
  }

  try {
    const fileInfo = await FileSystem.getInfoAsync(String(localUri));
    if (!fileInfo.exists) {
      return { ok: false, errorCode: 'MEDIA_UPLOAD_FAILED', retryable: true };
    }

    // Privacy boundary first (current sanitizer contract), then bounded JPEG.
    const sanitizedUri = await sanitizeImageBeforeUpload(String(localUri));
    const prepared = await ImageManipulator.manipulateAsync(
      String(sanitizedUri),
      [{ resize: { width: 1440 } }],
      { compress: 0.86, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    if (!prepared.base64) {
      return { ok: false, errorCode: 'IMAGE_REJECTED', retryable: false };
    }
    const body = base64ToArrayBuffer(prepared.base64);
    if (body.byteLength === 0 || body.byteLength > SAVED_SCAN_MEDIA_MAX_BYTES) {
      return { ok: false, errorCode: 'IMAGE_REJECTED', retryable: false };
    }

    // Reserve media on the row before the upload so an interrupted upload is
    // recoverable and never mistaken for ready.
    const { error: reserveError } = await supabase
      .from('saved_scans')
      .update({ storage_bucket: bucket, storage_path: path, media_status: 'pending' })
      .eq('id', input.savedScanId);
    if (reserveError) {
      return { ok: false, errorCode: 'MEDIA_FINALIZATION_FAILED', retryable: true };
    }

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(path, body, {
        contentType: SAVED_SCAN_MEDIA_CONTENT_TYPE,
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError && !isAlreadyExistsError(uploadError)) {
      // Row stays pending/retryable; local file preserved for retry.
      return { ok: false, errorCode: 'MEDIA_UPLOAD_FAILED', retryable: true };
    }

    return finalizeMediaRow(input.savedScanId, bucket, path);
  } catch {
    return { ok: false, errorCode: 'MEDIA_UPLOAD_FAILED', retryable: true };
  }
}

async function finalizeMediaRow(
  savedScanId: string,
  bucket: string,
  path: string,
): Promise<SavedScanMediaResult> {
  const { error } = await supabase
    .from('saved_scans')
    .update({
      storage_bucket: bucket,
      storage_path: path,
      media_status: 'ready',
      media_uploaded_at: new Date().toISOString(),
    })
    .eq('id', savedScanId);

  if (error) {
    // Upload succeeded but finalization failed: retryable; the next attempt
    // verifies the existing object and retries ONLY this row update.
    return { ok: false, errorCode: 'MEDIA_FINALIZATION_FAILED', retryable: true };
  }
  return { ok: true, bucket, path };
}

/**
 * Best-effort orphan cleanup for a proven, exact object path belonging to the
 * current user's saved scan. Never deletes folders or other items' media.
 */
export async function cleanupOrphanSavedScanMedia(input: {
  savedScanId: string;
  path: string;
}): Promise<boolean> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) return false;
  // Ownership proof: the path must be exactly this user's deterministic path.
  if (input.path !== buildSavedScanMediaPath(userId, input.savedScanId)) return false;

  const { data: row } = await supabase
    .from('saved_scans')
    .select('id,media_status')
    .eq('id', input.savedScanId)
    .maybeSingle();
  // Only clean when the row does not claim the media.
  if (row && row.media_status === 'ready') return false;

  const { error } = await supabase.storage.from(SAVED_SCAN_MEDIA_BUCKET).remove([input.path]);
  return !error;
}
