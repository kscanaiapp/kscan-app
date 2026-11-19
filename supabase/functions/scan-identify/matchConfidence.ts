/**
 * Scanner Match Confidence v1 — evidence-bound, per-offer confidence class.
 *
 * Why this exists (Build 42 Sprint 1 audit, defect B42-SCAN-CONF-01):
 *   The commerce pipeline already computes a deterministic attribute-agreement
 *   score for every candidate offer, but it uses that score only to order and
 *   select the shelf. When fewer than three offers reach the "usable" band,
 *   `selectByAgreementCoverage` pads the shelf with below-usable ("weak")
 *   offers, and the score is then discarded. Nothing downstream can tell a
 *   strong match from a padding offer, so every offer is presented under the
 *   same label. Search-handoff destinations also never receive `matchMetadata`
 *   (matchTier rejects them), so brand agreement on those offers is invisible.
 *
 * What this module does:
 *   Recomputes the SAME pure agreement score for each offer that is actually
 *   returned, combines it with evidence that already exists (scanner brand
 *   evidence, listing brand, destination kind, category/subtype compatibility,
 *   the model's own product hypothesis and the listing-bound match tier) and
 *   assigns exactly one class:
 *
 *     verified_exact — the listing-bound tier is `exact` (which itself requires
 *                      verified product identity) AND the destination is a
 *                      direct merchant listing. No producer of verified product
 *                      identity exists today, so this class is unreachable by
 *                      construction until one ships; it is never inferred from
 *                      a model hypothesis, a model confidence, a title or a score.
 *     probable       — the vision model's visually grounded brand agrees with the listing brand, the
 *                      model's own product hypothesis is fully present in the
 *                      listing title, and the category is compatible. Likely the
 *                      same product, NOT verified.
 *     similar        — an alternative whose attributes agree at or above the
 *                      existing usable threshold, with no category conflict.
 *     unsupported    — invalid destination, clear category conflict, or
 *                      agreement below the usable threshold (a coverage fill).
 *
 * Hard rules:
 *   - Pure and deterministic. No network, no model call, no randomness.
 *   - Additive only: never reorders, filters, or edits an existing field.
 *   - `agreementScore` is diagnostic. It is not a probability and must never be
 *     rendered as a "% match".
 *   - Thresholds are the existing v122 agreement bands (strong >= 75,
 *     usable >= 50). They are PROVISIONAL and must be recalibrated against the
 *     Build 42 benchmark before any user-facing use.
 */
import type { RecommendedProduct } from './shoppingProvider.ts';
import { classifyDestination, type DestinationKind } from './shoppingProvider.ts';
import {
  type AgreementBand,
  normalizeCommerceCategoryText,
  scoreProductAgreement,
} from './commerceRelevanceAgreement.ts';
import { resolveScannerBrandEvidence } from './brandEvidence.ts';
import { normalizeCommerceMatchMetadata } from './matchTier.ts';
import type { CommerceIdentityEvidence } from './scannerQualityGate.ts';
import type { ScannerCategoryRoute } from './scannerCategoryRoute.ts';
import { MATCH_CONFIDENCE_VERSION } from './matchConfidenceConfig.ts';

export type MatchConfidenceClass = 'verified_exact' | 'probable' | 'similar' | 'unsupported';

export const MATCH_CONFIDENCE_CLASSES: readonly MatchConfidenceClass[] = Object.freeze([
  'verified_exact',
  'probable',
  'similar',
  'unsupported',
]);

export type MatchConfidenceReason =
  | 'verified_product_identity'
  | 'exact_identity_unverified'
  | 'direct_merchant_listing'
  | 'search_handoff_destination'
  | 'invalid_destination'
  | 'non_identity_listing'
  | 'verified_brand_agrees'
  | 'listing_brand_contradicts'
  | 'listing_brand_unknown'
  | 'scanned_brand_unverified'
  | 'model_hypothesis_agrees'
  | 'model_hypothesis_partial'
  | 'model_hypothesis_absent'
  | 'category_compatible'
  | 'category_unconfirmed'
  | 'category_conflict'
  | 'category_different'
  | 'ancillary_listing'
  | 'subtype_compatible'
  | 'subtype_unconfirmed'
  | 'agreement_strong'
  | 'agreement_usable'
  | 'agreement_below_usable';

