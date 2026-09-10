/**
 * Commerce V2 retailer identity resolver (Build 35 §14-§16).
 *
 * The one Commerce-owned function that turns a raw offer's fields into a
 * truthful retailer identity. Every existing commerce surface's own retailer
 * derivation (ProductShelf's `getRetailer`, `mapRawProductToPurchaseOption`,
 * `normalizePurchaseOptions`, Watchlist) is a hand-rolled variant of this
 * same decision; this module is meant to become their one shared authority
 * as each surface adopts it (Build 35 §21), not a second parallel resolver.
 *
 * Absolute rule (§12-13): `brand` is NEVER a retailer candidate. A
 * manufacturer is not who is selling the item.
 */

import { isAggregatorDestination, isSafeCommerceUrl } from '../commerceDestination.ts';
import {
  findRetailerByDeclaredName,
  findRetailerByDomain,
  type CommerceClassification,
} from './retailerRegistry.ts';

export type RetailerSourceAuthority = 'declared' | 'domain' | 'unknown';

export interface RetailerIdentity {
  /** Registry key, or null when the retailer is not in the committed registry. */
  retailerKey: string | null;
  /** Best-known display name, or null when nothing truthful is known. */
  displayName: string | null;
  /** Logo asset reference, or null (monogram/text fallback -- Build 35 §20). */
  logoAsset: string | null;
  /** Fallback monogram character, only present when `retailerKey` resolved
   * against the registry. Null for a declared-but-unregistered name or an
   * unknown retailer -- there is nothing truthful to abbreviate. */
  fallbackMonogram: string | null;
  /** Retail vs. resale, only when the registry or the offer itself states it. */
  commerceType: CommerceClassification | null;
  /** How this identity was derived. Never influences ranking (§80). */
  sourceAuthority: RetailerSourceAuthority;
}

const UNKNOWN_IDENTITY: RetailerIdentity = Object.freeze({
  retailerKey: null,
  displayName: null,
  logoAsset: null,
  fallbackMonogram: null,
  commerceType: null,
  sourceAuthority: 'unknown',
});

