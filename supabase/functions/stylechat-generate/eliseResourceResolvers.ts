/**
 * E-1 server-side resource resolution.
 * Ownership and shared access are derived only from trusted backend rows.
 */

import type {
  EliseActorRelationship,
  EliseEvidenceSourceType,
  EliseEvidenceTrust,
  EliseResourceResolution,
} from './eliseVisualContextTypes.ts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

export type EliseResourceDataSource = {
  /**
   * INT-KPLUS-001 -- the canonical Closet authority (public.user_closet_items).
   * This is the ONLY row that may establish actorRelationship 'owned'.
   * Optional so existing callers/tests that predate the canonical Closet keep
   * compiling; when absent NOTHING can resolve as owned via this path, which is
   * the fail-closed direction.
   */
  fetchUserClosetItem?(id: string): Promise<Record<string, unknown> | null>;
  fetchSavedScan(id: string): Promise<Record<string, unknown> | null>;
  fetchInspirationItem(id: string): Promise<Record<string, unknown> | null>;
  fetchDressingRoom(roomId: string): Promise<Record<string, unknown> | null>;
  fetchDressingRoomItem(
    roomId: string,
    itemId: string,
  ): Promise<Record<string, unknown> | null>;
  /**
   * Active shared-room access for the actor.
   * Returns null when no membership; expired when share/membership is inactive.
   */
  fetchSharedRoomAccess(
    roomId: string,
    actorId: string,
  ): Promise<{ active: boolean; expired: boolean } | null>;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ownerMatches(row: Record<string, unknown>, actorId: string): boolean {
  const owner = asString(row.user_id) ?? asString(row.owner_id);
  return owner === actorId;
}

/**
 * public.user_closet_items uses the canonical Closet taxonomy columns
 * (primary_color / secondary_colors[] / material[]), NOT saved_scans' flat
 * single-value shape. Read them on their own terms rather than reusing the
 * scan helpers, which would silently drop every colour and material.
 */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const v = asString(entry);
    if (v) out.push(v);
  }
  return out;
}

function closetColors(row: Record<string, unknown>): string[] {
  const primary = asString(row.primary_color);
  const secondary = stringArray(row.secondary_colors);
  return primary ? [primary, ...secondary] : secondary;
}

/**
 * A soft-deleted Closet row is not a live possession: it must never establish
 * ownership. Tolerant of schema variants (deleted_at / removed_at / is_deleted).
 */
function isSoftDeleted(row: Record<string, unknown>): boolean {
  if (row.deleted_at != null) return true;
  if (row.removed_at != null) return true;
  if (row.is_deleted === true) return true;
  const status = asString(row.status);
  if (status === 'deleted' || status === 'removed') return true;
  return false;
}

function storageCanonical(
  row: Record<string, unknown>,
): { bucket: string | null; path: string | null } {
  return {
    bucket: asString(row.storage_bucket),
    path: asString(row.storage_path),
  };
}

function colorsFromRow(row: Record<string, unknown>): string[] {
  const color = asString(row.color);
  return color ? [color] : [];
}

function materialsFromRow(row: Record<string, unknown>): string[] {
  const material = asString(row.material);
  return material ? [material] : [];
}

export async function resolveScanOwnership(
  data: EliseResourceDataSource,
  actorId: string,
  scanId: string | null,
  sourceType: EliseEvidenceSourceType,
): Promise<EliseResourceResolution> {
  if (!scanId || !isUuid(scanId)) return { status: 'invalid_reference' };
  let row: Record<string, unknown> | null;
  try {
    row = await data.fetchSavedScan(scanId);
  } catch {
    return { status: 'unavailable' };
  }
  if (!row) return { status: 'not_found' };
  if (!ownerMatches(row, actorId)) return { status: 'unauthorized' };
  const storage = storageCanonical(row);
  return {
    status: 'verified',
    actorRelationship: 'scanned',
    sourceType: sourceType === 'selected_scan_item' ? 'selected_scan_item' : sourceType === 'recent_scan' ? 'recent_scan' : 'current_scan',
    trust: 'server_verified',
    canonicalIds: {
      scanId,
      sourceId: scanId,
      storageBucket: storage.bucket,
      storagePath: storage.path,
    },
    metadata: {
      title: asString(row.title),
      category: null,
      colors: [],
      materials: [],
      silhouette: null,
      brand: null,
    },
  };
}

