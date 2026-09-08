// Mirror Selfie canonical availability decision (Android production repair).
//
// MIRROR_SELFIE_V1_ACTIVE (constants/featureFlags.ts) says the PRODUCT wants
// Mirror Selfie live — it is derived purely from build-time env flags and
// knows nothing about the device it ends up running on. The on-device
// person-extraction runtime it depends on is declared Apple-only
// (modules/kscan-pii-native/expo-module.config.json: "platforms": ["apple"]),
// so the flag being on is necessary but never sufficient: Android has no
// native module to call, regardless of how the flag resolves.
//
// THIS is the one place that combines both facts. Every entry point that
// decides whether to expose, navigate into, or execute Mirror Selfie must
// read the decision from here rather than from the flag alone — that is what
// keeps "supported platform" a single authority instead of a scattered set of
// `Platform.OS !== 'android'` checks.

import { Platform } from 'react-native';
import { MIRROR_SELFIE_V1_ACTIVE } from '../../constants/featureFlags';

/** Platforms whose native extraction runtime is actually linked into the build. */
export const MIRROR_SELFIE_SUPPORTED_PLATFORMS: readonly string[] = ['ios'] as const;

export function isMirrorSelfiePlatformSupported(platformOS: string = Platform.OS): boolean {
  return MIRROR_SELFIE_SUPPORTED_PLATFORMS.includes(platformOS);
}

/**
 * THE canonical Mirror Selfie availability decision.
 *
 * Both arguments default to the real, running values and exist only as a test
 * seam — no caller in application code should ever need to pass either one.
 */
export function resolveMirrorSelfieAvailable(
  flagActive: boolean = MIRROR_SELFIE_V1_ACTIVE,
  platformOS: string = Platform.OS,
): boolean {
  return flagActive === true && isMirrorSelfiePlatformSupported(platformOS);
}

/** Evaluated once at import time against the real flag and the real platform. */
export const MIRROR_SELFIE_AVAILABLE = resolveMirrorSelfieAvailable();
