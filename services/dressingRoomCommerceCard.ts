/**
 * Display-ready commerce facts for one Dressing Room item.
 *
 * A product shared into a room used to render as a bare image and a title: the
 * price, the retailer and the link were all persisted on the row and on the
 * canonical snapshot, and none of them reached the screen. This module is the
 * single place those facts are derived, so the room, the detail sheet and any
 * later surface all read the same answer.
 *
 * PRODUCT IDENTITY IS THE INVARIANT. Every field below comes from THIS item's
 * own persisted columns or from THIS item's own snapshot payload. Nothing is
 * inferred from ambient state, from a sibling item, or from a live provider
 * lookup, so a card for Product A can only ever describe Product A -- a stale
 * index or a late response has nothing to bind to here.
 *
 * URLs are normalized through normalizePersistedCommerceUrl (https only, no
 * embedded credentials, no signed-object or token-bearing links), which is the
 * same guard the persistence path uses. A link that fails it is reported as
 * absent rather than rendered as a dead or unsafe control.
 */

import {
  collectRawPurchaseOptions,
  formatCommercePrice,
  normalizePersistedCommerceUrl,
  normalizePurchaseOptions,
} from './dressingRoomCommerce';
import type { CanonicalPurchaseOption } from '../types/canonicalDressingRoomItem';
import type { DressingRoomItem, LookItem } from '../types/styleObjects';

/**
 * The commerce-bearing fields shared by a room item and a Look item. Declared
 * structurally so a Look built from a room keeps the same card without a cast:
 * LookItem carries brand/productUrl/snapshotPayload but no price columns, and
 * the resolver already treats an absent field as "not recorded".
 */
export type RoomCommerceSource = Pick<DressingRoomItem, 'snapshotPayload'> &
  Partial<Pick<DressingRoomItem, 'brand' | 'priceAmount' | 'currency' | 'productUrl'>>;

export type RoomCommerceCard = {
  /** True when there is at least one commerce fact worth showing. */
  hasCommerce: boolean;
  /** Formatted, currency-correct price, e.g. "$248.00". Never a bare number. */
  priceLabel: string | null;
  /** Where it is sold, when the snapshot actually recorded a retailer. */
  retailer: string | null;
  /** The item's own brand, which is not the same claim as a retailer. */
  brand: string | null;
  /** A safe https destination, or null when there is nothing safe to open. */
  productUrl: string | null;
  /** Host shown next to the link so the destination is never a mystery. */
  productUrlHost: string | null;
  /** Purchase options carried by this item's own snapshot, already normalized. */
  purchaseOptions: CanonicalPurchaseOption[];
};

const EMPTY_CARD: RoomCommerceCard = {
  hasCommerce: false,
  priceLabel: null,
  retailer: null,
  brand: null,
  productUrl: null,
  productUrlHost: null,
  purchaseOptions: [],
};

function cleanLabel(value: unknown, max = 80): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

/**
 * The display host for a link, so a card never shows a friendly label over an
 * unrelated destination. Returns null rather than guessing.
 */
export function commerceUrlHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    return host || null;
  } catch {
    return null;
  }
}

export function resolveRoomCommerceCard(
  item: RoomCommerceSource | DressingRoomItem | LookItem | null | undefined,
): RoomCommerceCard {
  if (!item) return { ...EMPTY_CARD };

  const payload = (item.snapshotPayload || {}) as Record<string, unknown>;
  // Purchase options live either directly on the canonical snapshot extension
  // or inside one of the known scanner/catalog alias bags. Both are this item's
  // own payload; neither reaches outside it.
  const rawOptions = Array.isArray((payload as { purchaseOptions?: unknown }).purchaseOptions)
    ? (payload as { purchaseOptions?: unknown }).purchaseOptions
    : collectRawPurchaseOptions(payload);
  const purchaseOptions = normalizePurchaseOptions(rawOptions);
  const primary = purchaseOptions[0] ?? null;

  // Persisted columns first: they were written when the item was added and are
  // the row's own record of what was shared. A purchase option is the fallback.
  const priceAmount = (item as Partial<DressingRoomItem>).priceAmount ?? null;
  const currency = (item as Partial<DressingRoomItem>).currency ?? null;
  const priceLabel =
    formatCommercePrice(priceAmount, currency) ??
    (primary ? formatCommercePrice(primary.price, primary.currency) : null);

  const brand = cleanLabel(item.brand);
  // Retailer is only claimed when the snapshot recorded one. normalizePurchase
  // Options falls back to brand for that field, so a retailer identical to the
  // brand is reported as brand alone rather than asserting a storefront.
  const optionRetailer = cleanLabel(primary?.retailer);
  const retailer =
    optionRetailer && optionRetailer.toLowerCase() !== (brand ?? '').toLowerCase()
      ? optionRetailer
      : null;

  const productUrl =
    normalizePersistedCommerceUrl(item.productUrl) ??
    (primary
      ? normalizePersistedCommerceUrl(primary.productUrl) ??
        normalizePersistedCommerceUrl(primary.affiliateUrl)
      : null);

  return {
    hasCommerce: Boolean(priceLabel || retailer || productUrl),
    priceLabel,
    retailer,
    brand,
    productUrl,
    productUrlHost: commerceUrlHost(productUrl),
    purchaseOptions,
  };
}
