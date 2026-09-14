/**
 * THE VTO mode authority.
 *
 * ONE function answers "what can this customer do with this product, right
 * now, and why" for every VTO surface in the app: `resolveVtoMode`. No
 * component, hook, shelf, panel or Elise surface may re-derive any part of
 * that answer with its own boolean. `__tests__/vtoModeAuthority.test.js`
 * asserts that structurally.
 *
 * WHY THIS EXISTS ON TOP OF WHAT WAS ALREADY HERE. Three correct authorities
 * already existed and were never composed into one customer answer:
 *
 *   services/vto/vtoEligibility.ts      the generative (AI Photo) rule
 *   services/vto/vtoLiveGarment.ts      the governed Live asset rule
 *   services/vto/vtoLiveCapability.ts   the Live device/runtime reason ladder
 *
 * The entry point (components/vto/TryItOnEntry.tsx) gated its visibility on
 * the FIRST of those alone, so the customer-facing affordance was only ever
 * as available as the GENERATIVE path. A product with a governed Live asset
 * on a Live-capable device rendered no Try On at all whenever the generative
 * half was off -- which is exactly the documented Live-pilot operator posture
 * (`app_config.vto_generation.live.enabled = true` with the generative
 * `enabled` untouched, docs/vto-live-productization-v1.md §8). The Live
 * router computed `mode: 'live'` and nothing could reach it. That is the
 * defect this module exists to close: it does NOT widen any rule, it stops a
 * narrower rule from hiding a wider one.
 *
 * IT REPLACES NOTHING AND RE-DERIVES NOTHING. Every verdict below is produced
 * by calling the existing authority that owns it. `resolveVtoCapability` is
 * still the one Live reason ladder; `evaluateVtoEligibility` is still the one
 * generative rule and still the client mirror the server re-derives and wins
 * over; `resolveLiveGarment` is still the one governed-asset lookup. This
 * module decides only ORDER and REASON REPORTING.
 *
 * CHEAP AND SYNCHRONOUS (mission section 9). Every input is a static verified
 * fact a caller already holds: a category string, a verified https image
 * reference, the bundled asset registry, resolved flags, a cached native
 * self-check, resolved entitlement/quota state. It performs no I/O and
 * fetches no image bytes -- a TRY ON button must never cost a network round
 * trip to render. Checks that need bytes belong in capture/request preflight,
 * after the customer has acted.
 *
 * IT MAKES NO CLAIM ABOUT RUNTIME SUCCESS. See VTO_RUNTIME_PROOF below.
 */

import {
  evaluateVtoEligibility,
  toCanonicalVtoCategory,
  DEFAULT_VTO_SUPPORTED_CATEGORIES,
} from './vtoEligibility';
import { resolveLiveGarment, DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES } from './vtoLiveGarment';
import type { LiveVtoGovernedAssetEntry } from './vtoLiveGarmentRegistry';
import {
  resolveVtoCapability,
  type VtoCameraPermissionState,
  type VtoCapability,
} from './vtoLiveCapability';
import type { LiveVtoNativeCapability } from './liveVtoNativeModule';
import type { VtoGarmentInput } from '../../types/vto';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const VTO_MODES = ['LIVE_LOCAL', 'PHOTOREAL_STILL', 'UNAVAILABLE'] as const;
export type VtoMode = (typeof VTO_MODES)[number];

/**
 * How much is actually PROVEN about the mode being offered.
 *
 * `PROVEN` means a real customer-path execution of this mode has been
 * observed end to end. Neither mode carries it today and this module does not
 * decide that by inference -- see VTO_RUNTIME_PROOF.
 */
export const VTO_MODE_STATUSES = [
  'PROVEN',
  'SOURCE_CONNECTED_RUNTIME_UNPROVEN',
  'UNAVAILABLE',
] as const;
export type VtoModeStatus = (typeof VTO_MODE_STATUSES)[number];

