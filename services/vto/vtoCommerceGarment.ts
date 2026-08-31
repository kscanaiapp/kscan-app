/**
 * The ONE place a commerce record becomes a VTO garment.
 *
 * VTO-REACH-001. `buildVtoGarmentFromProduct` used to live inside
 * components/ProductShelf.tsx, which is fine while ProductShelf is the only
 * surface offering Try It On -- and ProductShelf is NOT the shipped scan
 * surface. `eas.json` sets EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true in every
 * governed profile, so ScanResultV2 (via PurchaseOptionsPanel and
 * MultiItemCommerceSection) is what a person actually sees after a scan, and
 * nothing in components/scan-results/ renders ProductShelf.
 *
 * Reaching the live surface therefore needs this derivation in two places. The
 * answer is not two derivations: a garment built one way on one shelf and
 * another way on another is exactly how "Product A's try-on" quietly becomes
 * Product B's. So the logic moves here, to a pure module with no react-native
 * imports, and both callers delegate to it:
 *
 *   components/ProductShelf.tsx          (legacy shelf / Recent Scans reopen)
 *   components/scan-results/types.ts     (the live Scan Results V2 surface)
 *
 * This is a MOVE, not a rewrite. The field precedence below is the same
 * precedence ProductShelf already applied, including the persisted-URL scrub
 * and the destination selector, so a garment built from a given record is
 * byte-identical to what the legacy shelf built before this extraction.
 *
 * It reads existing commerce fields only. No measurement, no fit data, no body
 * inference, no new catalog surface, and no opinion about which retailer wins
 * -- ranking and destination selection are decided before this runs.
 */

import { selectCommerceDestination } from '../commerceDestination';
import { normalizePersistedCommerceUrl } from '../dressingRoomCommerce';
import type { VtoGarmentInput } from '../../types/vto';

/** Any commerce-shaped record: the backend `RankedScanProduct`, a persisted
 *  snapshot, or ProductShelf's `Product`. All three carry the same field
 *  vocabulary in different casings, which is why the readers below try each. */
export type VtoCommerceRecord = Record<string, unknown>;

function firstString(record: VtoCommerceRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Image precedence, unchanged from ProductShelf#getProductImageUrl, scrub included. */
export function vtoGarmentImageUrl(record: VtoCommerceRecord | null | undefined): string | null {
  if (!record) return null;
  for (const key of ['imageUrl', 'image_url', 'thumbnail', 'thumbnailUrl', 'image_src', 'product_image_url']) {
    const safeUrl = normalizePersistedCommerceUrl(record[key]);
    if (safeUrl) return safeUrl;
  }
  return null;
}

/**
 * Purchase URL, unchanged from ProductShelf#getPurchaseUrl.
 *
 * Order is deliberately not the selector: a record can hold a retailer link in
 * any of these keys and a search-engine page in any other, so the destination
 * itself decides. Each candidate keeps the persisted-URL scrub first.
 */
export function vtoGarmentPurchaseUrl(record: VtoCommerceRecord | null | undefined): string | null {
  if (!record) return null;
  return selectCommerceDestination(
    ['productUrl', 'purchaseUrl', 'affiliateUrl', 'product_url', 'purchase_url', 'url', 'link']
      .map((key) => normalizePersistedCommerceUrl(record[key])),
  );
}

/** Retailer precedence, unchanged from ProductShelf#getRetailer. */
export function vtoGarmentRetailer(record: VtoCommerceRecord | null | undefined): string | null {
  if (!record) return null;
  return firstString(record, ['retailer', 'brand', 'source', 'merchant', 'store']);
}

/**
 * Narrows a commerce record into the VTO garment contract.
 *
 * Returns null when there is no stable reference to anchor a request to -- a
 * try-on with no product identity is a try-on of nothing, and the caller
 * renders no entry point at all in that case.
 *
 * `productRef` is a correlation handle, never an authorization input: the
 * server re-derives eligibility and takes identity from the verified JWT.
 */
export function buildVtoGarmentFromCommerceRecord(
  record: VtoCommerceRecord | null | undefined,
): VtoGarmentInput | null {
  if (!record) return null;
  const imageUrl = vtoGarmentImageUrl(record);
  const productRef =
    (typeof record.id === 'string' && record.id.trim())
    || vtoGarmentPurchaseUrl(record)
    || imageUrl;
  if (!productRef) return null;
  return {
    productRef,
    imageUrl: imageUrl ?? '',
    category: String(record.category || record.imageCategory || '').trim(),
    brand:
      typeof record.brand === 'string' && record.brand.trim() ? record.brand.trim() : null,
    commerceSource: vtoGarmentRetailer(record),
  };
}
