/**
 * Server-authoritative VTO eligibility.
 *
 * Category canonicalization reuses normalizeCategory from
 * _shared/scanHelpers.ts -- the same taxonomy Scanner and Commerce already
 * speak -- so VTO does not invent a second category vocabulary.
 *
 * The client has a compact mirror of this in services/vto/vtoEligibility.ts
 * for UX only. If they ever disagree, this one wins and the request is
 * refused; __tests__/vtoEligibilityParity.test.js exists so that disagreement
 * shows up as a failing test rather than as a puzzling refusal in the field.
 */

import { normalizeCategory } from '../_shared/scanHelpers.ts';
import type { VtoGarmentSlot, VtoIneligibleReason } from './vtoContract.ts';

const SLOT_BY_CANONICAL: Readonly<Record<string, VtoGarmentSlot>> = {
  top: 'top',
  outerwear: 'top',
  blazer: 'top',
  dress: 'full_body',
  jumpsuit: 'full_body',
  pants: 'bottom',
  skirt: 'bottom',
};

export function toCanonicalVtoCategory(input: string | null | undefined): string {
  return normalizeCategory(input);
}

export function resolveVtoGarmentSlot(canonical: string): VtoGarmentSlot | null {
  return SLOT_BY_CANONICAL[canonical] ?? null;
}

/**
 * Garment image references VTO will accept. https only: a data:, file:,
 * content:, or http: reference is either not a retailer image or is an
 * attempt to make the server fetch something it should not.
 */
export function isSupportedGarmentImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ServerEligibilityInput {
  category: unknown;
  garmentImageUrl: unknown;
  productRef: unknown;
  supportedCategories: readonly string[];
}

export type ServerEligibility =
  | { eligible: true; slot: VtoGarmentSlot; canonicalCategory: string; garmentImageUrl: string }
  | { eligible: false; reason: VtoIneligibleReason };

export function evaluateServerVtoEligibility(input: ServerEligibilityInput): ServerEligibility {
  if (typeof input.productRef !== 'string' || !input.productRef.trim()) {
    return { eligible: false, reason: 'invalid_product_reference' };
  }
  const canonical = toCanonicalVtoCategory(
    typeof input.category === 'string' ? input.category : null,
  );
  const slot = resolveVtoGarmentSlot(canonical);
  if (!slot || !input.supportedCategories.includes(canonical)) {
    return { eligible: false, reason: 'unsupported_category' };
  }
  if (!isSupportedGarmentImageUrl(input.garmentImageUrl)) {
    return { eligible: false, reason: 'missing_garment_image' };
  }
  return {
    eligible: true,
    slot,
    canonicalCategory: canonical,
    garmentImageUrl: (input.garmentImageUrl as string).trim(),
  };
}
