// Pure, runtime-independent validation/authorization helpers for the
// shared-room-image-url Edge Function. Deliberately has NO Deno.* calls and
// NO network access so it can be exercised with real behavioral tests under
// plain Node (see __tests__/sharedRoomImageResolver.test.js) as well as
// imported directly by index.ts under Deno.

/** Aligned with get_public_room_preview's preview_item_limit (24). */
export const MAX_ITEM_IDS = 24;

export const SHARED_ROOM_ITEM_SOURCE_TYPES = [
  'dressing_room_item',
  'inspiration_item',
] as const;

export type SharedRoomItemSourceType = typeof SHARED_ROOM_ITEM_SOURCE_TYPES[number];
export type SharedRoomItemRef = {
  sourceType: SharedRoomItemSourceType;
  sourceId: string;
};

// Matches the real share-token contract (services/roomDeepLinks.js
// normalizeRoomShareToken / public.get_public_room_preview): any URL-safe
// token up to 160 chars, NOT strictly a UUID. Today's tokens happen to be
// gen_random_uuid()::text, but the contract is broader than that - a stricter
// UUID-only check here would silently break the moment token generation
// changes, even though nothing else in the system requires UUID-shaped tokens.
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{1,160}$/;

// dressing_room_items.id IS a real uuid primary key, so item ids are validated
// strictly as UUIDs (unlike the share token).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidShareToken(value: unknown): value is string {
  return typeof value === 'string' && SHARE_TOKEN_RE.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isSharedRoomItemSourceType(value: unknown): value is SharedRoomItemSourceType {
  return SHARED_ROOM_ITEM_SOURCE_TYPES.includes(value as SharedRoomItemSourceType);
}

export function sharedRoomItemRefKey(ref: SharedRoomItemRef): string {
  return `${ref.sourceType}:${ref.sourceId}`;
}

/** Validates, deduplicates, and caps build-15 typed references as one batch. */
export function sanitizeItemRefs(value: unknown): SharedRoomItemRef[] {
  if (!Array.isArray(value)) return [];

  const result: SharedRoomItemRef[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const raw = candidate as { sourceType?: unknown; sourceId?: unknown };
    if (!isSharedRoomItemSourceType(raw.sourceType) || !isUuid(raw.sourceId)) continue;

    const ref = { sourceType: raw.sourceType, sourceId: raw.sourceId.toLowerCase() };
    const key = sharedRoomItemRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
    if (result.length === MAX_ITEM_IDS) break;
  }
  return result;
}

/**
 * Validates, deduplicates, and caps the requested item ids. Non-UUID entries
 * are dropped rather than causing the whole request to fail, so one bad id in
 * a batch doesn't block the rest.
 */
export function sanitizeItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = Array.from(new Set(value.filter(isUuid)));
  return deduped.slice(0, MAX_ITEM_IDS);
}

export type DressingRoomItemStorageRow = {
  id: string;
  storage_bucket?: string | null;
  storage_path?: string | null;
  snapshot_payload?: { image?: { storageBucket?: unknown; storagePath?: unknown } | null } | null;
};

export type ResolvedStorageRef = { bucket: string; path: string };

export type InspirationRoomLinkRow = {
  inspiration_id: string;
  user_id: string;
  deleted_at?: string | null;
};

export type InspirationItemStorageRow = {
  id: string;
  user_id: string;
  storage_bucket?: string | null;
  storage_path?: string | null;
  deleted_at?: string | null;
};

/**
 * Resolves a durable storage reference for a dressing_room_items row,
 * preferring the dedicated storage_bucket/storage_path columns and falling
 * back to the legacy snapshot_payload.image.{storageBucket,storagePath}
 * location used before those columns existed. Returns null when neither is a
 * usable non-empty string pair.
 *
 * This is the read-side counterpart of the write-side priority encoded in
 * services/dressingRoomItemContract.ts#resolveDressingRoomImageSource
 * (storage > remote > local) in the main React Native app. That module lives
 * in the RN app and cannot be imported here (this function runs under Deno,
 * in a separately deployed Edge Function, with no access to the RN
 * module graph) - this is a deliberate re-implementation of just the
 * storage-ref half of that contract, not a divergent one. The app only ever
 * calls this Edge Function for items missing a public imageUrl, and the
 * write path (services/styleObjects.ts) sets image_url XOR
 * storage_bucket+storage_path on a given row, never both, so there is no
 * priority conflict between the two sides in practice. If that
 * mutual-exclusivity assumption or the write-side priority order changes,
 * this function must be updated to match.
 */