/**
 * Resolve the legacy `closet_item` transport HONESTLY (INT-KPLUS-001).
 *
 * The transport label is a client-supplied hint and is NEVER ownership proof.
 * The server decides what the id actually is, in canonical-authority order:
 *
 *   1. public.user_closet_items  -> user_closet_item / owned
 *   2. public.inspiration_items  -> inspiration_item / saved   (NOT owned)
 *   3. public.saved_scans        -> saved_scan      / scanned  (NOT owned)
 *
 * A saved scan or inspiration upload arriving under the legacy `closet_item`
 * label therefore resolves as scanned/saved, exactly as it would through its
 * own transport. Foreign, deleted and forged ids fail closed as before.
 */
export async function resolveClosetItem(
  data: EliseResourceDataSource,
  actorId: string,
  itemId: string | null,
): Promise<EliseResourceResolution> {
  if (!itemId || !isUuid(itemId)) return { status: 'invalid_reference' };

  // 1 — canonical Closet. The only path that can produce 'owned'.
  if (typeof data.fetchUserClosetItem === 'function') {
    let closetRow: Record<string, unknown> | null;
    try {
      closetRow = await data.fetchUserClosetItem(itemId);
    } catch {
      return { status: 'unavailable' };
    }
    if (closetRow) {
      if (!ownerMatches(closetRow, actorId)) return { status: 'unauthorized' };
      // A soft-deleted Closet row is not a live possession.
      if (isSoftDeleted(closetRow)) return { status: 'not_found' };
      const storage = storageCanonical(closetRow);
      return {
        status: 'verified',
        actorRelationship: 'owned' satisfies EliseActorRelationship,
        sourceType: 'user_closet_item',
        trust: 'server_verified' satisfies EliseEvidenceTrust,
        canonicalIds: {
          itemId,
          sourceId: itemId,
          storageBucket: storage.bucket,
          storagePath: storage.path,
        },
        metadata: {
          title: asString(closetRow.title),
          category: asString(closetRow.category) ?? asString(closetRow.clothing_type),
          colors: closetColors(closetRow),
          materials: stringArray(closetRow.material),
          silhouette: asString(closetRow.subtype),
          brand: asString(closetRow.brand),
        },
      };
    }
  }

  // 2 — inspiration upload. Saved, never owned.
  let row: Record<string, unknown> | null;
  try {
    row = await data.fetchInspirationItem(itemId);
  } catch {
    return { status: 'unavailable' };
  }
  if (row) {
    if (!ownerMatches(row, actorId)) return { status: 'unauthorized' };
    const storage = storageCanonical(row);
    return {
      status: 'verified',
      actorRelationship: 'saved' satisfies EliseActorRelationship,
      sourceType: 'inspiration_item',
      trust: 'server_verified' satisfies EliseEvidenceTrust,
      canonicalIds: {
        itemId,
        sourceId: itemId,
        storageBucket: storage.bucket,
        storagePath: storage.path,
      },
      metadata: {
        title: asString(row.note) ?? asString(row.title),
        category: asString(row.category),
        colors: colorsFromRow(row),
        materials: materialsFromRow(row),
        silhouette: asString(row.silhouette),
        brand: null,
      },
    };
  }

  // 3 — saved scan. Scanned, never owned.
  try {
    row = await data.fetchSavedScan(itemId);
  } catch {
    return { status: 'unavailable' };
  }
  if (!row) return { status: 'not_found' };
  if (!ownerMatches(row, actorId)) return { status: 'unauthorized' };
  const storage = storageCanonical(row);
  return {
    status: 'verified',
    actorRelationship: 'scanned' satisfies EliseActorRelationship,
    sourceType: 'saved_scan',
    trust: 'server_verified' satisfies EliseEvidenceTrust,
    canonicalIds: {
      itemId,
      scanId: itemId,
      sourceId: itemId,
      storageBucket: storage.bucket,
      storagePath: storage.path,
    },
    metadata: {
      title: asString(row.title),
      category: null,
      colors: [],
      materials: [],
      silhouette: null,
      brand: null,
    },
  };
}

