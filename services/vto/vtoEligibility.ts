/**
 * Centralized VTO eligibility.
 *
 * Every "can this item be tried on" question in the app goes through here.
 * No UI component may re-derive it with its own `if (category === ...)`.
 *
 * THE SERVER IS AUTHORITATIVE. This module exists so the UI can hide an
 * affordance the user cannot use; supabase/functions/vto-generate re-derives
 * eligibility from the same rules and refuses anything it disagrees with.
 * __tests__/vtoEligibilityParity.test.js asserts the two canonicalizers agree
 * over a shared fixture table, so a divergence is a test failure rather than a
 * silent wasted round trip.
 *
 * The supported-category set is deliberately NOT frozen here: it defaults
 * conservatively and is narrowed/widened by remote config once benchmark
 * evidence exists (see docs/vto-foundation.md). Reliability beats breadth.
 */

import type { VtoEligibility, VtoGarmentSlot } from '../../types/vto';

/**
 * Canonical taxonomy tokens, mirroring normalizeCategory in
 * supabase/functions/_shared/scanHelpers.ts. Kept compact on purpose: the
 * client only needs the garment-bearing branches, and the parity test pins
 * the agreement.
 */
const CANONICAL_PATTERNS: ReadonlyArray<{ token: string; pattern: RegExp }> = [
  { token: 'blazer', pattern: /\b(blazers?|suit jackets?|tailored jackets?|sports? coats?|sport coats?)\b/ },
  {
    token: 'outerwear',
    pattern:
      /\b(jackets?|coats?|outerwear|parkas?|trench(?:\s?coats?)?|puffers?|puffer jackets?|down jackets?|bombers?|bomber jackets?|windbreakers?|overcoats?|peacoats?|pea coats?|anoraks?|raincoats?|rain jackets?)\b/,
  },
  { token: 'dress', pattern: /\b(dress(?:es)?|gowns?|sundress(?:es)?|frocks?)\b/ },
  { token: 'pants', pattern: /\b(jeans|pants|trousers|slacks|leggings|shorts|chinos|joggers|sweatpants|culottes)\b/ },
  {
    token: 'top',
    pattern: /\b(shirts?|blouses?|tops?|tanks?|tank tops?|tees?|t-shirts?|tshirts?|sweaters?|hoodies?|jumpers?|pullovers?|polos?|cardigans?)\b/,
  },
  { token: 'footwear', pattern: /\b(sneakers?|shoes?|boots?|heels?|loafers?|sandals?|pumps?|trainers?|flats?|footwear)\b/ },
  {
    token: 'bag',
    pattern: /\b(bags?|handbags?|purses?|totes?|clutch(?:es)?|backpacks?|satchels?|crossbody|cross-body|duffels?|duffles?)\b/,
  },
  {
    token: 'accessory',
    pattern:
      /\b(belts?|jewelry|jewellery|necklaces?|bracelets?|rings?|earrings?|sunglasses|scarf|scarves|hats?|caps?|beanies?|gloves?|watch(?:es)?|ties?|wallets?)\b/,
  },
];

/** Canonicalize a free-form category the same way the backend taxonomy does. */
export function toCanonicalVtoCategory(input: string | null | undefined): string {
  if (!input || typeof input !== 'string') return '';
  const lower = input.toLowerCase().trim();
  if (lower === 'non_fashion' || lower === 'non-fashion') return 'NON_FASHION';
  for (const { token, pattern } of CANONICAL_PATTERNS) {
    if (pattern.test(lower)) return token;
  }
  return lower;
}

/** Which body region a canonical garment token occupies, or null if the token
 *  is not a wearable garment VTO can visualize (footwear, bags, accessories). */
const SLOT_BY_CANONICAL: Readonly<Record<string, VtoGarmentSlot>> = {
  top: 'top',
  outerwear: 'top',
  blazer: 'top',
  dress: 'full_body',
  jumpsuit: 'full_body',
  pants: 'bottom',
  skirt: 'bottom',
};

export function resolveVtoGarmentSlot(canonical: string): VtoGarmentSlot | null {
  return SLOT_BY_CANONICAL[canonical] ?? null;
}

/**
 * Conservative launch default. Deliberately narrower than the full slot map:
 * bottoms are recognised as garments but are not enabled until benchmark
 * evidence says they render acceptably. Remote config may narrow or widen it.
 */
export const DEFAULT_VTO_SUPPORTED_CATEGORIES: readonly string[] = [
  'top',
  'outerwear',
  'blazer',
  'dress',
];

export interface VtoEligibilityInput {
  /** Free-form category as commerce produced it. */
  category: string | null | undefined;
  /** Remote https garment image. A garment with no image cannot be rendered. */
  imageUrl: string | null | undefined;
  /** Stable reference to the commerce candidate. */
  productRef: string | null | undefined;
  /** Server kill switch / client rollout flag, already resolved. */
  featureEnabled: boolean;
  /** Resolved K+ state. UX only on the client; enforced on the server. */
  hasEntitlement: boolean;
  /** Category allowlist in force (remote config, or the default above). */
  supportedCategories?: readonly string[];
}

/** True only for a plain https remote image reference. Rejects data:, file:,
 *  content:, javascript:, and anything that is not parseable as a URL. */
export function isSupportedGarmentImageUrl(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Single decision point. Order matters and is deliberate: feature control is
 * evaluated before entitlement so a globally disabled feature never renders
 * as "buy K+ to unlock", and item-shape problems are reported before either
 * so we never invite an upgrade for an item that could not be tried on anyway.
 */
export function evaluateVtoEligibility(input: VtoEligibilityInput): VtoEligibility {
  const supported = input.supportedCategories ?? DEFAULT_VTO_SUPPORTED_CATEGORIES;

  if (typeof input.productRef !== 'string' || !input.productRef.trim()) {
    return { eligible: false, reason: 'invalid_product_reference' };
  }

  const canonical = toCanonicalVtoCategory(input.category);
  const slot = resolveVtoGarmentSlot(canonical);
  if (!slot || !supported.includes(canonical)) {
    return { eligible: false, reason: 'unsupported_category' };
  }

  if (!isSupportedGarmentImageUrl(input.imageUrl)) {
    return { eligible: false, reason: 'missing_garment_image' };
  }

  if (!input.featureEnabled) {
    return { eligible: false, reason: 'feature_disabled' };
  }

  if (!input.hasEntitlement) {
    return { eligible: false, reason: 'entitlement_required' };
  }

  return { eligible: true, slot };
}
