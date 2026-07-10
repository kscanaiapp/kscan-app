/**
 * Free Tier Utility Expansion — optional backend sync type contracts.
 *
 * These types describe the proposed remote table shapes and the sync
 * orchestration result types. They are used by the mapper and the optional
 * Supabase sync service. Local free-tier features do not depend on these.
 */

export type FreeTierSyncEntityName =
  | 'utility_item'
  | 'brand_sizing_note'
  | 'outfit_feedback'
  | 'care_note'
  | 'wishlist_intent'
  | 'collection'
  | 'collection_item'
  | 'wear_event'
  | 'activity_log';

export type FreeTierSyncOperation = 'upsert' | 'delete';

export type FreeTierSyncDirection = 'push' | 'pull';

export interface FreeTierSyncStatus {
  enabled: boolean;
  authenticated: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  queueEnabled: boolean;
  pendingWrites: number;
  lastSyncAt?: string;
  lastError?: string;
}

export interface FreeTierSyncError {
  code: string;
  message: string;
  entity?: FreeTierSyncEntityName;
  operation?: FreeTierSyncOperation;
}

export interface FreeTierSyncResult {
  success: boolean;
  entity: FreeTierSyncEntityName;
  operation: FreeTierSyncOperation;
  direction: FreeTierSyncDirection;
  recordsAffected: number;
  error?: FreeTierSyncError;
}

// ── Remote table row shapes (proposed) ───────────────────────────────────────

export interface FreeTierRemoteUtilityItem {
  id?: string;
  user_id?: string;
  client_id?: string;
  source_item_id: string;
  source_type?: 'scan' | 'library' | 'product' | 'manual' | 'unknown';
  title?: string;
  brand?: string;
  category?: string;
  color?: string;
  material?: string;
  silhouette?: string;
  season_tags?: string[];
  occasion_tags?: string[];
  style_tags?: string[];
  image_uri?: string;
  price_estimate?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface FreeTierRemoteBrandSizingNote {
  id?: string;
  user_id?: string;
  client_id?: string;
  brand: string;
  usual_size?: string;
  fit_note?: string;
  runs_small?: boolean;
  runs_large?: boolean;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface FreeTierRemoteOutfitFeedback {
  id?: string;
  user_id?: string;
  client_id?: string;
  target_id: string;
  target_type?: 'outfit' | 'item';
  rating?: number;
  tags?: string[];
  note?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface FreeTierRemoteCareNote {
  id?: string;
  user_id?: string;
  client_id?: string;
  source_item_id: string;
  tags?: string[];
  note?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface FreeTierRemoteWishlistIntent {
  id?: string;
  user_id?: string;
  client_id?: string;
  source_item_id: string;
  intent: string;
  title_snapshot?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface FreeTierRemoteCollection {
  id?: string;
  user_id?: string;
  client_id?: string;
  name: string;
  cover_item_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface FreeTierRemoteCollectionItem {
  id?: string;
  user_id?: string;
  collection_id: string;
  client_id?: string;
  source_item_id: string;
  source_type?: 'scan' | 'library' | 'product' | 'manual' | 'unknown';
  sort_order?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface FreeTierRemoteWearEvent {
  id?: string;
  user_id?: string;
  client_id?: string;
  source_item_id: string;
  worn_at?: string;
  estimated_price?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface FreeTierRemoteActivityLog {
  id?: string;
  user_id?: string;
  client_id?: string;
  event_type: string;
  label: string;
  source_item_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}
