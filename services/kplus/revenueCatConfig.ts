/**
 * K+ RevenueCat PUBLIC SDK key configuration (Build 35 Phase B).
 *
 * Application configuration only. RevenueCat PUBLIC SDK keys are designed to be
 * shipped in a client; they are still never logged by this app.
 *
 * Hard rules for this file:
 *   - Only PUBLIC SDK keys are read here. A RevenueCat REST secret key
 *     (the one the server holds) must NEVER get an EXPO_PUBLIC_
 *     name. resolveKPlusRevenueCatConfig() also refuses any "sk_" value that
 *     reaches these variables.
 *   - The accesses are written out literally (process.env.EXPO_PUBLIC_...) so
 *     Metro can inline them at build time. Do not turn them into a dynamic
 *     lookup.
 *   - No value is defaulted. Absent means NOT_CONFIGURED, never a fallback key.
 *   - This is independent of EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED, which
 *     governs only legacy complimentary acquisition.
 *
 * Live values are an owner / EAS-environment matter and are not set by this
 * repository.
 */
import type { KPlusRevenueCatPublicKeys } from '../../types/kplusCommerceContract';

export function readRevenueCatPublicKeysFromEnv(): KPlusRevenueCatPublicKeys {
  return {
    ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_PUBLIC_SDK_KEY,
    android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_PUBLIC_SDK_KEY,
  };
}

/** A RevenueCat Test Store key ("test_...") may only be used by a development build. */
export const KPLUS_ALLOW_REVENUECAT_TEST_STORE_KEY: boolean = typeof __DEV__ !== 'undefined' && __DEV__ === true;
