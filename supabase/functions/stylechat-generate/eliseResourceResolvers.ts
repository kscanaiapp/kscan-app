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

function asStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    const single = asString(value);
    return single ? [single] : [];
  }
  const out: string[] = [];
  for (const entry of value) {
    const text = asString(entry);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Server-side descriptive metadata for a Dressing Room item.
 *
 * WHY THIS EXISTS: the room-item resolvers previously returned
 * `colors: []`, `materials: []`, `silhouette: null` — the server had no
 * opinion, so the client's claim about a verified item was the only value
 * available and won by default. The authoritative copy of that metadata is the
 * row's `snapshot_payload`, which is written when the item is added to the
 * room; reading it is what lets the server actually be the authority its
 * `server_verified` trust label already claims.
 *
 * Deliberately defensive: `snapshot_payload` is heterogeneous jsonb written by
 * several item sources across builds, so every field is optional and a
 * malformed payload yields no opinion rather than throwing. No value is
 * invented — an absent field stays absent.
 */
function snapshotMetadata(item: Record<string, unknown>): {
  colors: string[];
  materials: string[];
  silhouette: string | null;
  pattern: string | null;
  fit: string | null;
} {
  const payload = item.snapshot_payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { colors: [], materials: [], silhouette: null, pattern: null, fit: null };
  }
  const record = payload as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
  const attributes =
    record.attributes && typeof record.attributes === 'object' &&
      !Array.isArray(record.attributes)
      ? (record.attributes as Record<string, unknown>)
      : {};

  const colors = asStringList(
    record.colors ?? attributes.colors ?? metadata.color ?? attributes.color ?? record.color,
    8,
  );
  const materials = asStringList(
    record.materials ?? attributes.material ?? metadata.materialEstimate ?? record.material,
    8,
  );
  const silhouette =
    asString(record.silhouette) ??
    asString(attributes.silhouette) ??
    asString(metadata.silhouette);

  // Closet V2 / S4. Read with the same defensive breadth as the fields above:
  // snapshot_payload is heterogeneous jsonb written by several item sources
  // across builds. A payload that never recorded either yields null, which is
  // the honest answer and is what makes the manifest report it unavailable.
  const pattern =
    asString(record.pattern) ??
    asString(attributes.pattern) ??
    asString(metadata.pattern);
  const fit =
    asString(record.fit) ??
    asString(attributes.fit) ??
    asString(metadata.fit);

  return { colors, materials, silhouette, pattern, fit };
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

export async function resolveClosetItem(
  data: EliseResourceDataSource,
  actorId: string,
  itemId: string | null,
): Promise<EliseResourceResolution> {
  if (!itemId || !isUuid(itemId)) return { status: 'invalid_reference' };
  let row: Record<string, unknown> | null;
  try {
    row = await data.fetchInspirationItem(itemId);
  } catch {
    return { status: 'unavailable' };
  }
  if (!row) {
    // Closet may also surface saved scans as durable items.
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
      actorRelationship: 'owned',
      sourceType: 'closet_item',
      trust: 'server_verified',
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
  if (!ownerMatches(row, actorId)) return { status: 'unauthorized' };
  const storage = storageCanonical(row);
  return {
    status: 'verified',
    actorRelationship: 'owned',
    sourceType: 'closet_item',
    trust: 'server_verified',
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
      ...snapshotMetadata(item),
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
      ...snapshotMetadata(item),
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
      return resolveClosetItem(data, actorId, input.itemId ?? input.sourceId);
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
