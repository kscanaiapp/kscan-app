/**
 * Free Tier Utility Expansion — local-to-remote mapper.
 *
 * Maps device-local free-tier data shapes to the proposed remote table
 * shapes defined in freeTierSyncTypes.ts. These mappers are pure, defensive,
 * and do not mutate inputs. They are used only when optional backend sync
 * flags are enabled.
 */

import type {
  NormalizedItem,
  BrandSizingEntry,
  OutfitFeedbackEntry,
  CareNoteEntry,
  WishlistIntentEntry,
  OutfitCollection,
  WearTrackingEntry,
  ActivityEvent,
} from './wardrobeUtilityTypes';
import type {
  FreeTierRemoteUtilityItem,
  FreeTierRemoteBrandSizingNote,
  FreeTierRemoteOutfitFeedback,
  FreeTierRemoteCareNote,
  FreeTierRemoteWishlistIntent,
  FreeTierRemoteCollection,
  FreeTierRemoteCollectionItem,
  FreeTierRemoteWearEvent,
  FreeTierRemoteActivityLog,
} from './freeTierSyncTypes';

function safeIso(date?: string | Date | null): string | undefined {
  if (!date) return undefined;
  try {
    const d = typeof date === 'string' ? new Date(date) : date;
    if (Number.isNaN(d.getTime())) return undefined;
    return d.toISOString();
  } catch {
    return undefined;
  }
}

function safeArray<T>(value: T[] | null | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value;
}