export type MatchConfidence = {
  version: typeof MATCH_CONFIDENCE_VERSION;
  class: MatchConfidenceClass;
  destination: DestinationKind;
  agreementBand: AgreementBand;
  /** Diagnostic 0–100 attribute agreement. Not a probability. Never display as "% match". */
  agreementScore: number;
  reasons: MatchConfidenceReason[];
};

export type ListingBrandAgreement = 'agrees' | 'contradicts' | 'unknown' | 'scanned_unverified';
export type ModelAgreement = 'agrees' | 'partial' | 'absent';

/** Every signal the classifier consumes. Built by `collectOfferEvidence`. */
export type OfferEvidence = {
  destination: DestinationKind;
  agreementScore: number;
  agreementBand: AgreementBand;
  clearCategoryConflict: boolean;
  /**
   * compatible — the listing text normalizes to the scanned category;
   * absent     — the listing text names no category at all ("adidas Stan Smith");
   * different  — the listing names another canonical category (blazer for a jacket);
   * ancillary  — the listing names the product but sells something else
   *              ("Stan Smith socks", "F-91W replacement band").
   */
  category: 'compatible' | 'absent' | 'different' | 'ancillary';
  subtypeCompatible: boolean;
  nonIdentityListing: boolean;
  brand: ListingBrandAgreement;
  model: ModelAgreement;
  /** True only when the listing-bound match tier is `exact` (verified product identity). */
  verifiedProductIdentity: boolean;
};

export type MatchConfidenceContext = {
  identification: Record<string, unknown>;
  route?: ScannerCategoryRoute | null;
  /** Supplied only when v124 commerce identity is enabled, exactly as ranking receives it. */
  commerceIdentity?: CommerceIdentityEvidence | null;
};

/**
 * Classify one offer from its evidence. Order matters: disqualifying evidence
 * is checked before any positive class, so a coverage fill can never be
 * promoted by brand or model agreement.
 */
export function classifyMatchConfidence(e: OfferEvidence): MatchConfidence {
  const reasons: MatchConfidenceReason[] = [];
  const base = (cls: MatchConfidenceClass): MatchConfidence => ({
    version: MATCH_CONFIDENCE_VERSION,
    class: cls,
    destination: e.destination,
    agreementBand: e.agreementBand,
    agreementScore: e.agreementScore,
    reasons,
  });

  reasons.push(
    e.destination === 'direct'
      ? 'direct_merchant_listing'
      : e.destination === 'search_handoff'
      ? 'search_handoff_destination'
      : 'invalid_destination',
  );
  if (e.destination === 'invalid') return base('unsupported');

  if (e.clearCategoryConflict) {
    reasons.push('category_conflict');
    return base('unsupported');
  }
  if (e.category === 'ancillary') {
    reasons.push('ancillary_listing');
    return base('unsupported');
  }
  if (e.nonIdentityListing) {
    reasons.push('non_identity_listing');
    return base('unsupported');
  }
  reasons.push(
    e.category === 'compatible'
      ? 'category_compatible'
      : e.category === 'different'
      ? 'category_different'
      : 'category_unconfirmed',
  );
  reasons.push(e.subtypeCompatible ? 'subtype_compatible' : 'subtype_unconfirmed');
  reasons.push(
    e.agreementBand === 'strong'
      ? 'agreement_strong'
      : e.agreementBand === 'usable'
      ? 'agreement_usable'
      : 'agreement_below_usable',
  );

  if (e.verifiedProductIdentity && e.destination === 'direct' &&
    e.category !== 'different' && e.brand !== 'contradicts') {
    reasons.push('verified_product_identity');
    return base('verified_exact');
  }

  reasons.push(
    e.brand === 'agrees'
      ? 'verified_brand_agrees'
      : e.brand === 'contradicts'
      ? 'listing_brand_contradicts'
      : e.brand === 'unknown'
      ? 'listing_brand_unknown'
      : 'scanned_brand_unverified',
  );
  reasons.push(
    e.model === 'agrees'
      ? 'model_hypothesis_agrees'
      : e.model === 'partial'
      ? 'model_hypothesis_partial'
      : 'model_hypothesis_absent',
  );

  // Identity agreement is judged BEFORE the attribute band on purpose: the v122
  // attribute scorer rewards attribute-shaped titles ("White Leather Low-Top
  // Sneakers") and scores identity-shaped titles ("adidas Stan Smith") near
  // zero, so an attribute band can never be the reason a same-product listing
  // is called unsupported. Category must be compatible or simply absent from
  // the listing text; a different canonical category can at most be similar.
  if (e.brand === 'agrees' && e.model === 'agrees' && e.category !== 'different') {
    reasons.push('exact_identity_unverified');
    return base('probable');
  }
  if (e.agreementBand === 'weak') return base('unsupported');
  return base('similar');
}

