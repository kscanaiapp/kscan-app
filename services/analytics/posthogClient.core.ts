/**
 * PostHog wiring — the ONLY file in this app that imports `posthog-react-native`.
 * Every feature keeps emitting through its own allowlisted, scrubbed telemetry
 * sink (see BRIDGED_SINKS below) — this module only supplies the sink those
 * modules forward already-scrubbed events to. Nothing outside this file (and
 * its JSX sibling, posthogClient.tsx, which re-exports everything here plus
 * the one Provider component) may import `posthog-react-native` directly.
 *
 * Split from posthogClient.tsx so this half — the client, the bridge, the
 * identity sync — has zero JSX and can be `require()`d directly by tests and
 * verification scripts under plain Node (Node's built-in TypeScript support
 * strips type annotations but cannot parse JSX). Only `PostHogAnalyticsProvider`
 * lives in the .tsx sibling.
 *
 * V1 SCOPE — PRODUCT ANALYTICS ONLY. Explicitly OFF: UI autocapture (screens/
 * touches, set on the Provider in posthogClient.tsx), session replay,
 * exception/error autocapture, native crash capture, remote feature flags,
 * experiments, surveys. Sentry (not this file) remains K Scan's engineering/
 * error-observability channel; PostHog is not a second one. Session replay in
 * particular stays off because this app photographs faces, bodies (Virtual
 * Try-On) and freeform StyleChat text — enabling screen recording needs a
 * masking policy reviewed against those surfaces first, not just the SDK's
 * generic defaults.
 *
 * CONFIGURATION — env-only, no fallback. EXPO_PUBLIC_POSTHOG_API_KEY and
 * EXPO_PUBLIC_POSTHOG_HOST are the sole configuration authority; this file
 * must never hardcode a project token or host. Either one absent (or empty)
 * means POSTHOG ENABLED = FALSE and the app runs exactly as it would without
 * PostHog — every exported function here degrades to a safe no-op.
 *
 * CONSENT — none reinterpreted. `opt_out_of_sale` (contexts/
 * PrivacyPreferencesContext.tsx) is a CCPA/CPRA "don't sell my data" flag,
 * not a general analytics-consent switch, and this module does not read it,
 * call `optIn`/`optOut`, or gate capture on it. K Scan has no dedicated
 * analytics/telemetry consent authority today (searched: no
 * analytics_consent / telemetry_consent / tracking_consent field exists
 * anywhere in the app or schema) — so this ships as an unconditional
 * first-party-analytics posture once configured, which is a decision that
 * needs explicit legal/privacy sign-off, not something this module invents
 * silently. If K Scan later adds a real consent authority, wire it here;
 * until then, do not route any existing unrelated preference through this
 * file.
 */

import PostHog, { PostHogProvider } from 'posthog-react-native';

import { syncPostHogIdentityWith } from './posthogIdentitySync';
import { setClosetTelemetrySink } from '../closetTelemetry';
import { setKPlusAnalyticsSink } from '../kplus/kplusTelemetry';
import { setTodayWithEliseAnalyticsSink } from '../todayWithElise/analytics';
import { setVoiceAnalyticsSink } from '../voice/voiceTelemetry';
import { setVtoAnalyticsSink } from '../vto/vtoTelemetry';

export { PostHogProvider };

function resolveApiKey(): string {
  return process.env.EXPO_PUBLIC_POSTHOG_API_KEY ?? '';
}

function resolveHost(): string {
  return process.env.EXPO_PUBLIC_POSTHOG_HOST ?? '';
}

export function isPostHogConfigured(): boolean {
  return resolveApiKey().length > 0 && resolveHost().length > 0;
}

function createClient(): PostHog | null {
  if (!isPostHogConfigured()) return null;
  try {
    return new PostHog(resolveApiKey(), {
      host: resolveHost(),
      captureAppLifecycleEvents: true,
      // V1 = product analytics only. Every autocapture surface is explicit
      // and off — see the module header for why each one is off. UI
      // autocapture (screens/touches) is set on the Provider itself, in
      // posthogClient.tsx: `autocapture={false}`.
      enableSessionReplay: false,
      errorTracking: {
        autocapture: false,
      },
      disableRemoteFeatureFlags: true,
      preloadFeatureFlags: false,
      disableSurveys: true,
      // No consent authority exists yet (see module header) — this ships as
      // an unconditional first-party posture once configured, pending
      // legal/privacy review. Not coupled to any existing preference.
      defaultOptIn: true,
    });
  } catch {
    return null;
  }
}

export const posthog: PostHog | null = createClient();

/** Generic bridge target for every feature telemetry module's `setXSink`. */
export function forwardTelemetryToPostHog(
  event: string,
  payload: Record<string, string | number | boolean | null> = {},
): void {
  if (!posthog) return;
  try {
    posthog.capture(event, payload);
  } catch {
    /* analytics never propagates */
  }
}

/**
 * The five sinks bridged in V1. `services/style-chat/
 * eliseVisualAttachmentTelemetry.ts` is DELIBERATELY EXCLUDED — unlike its
 * siblings it has no event-name allowlist and its `resolutionOutcome`/
 * `transportOutcome`/etc. properties pass through as raw, unscrubbed strings
 * (one real call site forwards a raw backend `errorCode` as
 * `resolutionOutcome` with no allowlist check). Bridging it as-is would be
 * the first time that unscrubbed value leaves the device. It stays wired to
 * its default (inert, `sink === null`) until it gets the same two-allowlist
 * discipline as the other five — see the sink inventory in the PR
 * description for the full audit.
 */
const SINK_SETTERS = [
  setClosetTelemetrySink,
  setKPlusAnalyticsSink,
  setTodayWithEliseAnalyticsSink,
  setVoiceAnalyticsSink,
  setVtoAnalyticsSink,
];

let bridged = false;

/**
 * Wires the five safe feature telemetry sinks to PostHog. Idempotent and
 * safe to call before the client exists — it just bridges to a no-op.
 */
export function bridgeAllTelemetrySinks(): void {
  if (bridged) return;
  for (const setSink of SINK_SETTERS) {
    (setSink as (sink: typeof forwardTelemetryToPostHog | null) => void)(
      forwardTelemetryToPostHog,
    );
  }
  bridged = true;
}

export function unbridgeAllTelemetrySinks(): void {
  if (!bridged) return;
  for (const setSink of SINK_SETTERS) {
    (setSink as (sink: typeof forwardTelemetryToPostHog | null) => void)(null);
  }
  bridged = false;
}

export function identifyPostHogUser(userId: string): void {
  if (!posthog) return;
  try {
    posthog.identify(userId);
  } catch {
    /* identity sync never propagates */
  }
}

export function resetPostHogUser(): void {
  if (!posthog) return;
  try {
    posthog.reset();
  } catch {
    /* identity sync never propagates */
  }
}

export function syncPostHogIdentity(userId: string | null): void {
  try {
    syncPostHogIdentityWith(posthog, userId);
  } catch {
    /* identity sync never propagates */
  }
}