function safeString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeBoolean(value: boolean | null | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function clientId(prefix: string, localId?: string): string | undefined {
  return localId ? `${prefix}:${localId}` : undefined;
}

function stripRawImageUri(uri?: string): string | undefined {
  // Only allow app-managed image URIs; reject data URIs and file paths
  // that could contain raw image bytes or sensitive local paths.
  if (!uri) return undefined;
  if (uri.startsWith('data:')) return undefined;
  if (uri.startsWith('file://')) return undefined;
  if (uri.startsWith('content://')) return undefined;
  return uri;
}

// ── Utility item ─────────────────────────────────────────────────────────────

export function mapNormalizedItemToRemote(
  item: NormalizedItem,
  options?: { clientId?: string }
): FreeTierRemoteUtilityItem {
  return {
    client_id: options?.clientId ?? clientId('item', item.id),
    source_item_id: item.id ?? 'unknown',
    source_type: item.source ?? 'unknown',
    title: safeString(item.title),
    brand: safeString(item.brand),
    category: safeString(item.category),
    color: safeString(item.color),
    material: safeString(item.material),
    silhouette: safeString(item.silhouette),
    season_tags: safeArray(item.seasonTags),
    occasion_tags: safeArray(item.occasionTags),
    style_tags: safeArray(item.styleTags),
    image_uri: stripRawImageUri(item.imageUri),
    price_estimate: safeNumber(item.priceEstimate),
    metadata: {
      savedAt: safeIso(item.savedAt),
    },
  };
}

// ── Brand sizing memory ──────────────────────────────────────────────────────

export function mapBrandSizingEntryToRemote(
  entry: BrandSizingEntry,
  options?: { clientId?: string }
): FreeTierRemoteBrandSizingNote {
  return {
    client_id: options?.clientId ?? clientId('sizing', entry.brand),
    brand: entry.brand ?? 'unknown',
    usual_size: safeString(entry.usualSize),
    fit_note: safeString(entry.fitNote),
    runs_small: safeBoolean(entry.runsSmall),
    runs_large: safeBoolean(entry.runsLarge),
    metadata: {
      localUpdatedAt: safeIso(entry.lastUpdatedAt),
    },
  };
}

// ── Outfit feedback ──────────────────────────────────────────────────────────

export function mapOutfitFeedbackEntryToRemote(
  entry: OutfitFeedbackEntry,
  options?: { clientId?: string }
): FreeTierRemoteOutfitFeedback {
  return {
    client_id: options?.clientId ?? clientId('feedback', entry.targetId),
    target_id: entry.targetId ?? 'unknown',
    target_type: 'outfit',
    rating: safeNumber(entry.rating),
    tags: safeArray(entry.tags),
    metadata: {
      localUpdatedAt: safeIso(entry.updatedAt),
    },
  };
}

// ── Care notes ───────────────────────────────────────────────────────────────

export function mapCareNoteEntryToRemote(
  entry: CareNoteEntry,
  options?: { clientId?: string }
): FreeTierRemoteCareNote {
  return {
    client_id: options?.clientId ?? clientId('care', entry.itemId),
    source_item_id: entry.itemId ?? 'unknown',
    tags: safeArray(entry.tags),
    note: safeString(entry.note),
    metadata: {
      localUpdatedAt: safeIso(entry.updatedAt),
    },
  };
}

// ── Wishlist intent ──────────────────────────────────────────────────────────

export function mapWishlistIntentEntryToRemote(
  entry: WishlistIntentEntry,
  options?: { clientId?: string }
): FreeTierRemoteWishlistIntent {
  return {
    client_id: options?.clientId ?? clientId('wishlist', entry.itemId),
    source_item_id: entry.itemId ?? 'unknown',
    intent: entry.intent ?? 'unknown',
    title_snapshot: safeString(entry.titleSnapshot),
    metadata: {
      localUpdatedAt: safeIso(entry.updatedAt),
    },
  };
}

// ── Collections ──────────────────────────────────────────────────────────────

export function mapOutfitCollectionToRemote(
  collection: OutfitCollection,
  options?: { clientId?: string }
): FreeTierRemoteCollection {
  return {
    client_id: options?.clientId ?? clientId('collection', collection.id),
    name: collection.name ?? 'Untitled',
    cover_item_id: safeString(collection.coverItemId),
    metadata: {
      localCreatedAt: safeIso(collection.createdAt),
      localUpdatedAt: safeIso(collection.updatedAt),
    },
  };
}

export function mapOutfitCollectionItemsToRemote(
  collection: OutfitCollection
): FreeTierRemoteCollectionItem[] {
  const collectionId = collection.id ?? 'unknown';
  return (collection.itemIds ?? []).map((itemId, index) => ({
    client_id: clientId('collection-item', `${collectionId}:${itemId}`),
    collection_id: collectionId,
    source_item_id: itemId,
    source_type: 'unknown',
    sort_order: index,
    metadata: {},
  }));
}

// ── Wear events / cost per wear ──────────────────────────────────────────────

export function mapWearTrackingEntryToRemoteWearEvent(
  entry: WearTrackingEntry,
  options?: { clientId?: string; wornAt?: string }
): FreeTierRemoteWearEvent {
  return {
    client_id: options?.clientId ?? clientId('wear', entry.itemId),
    source_item_id: entry.itemId ?? 'unknown',
    worn_at: safeIso(options?.wornAt) ?? safeIso(entry.lastWornAt) ?? safeIso(entry.updatedAt),
    estimated_price: safeNumber(entry.estimatedPrice),
    metadata: {
      localWearCount: safeNumber(entry.wearCount),
      localUpdatedAt: safeIso(entry.updatedAt),
    },
  };
}

// ── Activity log ─────────────────────────────────────────────────────────────

export function mapActivityEventToRemote(
  event: ActivityEvent,
  options?: { clientId?: string; sourceItemId?: string }
): FreeTierRemoteActivityLog {
  return {
    client_id: options?.clientId ?? clientId('activity', event.id),
    event_type: event.type ?? 'unknown',
    label: event.label ?? '',
    source_item_id: safeString(options?.sourceItemId),
    metadata: {
      localCreatedAt: safeIso(event.createdAt),
    },
  };
}

// ── Partial input helpers (defensive) ────────────────────────────────────────

export function mapPartialNormalizedItemToRemote(
  item: Partial<NormalizedItem>
): FreeTierRemoteUtilityItem {
  return mapNormalizedItemToRemote({
    id: item.id ?? 'unknown',
    title: item.title,
    brand: item.brand,
    category: item.category,
    color: item.color,
    material: item.material,
    silhouette: item.silhouette,
    seasonTags: item.seasonTags,
    occasionTags: item.occasionTags,
    styleTags: item.styleTags,
    imageUri: item.imageUri,
    priceEstimate: item.priceEstimate,
    savedAt: item.savedAt,
    source: item.source,
  });
}