/** The fields `resolveRetailerIdentity` reads. `brand` is deliberately absent. */
export interface RetailerIdentityInput {
  retailer?: unknown;
  source?: unknown;
  merchant?: unknown;
  store?: unknown;
  productUrl?: unknown;
  commerceType?: unknown;
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function offerCommerceType(offer: RetailerIdentityInput): CommerceClassification | null {
  return offer.commerceType === 'retail' || offer.commerceType === 'resale' ? offer.commerceType : null;
}

/**
 * Resolves the truthful retailer identity for one offer.
 *
 * Priority (§14-16):
 *   1. An explicit seller-authoritative field (`retailer`, `source`,
 *      `merchant`, `store` -- checked in that order, never `brand`),
 *      matched against the registry when possible. A declared name with no
 *      registry match is still returned as-is (real, just unregistered) --
 *      never dropped, never replaced with a guess.
 *   2. A domain fallback, only when there is no declared field AND the
 *      offer's purchase URL is a safe, non-aggregator merchant destination
 *      AND its hostname is in the committed registry. An unmapped hostname
 *      never becomes a fabricated retailer name (§16).
 *   3. Unknown -- no retailer field is fabricated (§70, §76).
 */
export function resolveRetailerIdentity(offer: RetailerIdentityInput | null | undefined): RetailerIdentity {
  if (!offer || typeof offer !== 'object') return UNKNOWN_IDENTITY;

  // Retail-vs-resale is a fact about the transaction the offer itself
  // declares (or doesn't) -- it is not fabricated by, and does not depend
  // on, whether the seller's NAME can be resolved. An offer can truthfully
  // say "this is resale" while the retailer identity stays unknown.
  const declaredCommerceType = offerCommerceType(offer);

  const declared = firstNonEmptyString([offer.retailer, offer.source, offer.merchant, offer.store]);
  if (declared) {
    const entry = findRetailerByDeclaredName(declared);
    if (entry) {
      return {
        retailerKey: entry.retailerKey,
        displayName: entry.displayName,
        logoAsset: entry.logoAsset,
        fallbackMonogram: entry.fallbackMonogram,
        commerceType: declaredCommerceType ?? entry.commerceType,
        sourceAuthority: 'declared',
      };
    }
    return {
      retailerKey: null,
      displayName: declared,
      logoAsset: null,
      fallbackMonogram: null,
      commerceType: declaredCommerceType,
      sourceAuthority: 'declared',
    };
  }

  const url = typeof offer.productUrl === 'string' ? offer.productUrl : null;
  const safeUrl = url ? isSafeCommerceUrl(url) : null;
  if (safeUrl && !isAggregatorDestination(safeUrl)) {
    let hostname: string | null = null;
    try {
      hostname = new URL(safeUrl).hostname;
    } catch {
      hostname = null;
    }
    const entry = findRetailerByDomain(hostname);
    if (entry) {
      return {
        retailerKey: entry.retailerKey,
        displayName: entry.displayName,
        logoAsset: entry.logoAsset,
        fallbackMonogram: entry.fallbackMonogram,
        commerceType: declaredCommerceType ?? entry.commerceType,
        sourceAuthority: 'domain',
      };
    }
  }

  return {
    retailerKey: null,
    displayName: null,
    logoAsset: null,
    fallbackMonogram: null,
    commerceType: declaredCommerceType,
    sourceAuthority: 'unknown',
  };
}

/**
 * Read-path identity for PERSISTED commerce snapshots (Build 35 closure §6).
 *
 * Additive to -- never a replacement for -- `resolveRetailerIdentity`, whose
 * approved contract (declared seller field wins) is unchanged. This variant
 * exists because rows written before the seller-truth repair can carry a
 * BRAND in their stored `retailer` field: `normalizePurchaseOptions` used to
 * fall back to `record.brand`, and `savedScansCloud`/Dressing Room read those
 * stored rows back verbatim. Nothing rewrites history, so the bad label
 * outlives the fix.
 *
 * The one deterministic correction available is the row's own governed
 * purchase URL. When that URL is safe, is not an aggregator, and lands on a
 * domain in the committed registry, the registry identity is what the Shop
 * action will actually open -- so it outranks a stored free-text label that
 * contradicts it. A label that agrees with the domain is left alone.
 *
 * Deliberately NOT done here: no brand comparison, no title/image similarity,
 * no fuzzy or LLM matching, and no correction at all when the domain is
 * unregistered or the destination is an aggregator -- in those cases the
 * stored value stands, because nothing deterministic contradicts it. A
 * legacy row whose URL this cannot resolve keeps its stored label and is a
 * documented legacy limitation, not a silently guessed one.
 */
export function resolvePersistedRetailerIdentity(
  offer: RetailerIdentityInput | null | undefined,
): RetailerIdentity {
  const stored = resolveRetailerIdentity(offer);
  if (!offer || typeof offer !== 'object') return stored;

  const url = typeof offer.productUrl === 'string' ? offer.productUrl : null;
  const safeUrl = url ? isSafeCommerceUrl(url) : null;
  if (!safeUrl || isAggregatorDestination(safeUrl)) return stored;

  let hostname: string | null = null;
  try {
    hostname = new URL(safeUrl).hostname;
  } catch {
    return stored;
  }
  const entry = findRetailerByDomain(hostname);
  if (!entry) return stored;
  // The stored label already resolves to this same retailer: nothing to correct.
  if (stored.retailerKey === entry.retailerKey) return stored;

  return {
    retailerKey: entry.retailerKey,
    displayName: entry.displayName,
    logoAsset: entry.logoAsset,
    fallbackMonogram: entry.fallbackMonogram,
    commerceType: offerCommerceType(offer) ?? entry.commerceType,
    sourceAuthority: 'domain',
  };
}