// ── Evidence collection ──────────────────────────────────────────────────────

const key = (value: unknown): string =>
  typeof value === 'string'
    ? value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    : '';

const tokens = (value: unknown): string[] => key(value).split(' ').filter(Boolean);

/** Words that describe a kind of item, colour or material — never a product identity. */
const GENERIC_IDENTITY_TOKENS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'with', 'of', 'in', 'for', 'by', 'new', 'classic', 'original', 'originals',
  'men', 'mens', 'women', 'womens', 'unisex', 'kids', 'style',
  'shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers', 'boot', 'boots', 'sandal', 'sandals',
  'clog', 'clogs', 'jacket', 'coat', 'dress', 'bag', 'handbag', 'tote', 'backpack', 'top', 'shirt',
  'tee', 't', 'pants', 'jeans', 'trousers', 'skirt', 'hoodie', 'sweater', 'cap', 'hat', 'watch',
  'sunglasses', 'glasses', 'frame', 'frames',
  'black', 'white', 'red', 'blue', 'green', 'navy', 'grey', 'gray', 'brown', 'beige', 'tan', 'pink',
  'purple', 'yellow', 'orange', 'gold', 'silver', 'burgundy', 'cream', 'ivory',
  'leather', 'suede', 'canvas', 'denim', 'cotton', 'wool', 'nylon', 'mesh', 'rubber',
]);

/** `normalizeCategory` echoes unrecognised text back; only these values are categories. */
const CANONICAL_CATEGORIES: ReadonlySet<string> = new Set([
  'blazer', 'outerwear', 'dress', 'pants', 'top', 'footwear', 'bag', 'accessory',
]);

/**
 * Listings that name a product without being it: "Stan Smith socks",
 * "F-91W replacement band", "Kånken shoulder strap", "Wayfarer case".
 * Several of these nouns have no canonical category, so without this cue they
 * would read as "category absent" and could pass as the scanned product.
 */
const ANCILLARY_LISTING_CUE =
  /\b(socks?|laces?|shoelaces?|insoles?|cleaner|cleaning|protectors?|keychains?|key ?rings?|posters?|stickers?|charms?|replacement|spare|strap|straps|band|bands|case|cases|pouch|box)\b/;

/** Title cues that a listing names a brand without being that brand's product. */
const NON_IDENTITY_TITLE_CUE =
  /\b(alternative to|inspired by|inspired|similar to|style of|look ?alike|dupe|replica|fake|knock ?off|compatible with|for use with|replacement)\b/;

function containsPhrase(haystackKey: string, needleKey: string): boolean {
  return !!needleKey && ` ${haystackKey} `.includes(` ${needleKey} `);
}

function productUrlOf(product: Record<string, unknown>): unknown {
  return product.productUrl ?? product.product_url ?? product.purchaseUrl ?? product.url ?? product.link;
}

function productTextOf(product: Record<string, unknown>): string {
  return [product.title, product.name, product.category, product.item_type]
    .filter((value) => typeof value === 'string')
    .join(' ');
}

export function listingBrandAgreement(
  product: Record<string, unknown>,
  identification: Record<string, unknown>,
): ListingBrandAgreement {
  const scanned = resolveScannerBrandEvidence(identification);
  if (!scanned.verified || !scanned.brand) return 'scanned_unverified';
  const scannedKey = key(scanned.brand);
  const providerKey = key(product.brand);
  if (providerKey) return providerKey === scannedKey ? 'agrees' : 'contradicts';
  const titleKey = key(product.title ?? product.name);
  if (NON_IDENTITY_TITLE_CUE.test(titleKey)) return 'unknown';
  return containsPhrase(titleKey, scannedKey) ? 'agrees' : 'unknown';
}

/**
 * Does the listing title name the model the vision model hypothesised? Brand
 * tokens and generic kind/colour/material words are removed first, so only a
 * distinctive model identifier ("stan smith", "f 91w", "air jordan 1 high")
 * can agree. A low-confidence hypothesis is ignored.
 */