/**
 * DECLARED RUNTIME PROOF, not inferred.
 *
 * Both modes are wired end to end in source and both are gated OFF by
 * default. Neither has been proven on the real customer path, and the
 * evidence for each is cited rather than summarized:
 *
 * LIVE_LOCAL -- docs/vto-live-productization-v1.md section 10: "No frame has
 *   been rendered on a phone by this lane's code." iOS physical runtime is
 *   recorded PENDING; the Android physical-camera hold (`ETIMEDOUT (-110)`,
 *   binds and reports RUNNING but never delivers a frame) is recorded
 *   PENDING RECLASSIFICATION. Every state transition is proven against a
 *   fixture on the JVM and under `swift test`, which is not runtime
 *   certification.
 *
 * PHOTOREAL_STILL -- docs/vto-provider-benchmark.md section 3.6 records ONE
 *   real, billed, fully-completed provider generation (submit -> async task
 *   -> poll -> result, `usage.image_count: 1`). It was run through a
 *   TEMPORARY DIAGNOSTIC function, not the governed `vto-generate`, with
 *   synthetic random-noise input, and section 5 records the governed
 *   function's own result path as "not yet exercised inside the deployed
 *   vto-generate function itself". The last observed result on the governed
 *   staging path was `rate_limited` / `submit_http_429`
 *   (docs/vto-live-bridge-contract.md). Provider transport is therefore
 *   PROVEN; the governed customer path is not.
 *
 * Changing either value is a deliberate edit backed by new evidence, which is
 * the point of declaring it here instead of computing it.
 */
export const VTO_RUNTIME_PROOF: Readonly<Record<'LIVE_LOCAL' | 'PHOTOREAL_STILL', VtoModeStatus>> =
  Object.freeze({
    LIVE_LOCAL: 'SOURCE_CONNECTED_RUNTIME_UNPROVEN',
    PHOTOREAL_STILL: 'SOURCE_CONNECTED_RUNTIME_UNPROVEN',
  });

/**
 * Why a mode is not on offer. Every value is a bounded enum safe to put in
 * telemetry; none of them carries product text, a URL, or a provider string.
 */
export const VTO_MODE_REASON_CODES = [
  'INVALID_PRODUCT_REFERENCE',
  'FEATURE_DISABLED',
  'DEVICE_UNSUPPORTED',
  'NO_LIVE_ASSET',
  'UNSUPPORTED_CATEGORY',
  'NO_SAFE_GARMENT_IMAGE',
  'ACCOUNT_INELIGIBLE',
  'ENTITLEMENT_REQUIRED',
  'QUOTA_EXHAUSTED',
  'PHOTO_MODE_UNPROVEN',
  'PERMISSION_UNAVAILABLE',
] as const;
export type VtoModeReasonCode = (typeof VTO_MODE_REASON_CODES)[number];

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * Everything about the DEVICE and the OPERATOR SWITCHES. All of it is state a
 * caller already resolved; nothing here is probed by this module.
 */
export interface VtoCapabilityState {
  /** Build-time generative gate (EXPO_PUBLIC_VTO_UI_ENABLED), already read. */
  photoFeatureEnabled: boolean;
  /** Operator switch for the generative path (app_config row), already read. */
  photoRemoteEnabled: boolean;
  /** Build-time Live gate (EXPO_PUBLIC_LIVE_VTO_ENABLED), already read. */
  liveFeatureEnabled: boolean;
  /** Operator switch for Live (same app_config row), already read. */
  liveRemoteEnabled: boolean;
  /** Cached native self-check -- services/vto/vtoCapabilityCache.ts. */
  nativeCapability: LiveVtoNativeCapability;
  /** Read, never prompted. 'undetermined' is NOT disqualifying. */
  cameraPermission: VtoCameraPermissionState;
  platformOS: string;
  /** Generative category allow-list in force. */
  photoSupportedCategories?: readonly string[];
  /** Live category allow-list in force. */
  liveSupportedCategories?: readonly string[];
  /** Governed Live asset registry. Test injection only; production callers
   *  never pass it and get the real bundled registry. */
  liveAssetRegistry?: readonly LiveVtoGovernedAssetEntry[];
}

