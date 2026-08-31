/**
 * K+ Smart Watchlist V1 client types.
 *
 * A Watch is an OFFER at ONE retailer, identified by its governed listing
 * URL -- never a product, never a variant (see the K5-C0 audit). Nothing
 * here carries a size, color, or variant field: the pipeline cannot
 * populate one, so this type does not pretend to have one.
 */

export type WatchIntent = 'just_watching' | 'buy_under';
export type WatchStatus = 'active' | 'paused' | 'deleted';
export type WatchLastStatus = 'unchecked' | 'available' | 'unavailable' | 'error';
export type WatchEventType =
  | 'price_decreased'
  | 'price_increased'
  | 'target_price_reached'
  | 'listing_unavailable'
  | 'listing_available_again';

export interface CommerceWatch {
  id: string;
  source: string;
  canonicalUrl: string;
  displayTitle: string;
  displayImageUrl: string | null;
  initialPriceAmount: number | null;
  currentPriceAmount: number | null;
  currency: string;
  watchIntent: WatchIntent;
  targetPriceAmount: number | null;
  targetReachedAt: string | null;
  status: WatchStatus;
  lastCheckedAt: string | null;
  lastStatus: WatchLastStatus;
  createdAt: string;
}

export interface CommerceWatchEvent {
  id: string;
  watchId: string;
  eventType: WatchEventType;
  priceAmount: number | null;
  currency: string | null;
  observedAt: string;
}

/** The minimum a commerce card must carry to be offered a Watch action. */
export interface WatchableListing {
  productUrl: string;
  title: string;
  price?: string;
  source: string;
  imageUrl?: string;
  type?: 'retail' | 'similar';
  commerceType?: 'retail' | 'resale';
  /** Server-authored (K5-C1). Only 'refreshable_listing' may be watched. */
  watchCapability?: 'refreshable_listing' | 'unsupported';
}

export function isWatchableListing(listing: WatchableListing | null | undefined): boolean {
  return listing?.watchCapability === 'refreshable_listing';
}
