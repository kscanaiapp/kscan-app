/**
 * THE VTO capability router.
 *
 * One authoritative decision layer for "which try-on modes may this customer
 * use for this item, right now". Every VTO surface asks this and nothing
 * re-derives any part of it: no component may consult the Live flag, probe the
 * native module, or check a garment category on its own. That rule is what
 * keeps the Live and AI Photo answers from drifting apart per screen, and it
 * is asserted structurally in __tests__/vtoLiveCapabilityRouter.test.js.
 *
 * PURE AND SYNCHRONOUS. Every input is evidence a caller already resolved --
 * a flag, a remote-config answer, a native self-check, an eligibility result,
 * a permission status. The router performs no I/O, so it cannot decide
 * something is available while a probe is still outstanding, and it can be
 * exhaustively tested over the whole customer state matrix without a device.
 *
 * FAIL CLOSED. Every unresolved, unknown, or malformed input reads as "no
 * Live". The consequence of being wrong in that direction is that a customer
 * gets today's shipped AI Photo experience; the consequence of being wrong in
 * the other direction is a broken Live surface where a working feature used to
 * be. Those are not symmetric.
 *
 * PERMISSION IS NOT PROBED HERE. A permission status is an INPUT, and
 * 'undetermined' is explicitly still Live-capable: the camera prompt belongs
 * at the moment the customer chooses Live, never at the moment they open Try
 * It On. See services/vto/vtoLiveCameraPermission.ts.
 */

import {
  isLiveVtoNativeCapable,
  LIVE_VTO_SUPPORTED_PLATFORMS,
  type LiveVtoNativeCapability,
} from './liveVtoNativeModule';

/** Why Live is not on offer. Ordered from most fundamental to most local; the
 *  router reports the FIRST that applies, so the reason names the real cause
 *  rather than the last check that happened to run. */
export const VTO_LIVE_UNAVAILABLE_REASONS = [
  'feature_disabled',
  'device_unsupported',
  'native_module_missing',
  'runtime_unavailable',
  'garment_unsupported',
  'permission_unavailable',
] as const;
export type VtoLiveUnavailableReason = (typeof VTO_LIVE_UNAVAILABLE_REASONS)[number];

export type VtoCameraPermissionState =
  | 'granted'
  | 'denied'
  | 'undetermined'
  | 'unavailable';

export type VtoCapabilityMode = 'live' | 'ai_photo' | 'unavailable';

/**
 * `evidenceSource` records WHERE the Live answer came from. 'harness' can only
 * ever appear in a development build with the harness explicitly activated
 * (constants/featureFlags.ts#LIVE_VTO_HARNESS_ENABLED folds to false in a
 * release build), and the Photoreal handoff refuses to run under it. A
 * simulated capability is therefore visible to every consumer rather than
 * masquerading as native evidence.
 */
export type VtoCapabilityEvidenceSource = 'native' | 'harness';

/** Derived from the capability's own provenance rather than from a caller's
 *  declaration, so a simulated answer cannot be laundered into a native one by
 *  a consumer that simply forgets to pass the flag. */
function evidenceSourceOf(nativeCapability: LiveVtoNativeCapability): VtoCapabilityEvidenceSource {
  return nativeCapability?.provenance === 'simulated' ? 'harness' : 'native';
}

export type VtoCapability =
  | {
      mode: 'live';
      liveAvailable: true;
      aiPhotoAvailable: boolean;
      reason: null;
      evidenceSource: VtoCapabilityEvidenceSource;
    }
  | {
      mode: 'ai_photo';
      liveAvailable: false;
      aiPhotoAvailable: true;
      reason: VtoLiveUnavailableReason;
      evidenceSource: VtoCapabilityEvidenceSource;
    }
  | {
      mode: 'unavailable';
      liveAvailable: false;
      aiPhotoAvailable: false;
      reason: VtoLiveUnavailableReason;
      evidenceSource: VtoCapabilityEvidenceSource;
    };

