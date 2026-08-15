// Unified owned-item styling contract (AI Stylist expansion).
//
// A single application-level shape for every "styleable owned item" regardless
// of where it is stored today:
//   - public.saved_scans        (cloud metadata rows for saved scans)
//   - public.inspiration_items  (cloud-backed inspiration uploads)
//   - local saved scans         (device-only rows from kscan_library manifest)
//
// This is a read contract used by the manual Look builder, AI Stylist flows,
// and Look/Dressing Room snapshot creation. It never replaces the underlying
// tables and never invents remote identity: local-only scans are explicitly
// marked as not remote-backed and are unusable for server persistence until
// the existing saved-scan cloud-sync path has produced a stable remote row.

export const OWNED_ITEM_CONTRACT_VERSION = 1;

export const OWNED_ITEM_SOURCE_TYPES = ['saved_scan', 'inspiration_item'] as const;
export type OwnedItemSourceType = (typeof OWNED_ITEM_SOURCE_TYPES)[number];

/** DR-2 Dressing Room attachment source (stable UUID only; never ownership claims). */
export const DRESSING_ROOM_ITEM_SOURCE_TYPE = 'dressing_room_item' as const;
export type DressingRoomItemSourceType = typeof DRESSING_ROOM_ITEM_SOURCE_TYPE;

/** DR-2 shared room attachment source (stable UUID only). */
export const SHARED_ROOM_ITEM_SOURCE_TYPE = 'shared_room_item' as const;
export type SharedRoomItemSourceType = typeof SHARED_ROOM_ITEM_SOURCE_TYPE;

export type StyleChatItemSourceType =
  | OwnedItemSourceType
  | DressingRoomItemSourceType
  | SharedRoomItemSourceType;

/**
 * A single separable brand observation, mirrored from the durable
 * identification snapshot (`IdentificationBrandEvidence`). Redeclared here
 * rather than imported so the owned-item contract stays a leaf type with no
 * dependency on the services layer.
 */
export type OwnedItemBrandEvidence = {
  type: string;
  value?: string | null;
  confidence?: number | null;
};

/** Which layer supplied a canonical field. */
export type OwnedItemFieldProvenance =
  | 'identification_snapshot_v2'
  | 'identification_snapshot_v1'
  | 'legacy_metadata'
  | 'absent';

export type OwnedItemMetadataProvenance = {
  category: OwnedItemFieldProvenance;
  subcategory: OwnedItemFieldProvenance;
  color: OwnedItemFieldProvenance;
  material: OwnedItemFieldProvenance;
  pattern: OwnedItemFieldProvenance;
  silhouette: OwnedItemFieldProvenance;
  fit: OwnedItemFieldProvenance;
  brand: OwnedItemFieldProvenance;
};

/** Every field absent — the honest default for a record with no metadata. */
export const ABSENT_ITEM_METADATA_PROVENANCE: OwnedItemMetadataProvenance = {
  category: 'absent',
  subcategory: 'absent',
  color: 'absent',
  material: 'absent',
  pattern: 'absent',
  silhouette: 'absent',
  fit: 'absent',
  brand: 'absent',
};

/** Reference to an owned item that the server can independently verify. */
export type OwnedItemRef = {
  sourceType: OwnedItemSourceType;
  sourceId: string;
};

export type OwnedClosetItem = {
  /** Which underlying record backs this item. */
  sourceType: OwnedItemSourceType;
  /**
   * Remote UUID of the backing row when one exists. Local-only saved scans
   * have sourceId = null until cloud sync succeeds; a local id is NEVER
   * placed here because local ids are not server-verifiable UUIDs.
   */
  sourceId: string | null;
  /** Device-local id (saved-scan manifest id) when known. */
  localId: string | null;
  title: string;
  /** Display image: signed URL, remote URL, or local file URI. */
  imageUri: string | null;
  /** Private storage reference when the image lives in Supabase storage. */
  storageBucket: string | null;
  storagePath: string | null;
  category: string | null;
  subcategory: string | null;
  color: string | null;
  pattern: string | null;
  material: string | null;
  silhouette: string | null;
  fit: string | null;
  brand: string | null;
  /**
   * Separable brand observations from the durable identification snapshot
   * (Closet V2 / S2). Empty for legacy rows and for rows whose snapshot never
   * recorded one.
   *
   * Kept alongside `brand` rather than folded into it on purpose: a
   * `brand_guess` and an observed `visible_brand_text` are different claims,
   * and collapsing them turns a guess into an assertion. Consumers that need
   * a display string may use `brand`; it is null unless the adapter has an
   * authoritative observed-brand source.
   */
  brandEvidence: OwnedItemBrandEvidence[];
  /**
   * Which layer answered each canonical field — the identification snapshot,
   * the legacy metadata projection, or nothing. Lets a consumer distinguish
   * "this garment has no pattern" from "pattern was never captured".
   */
  metadataProvenance: OwnedItemMetadataProvenance;
  styleTags: string[];
  /** Normalized attribute bag for forward compatibility (bounded, no blobs). */
  normalizedAttributes: Record<string, string>;
  /** Source bookkeeping (savedAt / note / scanType), display-safe only. */
  sourceMetadata: Record<string, string | null>;
  /** True when the backing record is soft-deleted or otherwise unavailable. */
  unavailable: boolean;
  /** True when a stable remote row exists (sourceId is a real UUID). */
  remoteBacked: boolean;
  /**
   * Remote media backing state for saved scans (Phase 2). null = never
   * requested (legacy local-only media). Remote-media-backed means status
   * 'ready' AND a private storage reference exists.
   */
  mediaStatus?: 'pending' | 'ready' | 'failed' | null;
  /**
   * True when the item carries enough structured metadata to participate in
   * AI outfit generation. Inspiration uploads have no garment metadata today
   * and are manual-builder-only until categorization exists.
   */
  aiEligible: boolean;
  contractVersion: typeof OWNED_ITEM_CONTRACT_VERSION;
};

export function isOwnedItemSourceType(value: unknown): value is OwnedItemSourceType {
  return (
    typeof value === 'string' &&
    (OWNED_ITEM_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

/** Stable key for selection state across mixed local/remote items. */
export function ownedItemKey(item: Pick<OwnedClosetItem, 'sourceType' | 'sourceId' | 'localId'>): string {
  if (item.sourceId) return `${item.sourceType}:${item.sourceId}`;
  return `${item.sourceType}:local:${item.localId ?? 'unknown'}`;
}
