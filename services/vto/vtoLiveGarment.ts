/**
 * Live garment eligibility and descriptor derivation.
 *
 * ONE PRODUCT IDENTITY, TWO VISUALIZATION MODES. This module derives nothing
 * about a product on its own. It takes the VtoGarmentInput the existing
 * centralized derivation already produced (services/vto/vtoCommerceGarment.ts,
 * from the commerce record) and answers one further question: can the Live
 * runtime render THIS garment. There is deliberately no second product
 * identification path for Live -- `productRef` is carried through unchanged,
 * which is what makes a Live session and its Photoreal handoff provably about
 * the same item the customer was already looking at.
 *
 * LIVE SUPPORTS FEWER CATEGORIES THAN AI PHOTO, and says so. The research
 * authority's hard allow-list is t-shirt / simple-top / sweater (#291
 * garment-contract, LIVE_SUPPORTED_TEMPLATE_FAMILIES) -- everything else is
 * explicitly not built. Mapped onto this app's canonical taxonomy that is the
 * single token 'top'. Outerwear, blazers and dresses are eligible for AI Photo
 * and are NOT eligible for Live, and the router routes them accordingly rather
 * than pretending every category works.
 *
 * No fit claim is made or implied anywhere here.
 */

import { toCanonicalVtoCategory } from './vtoEligibility';
import type {
  LiveSupportedTemplateFamily,
  LiveVtoGarmentDescriptor,
} from '../../types/vtoLive';
import type { VtoGarmentInput } from '../../types/vto';

/**
 * Canonical K Scan tokens Live can render, conservative by construction.
 *
 * Narrower than DEFAULT_VTO_SUPPORTED_CATEGORIES on purpose: that set is the
 * generative path's, which has shipped and been benchmarked. Live has neither.
 * Remote config may narrow this further; it may not widen it past what the
 * native runtime actually implements.
 */
export const DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES: readonly string[] = ['top'];

/**
 * Canonical token -> research template family.
 *
 * Only 'top' has an entry. The mapping is a Record rather than a bare
 * category list so that widening Live later means naming the template family
 * a new category renders as -- which is a question the native runtime has to
 * answer -- instead of quietly adding a string to an allow-list.
 */
const TEMPLATE_FAMILY_BY_CANONICAL: Readonly<Record<string, LiveSupportedTemplateFamily>> = {
  top: 'simple-top',
};

export type LiveGarmentIneligibleReason =
  | 'unsupported_category'
  | 'missing_garment_image'
  | 'invalid_product_reference';

export type LiveGarmentEligibility =
  | { eligible: true; descriptor: LiveVtoGarmentDescriptor }
  | { eligible: false; reason: LiveGarmentIneligibleReason };

export interface LiveGarmentEligibilityInput {
  garment: VtoGarmentInput | null | undefined;
  /** Category allow-list in force. Defaults to the conservative set above. */
  supportedCategories?: readonly string[];
}

/**
 * The one Live garment decision. Mirrors the ORDER evaluateVtoEligibility
 * uses -- product reference, then category, then image -- so the two paths
 * report the same first cause for the same broken record rather than
 * disagreeing about why an item is unusable.
 */
export function evaluateLiveGarmentEligibility(
  input: LiveGarmentEligibilityInput,
): LiveGarmentEligibility {
  const garment = input.garment;
  const supported = input.supportedCategories ?? DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES;

  if (!garment || typeof garment.productRef !== 'string' || !garment.productRef.trim()) {
    return { eligible: false, reason: 'invalid_product_reference' };
  }

  const canonical = toCanonicalVtoCategory(garment.category);
  const templateFamily = TEMPLATE_FAMILY_BY_CANONICAL[canonical];
  if (!templateFamily || !supported.includes(canonical)) {
    return { eligible: false, reason: 'unsupported_category' };
  }

  if (typeof garment.imageUrl !== 'string' || !garment.imageUrl.trim()) {
    return { eligible: false, reason: 'missing_garment_image' };
  }

  return {
    eligible: true,
    descriptor: {
      productRef: garment.productRef.trim(),
      imageUrl: garment.imageUrl.trim(),
      canonicalCategory: canonical,
      templateFamily,
    },
  };
}

/** Convenience predicate for the router, which only needs the boolean. */
export function isLiveGarmentEligible(
  garment: VtoGarmentInput | null | undefined,
  supportedCategories?: readonly string[],
): boolean {
  return evaluateLiveGarmentEligibility({ garment, supportedCategories }).eligible;
}
