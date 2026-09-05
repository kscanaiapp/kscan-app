import type { Phase4ProductInput } from './types';

export interface VariantGroup {
  productRef: string;
  entries: Phase4ProductInput[];
  ambiguous: boolean;
}

/**
 * Task section 14: never collapse distinct variants into one asset, and
 * never infer "official" variant identity from pixel content. This app's
 * real Commerce contract has no canonical enumerated variant id (see
 * docs/vto-phase4-source-authority.md — `CanonicalPurchaseOption.variant`
 * is a free-text, retailer-declared, nullable label). So: entries sharing a
 * `productRef` with the SAME `variantId` (including all-null) are just
 * multiple candidate images of one variant (an image-selection problem,
 * `imageSelection.ts`); entries sharing a `productRef` with DIFFERING
 * non-null `variantId` values are marked ambiguous outright — there is no
 * authoritative signal here to tell them apart with confidence.
 */
export function groupByVariant(products: readonly Phase4ProductInput[]): VariantGroup[] {
  const byRef = new Map<string, Phase4ProductInput[]>();
  for (const p of products) {
    const list = byRef.get(p.productRef) ?? [];
    list.push(p);
    byRef.set(p.productRef, list);
  }

  const groups: VariantGroup[] = [];
  for (const [productRef, entries] of byRef) {
    const distinctVariantIds = new Set(entries.map((e) => e.variantId).filter((v): v is string => v !== null));
    const allAuthoritative = entries.every((e) => e.variantAuthoritative);
    const ambiguous = distinctVariantIds.size > 1 && !allAuthoritative;
    groups.push({ productRef, entries, ambiguous });
  }
  return groups;
}
