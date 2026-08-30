// Build 34 / Track B / Phase B2B — cloud Closet MEDIA upload.
//
// THE ONLY SOURCE OF A CLOUD-ELIGIBLE PIXEL IS B2A.
//
// This module calls services/closetMediaPrivacy.ts#sanitizeClosetMedia and
// uploads what it returns, and nothing else. It does not import
// privacyBoundary, nativeFaceEngine, nativePlateEngine or kscan-pii-native —
// those are implementation details beneath B2A's contract. It never reads the
// user's original local file for upload, and it never infers safety from a
// file existing, a filename, a native module being linked, or a flag a caller
// passed in: the ONLY thing that authorizes an upload is
// `result.status === 'SAFE'`.
//
// B2A's privacy semantics are consumed, never re-decided here:
//   face present         -> masked locally by B2A -> uploadable
//   no face              -> real re-encoded artifact -> uploadable
//   plate-like region    -> BLOCKED -> facts keep syncing, media never uploads
//   native/sanitizer bad -> BLOCKED -> no raw fallback, ever
//
// UPLOAD SAGA (idempotent, deterministic paths):
//   reserve (media_status=pending) -> primary -> thumbnail -> verify both
//   -> commit ready. A partial success is never `ready`; a retry reuses the
//   SAME two object paths rather than creating a second copy.

import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '../supabaseClient';
import {
  sanitizeClosetMedia,
  type ClosetMediaBlockedReason,
  type ClosetMediaSanitizationResult,
} from '../closetMediaPrivacy';
import {
  CLOSET_MEDIA_BUCKET,
  buildClosetPrimaryPath,
  buildClosetThumbnailPath,
  classifySyncFailure,
  type ClosetSyncFailureClass,
} from './closetSyncContract';

const CLOSET_TABLE = 'user_closet_items';
const CONTENT_TYPE = 'image/jpeg';

/**
 * Single result shape with optional fields — see the note on
 * ClosetFactsSyncResult: this project does not enable `strict`, so
 * boolean-literal discriminated unions do not narrow.
 *
 * `blocked: true` means B2A refused the image. That is deterministic and is
 * never auto-retried; `blocked` absent/false with a failureClass is a
 * transport or contract failure, which may be.
 */
export interface ClosetMediaSyncResult {
  ok: boolean;
  blocked?: boolean;
  reason?: ClosetMediaBlockedReason;
  failureClass?: ClosetSyncFailureClass;
  detail?: string;
  primaryPath?: string;
  thumbnailPath?: string;
  /**
   * The server row_version after this saga's writes.
   *
   * LOAD-BEARING, not informational. The media saga performs its OWN updates
   * (the reservation and the ready commit), and B1A's update-authority trigger
   * bumps row_version on every one of them. A caller that recorded only the
   * row_version it got from the FACTS write would hold a stale revision the
   * moment media ran, and its next conditional edit would be refused as a
   * phantom conflict against a server nothing else had touched.
   */
  rowVersion?: number;
}

/**
 * Base64 -> ArrayBuffer, matching services/savedScanMedia.ts.
 *
 * The repository's established way of handing bytes to supabase-js in React
 * Native, where Blob/File are not reliably available. Copied rather than
 * imported to keep this module free of the saved-scan domain (whose media
 * pipeline still routes through the passthrough sanitizer B1C found defective).
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
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

/** Proof an object really landed. A successful upload call is not proof. */
async function verifyObjectExists(path: string): Promise<boolean> {
  const { data, error } = await supabase.storage.from(CLOSET_MEDIA_BUCKET).createSignedUrl(path, 60);
  return !error && !!data?.signedUrl;
}

async function uploadArtifact(path: string, localUri: string): Promise<{ ok: boolean; detail?: string }> {
  const base64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const body = base64ToArrayBuffer(base64);
  if (body.byteLength === 0) return { ok: false, detail: 'artifact read produced no bytes' };

  const { error } = await supabase.storage.from(CLOSET_MEDIA_BUCKET).upload(path, body, {
    contentType: CONTENT_TYPE,
    cacheControl: '3600',
    // TRUE, unlike the saved-scan precedent's `false` + already-exists probe.
    // Section 21 requires a retry to reuse the SAME deterministic path, and
    // each attempt re-derives a FRESH sanitized artifact from B2A (the prior
    // one was cleaned up), so the bytes at that path must be replaceable. With
    // upsert:false a retry after a partial failure could never overwrite a
    // truncated object.
    upsert: true,
  });
  if (error) return { ok: false, detail: 'storage upload rejected' };
  return { ok: true };
}

/**
 * Upload one Closet item's cloud media.
 *
 * @param serverItemId authoritative server id — the ONLY id the B1C storage
 *   paths may be derived from. A local id here would violate the database's
 *   path CHECK constraints and be rejected by Postgres.
 * @param isStillCurrent re-checked immediately before the READY commit. An
 *   upload that finishes after the item was deleted, edited, or the account
 *   changed must not commit authoritative state (sections 29-31).
 */