export function modelHypothesisAgreement(
  product: Record<string, unknown>,
  identification: Record<string, unknown>,
  commerceIdentity?: CommerceIdentityEvidence | null,
): ModelAgreement {
  const hypothesis = commerceIdentity?.exactItemHypothesis ?? identification.exact_item_hypothesis;
  const confidence = commerceIdentity?.exactMatchConfidence ?? identification.exact_match_confidence;
  if (typeof hypothesis !== 'string' || !hypothesis.trim()) return 'absent';
  if (typeof confidence === 'string' && confidence.trim().toLowerCase() === 'low') return 'absent';
  const brand = resolveScannerBrandEvidence(identification).brand ?? identification.brand_guess;
  const brandTokens = new Set(tokens(brand));
  const distinctive = [...new Set(tokens(hypothesis))].filter((t) => !brandTokens.has(t) && !GENERIC_IDENTITY_TOKENS.has(t));
  if (distinctive.length === 0) return 'absent';
  const titleTokens = new Set(tokens(product.title ?? product.name));
  const hits = distinctive.filter((t) => titleTokens.has(t)).length;
  if (hits === distinctive.length) return 'agrees';
  return hits > 0 ? 'partial' : 'absent';
}

export function collectOfferEvidence(
  product: Record<string, unknown>,
  ctx: MatchConfidenceContext,
): OfferEvidence {
  const identification = ctx.identification ?? {};
  const agreement = scoreProductAgreement(
    product as unknown as RecommendedProduct,
    identification,
    ctx.route ?? null,
    ctx.commerceIdentity ?? null,
  );
  const productText = productTextOf(product);
  const scannedRaw = normalizeCommerceCategoryText(String(identification.item_type ?? ''));
  const scannedCategory = CANONICAL_CATEGORIES.has(scannedRaw) ? scannedRaw : '';
  const productRaw = normalizeCommerceCategoryText(productText);
  const productCategory = CANONICAL_CATEGORIES.has(productRaw) ? productRaw : '';
  const scannedIsAncillary = ANCILLARY_LISTING_CUE.test(key(`${identification.item_type ?? ''} ${identification.subtype ?? ''}`));
  const ancillaryListing = !scannedIsAncillary && ANCILLARY_LISTING_CUE.test(key(productText));
  const productTokens = new Set(tokens(productText).map((t) => t.replace(/s$/, '')));
  const subtypeTokens = tokens(identification.subtype).map((t) => t.replace(/s$/, ''));
  return {
    destination: classifyDestination(productUrlOf(product)),
    agreementScore: agreement.score,
    agreementBand: agreement.band,
    clearCategoryConflict: agreement.clearCategoryConflict,
    category: ancillaryListing
      ? 'ancillary'
      : !scannedCategory || !productCategory
      ? 'absent'
      : productCategory === scannedCategory
      ? 'compatible'
      : 'different',
    subtypeCompatible: subtypeTokens.length > 0 && subtypeTokens.every((t) => productTokens.has(t)),
    nonIdentityListing: NON_IDENTITY_TITLE_CUE.test(key(product.title ?? product.name)),
    brand: listingBrandAgreement(product, identification),
    model: modelHypothesisAgreement(product, identification, ctx.commerceIdentity),
    verifiedProductIdentity: normalizeCommerceMatchMetadata(product.matchMetadata, product)?.tier === 'exact',
  };
}

/** Additive annotation at the response boundary. Same array order, same fields plus one. */
export function annotateMatchConfidence<T>(products: T[], ctx: MatchConfidenceContext): T[] {
  return products.map((product) => {
    const record = product as unknown as Record<string, unknown>;
    if (!record || typeof record !== 'object') return product;
    return { ...product, matchConfidence: classifyMatchConfidence(collectOfferEvidence(record, ctx)) };
  });
}

export type MatchConfidenceSummary = {
  offers: number;
  classes: Record<MatchConfidenceClass, number>;
  destinations: Record<DestinationKind, number>;
};

/** Counts only — no titles, URLs, brands, queries or identifiers. Safe to log. */
export function summarizeMatchConfidence(products: unknown[]): MatchConfidenceSummary {
  const summary: MatchConfidenceSummary = {
    offers: 0,
    classes: { verified_exact: 0, probable: 0, similar: 0, unsupported: 0 },
    destinations: { direct: 0, search_handoff: 0, invalid: 0 },
  };
  for (const product of products) {
    const mc = (product as { matchConfidence?: MatchConfidence } | null)?.matchConfidence;
    if (!mc) continue;
    summary.offers += 1;
    if (mc.class in summary.classes) summary.classes[mc.class] += 1;
    if (mc.destination in summary.destinations) summary.destinations[mc.destination] += 1;
  }
  return summary;
}
