export type SnapshotPayload = Record<string, unknown>;

export const DRESSING_ROOM_REACTION_TYPES = ['like', 'love', 'favorite', 'looking'] as const;

export type DressingRoomReactionType = typeof DRESSING_ROOM_REACTION_TYPES[number];

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
};

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
};

export type ProductMatchSnapshotSource = {
  id?: string | null;
  title?: string | null;
  name?: string | null;
  retailer?: string | null;
  price?: string | null;
  imageUrl?: string | null;
  imageCategory?: string | null;
  productUrl?: string | null;
  purchaseUrl?: string | null;
  affiliateUrl?: string | null;
};

export type ScanImageSnapshotSource = {
  userId?: string | null;
  localImageUri?: string | null;
  sourceId?: string | null;
  sourceType?: 'live_scan' | 'style_library_scan';
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

export type RoomDetail = {
  room: DressingRoom;
  items: DressingRoomItem[];
};

export type LookDetail = {
  look: Look;
  items: LookItem[];
};
