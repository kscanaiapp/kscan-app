// stylechat-generate v2 — attachment ownership provenance.
//
// Ownership language for an attached item MUST be derived from the resolved
// row provenance, never from the attachment envelope (attachmentType) alone.
// A photo the client wraps as `owned_item`/`saved_scan` may be a screenshot,
// a camera shot of a garment the user does not own, or a genuine wardrobe
// piece — the envelope cannot tell them apart, so it must not drive ownership.
//
// This mirrors the doctrine already encoded in eliseWardrobeRetrieval.ts
// (roomItemRelationship): "source provenance ≠ actor relationship ≠ physical
// ownership ≠ room ownership". Only explicit owned-closet provenance yields
// 'owned'; presence in the user's own room does NOT. Kept as a separate,
// dependency-free module so attachmentContext.ts stays pure and Node-testable.

import type { EliseActorRelationship } from './eliseAdviceTypes.ts';

// Dressing-room source kinds → actor relationship. Mirrors the sets in
// eliseWardrobeRetrieval.roomItemRelationship; attachmentOwnership.test.ts
// asserts the two classifiers agree so they cannot silently drift.
const DISCOVERED_ROOM_SOURCE_KINDS = new Set([
  'catalog_product',
  'product_match',
  'commerce_product',
]);
const SCANNED_ROOM_SOURCE_KINDS = new Set([
  'scan_image',
  'live_scan',
  'scanned_item',
  'scanner',
  'outfit_scan',
]);
const SAVED_ROOM_SOURCE_KINDS = new Set([
  'inspiration',
  'inspiration_item',
  'saved_scan',
  'closet_item',
  'upload_inspiration',
]);
const OWNED_ROOM_SOURCE_KINDS = new Set(['owned_closet', 'physically_owned']);

/** Reads the canonical source kind from a dressing_room_items row. */
function roomSourceKind(row: Record<string, unknown>): string | null {
  const payload =
    row.snapshot_payload && typeof row.snapshot_payload === 'object' && !Array.isArray(row.snapshot_payload)
      ? (row.snapshot_payload as Record<string, unknown>)
      : {};
  const canonical =
    payload.canonical && typeof payload.canonical === 'object' && !Array.isArray(payload.canonical)
      ? (payload.canonical as Record<string, unknown>)
      : null;
  const canonicalSource =
    canonical && canonical.source && typeof canonical.source === 'object' && !Array.isArray(canonical.source)
      ? (canonical.source as Record<string, unknown>)
      : null;
  const canonicalKind = typeof canonicalSource?.kind === 'string' ? canonicalSource.kind : null;
  const legacyKind = typeof row.source_type === 'string' ? row.source_type : null;
  return (canonicalKind ?? legacyKind)?.toLowerCase() ?? null;
}

/**
 * Actor relationship for an OWNED dressing-room row, derived from its item
 * provenance — not from the fact that the room belongs to the actor. Presence
 * in the user's own room is deliberately NOT treated as physical ownership.
 */
export function relationshipForDressingRoomRow(row: Record<string, unknown>): EliseActorRelationship {
  const kind = roomSourceKind(row);
  if (kind && DISCOVERED_ROOM_SOURCE_KINDS.has(kind)) return 'saved';
  if (kind && SCANNED_ROOM_SOURCE_KINDS.has(kind)) return 'scanned';
  if (kind && SAVED_ROOM_SOURCE_KINDS.has(kind)) return 'saved';
  if (kind && OWNED_ROOM_SOURCE_KINDS.has(kind)) return 'owned';
  return 'unverified';
}

/** Actor relationship for a legacy Look item, derived from its source ref. */
export function relationshipForLookItem(row: Record<string, unknown>): EliseActorRelationship {
  if (row.source_saved_scan_id) return 'scanned';
  if (row.source_inspiration_item_id) return 'saved';
  return 'unverified';
}

/**
 * One-word note the model MUST use as the authority for any ownership claim.
 * Kept terse and machine-stable; the prompt maps each value to allowed
 * language. Never says "owned" for anything but an explicit 'owned' relationship.
 */
export function attachmentOwnershipNote(relationship: EliseActorRelationship): string {
  switch (relationship) {
    case 'owned':
      return 'owned';
    case 'saved':
      return 'saved_not_owned';
    case 'scanned':
      return 'scanned_ownership_unconfirmed';
    case 'shared':
      return 'shared_not_owned';
    case 'discovered':
      return 'available_not_owned';
    case 'unverified':
    case 'unknown':
    default:
      return 'ownership_unconfirmed';
  }
}