/** Quota is SERVER-OWNED. The client knows it only where the server has
 *  already told it -- today, through a `rate_limited` refusal on this
 *  session. 'unknown' is the honest default and never blocks entry. */
export type VtoQuotaState = 'available' | 'exhausted' | 'unknown';

/**
 * Everything about the ACTOR. Preserves the existing K+ policy exactly: VTO
 * is a K+ surface (`__tests__/kplusCoreFreeBoundary.test.js` pins
 * `components/vto/TryItOnEntry.tsx -> vto`), and nothing here invents a
 * price, a tier, or a second entitlement rule.
 */
export interface VtoEntitlementState {
  /** An anonymous actor has no VTO. */
  authenticated: boolean;
  /** Existing account-state gate (active / not suspended / not pending
   *  deletion). Unresolved reads as NOT active. */
  accountActive: boolean;
  /** Resolved K+ state. Any unresolved state must arrive here as false. */
  hasEntitlement: boolean;
  /** False while entitlement is still loading, so a spinner is never
   *  reported to the customer as an upgrade prompt. */
  entitlementResolved: boolean;
  quota?: VtoQuotaState;
}

// ─── Decision ────────────────────────────────────────────────────────────────

export interface VtoModeDecision {
  mode: VtoMode;
  status: VtoModeStatus;
  /** Null only when a mode IS on offer. */
  reasonCode: VtoModeReasonCode | null;
  /** The verified commerce reference this decision is about. */
  productRef: string | null;
  /** Present only for LIVE_LOCAL: the exact governed bundled asset. */
  liveAssetKey?: string;
  /** Present when a verified https garment image exists. In-process only --
   *  never emitted to telemetry (see services/vto/vtoTelemetry.ts). */
  garmentImageRef?: string;
  /** Canonical K Scan category token, when the category canonicalizes. */
  supportedCategory?: string;
  /**
   * Why LIVE specifically is not on offer, even when the decision itself is
   * PHOTOREAL_STILL. Reported separately so Live-coverage roadmap counting
   * (`NO_LIVE_ASSET`) is never hidden behind a product that happens to have a
   * working photo path -- and so the primary distribution is not gamed by
   * folding two different questions into one number.
   */
  liveReasonCode: VtoModeReasonCode | null;
  /**
   * The Live half's own router answer, carried through unchanged so the Live
   * surface consumes the SAME object this authority decided on rather than
   * asking the router a second time.
   */
  capability: VtoCapability;
  /** True when the ONLY thing standing between this actor and a usable mode
   *  is K+. The one ineligibility worth converting on rather than hiding. */
  upgradeOpportunity: boolean;
}

const DEFAULT_QUOTA: VtoQuotaState = 'unknown';

/** Live ineligibility mapped onto the reported vocabulary. */
function liveReasonFor(
  resolution: ReturnType<typeof resolveLiveGarment>,
  capability: VtoCapability,
): VtoModeReasonCode {
  // A device/flag problem outranks a garment problem: it is true of every
  // product, so reporting the garment would name the smaller cause.
  if (!capability.liveAvailable) {
    switch (capability.reason) {
      case 'feature_disabled':
        return 'FEATURE_DISABLED';
      case 'device_unsupported':
      case 'native_module_missing':
      case 'runtime_unavailable':
        return 'DEVICE_UNSUPPORTED';
      case 'permission_unavailable':
        return 'PERMISSION_UNAVAILABLE';
      default:
        break;
    }
  }
  switch (resolution.status) {
    case 'ELIGIBLE':
      return 'DEVICE_UNSUPPORTED';
    case 'NOT_FOUND':
      return 'NO_LIVE_ASSET';
    case 'ERROR':
      return 'NO_LIVE_ASSET';
    case 'INELIGIBLE':
      switch (resolution.reason) {
        case 'unsupported_category':
          return 'UNSUPPORTED_CATEGORY';
        case 'missing_garment_image':
          return 'NO_SAFE_GARMENT_IMAGE';
        case 'invalid_product_reference':
          return 'INVALID_PRODUCT_REFERENCE';
        case 'asset_not_found':
        case 'asset_not_eligible':
        case 'resolution_error':
        default:
          return 'NO_LIVE_ASSET';
      }
  }
}

