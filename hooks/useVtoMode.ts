/**
 * THE React binding for the VTO mode authority.
 *
 * ONE HOOK, ONE DECISION, EVERY SURFACE. A customer surface asks this and
 * nothing else. It does not read a feature flag, probe the native module,
 * check a category, look up an asset, read a permission, or compose two
 * eligibility answers of its own -- all of that is evidence this hook
 * gathers and hands to `resolveVtoMode`
 * (services/vto/vtoModeAuthority.ts), which is the only place the answer is
 * decided. `__tests__/vtoModeAuthority.test.js` asserts that structurally.
 *
 * IT PROMPTS FOR NOTHING AND FETCHES NO IMAGE. The camera permission is READ,
 * never requested, and only after every cheaper Live gate has already passed
 * -- so on a build with the Live flag off (which is every build today)
 * expo-camera is not loaded by this path at all. No garment image is fetched:
 * a TRY ON button that costs a network round trip to render is not a button,
 * it is a spinner.
 *
 * NON-BLOCKING BY CONSTRUCTION. Until the remote config and the permission
 * read resolve, the decision reports UNAVAILABLE and the surface renders
 * nothing -- never a spinner in a product card, and never an affordance that
 * might turn out to be dead.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { LIVE_VTO_ENABLED, VTO_UI_ENABLED } from '../constants/featureFlags';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { useKPlusEntitlement } from './useKPlusEntitlement';
import {
  DISABLED_VTO_REMOTE_CONFIG,
  getVtoRemoteConfig,
  type VtoRemoteConfig,
} from '../services/vto/vtoFeatureControl';
import { getLiveVtoCapability } from '../services/vto/vtoCapabilityCache';
import { isLiveVtoNativeCapable, LIVE_VTO_SUPPORTED_PLATFORMS } from '../services/vto/liveVtoNativeModule';
import { getLiveVtoHarnessState } from '../services/vto/vtoLiveHarness';
import { readLiveCameraPermission } from '../services/vto/vtoLiveCameraPermission';
import { resolveVtoMode, type VtoModeDecision, type VtoQuotaState } from '../services/vto/vtoModeAuthority';
import type { VtoCameraPermissionState } from '../services/vto/vtoLiveCapability';
import type { VtoGarmentInput } from '../types/vto';

export interface UseVtoModeArgs {
  /** The verified product reference, produced by the one shared derivation
   *  (services/vto/vtoCommerceGarment.ts). */
  garment: VtoGarmentInput | null | undefined;
  /**
   * Server-owned quota, where the client already holds an authoritative
   * answer. It does not hold one today: the quota decision lives in
   * `vto_generation_reservations` and reaches the client only as a
   * `rate_limited` REFUSAL, which is ambiguous between an exhausted user
   * quota, a duplicate in-flight request and a provider gateway 429. Guessing
   * from an ambiguous code would hide a working Try On after a transient
   * provider blip, so the honest default is 'unknown' and the resolver gate
   * is wired and tested for the day an unambiguous signal exists.
   */
  quota?: VtoQuotaState;
}

export function useVtoMode(args: UseVtoModeArgs): VtoModeDecision {
  const { isAuthenticated } = useAuthSession();
  const { isActive: hasKPlus, state: kplusState } = useKPlusEntitlement();
  const harness = getLiveVtoHarnessState();
  const platformOS = Platform.OS;

  const [config, setConfig] = useState<VtoRemoteConfig | null>(null);
  const configGenerationRef = useRef(0);

  useEffect(() => {
    if ((!VTO_UI_ENABLED && !LIVE_VTO_ENABLED) || !isAuthenticated) {
      setConfig(DISABLED_VTO_REMOTE_CONFIG);
      return;
    }
    const generation = ++configGenerationRef.current;
    let cancelled = false;
    void getVtoRemoteConfig().then((next) => {
      // A late resolution after an actor change or unmount must not enable an
      // affordance on somebody else's screen.
      if (cancelled || generation !== configGenerationRef.current) return;
      setConfig(next);
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // Cached self-check, not a per-render bridge call. See
  // services/vto/vtoCapabilityCache.ts.
  const nativeCapability = useMemo(
    () => harness?.nativeCapability ?? getLiveVtoCapability(),
    [harness?.nativeCapability],
  );

  const liveRemoteEnabled = config?.liveEnabled === true;
  const liveSupportedCategories = config?.liveSupportedCategories;

  // Cheap gates first: the permission read happens only when every other Live
  // gate has already passed, which today is never.
  const worthReadingPermission =
    LIVE_VTO_ENABLED
    && liveRemoteEnabled
    && LIVE_VTO_SUPPORTED_PLATFORMS.includes(platformOS)
    && isLiveVtoNativeCapable(nativeCapability);

  const [permission, setPermission] = useState<VtoCameraPermissionState>('undetermined');
  const permissionGenerationRef = useRef(0);

  useEffect(() => {
    if (harness) {
      setPermission(harness.cameraPermission);
      return;
    }
    if (!worthReadingPermission) {
      setPermission('undetermined');
      return;
    }
    const generation = ++permissionGenerationRef.current;
    let cancelled = false;
    void readLiveCameraPermission().then((next) => {
      if (cancelled || generation !== permissionGenerationRef.current) return;
      setPermission(next);
    });
    return () => {
      cancelled = true;
    };
  }, [harness, worthReadingPermission]);

  const quota = args.quota ?? 'unknown';
  const garment = args.garment;

  return useMemo(
    () =>
      resolveVtoMode(
        garment,
        {
          photoFeatureEnabled: VTO_UI_ENABLED,
          photoRemoteEnabled: config?.enabled === true,
          liveFeatureEnabled: LIVE_VTO_ENABLED,
          liveRemoteEnabled,
          nativeCapability,
          cameraPermission: permission,
          platformOS,
          photoSupportedCategories: config?.supportedCategories,
          liveSupportedCategories,
        },
        {
          authenticated: isAuthenticated === true,
          // The account-state gate is SERVER-AUTHORITATIVE
          // (`assertAccountActive` in supabase/functions/vto-generate). The
          // client holds no suspension / pending-deletion signal, so the most
          // it can honestly assert is that a session exists. The resolver
          // keeps this a separate input so that when a client-side signal
          // does arrive it is wired in exactly one place.
          accountActive: isAuthenticated === true,
          hasEntitlement: hasKPlus === true,
          entitlementResolved: kplusState !== 'loading' && config !== null,
          quota,
        },
      ),
    [
      config,
      garment,
      hasKPlus,
      isAuthenticated,
      kplusState,
      liveRemoteEnabled,
      liveSupportedCategories,
      nativeCapability,
      permission,
      platformOS,
      quota,
    ],
  );
}
