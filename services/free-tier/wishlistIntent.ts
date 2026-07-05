/**
 * Free Tier Utility Expansion — wishlist / shopping intent (local only).
 * Captures intent without commerce: no price tracking, no retailer
 * integrations, no availability claims.
 */

import {
  FREE_TIER_STORAGE_KEYS,
  type WishlistIntentEntry,
  type WishlistIntentKind,
} from './wardrobeUtilityTypes';
import { readStore, updateStore } from './freeTierStorage';

type IntentMap = Record<string, WishlistIntentEntry>;
const KEY = FREE_TIER_STORAGE_KEYS.wishlistIntent;

export const WISHLIST_INTENT_LABELS: Record<WishlistIntentKind, string> = {
  want_similar: 'Want similar',
  wishlist: 'Save to wishlist',
  not_interested: 'Not interested',
  own_it: 'Already own this',
  compare_later: 'Compare later',
};

export async function loadWishlistIntent(): Promise<IntentMap> {
  return readStore<IntentMap>(KEY, {});
}

export async function setWishlistIntent(
  itemId: string,
  intent: WishlistIntentKind,
  titleSnapshot?: string,
  userId?: string
): Promise<IntentMap> {
  if (!itemId) return loadWishlistIntent();
  return updateStore<IntentMap>(
    KEY,
    {},
    (current) => ({
      ...current,
      [itemId]: {
        itemId,
        intent,
        titleSnapshot: titleSnapshot ? titleSnapshot.slice(0, 120) : undefined,
        updatedAt: new Date().toISOString(),
      },
    }),
    userId
  );
}

export async function clearWishlistIntent(itemId: string, userId?: string): Promise<IntentMap> {
  return updateStore<IntentMap>(
    KEY,
    {},
    (current) => {
      if (!current[itemId]) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    },
    userId
  );
}