/**
 * THE decision.
 *
 * Order is deliberate and mirrors the existing authorities rather than
 * inventing a new precedence:
 *
 *   1. product identity  -- a try-on of nothing is not a try-on
 *   2. actor             -- an anonymous or inactive account has no VTO
 *   3. entitlement       -- the EXISTING K+ policy, unchanged and un-priced
 *   4. LIVE              -- local, exact governed asset only, no provider
 *   5. PHOTOREAL         -- the existing generative rule, then quota
 *   6. UNAVAILABLE       -- reported with the blocker that is actually true
 *
 * LIVE IS TRIED BEFORE PHOTOREAL because it is the local, non-billable,
 * lower-latency experience and because it does not depend on the generative
 * operator switch at all. It is NOT tried first in order to widen anything:
 * step 4 still demands an EXACT governed asset for this exact productRef and
 * substitutes nothing (services/vto/vtoLiveGarment.ts).
 */
export function resolveVtoMode(
  garment: VtoGarmentInput | null | undefined,
  capabilityState: VtoCapabilityState,
  entitlementState: VtoEntitlementState,
): VtoModeDecision {
  const photoSupported =
    capabilityState.photoSupportedCategories ?? DEFAULT_VTO_SUPPORTED_CATEGORIES;
  const liveSupported =
    capabilityState.liveSupportedCategories ?? DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES;
  const quota = entitlementState.quota ?? DEFAULT_QUOTA;

  const productRef =
    garment && typeof garment.productRef === 'string' && garment.productRef.trim()
      ? garment.productRef.trim()
      : null;

  const canonical = toCanonicalVtoCategory(garment?.category);
  const supportedCategory = canonical || undefined;

  const actorUsable = entitlementState.authenticated && entitlementState.accountActive;

  // The Live garment resolution, from the authority that owns it. A registry
  // lookup and two string comparisons -- no I/O, no image bytes.
  const liveResolution = resolveLiveGarment({
    garment,
    supportedCategories: liveSupported,
    registry: capabilityState.liveAssetRegistry,
  });

  // The generative rule, asked with entitlement GRANTED so it reports the
  // ITEM's shape rather than the ACTOR's wallet. Entitlement is applied once,
  // below, to whichever mode wins -- not twice, in two places, with two
  // answers that could disagree.
  const photoShapeEligibility = evaluateVtoEligibility({
    category: garment?.category,
    imageUrl: garment?.imageUrl,
    productRef: garment?.productRef,
    featureEnabled: capabilityState.photoFeatureEnabled && capabilityState.photoRemoteEnabled,
    hasEntitlement: true,
    supportedCategories: photoSupported,
  });

  // What the generative path is actually worth to THIS actor right now. The
  // router is handed this rather than the shape answer, so a capability
  // object carried into the Live surface can never claim an AI Photo fallback
  // the actor cannot use.
  const photoAvailableForActor =
    photoShapeEligibility.eligible
    && actorUsable
    && entitlementState.hasEntitlement
    && quota !== 'exhausted';

  const capability = resolveVtoCapability({
    aiPhotoAvailable: photoAvailableForActor,
    liveFeatureEnabled: capabilityState.liveFeatureEnabled,
    liveRemoteEnabled: capabilityState.liveRemoteEnabled,
    nativeCapability: capabilityState.nativeCapability,
    garmentLiveEligible: liveResolution.status === 'ELIGIBLE',
    cameraPermission: capabilityState.cameraPermission,
    platformOS: capabilityState.platformOS,
  });

  const liveReasonCode = capability.liveAvailable
    ? null
    : liveReasonFor(liveResolution, capability);

  const garmentImageRef =
    liveResolution.status === 'ELIGIBLE'
      ? liveResolution.descriptor.imageUrl
      : photoShapeEligibility.eligible && typeof garment?.imageUrl === 'string'
        ? garment.imageUrl.trim()
        : undefined;

  const base = {
    productRef,
    supportedCategory,
    garmentImageRef,
    liveReasonCode,
    capability,
  };

  const unavailable = (
    reasonCode: VtoModeReasonCode,
    upgradeOpportunity = false,
  ): VtoModeDecision => ({
    ...base,
    mode: 'UNAVAILABLE',
    status: 'UNAVAILABLE',
    reasonCode,
    upgradeOpportunity,
  });

  /**
   * The blocker for an item with no reachable mode.
   *
   * The generative path is the broader of the two, so its reason is the one
   * that describes the item: reporting Live's NO_LIVE_ASSET for a dress would
   * name a narrower fact than the one that actually decides. Live's own
   * blocker is never lost -- it is always on `liveReasonCode`.
   */
  const itemBlocker = (): VtoModeReasonCode => {
    if (photoShapeEligibility.eligible !== true) {
      switch (photoShapeEligibility.reason) {
        case 'unsupported_category':
          // A category Live CAN render, that the generative path cannot, is a
          // Live-asset problem rather than a category problem -- say which.
          return liveResolution.status === 'NOT_FOUND' ? 'NO_LIVE_ASSET' : 'UNSUPPORTED_CATEGORY';
        case 'missing_garment_image':
          return 'NO_SAFE_GARMENT_IMAGE';
        case 'invalid_product_reference':
          return 'INVALID_PRODUCT_REFERENCE';
        case 'feature_disabled':
          return liveReasonCode === 'NO_LIVE_ASSET' ? 'NO_LIVE_ASSET' : 'FEATURE_DISABLED';
        default:
          break;
      }
    }
    return liveReasonCode ?? 'FEATURE_DISABLED';
  };

  if (!productRef) return unavailable('INVALID_PRODUCT_REFERENCE');

  // An actor problem is reported before any item problem only because it
  // makes every item unavailable anyway, which is what these two are.
  if (!actorUsable) return unavailable('ACCOUNT_INELIGIBLE');

  const liveReachable = capability.liveAvailable === true;
  const photoShapeReachable = photoShapeEligibility.eligible;

  if (!entitlementState.hasEntitlement) {
    // Deliberately NOT an upgrade prompt while entitlement is still loading:
    // a spinner must never read to the customer as "you need to pay".
    if (!entitlementState.entitlementResolved) return unavailable('ENTITLEMENT_REQUIRED');
    if (liveReachable || photoShapeReachable) return unavailable('ENTITLEMENT_REQUIRED', true);
    // Not entitled AND nothing would be reachable anyway. Report the item's
    // own blocker so the roadmap counts the real cause, not the paywall.
    return unavailable(itemBlocker());
  }

  if (liveReachable && liveResolution.status === 'ELIGIBLE') {
    return {
      ...base,
      mode: 'LIVE_LOCAL',
      status: VTO_RUNTIME_PROOF.LIVE_LOCAL,
      reasonCode: null,
      liveAssetKey: liveResolution.asset.assetKey,
      upgradeOpportunity: false,
    };
  }

  if (photoShapeReachable) {
    // Quota is the last gate before the customer enters a flow that costs a
    // provider call. An exhausted quota is reported honestly rather than
    // discovered by tapping and failing.
    if (quota === 'exhausted') return unavailable('QUOTA_EXHAUSTED');
    return {
      ...base,
      mode: 'PHOTOREAL_STILL',
      status: VTO_RUNTIME_PROOF.PHOTOREAL_STILL,
      reasonCode: null,
      upgradeOpportunity: false,
    };
  }

  return unavailable(itemBlocker());
}

/** True when the surface should render a customer-visible Try On action.
 *  An UNAVAILABLE item renders NOTHING -- never a disabled or dead button --
 *  unless the single missing thing is K+, which the shared K+ surface owns. */
export function shouldRenderTryOnAction(decision: VtoModeDecision): boolean {
  return decision.mode !== 'UNAVAILABLE' || decision.upgradeOpportunity === true;
}