export async function uploadClosetItemMedia(input: {
  userId: string;
  serverItemId: string;
  localImageUri: string;
  signal?: { aborted: boolean };
  isStillCurrent: () => boolean | Promise<boolean>;
}): Promise<ClosetMediaSyncResult> {
  const primaryPath = buildClosetPrimaryPath(input.userId, input.serverItemId);
  const thumbnailPath = buildClosetThumbnailPath(input.userId, input.serverItemId);

  let sanitized: ClosetMediaSanitizationResult;
  try {
    sanitized = await sanitizeClosetMedia(input.localImageUri, { signal: input.signal });
  } catch {
    // B2A is fail-closed by contract; a throw is still treated as a refusal
    // rather than as permission to fall back to the raw image.
    return { ok: false, blocked: false, failureClass: 'retryable', detail: 'sanitization threw' };
  }

  if (sanitized.status !== 'SAFE') {
    // BLOCKED is B2A's closed vocabulary, not an error string. It affects THIS
    // item's media only: the facts row stays synced and the local image stays
    // exactly where it is.
    return {
      ok: false,
      blocked: true,
      reason: sanitized.reason,
      detail: sanitized.detail,
    };
  }

  // Tracks the newest server revision this saga has observed, so every exit
  // path can hand it back (see ClosetMediaSyncResult.rowVersion).
  let rowVersion: number | undefined;

  try {
    // Reserve BEFORE uploading so an interrupted upload is discoverable as
    // pending rather than being mistaken for absent.
    const { data: reserved, error: reserveError } = await supabase
      .from(CLOSET_TABLE)
      .update({
        storage_bucket: CLOSET_MEDIA_BUCKET,
        storage_path: primaryPath,
        media_status: 'pending',
      })
      .eq('id', input.serverItemId)
      .select('id,row_version');
    if (reserveError) {
      return {
        ok: false,
        blocked: false,
        failureClass: classifySyncFailure(reserveError),
        detail: 'media reservation failed',
      };
    }
    const reservedRows = Array.isArray(reserved) ? reserved : reserved ? [reserved] : [];
    if (reservedRows.length > 0) rowVersion = (reservedRows[0] as any).row_version;

    const primary = await uploadArtifact(primaryPath, sanitized.primary.uri);
    if (!primary.ok) {
      return { ok: false, blocked: false, failureClass: 'retryable', detail: primary.detail, rowVersion };
    }

    const thumbnail = await uploadArtifact(thumbnailPath, sanitized.thumbnail.uri);
    if (!thumbnail.ok) {
      // The primary object legitimately remains at its deterministic path. It
      // is NOT authoritative media: media_status stays pending, so nothing
      // downstream may treat this item as media-backed. The next attempt
      // overwrites both objects at the same two paths.
      return { ok: false, blocked: false, failureClass: 'retryable', detail: thumbnail.detail, rowVersion };
    }

    // Both objects must be independently provable before anything is called
    // ready. An upload call that returned without error is not evidence.
    const [primaryExists, thumbnailExists] = [
      await verifyObjectExists(primaryPath),
      await verifyObjectExists(thumbnailPath),
    ];
    if (!primaryExists || !thumbnailExists) {
      return {
        ok: false,
        blocked: false,
        failureClass: 'retryable',
        detail: 'uploaded object could not be verified',
        rowVersion,
      };
    }

    // LAST GATE BEFORE AUTHORITATIVE STATE. Everything above is idempotent and
    // safe to repeat; committing `ready` for an item the user has since deleted
    // or replaced is not.
    if (!(await input.isStillCurrent())) {
      return {
        ok: false,
        blocked: false,
        failureClass: 'permanent',
        detail: 'operation went stale before media commit',
        rowVersion,
      };
    }

    const { data: committed, error: commitError } = await supabase
      .from(CLOSET_TABLE)
      .update({
        storage_bucket: CLOSET_MEDIA_BUCKET,
        storage_path: primaryPath,
        thumbnail_storage_path: thumbnailPath,
        media_status: 'ready',
        media_uploaded_at: new Date().toISOString(),
      })
      .eq('id', input.serverItemId)
      .select('id,row_version');
    if (commitError) {
      // Objects are up; only the row update failed. Retryable, and the next
      // attempt re-uploads to the same paths rather than duplicating.
      return {
        ok: false,
        blocked: false,
        failureClass: classifySyncFailure(commitError),
        detail: 'media finalization failed',
        rowVersion,
      };
    }
    const committedRows = Array.isArray(committed) ? committed : committed ? [committed] : [];
    if (committedRows.length > 0) rowVersion = (committedRows[0] as any).row_version;

    return { ok: true, primaryPath, thumbnailPath, rowVersion };
  } finally {
    // Section 22: release B2A's derivatives once consumed or abandoned. This
    // only ever removes the privacy-cache artifacts B2A created; the user's
    // local Closet original is never touched by this cleanup.
    if (sanitized.status === 'SAFE') {
      await sanitized.cleanup().catch(() => undefined);
    }
  }
}

/**
 * Release of a tombstoned item's cloud objects, with an OBSERVABLE result.
 *
 * Only ever the two exact deterministic paths derived from this user's id and
 * the item's server id — never a folder, never a prefix, never another item's
 * media.
 *
 * `supabase.storage.remove()` reports failure through its returned `error`,
 * not only through a thrown exception — a bare `await` that ignores the
 * response therefore "succeeds" even when nothing was actually deleted. The
 * caller (closetSyncEngine's delete handling) uses this result to decide
 * whether the durable pending_delete evidence may be cleared: it must stay
 * discoverable for a retry when `ok` is false, exactly the way a facts or
 * media-upload failure already keeps its own retry evidence. The
 * account-deletion worker (B1B) remains the backstop that guarantees eventual
 * purge regardless — this only affects how soon an OUTBOUND delete's own
 * cleanup is retried.
 */
export async function releaseClosetItemMedia(
  userId: string,
  serverItemId: string,
): Promise<{ ok: boolean }> {
  try {
    const { error } = await supabase.storage
      .from(CLOSET_MEDIA_BUCKET)
      .remove([buildClosetPrimaryPath(userId, serverItemId), buildClosetThumbnailPath(userId, serverItemId)]);
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}
