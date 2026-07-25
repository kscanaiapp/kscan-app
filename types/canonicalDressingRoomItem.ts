/**
 * DR-1 canonical Dressing Room item contract (typed).
 * One contract across Scanner → Closet → Room → Shared → Elise → commerce.
 * Persistence prefers existing snapshot_payload; signed URLs are never identity.
 */

export const CANONICAL_DRESSING_ROOM_ITEM_SCHEMA_VERSION = 1 as const;

export type CanonicalItemSourceKind =
  | 'scanner_single'
  | 'scanner_selected_item'
  | 'scanner_multi_item'
  | 'textscan'
  | 'saved_scan'
  | 'closet_item'
  | 'catalog_product'
  | 'inspiration_item'
  | 'dressing_room_item'
  | 'shared_room_item'
  | 'product_match'
  | 'scan_image'
  | 'live_scan'
  | 'style_library_scan'
  | 'upload_inspiration';

export type CanonicalPurchaseOption = {
  title: string | null;
  retailer: string | null;
  price: string | null;
  currency: string | null;
  productUrl: string | null;
  affiliateUrl: string | null;
  imageUrl: string | null;
  availability: string | null;
  size: string | null;
  variant: string | null;
  matchScore: number | null;
  confidence: number | null;
  provider: string | null;
  productId: string | null;
};

export type CanonicalItemImage = {
  kind: 'storage' | 'remote' | 'local' | 'none';
  storageBucket?: string | null;
  storagePath?: string | null;
  remoteUrl?: string | null;
  localUri?: string | null;
  thumbnailUri?: string | null;
  digest?: string | null;
};

export type CanonicalItemSource = {
  kind: CanonicalItemSourceKind;
  scanId?: string | null;
  scanSessionId?: string | null;
  selectedItemId?: string | null;
  savedScanId?: string | null;
  closetItemId?: string | null;
  inspirationItemId?: string | null;
  providerProductId?: string | null;
  backendVersion?: string | null;
  creationSource?: string | null;
};

export type CanonicalItemFashion = {
  category?: string | null;
  itemType?: string | null;
  material?: string | null;
  brand?: string | null;
  brandCertainty?: string | number | null;
  colors?: string[] | null;
  silhouette?: string | null;
  style?: string | null;
  description?: string | null;
  qualityBand?: string | null;
  categoryRoute?: string | null;
};

export type CanonicalDressingRoomItem = {
  schemaVersion: typeof CANONICAL_DRESSING_ROOM_ITEM_SCHEMA_VERSION;
  source: CanonicalItemSource;
  fashion: CanonicalItemFashion;
  image: CanonicalItemImage;
  commerce: {
    purchaseOptions: CanonicalPurchaseOption[];
  };
  ownership: {
    /** Never trusted from client for authorization; may be recorded for audit. */
    ownerUserId?: string | null;
  };
  dedupe: {
    key?: string | null;
    strategy?: string | null;
  };
};

/** Bounded payload fragment written into snapshot_payload when flags allow. */
export type CanonicalSnapshotExtension = {
  schemaVersion: typeof CANONICAL_DRESSING_ROOM_ITEM_SCHEMA_VERSION;
  source: CanonicalItemSource;
  purchaseOptions?: CanonicalPurchaseOption[];
  dedupeKey?: string | null;
  dedupeStrategy?: string | null;
};
