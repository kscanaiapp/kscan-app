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
 *
 * ASSET RESOLUTION (added alongside vtoLiveGarmentRegistry.ts). Category
 * eligibility alone used to be enough to hand native a descriptor, because
 * native resolved every descriptor to the same bundled fixture regardless
 * of which product it named (docs/vto-live-bridge-contract.md §13.5). That
 * placeholder is gone: `resolveLiveGarment` is now the one function that
 * decides ELIGIBLE(asset) | INELIGIBLE(reason) | NOT_FOUND | ERROR, and
 * `evaluateLiveGarmentEligibility` below is a thin backward-compatible
 * adapter over it for the one existing boolean-shaped call site.
 */

import { toCanonicalVtoCategory } from './vtoEligibility';
import {
  KSGARMENT_SCHEMA_VERSION,
  LIVE_VTO_GOVERNED_ASSETS,
  findGovernedLiveAssetByProductRef,
  isLiveVtoAssetKey,
  type LiveVtoGovernedAssetEntry,
} from './vtoLiveGarmentRegistry';
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
  | 'invalid_product_reference'
  /** A governed asset WAS found for this productRef, but the asset's own
   *  Phase-4 QA/eligibility verdict (manifest.eligibility.live2d) says no.
   *  Distinct from unsupported_category: the category is fine, this SPECIFIC
   *  asset is not usable. */
  | 'asset_not_eligible'
  /** No governed asset exists for this productRef at all. Kept as an
   *  INELIGIBLE reason (not surfaced as a separate top-level status) for
   *  evaluateLiveGarmentEligibility's existing boolean-shaped callers; new
   *  callers wanting to distinguish "not found" from "found but excluded"
   *  should call resolveLiveGarment directly and read `status`. */
  | 'asset_not_found'
  /** The registry entry itself failed a structural self-consistency check
   *  (should not happen for the committed registry -- see
   *  __tests__/vtoLiveGarmentRegistryParity.test.js -- but resolution fails
   *  closed rather than handing native a malformed descriptor). */
  | 'resolution_error';

export type LiveGarmentEligibility =
  | { eligible: true; descriptor: LiveVtoGarmentDescriptor }
  | { eligible: false; reason: LiveGarmentIneligibleReason };

export interface LiveGarmentEligibilityInput {
  garment: VtoGarmentInput | null | undefined;
  /** Category allow-list in force. Defaults to the conservative set above. */
  supportedCategories?: readonly string[];
  /** Governed asset registry to resolve against. Defaults to the real
   *  bundled registry; overridable so tests can exercise ELIGIBLE/
   *  INELIGIBLE/NOT_FOUND/ERROR without depending on the live registry's
   *  current contents. */
  registry?: readonly LiveVtoGovernedAssetEntry[];
}

/**
 * The four-way resolver contract. Distinct from LiveGarmentEligibility
 * (below) in ONE respect: it distinguishes NOT_FOUND (no governed asset
 * exists for this productRef -- the expected outcome for most real
 * products) from INELIGIBLE (a real, structural reason -- bad category, no
 * image, or a found-but-QA-excluded asset) and from ERROR (the registry
 * entry itself is malformed -- should never happen, fails closed anyway).
 */
export type LiveGarmentResolutionStatus = 'ELIGIBLE' | 'INELIGIBLE' | 'NOT_FOUND' | 'ERROR';

/** What ELIGIBLE carries beyond the native descriptor -- the mission's own
 *  required fields: resolved asset version, garment schema version, source
 *  manifest identity, and a governed retrieval address. `retrievalAddress`
 *  is a `bundled-asset://` URI, not an http(s) one: no network fetch is
 *  implemented (see vtoLiveGarmentRegistry.ts's header) and this string
 *  says so honestly rather than fabricating a download URL. */
export interface ResolvedLiveGarmentAsset {
  assetKey: string;
  assetId: string;
  assetVersion: string;
  ksgarmentSchemaVersion: string;
  sourceManifestId: string;
  retrievalAddress: string;
}

export type LiveGarmentResolution =
  | { status: 'ELIGIBLE'; descriptor: LiveVtoGarmentDescriptor; asset: ResolvedLiveGarmentAsset }
  | { status: 'INELIGIBLE'; reason: LiveGarmentIneligibleReason; productRef: string | null }
  | { status: 'NOT_FOUND'; productRef: string }
  | { status: 'ERROR'; reason: LiveGarmentIneligibleReason; productRef: string | null };

/**
 * productRef -> K Scan product authority (VtoGarmentInput, already derived
 * by services/vto/vtoCommerceGarment.ts from the commerce record) ->
 * category/image eligibility (this function's own long-standing first
 * three checks) -> governed Live-VTO asset registry lookup
 * (vtoLiveGarmentRegistry.ts) -> exact versioned .ksgarment asset ->
 * validated descriptor ready for the native loader.
 *
 * ORDER MATTERS and mirrors evaluateVtoEligibility's: product reference,
 * then category, then image, THEN asset lookup -- so a broken record and a
 * merely-unaddressed-by-Phase-4 record report different, both-true causes
 * rather than colliding on one.
 */