export function resolveStorageRefFromRow(row: DressingRoomItemStorageRow): ResolvedStorageRef | null {
  const payloadImage = row.snapshot_payload?.image ?? null;

  const bucket =
    row.storage_bucket ??
    (payloadImage && typeof payloadImage.storageBucket === 'string' ? payloadImage.storageBucket : null);
  const path =
    row.storage_path ??
    (payloadImage && typeof payloadImage.storagePath === 'string' ? payloadImage.storagePath : null);

  if (typeof bucket === 'string' && bucket.trim() && typeof path === 'string' && path.trim()) {
    return { bucket, path };
  }
  return null;
}

/** Only buckets on this allowlist are ever eligible for signing. */
export const ALLOWED_BUCKETS = new Set(['style-library-images']);

export function isBucketAllowed(bucket: string): boolean {
  return ALLOWED_BUCKETS.has(bucket);
}

/**
 * Enforces the private object conventions established by the write paths and
 * database constraints. The room owner id stays server-side and is never
 * included in the response.
 */
export function isApprovedPrivateStorageRef(
  sourceType: SharedRoomItemSourceType,
  ownerId: string,
  ref: ResolvedStorageRef,
): boolean {
  if (!isUuid(ownerId) || !isBucketAllowed(ref.bucket)) return false;
  const segments = ref.path.split('/');
  if (segments.length !== 3 || segments[0].toLowerCase() !== ownerId.toLowerCase()) return false;
  if (!/^[A-Za-z0-9._-]+[.]jpg$/.test(segments[2])) return false;

  if (sourceType === 'inspiration_item') return segments[1] === 'inspirations';
  return segments[1] === 'scans' || segments[1] === 'saved-scans';
}

/**
 * Intersects inspiration rows with the already room-scoped active link rows.
 * A deleted, detached, foreign-owner, or path-invalid row never yields a ref.
 */
export function resolveAuthorizedInspirationStorageRefs(
  ownerId: string,
  links: InspirationRoomLinkRow[],
  items: InspirationItemStorageRow[],
): Map<string, ResolvedStorageRef> {
  const linkedIds = new Set(
    links
      .filter((row) => row.deleted_at == null && row.user_id.toLowerCase() === ownerId.toLowerCase())
      .map((row) => row.inspiration_id.toLowerCase()),
  );
  const refs = new Map<string, ResolvedStorageRef>();

  for (const row of items) {
    const sourceId = row.id.toLowerCase();
    if (row.deleted_at != null || row.user_id.toLowerCase() !== ownerId.toLowerCase()) continue;
    if (!linkedIds.has(sourceId)) continue;
    if (typeof row.storage_bucket !== 'string' || typeof row.storage_path !== 'string') continue;

    const ref = { bucket: row.storage_bucket, path: row.storage_path };
    if (isApprovedPrivateStorageRef('inspiration_item', ownerId, ref)) refs.set(sourceId, ref);
  }
  return refs;
}

/**
 * Encodes a Storage object reference without escaping path separators.
 *
 * Encoding the entire path with encodeURIComponent turns "/" into "%2F".
 * Supabase may still return a signedURL for that request, but the resulting
 * object URL is not fetchable. Encode each path segment independently so
 * spaces and other unsafe characters remain safe while the object hierarchy
 * stays intact.
 */
export function encodeStorageObjectPath(bucket: string, path: string): string {
  const encodedBucket = encodeURIComponent(bucket);
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${encodedBucket}/${encodedPath}`;
}