export interface VtoCapabilityInput {
  /** Result of the EXISTING generative eligibility chain (build flag, remote
   *  config, K+ entitlement, garment eligibility). Not re-derived here. */
  aiPhotoAvailable: boolean;
  /** Build-time Live gate (EXPO_PUBLIC_LIVE_VTO_ENABLED). */
  liveFeatureEnabled: boolean;
  /** Operator kill switch, read from the existing vto_generation app_config
   *  row. Defaults to false wherever the row is unreadable or silent. */
  liveRemoteEnabled: boolean;
  /** Conservative native self-check answer. */
  nativeCapability: LiveVtoNativeCapability;
  /** Can the Live runtime render THIS garment (services/vto/vtoLiveGarment.ts). */
  garmentLiveEligible: boolean;
  /**
   * Optional, additive signal from an offline garment-asset preparation
   * pipeline (see vto-phase4-pipeline/, a local/batch tool -- not a runtime
   * dependency of this app and not wired to any caller yet): whether that
   * pipeline judged THIS specific product's Live asset usable. Absent
   * (`undefined`) everywhere today, which preserves every existing caller's
   * behavior exactly -- this field only ever narrows availability, and only
   * when a caller explicitly passes `false`. A prepared asset existing is
   * NOT the same thing as Live being reachable (task section 52): every
   * other gate above still applies first.
   */
  garmentLiveAssetEligible?: boolean;
  /** Current camera permission. 'undetermined' is NOT disqualifying. */
  cameraPermission: VtoCameraPermissionState;
  platformOS: string;
}

/**
 * Resolves the Live half only. Split out so the reason ladder is readable and
 * so the mode assembly below has exactly one thing to decide.
 */
function resolveLiveReason(input: VtoCapabilityInput): VtoLiveUnavailableReason | null {
  // A disabled feature is reported as disabled even on a device that could
  // never run it -- otherwise turning the flag on later would look like a
  // device regression rather than the rollout it is.
  if (input.liveFeatureEnabled !== true) return 'feature_disabled';
  if (input.liveRemoteEnabled !== true) return 'feature_disabled';

  if (!LIVE_VTO_SUPPORTED_PLATFORMS.includes(input.platformOS)) return 'device_unsupported';

  const native = input.nativeCapability;
  if (!native || native.present !== true) return 'native_module_missing';
  // Present but the device itself cannot run it.
  if (native.capable !== true) return 'device_unsupported';
  // Capable device, but the runtime's own resources are not ready (no model,
  // failed initialization). This is the case a registration-only check misses.
  if (!isLiveVtoNativeCapable(native)) return 'runtime_unavailable';

  if (input.garmentLiveEligible !== true) return 'garment_unsupported';
  // Additive: only an explicit `false` from the asset-eligibility signal
  // disqualifies. `undefined` (every caller today) changes nothing.
  if (input.garmentLiveAssetEligible === false) return 'garment_unsupported';

  // Only an explicit refusal (or a device with no camera) disqualifies.
  // 'undetermined' stays capable: the prompt happens on Live entry.
  if (input.cameraPermission === 'denied' || input.cameraPermission === 'unavailable') {
    return 'permission_unavailable';
  }

  return null;
}

/**
 * The single entry point. Returns the complete customer-facing answer:
 * which mode the surface should present, what remains available, and -- when
 * Live is not on offer -- exactly why.
 */
export function resolveVtoCapability(input: VtoCapabilityInput): VtoCapability {
  const evidenceSource = evidenceSourceOf(input.nativeCapability);
  const liveReason = resolveLiveReason(input);
  const aiPhotoAvailable = input.aiPhotoAvailable === true;

  if (liveReason === null) {
    return { mode: 'live', liveAvailable: true, aiPhotoAvailable, reason: null, evidenceSource };
  }

  if (aiPhotoAvailable) {
    return {
      mode: 'ai_photo',
      liveAvailable: false,
      aiPhotoAvailable: true,
      reason: liveReason,
      evidenceSource,
    };
  }

  return {
    mode: 'unavailable',
    liveAvailable: false,
    aiPhotoAvailable: false,
    reason: liveReason,
    evidenceSource,
  };
}

/**
 * Should the surface show a MODE CHOICE at all?
 *
 * True only when both modes are genuinely usable. This is the predicate that
 * keeps a disabled/dead Live option off a normal customer's screen: when Live
 * is unavailable for any reason, the sheet renders exactly the AI Photo
 * experience it renders today, with no extra chrome, no "coming soon", and no
 * greyed-out tab.
 */
export function shouldOfferModeChoice(capability: VtoCapability): boolean {
  return capability.liveAvailable === true && capability.aiPhotoAvailable === true;
}

/** The mode a surface should open on. Live leads when it is available, per the
 *  product intent; AI Photo is the answer in every other case. */
export function defaultVtoMode(capability: VtoCapability): 'live' | 'ai_photo' {
  return capability.liveAvailable === true ? 'live' : 'ai_photo';
}
