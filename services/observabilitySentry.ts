import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as Sentry from '@sentry/react-native';

import {
  getProviderState,
  initializeProvider,
  resetProviderForTests,
} from './observabilitySentryPolicy';
import { setCorrelationObserver, setObservabilitySink } from './observability';

/**
 * Sentry transport binding for the Build 29 observability foundation.
 *
 * This module contains no policy. Whether monitoring runs, the identity it
 * reports under, and every field that may leave the device are decided by
 * `services/observabilitySentryPolicy.js`, which is exercised directly under
 * `node --test`. This file only supplies the real SDK and the real K Scan
 * pipeline hooks to that runtime.
 */

export type ObservabilityProviderState = {
  initialized: boolean;
  enabled: boolean;
  reason: string;
};

/**
 * Metro inlines `process.env.EXPO_PUBLIC_*` only for literal member accesses.
 * A computed lookup (`process.env[name]`) survives into the bundle as a runtime
 * read against an object that does not exist on device, which would resolve
 * every flag to `undefined` and fail OFF for the wrong reason. The snapshot is
 * therefore built from literals here and handed to the policy.
 */
function environmentSnapshot(): Record<string, string | undefined> {
  return {
    EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED: process.env.EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED,
    EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
    EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENVIRONMENT:
      process.env.EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENVIRONMENT,
  };
}

function platformBuildIdentifier(): string | null {
  const value = Platform.OS === 'ios'
    ? Constants.platform?.ios?.buildNumber
    : Platform.OS === 'android'
      ? Constants.platform?.android?.versionCode
      : null;
  return value == null ? null : String(value);
}

/**
 * Initialize the monitoring provider. Safe to call repeatedly: the runtime
 * guard performs at most one `Sentry.init` for the lifetime of the JS runtime,
 * and any failure leaves the provider disabled with the app untouched.
 */
export function initializeObservabilityProvider(): ObservabilityProviderState {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;

  return initializeProvider(
    Sentry,
    {
      env: environmentSnapshot(),
      observability: extra?.observability ?? null,
      appVersion: Constants.expoConfig?.version ?? null,
      build: platformBuildIdentifier(),
      platform: Platform.OS,
    },
    {
      // Sentry MIRRORS K Scan correlation identity; it never mints its own.
      // `tracePropagationTargets: []` additionally stops the SDK injecting
      // competing sentry-trace/baggage headers onto K Scan requests.
      onCorrelation: setCorrelationObserver,
      // The governed K Scan event pipeline is the only breadcrumb source. Its
      // payloads are already allowlisted, and `beforeBreadcrumb` re-checks
      // them. Sentry structured logs stay disabled.
      onSink: setObservabilitySink,
    },
  );
}

export function getObservabilityProviderState(): ObservabilityProviderState {
  return getProviderState();
}

/** Test-only: release the one-shot guard so init decisions can be re-exercised. */
export function resetObservabilityProviderForTests(): void {
  resetProviderForTests();
  setCorrelationObserver(null);
  setObservabilitySink(null);
}

/**
 * Wrap the governed Expo Router root. When the provider is off — the default —
 * the component is returned untouched, so the app tree is identical to a build
 * with no monitoring installed.
 */
export function withObservabilityRoot<T>(RootComponent: T): T {
  try {
    if (!getProviderState().enabled) return RootComponent;
    return Sentry.wrap(RootComponent as never) as unknown as T;
  } catch {
    return RootComponent;
  }
}
