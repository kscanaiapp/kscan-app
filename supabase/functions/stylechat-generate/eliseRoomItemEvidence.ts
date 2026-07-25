/**
 * DR-1 Elise room-item evidence compatibility helpers (pure).
 *
 * Evidence kinds:
 * - owned_room_item  → dressing_room_items owned via dressing_rooms.user_id
 * - shared_room_item → requires active share/membership (server-side only)
 *
 * Client-supplied ownership claims are never authoritative.
 */

export type EliseRoomEvidenceKind = 'owned_room_item' | 'shared_room_item';

export type EliseRoomEvidenceRef = {
  kind: EliseRoomEvidenceKind;
  itemId: string;
  roomId?: string | null;
  shareToken?: string | null;
};

export function isEliseRoomEvidenceKind(value: unknown): value is EliseRoomEvidenceKind {
  return value === 'owned_room_item' || value === 'shared_room_item';
}

/**
 * Map StyleChat attachment sourceType to Elise evidence kind.
 * dressing_room_item attachments resolve as owned_room_item evidence.
 */
export function evidenceKindForOwnedAttachmentSource(
  sourceType: string,
): EliseRoomEvidenceKind | null {
  if (sourceType === 'dressing_room_item' || sourceType === 'owned_room_item') {
    return 'owned_room_item';
  }
  if (sourceType === 'shared_room_item') return 'shared_room_item';
  return null;
}

/**
 * Bounded fields safe to expose to the model from a room item snapshot.
 * Excludes purchase URLs by default (commerce may be summarized separately).
 */
export function sanitizeRoomItemEvidenceFields(input: {
  title?: unknown;
  brand?: unknown;
  category?: unknown;
  color?: unknown;
  silhouette?: unknown;
  purchaseOptionCount?: number;
}): Record<string, string | number | null> {
  const bound = (value: unknown, max = 60): string | null => {
    if (typeof value !== 'string') return null;
    const text = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, max) : null;
  };
  return {
    title: bound(input.title, 80),
    brand: bound(input.brand),
    category: bound(input.category),
    color: bound(input.color),
    silhouette: bound(input.silhouette),
    purchaseOptionCount:
      typeof input.purchaseOptionCount === 'number' && Number.isFinite(input.purchaseOptionCount)
        ? Math.max(0, Math.min(24, Math.floor(input.purchaseOptionCount)))
        : null,
  };
}
