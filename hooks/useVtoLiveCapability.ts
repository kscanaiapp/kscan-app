/**
 * React binding for the VTO capability router.
 *
 * ONE HOOK, ONE DECISION. Components ask this and nothing else: no component
 * reads LIVE_VTO_ENABLED, probes the native module, checks a garment category
 * against a Live allow-list, or reads a permission status. Keeping those four
 * questions in one place is the whole point of the router
 * (services/vto/vtoLiveCapability.ts); this hook only supplies it with
 * evidence and re-renders when that evidence changes.
 *
 * IT PROMPTS FOR NOTHING. The permission read here is
 * `readLiveCameraPermission`, which inspects status without putting a dialog
 * on screen, and it is skipped entirely unless every cheaper Live gate has
 * already passed -- so on a build with the flag off (which is every build
 * today) expo-camera is never even loaded by this path. The actual prompt
 * belongs to the Live entry action; see hooks/useVtoLiveSession.ts.
 *
 * NON-BLOCKING BY CONSTRUCTION. Until the permission read resolves the
 * capability simply reports Live unavailable and AI Photo carries on. There is
 * no spinner and no gate on the existing surface: an unresolved Live answer
 * must never delay the try-on the customer actually asked for.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { LIVE_VTO_ENABLED } from '../constants/featureFlags';
import {
  describeLiveVtoNativeCapability,
  isLiveVtoNativeCapable,
  LIVE_VTO_SUPPORTED_PLATFORMS,
  type LiveVtoNativeCapability,
} from '../services/vto/liveVtoNativeModule';
import { isLiveGarmentEligible } from '../services/vto/vtoLiveGarment';
import { getLiveVtoHarnessState } from '../services/vto/vtoLiveHarness';
import { readLiveCameraPermission } from '../services/vto/vtoLiveCameraPermission';
import {
  resolveVtoCapability,
  type VtoCameraPermissionState,
  type VtoCapability,
} from '../services/vto/vtoLiveCapability';
import type { VtoGarmentInput } from '../types/vto';

export interface UseVtoLiveCapabilityArgs {
  garment: VtoGarmentInput | null | undefined;
  /** The EXISTING generative availability answer, passed in rather than
   *  re-derived, so the two halves can never disagree about AI Photo. */
  aiPhotoAvailable: boolean;
  /** Live operator switch from the same remote row (useVtoAvailability). */
  liveRemoteEnabled: boolean;
  liveSupportedCategories?: readonly string[];
}

export function useVtoLiveCapability(args: UseVtoLiveCapabilityArgs): VtoCapability {
  const harness = getLiveVtoHarnessState();
  const platformOS = Platform.OS;

  const garmentLiveEligible = useMemo(
    () => isLiveGarmentEligible(args.garment, args.liveSupportedCategories),
    [args.garment, args.liveSupportedCategories],
  );

  const nativeCapability: LiveVtoNativeCapability = useMemo(
    () => harness?.nativeCapability ?? describeLiveVtoNativeCapability(),
    [harness?.nativeCapability],
  );

  // Cheap gates first. Everything below is true only when a permission read is
  // actually worth performing -- which today is never, because the flag is off.
  const worthReadingPermission =
    LIVE_VTO_ENABLED
    && args.liveRemoteEnabled === true
    && LIVE_VTO_SUPPORTED_PLATFORMS.includes(platformOS)
    && isLiveVtoNativeCapable(nativeCapability)
    && garmentLiveEligible;

  const [permission, setPermission] = useState<VtoCameraPermissionState>('undetermined');
  const generationRef = useRef(0);

  useEffect(() => {
    if (harness) {
      setPermission(harness.cameraPermission);
      return;
    }
    if (!worthReadingPermission) {
      setPermission('undetermined');
      return;
    }
    const generation = ++generationRef.current;
    let cancelled = false;
    void readLiveCameraPermission().then((next) => {
      // A late resolution after the garment or actor changed must not decide
      // anything on the screen that replaced it.
      if (cancelled || generation !== generationRef.current) return;
      setPermission(next);
    });
    return () => {
      cancelled = true;
    };
  }, [harness, worthReadingPermission]);

  return useMemo(
    () =>
      resolveVtoCapability({
        aiPhotoAvailable: args.aiPhotoAvailable === true,
        liveFeatureEnabled: LIVE_VTO_ENABLED,
        liveRemoteEnabled: args.liveRemoteEnabled === true,
        nativeCapability,
        garmentLiveEligible,
        cameraPermission: permission,
        platformOS,
      }),
    [args.aiPhotoAvailable, args.liveRemoteEnabled, garmentLiveEligible, nativeCapability, permission, platformOS],
  );
}
