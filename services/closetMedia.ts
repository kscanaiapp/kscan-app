// Cloud Closet media contract (Build 34 Track B, Phase B1C).
//
// SCOPE: this module defines the CONTRACT ONLY -- deterministic object paths,
// bounds, and state predicates. It deliberately contains no upload saga, no
// sync queue and no client orchestration; that is Phase B2. The saga shape B2
// must implement is specified in docs/build34-trackb-b1c-closet-media-ledger.md
// and mirrors services/savedScanMedia.ts#ensureSavedScanMediaBacking.
//
// Every constant below is inherited from proven, already-shipping code rather
// than chosen here:
//   bucket / max bytes / content type / signed-URL TTL
//                        <- services/savedScanMedia.ts
//   primary width 1440   <- services/closetLibrary.js IMAGE_WIDTH (and the
//                           saved-scan cloud primary, which is also 1440)
//   thumbnail width 160  <- services/closetLibrary.js THUMB_WIDTH
//
// PATHS ARE FLAT, ONE LEVEL UNDER {userId}/closet, AND THAT IS LOAD-BEARING:
// Supabase Storage list() is not recursive, and the account-deletion
// enumerator does not filter folder pseudo-entries. A nested layout would make
// account deletion silently skip Closet media. See the B1C ledger.

export const CLOSET_MEDIA_BUCKET = 'style-library-images';
export const CLOSET_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const CLOSET_MEDIA_CONTENT_TYPE = 'image/jpeg';

/** Matches services/closetLibrary.js IMAGE_WIDTH / THUMB_WIDTH exactly. */
export const CLOSET_MEDIA_PRIMARY_WIDTH = 1440;
export const CLOSET_MEDIA_THUMBNAIL_WIDTH = 160;

/** Same TTL services/savedScanMedia.ts uses for private object resolution. */
export const CLOSET_MEDIA_SIGNED_URL_TTL_SECONDS = 60;

/** The owner-scoped Closet namespace; also the account-deletion prefix. */
export function buildClosetMediaPrefix(userId: string): string {
  return `${userId}/closet`;
}

export type ClosetMediaStatus = 'pending' | 'ready' | 'failed' | null;

/**
 * Deterministic, user-scoped object paths for one Closet item.
 *
 * Derived from the authenticated owner id and the SERVER-ISSUED
 * user_closet_items.id -- never from a local file URI, a client_id, or any
 * caller-supplied path. The database enforces exactly these two strings via the
 * user_closet_items_media_primary_path_derived /
 * user_closet_items_media_thumb_path_derived CHECK constraints, so a row can
 * never reference a path this function would not produce.
 */
export function buildClosetMediaPaths(
  userId: string,
  closetItemId: string,
): { primary: string; thumbnail: string } {
  const prefix = buildClosetMediaPrefix(userId);
  return {
    primary: `${prefix}/${closetItemId}-primary.jpg`,
    thumbnail: `${prefix}/${closetItemId}-thumb.jpg`,
  };
}

/**
 * True only for a row whose cloud media is committed and fully referenced.
 * Mirrors services/savedScanMedia.ts#isRemoteMediaBacked.
 *
 * A missing thumbnail does NOT disqualify a row: thumbnail generation is a
 * convenience derivative and is allowed to fail without invalidating the
 * committed primary image (the same rule the local Closet store applies).
 */
export function isClosetMediaBacked(row: {
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