export async function resolveOwnedRoomItem(
  data: EliseResourceDataSource,
  actorId: string,
  roomId: string | null,
  itemId: string | null,
): Promise<EliseResourceResolution> {
  if (!roomId || !itemId || !isUuid(roomId) || !isUuid(itemId)) {
    return { status: 'invalid_reference' };
  }
  let room: Record<string, unknown> | null;
  let item: Record<string, unknown> | null;
  try {
    room = await data.fetchDressingRoom(roomId);
    item = await data.fetchDressingRoomItem(roomId, itemId);
  } catch {
    return { status: 'unavailable' };
  }
  if (!room) return { status: 'not_found' };
  if (!ownerMatches(room, actorId)) return { status: 'unauthorized' };
  if (!item) return { status: 'not_found' };
  const itemRoom = asString(item.dressing_room_id);
  if (itemRoom && itemRoom !== roomId) return { status: 'unauthorized' };
  const storage = storageCanonical(item);
  return {
    status: 'verified',
    actorRelationship: 'owned',
    sourceType: 'owned_room_item',
    trust: 'server_verified',
    canonicalIds: {
      roomId,
      itemId,
      sourceId: itemId,
      storageBucket: storage.bucket,
      storagePath: storage.path,
    },
    metadata: {
      title: asString(item.title),
      category: asString(item.category),
      colors: [],
      materials: [],
      silhouette: null,
      brand: asString(item.brand),
    },
  };
}

export async function resolveSharedRoomItem(
  data: EliseResourceDataSource,
  actorId: string,
  roomId: string | null,
  itemId: string | null,
): Promise<EliseResourceResolution> {
  if (!roomId || !itemId || !isUuid(roomId) || !isUuid(itemId)) {
    return { status: 'invalid_reference' };
  }
  let access: { active: boolean; expired: boolean } | null;
  let item: Record<string, unknown> | null;
  try {
    access = await data.fetchSharedRoomAccess(roomId, actorId);
    item = await data.fetchDressingRoomItem(roomId, itemId);
  } catch {
    return { status: 'unavailable' };
  }
  if (!access) return { status: 'unauthorized' };
  if (access.expired || !access.active) return { status: 'unauthorized' };
  if (!item) return { status: 'not_found' };
  const itemRoom = asString(item.dressing_room_id);
  if (itemRoom && itemRoom !== roomId) return { status: 'unauthorized' };
  const storage = storageCanonical(item);
  return {
    status: 'verified',
    // Shared must never upgrade to owned.
    actorRelationship: 'shared' satisfies EliseActorRelationship,
    sourceType: 'shared_room_item',
    trust: 'server_verified' satisfies EliseEvidenceTrust,
    canonicalIds: {
      roomId,
      itemId,
      sourceId: itemId,
      storageBucket: storage.bucket,
      storagePath: storage.path,
    },
    metadata: {
      title: asString(item.title),
      category: asString(item.category),
      colors: [],
      materials: [],
      silhouette: null,
      brand: asString(item.brand),
    },
  };
}

export async function resolveEvidenceResource(input: {
  data: EliseResourceDataSource;
  actorId: string;
  sourceType: EliseEvidenceSourceType;
  scanId: string | null;
  itemId: string | null;
  roomId: string | null;
  sourceId: string | null;
}): Promise<EliseResourceResolution> {
  const { data, actorId, sourceType } = input;
  switch (sourceType) {
    case 'current_scan':
    case 'selected_scan_item':
    case 'recent_scan':
      return resolveScanOwnership(
        data,
        actorId,
        input.scanId ?? input.sourceId,
        sourceType,
      );
    case 'closet_item':
    case 'user_closet_item':
    case 'inspiration_item':
      // All three enter the same honest resolver: the server decides what the
      // id actually is, the transport label never does (INT-KPLUS-001).
      return resolveClosetItem(data, actorId, input.itemId ?? input.sourceId);
    case 'saved_scan':
      // A saved scan resolves through the scan authority, which cannot emit
      // 'owned'.
      return resolveScanOwnership(
        data,
        actorId,
        input.scanId ?? input.itemId ?? input.sourceId,
        'recent_scan',
      );
    case 'owned_room_item':
      return resolveOwnedRoomItem(
        data,
        actorId,
        input.roomId,
        input.itemId ?? input.sourceId,
      );
    case 'shared_room_item':
      return resolveSharedRoomItem(
        data,
        actorId,
        input.roomId,
        input.itemId ?? input.sourceId,
      );
    case 'commerce_product':
    case 'text_scan':
    case 'uploaded_image':
    case 'unknown_legacy':
      // No ownership resource to resolve; caller keeps client_metadata / model_inferred.
      return { status: 'invalid_reference' };
    default:
      return { status: 'invalid_reference' };
  }
}
