export type SnapshotPayload = Record<string, unknown>;

export const DRESSING_ROOM_REACTION_TYPES = ['like', 'love', 'favorite', 'looking', 'thumbs_down'] as const;
export const ACTIVE_DRESSING_ROOM_REACTION_TYPES = ['like', 'love', 'looking', 'thumbs_down'] as const;

export type DressingRoomReactionType = typeof DRESSING_ROOM_REACTION_TYPES[number];
export type ActiveDressingRoomReactionType = typeof ACTIVE_DRESSING_ROOM_REACTION_TYPES[number];

export function isActiveDressingRoomReactionType(
  reactionType: DressingRoomReactionType | string,
): reactionType is ActiveDressingRoomReactionType {
  return (ACTIVE_DRESSING_ROOM_REACTION_TYPES as readonly string[]).includes(reactionType);
}

export interface ItemReactionCount {
  item_id: string;
  reaction_type: DressingRoomReactionType;
  count: number;
}

export type DressingRoom = {
  id: string;
  userId: string;
  title: string;
  description?: string | null;
  roomNote?: string | null;
  coverImageUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount?: number;
  coverFallbackUrl?: string | null;
};

export type DressingRoomItem = {
  id: string;
  dressingRoomId: string;
  sourceType?: string | null;
  sourceId?: string | null;
  snapshotVersion: number;
  snapshotPayload: SnapshotPayload;
  title?: string | null;
  imageUrl?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  brand?: string | null;
  category?: string | null;
  priceAmount?: string | null;
  currency?: string | null;
  productUrl?: string | null;
  notes?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

/** Look origin. Legacy rows have a NULL source and are treated as dressing_room. */
export type LookSource = 'dressing_room' | 'manual' | 'ai';

export type Look = {
  id: string;
  userId: string;
  dressingRoomId?: string | null;
  title: string;
  description?: string | null;
  coverImageUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount?: number;
  coverFallbackUrl?: string | null;
  dressingRoomTitle?: string | null;
  // AI Stylist expansion (all optional; legacy rows return null)
  source?: LookSource | null;
  occasion?: string | null;
  dressCode?: string | null;
  setting?: string | null;
  contextNote?: string | null;
  explanation?: string | null;
  promptVersion?: string | null;
  contractVersion?: string | null;
};

export type LookItemSourceType = 'dressing_room_item' | 'saved_scan' | 'inspiration_item';

export type LookItem = {
  id: string;
  lookId: string;
  sourceDressingRoomItemId?: string | null;
  snapshotVersion: number;
  snapshotPayload: SnapshotPayload;
  title?: string | null;
  imageUrl?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  brand?: string | null;
  category?: string | null;
  productUrl?: string | null;
  itemRole?: string | null;
  sortOrder: number;
  layoutPayload?: SnapshotPayload | null;
  createdAt: string;
  updatedAt: string;
  // AI Stylist expansion (legacy rows: null → dressing_room_item)
  sourceType?: LookItemSourceType | null;
  sourceSavedScanId?: string | null;
  sourceInspirationItemId?: string | null;
};

export type ProductMatchSnapshotSource = {
  id?: string | null;
  title?: string | null;
  name?: string | null;
  displayName?: string | null;
  product_name?: string | null;
  retailer?: string | null;
  brand?: string | null;
  price?: string | null;
  imageUrl?: string | null;
  // snake_case / alternate image aliases (mirror ProductShelf getProductImageUrl)
  image_url?: string | null;
  thumbnail?: string | null;
  thumbnailUrl?: string | null;
  image_src?: string | null;
  product_image_url?: string | null;
  imageCategory?: string | null;
  category?: string | null;
  canonical_category?: string | null;
  productUrl?: string | null;
  purchaseUrl?: string | null;
  affiliateUrl?: string | null;
  // snake_case / alternate link aliases (mirror ProductShelf getPurchaseUrl)
  product_url?: string | null;
  purchase_url?: string | null;
  url?: string | null;
  link?: string | null;
};

export type ScanImageSnapshotSource = {
  userId?: string | null;
  localImageUri?: string | null;
  sourceId?: string | null;
  sourceType?: 'live_scan' | 'style_library_scan' | 'upload_inspiration' | 'text-scan' | 'textScan' | null;
  createdAt?: string | null;
  result?: string | null;
  metadata?: {
    category?: string | null;
    color?: string | null;
    silhouette?: string | null;
    itemType?: string | null;
    brand?: string | null;
    size?: string | null;
  } | null;
};

export type InspirationItem = {
  id: string;
  userId: string;
  storageBucket: string;
  storagePath: string;
  source: 'upload';
  originalFilename?: string | null;
  contentType?: string | null;
  fileSizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  note?: string | null;
  imageUrl?: string | null;
  createdAt: string;
  deletedAt?: string | null;
};

export type DressingRoomInspirationLink = {
  id: string;
  roomId: string;
  inspirationId: string;
  userId: string;
  createdAt: string;
  deletedAt?: string | null;
  inspiration?: InspirationItem | null;
};

export type RoomDetail = {
  room: DressingRoom;
  items: DressingRoomItem[];
};

export type LookDetail = {
  look: Look;
  items: LookItem[];
};

// ── Outfit decisions (AI Stylist expansion) ───────────────────────────────────

export type OutfitDecisionStatus = 'open' | 'decided' | 'closed';

export type OutfitDecisionGroup = {
  id: string;
  dressingRoomId: string;
  createdBy?: string | null;
  title?: string | null;
  question: string;
  occasion?: string | null;
  status: OutfitDecisionStatus;
  chosenOptionId?: string | null;
  wearingConfirmedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OutfitDecisionOption = {
  id: string;
  groupId: string;
  sourceType: 'manual_look' | 'ai_suggestion';
  sourceLookId?: string | null;
  title?: string | null;
  explanation?: string | null;
  variation?: string | null;
  sortOrder: number;
  snapshotVersion: number;
  createdAt: string;
};

export type OutfitDecisionOptionItem = {
  id: string;
  optionId: string;
  sourceType?: string | null;
  itemRole?: string | null;
  sortOrder: number;
  snapshotVersion: number;
  snapshotPayload: SnapshotPayload;
  imageUrl?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  createdAt: string;
};

export type OutfitDecisionOptionWithItems = OutfitDecisionOption & {
  items: OutfitDecisionOptionItem[];
  voteCount?: number;
};

export type OutfitDecisionDetail = {
  group: OutfitDecisionGroup;
  options: OutfitDecisionOptionWithItems[];
  /** The current user's voted option id, when signed in and voted. */
  myVoteOptionId?: string | null;
};