export function resolveLiveGarment(input: LiveGarmentEligibilityInput): LiveGarmentResolution {
  const garment = input.garment;
  const supported = input.supportedCategories ?? DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES;
  const registry = input.registry ?? LIVE_VTO_GOVERNED_ASSETS;

  if (!garment || typeof garment.productRef !== 'string' || !garment.productRef.trim()) {
    return { status: 'INELIGIBLE', reason: 'invalid_product_reference', productRef: null };
  }
  const productRef = garment.productRef.trim();

  const canonical = toCanonicalVtoCategory(garment.category);
  const templateFamily = TEMPLATE_FAMILY_BY_CANONICAL[canonical];
  if (!templateFamily || !supported.includes(canonical)) {
    return { status: 'INELIGIBLE', reason: 'unsupported_category', productRef };
  }

  if (typeof garment.imageUrl !== 'string' || !garment.imageUrl.trim()) {
    return { status: 'INELIGIBLE', reason: 'missing_garment_image', productRef };
  }

  const asset = findGovernedLiveAssetByProductRef(productRef, registry);
  if (!asset) {
    // NOT THE SAME AS unsupported_category. The category/image ARE fine;
    // there is simply no governed .ksgarment for this specific product yet
    // -- the truthful, expected answer for almost every real productRef
    // (see vtoLiveGarmentRegistry.ts's header).
    return { status: 'NOT_FOUND', productRef };
  }

  // Structural self-consistency of the registry entry itself. Fails closed
  // rather than handing native a descriptor pointing at an
  // unallowlisted/mismatched asset -- should be unreachable for the
  // committed registry (see the parity test), which is exactly why this is
  // ERROR (an authority-internal problem) rather than INELIGIBLE (a
  // legitimate product-level verdict).
  if (
    !isLiveVtoAssetKey(asset.assetKey) ||
    !asset.assetId.trim() ||
    !asset.assetVersion.trim() ||
    asset.ksgarmentSchemaVersion !== KSGARMENT_SCHEMA_VERSION
  ) {
    return { status: 'ERROR', reason: 'resolution_error', productRef };
  }

  if (asset.canonicalCategory !== canonical || asset.templateFamily !== templateFamily) {
    // The registry entry exists but was authored for a different category
    // than the one this productRef's commerce record now reports. Treat as
    // not-eligible-under-this-category rather than silently loading it.
    return { status: 'INELIGIBLE', reason: 'unsupported_category', productRef };
  }

  if (!asset.eligible || !asset.qaPassed) {
    return { status: 'INELIGIBLE', reason: 'asset_not_eligible', productRef };
  }

  const descriptor: LiveVtoGarmentDescriptor = {
    productRef,
    imageUrl: garment.imageUrl.trim(),
    canonicalCategory: canonical,
    templateFamily,
    assetKey: asset.assetKey,
    assetId: asset.assetId,
    assetVersion: asset.assetVersion,
  };

  return {
    status: 'ELIGIBLE',
    descriptor,
    asset: {
      assetKey: asset.assetKey,
      assetId: asset.assetId,
      assetVersion: asset.assetVersion,
      ksgarmentSchemaVersion: asset.ksgarmentSchemaVersion,
      sourceManifestId: asset.assetId,
      retrievalAddress: `bundled-asset://${asset.assetKey}`,
    },
  };
}

/**
 * Backward-compatible boolean-shaped adapter over resolveLiveGarment, for
 * the existing call site (components/vto/VirtualTryOnSheet.tsx) which only
 * ever needed "is this usable, and if so, its descriptor". NOT_FOUND and
 * ERROR both collapse to `eligible: false` here -- a caller that needs to
 * tell them apart (e.g. to decide whether to offer an AI Photo fallback
 * with different copy) should call resolveLiveGarment directly.
 */
export function evaluateLiveGarmentEligibility(
  input: LiveGarmentEligibilityInput,
): LiveGarmentEligibility {
  const resolution = resolveLiveGarment(input);
  switch (resolution.status) {
    case 'ELIGIBLE':
      return { eligible: true, descriptor: resolution.descriptor };
    case 'INELIGIBLE':
      return { eligible: false, reason: resolution.reason };
    case 'NOT_FOUND':
      return { eligible: false, reason: 'asset_not_found' };
    case 'ERROR':
      return { eligible: false, reason: resolution.reason };
  }
}

/** Convenience predicate for the router, which only needs the boolean.
 *  `registry` is test-only injection (default production callers never pass
 *  it): services/vto/vtoLiveGarmentRegistry.ts's real registry is used
 *  otherwise. */
export function isLiveGarmentEligible(
  garment: VtoGarmentInput | null | undefined,
  supportedCategories?: readonly string[],
  registry?: readonly LiveVtoGovernedAssetEntry[],
): boolean {
  return evaluateLiveGarmentEligibility({ garment, supportedCategories, registry }).eligible;
}
