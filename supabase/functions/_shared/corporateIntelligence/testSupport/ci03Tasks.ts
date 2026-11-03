/**
 * CI-03 test support: tasks built through the REAL CI-02 sealed assembler (never hand-written), so the production
 * validator is exercised against exactly what the server would assemble. Offline; no network, provider or clock.
 */
import {
  assembleCorporateTaskContext,
  sealTrustedAssemblerInput,
  type TrustedAssemblerFields,
  type TrustedDiscoveryProduct,
  type TrustedDiscoveryResult,
} from '../contextAssembler.ts';
import type { CorporateTaskV1 } from '../contracts.ts';
import { FIXTURE_NOW } from './baseTask.ts';

export const CI03_NOW = FIXTURE_NOW; // 2026-11-03T12:00:00Z
export const MERCHANT_A = 'merchant_a';
export const MERCHANT_B = 'merchant_b';
export const PRODUCT_ID = (n: number) => `prod_${String(n).padStart(4, '0')}`;

export function discoveryProduct(
  over: Partial<TrustedDiscoveryProduct> & { n?: number; brand?: string; name?: string } = {},
): TrustedDiscoveryProduct {
  const brand = over.brand ?? MERCHANT_A;
  const name = over.name ?? 'Atelier Nine';
  const { n: _n, brand: _b, name: _name, ...rest } = over;
  return {
    productId: PRODUCT_ID(over.n ?? 1),
    brandId: brand,
    brandName: name,
    price: '$148.00',
    currency: 'USD',
    inventoryVerifiedAt: '2026-11-03T10:00:00Z',
    ownershipIdentity: {
      brandId: brand,
      brandName: name,
      ownershipVerificationStatus: 'verified',
      publicOwnershipLabelAllowed: true,
      verifiedUntil: '2027-01-01T00:00:00Z',
    },
    ...rest,
  };
}

export function discoveryResult(products: TrustedDiscoveryProduct[], status: TrustedDiscoveryResult['status'] = 'ready'): TrustedDiscoveryResult {
  return { status, generatedAt: '2026-11-03T11:59:00Z', products };
}

export function assembleTask(over: Partial<TrustedAssemblerFields> = {}, now: Date = CI03_NOW): CorporateTaskV1 {
  const sealed = sealTrustedAssemblerInput({
    correlationId: 'req_8f3a91c2d4',
    taskState: { route: 'discovery', discoveryStatus: 'ready' },
    locale: 'en-US',
    stylistDisplayName: 'Elise',
    discovery: discoveryResult([discoveryProduct()]),
    ...over,
  });
  if (!sealed.ok) throw new Error(`seal failed: ${sealed.reason}`);
  const r = assembleCorporateTaskContext(sealed.input, now);
  if (!r.ok) throw new Error(`assembly failed: ${r.reason} ${JSON.stringify(r.contractErrors ?? [])}`);
  return r.task;
}

/** The two oracle ownership contexts, rebuilt as real tasks. */
export const tasksForContext = {
  /** One eligible merchant "Atelier Nine" (merchant_a), discovery explanation. */
  eligibleA: () => assembleTask(),
  /** Discovery returned nothing eligible: neutral empty state, zero_eligible inventory. */
  zeroEligible: () => assembleTask({ taskState: { route: 'discovery', discoveryStatus: 'empty' }, discovery: discoveryResult([], 'empty') }),
} as const;

/** A StyleChat conversation task (no discovery, no merchant facts). */
export const stylechatTask = () => assembleTask({ taskState: { route: 'stylechat' }, discovery: null });

/** Two eligible merchants: Atelier Nine (merchant_a, prod_0001, USD) and Kente House (merchant_b, prod_0002, EUR). */
export const twoMerchantTask = () =>
  assembleTask({
    discovery: discoveryResult([
      discoveryProduct(),
      discoveryProduct({ n: 2, brand: MERCHANT_B, name: 'Kente House', price: '€90.00', currency: 'EUR' }),
    ]),
  });

/** Contexts addressable from JSON fixtures (`production_output` assessor). */
export const CI03_FIXTURE_CONTEXTS: Readonly<Record<string, () => CorporateTaskV1>> = Object.freeze({
  eligibleA: tasksForContext.eligibleA,
  zeroEligible: tasksForContext.zeroEligible,
  stylechat: stylechatTask,
  twoMerchants: twoMerchantTask,
});
