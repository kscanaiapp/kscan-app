/**
 * K+ product-funnel telemetry (allowlisted sink). Patterned after
 * services/todayWithElise/analytics.ts / services/closetTelemetry.ts --
 * NOT a second analytics SDK vendor. Failures never propagate and never
 * affect entitlement/activation business logic.
 *
 * Build 34 K+ Early Access Discovery + Measurement Shell (sections 16-23):
 * every event and every property value is bounded to a known enum. There is
 * no free-form string anywhere in this module -- an unrecognized source or
 * feature collapses to 'unknown' rather than passing through, and an
 * unrecognized entitlement_state/activation_outcome is dropped rather than
 * guessed.
 */

import { KPLUS_SOURCES, toKPlusSource, type KPlusSource } from '../../types/kplusSource';

export const KPLUS_EVENTS = [
  /** A visible K+ affordance was actually rendered to the user (section 17). */
  'kplus_feature_exposed',
  /** The user explicitly engaged Learn More / Activate K+ / a gated capability (section 18). */
  'kplus_feature_gate_opened',
  /** The shared K+ Early Access surface actually became visible (section 19). */
  'kplus_early_access_viewed',
  'kplus_activation_started',
  'kplus_activation_completed',
  'kplus_activation_failed',
  /** Only for features with a deterministic operation and completion point (section 22). */
  'kplus_feature_started',
  'kplus_feature_completed',
] as const;

export type KPlusEvent = (typeof KPLUS_EVENTS)[number];

export const KPLUS_EVENT_PROPERTIES = [
  'source',
  'feature',
  'entitlement_state',
  'activation_outcome',
] as const;

export type KPlusEventProperty = (typeof KPLUS_EVENT_PROPERTIES)[number];

export type KPlusEventPayload = Partial<Record<KPlusEventProperty, string | null>>;

export type KPlusAnalyticsSink = (event: KPlusEvent, payload: KPlusEventPayload) => void;

/** Explicitly prohibited: no email, raw UUID, freeform text, or content of
 *  any kind ever crosses this module's allowlist boundary. */
const EVENT_SET = new Set<string>(KPLUS_EVENTS);
const PROPERTY_SET = new Set<string>(KPLUS_EVENT_PROPERTIES);

const ENTITLEMENT_STATES = ['loading', 'eligible', 'active', 'expired', 'unavailable', 'error'];
const ENTITLEMENT_STATE_SET = new Set<string>(ENTITLEMENT_STATES);

const ACTIVATION_OUTCOMES = ['granted', 'already_active', 'campaign_consumed', 'failed'];
const ACTIVATION_OUTCOME_SET = new Set<string>(ACTIVATION_OUTCOMES);

/**
 * Every property value is bounded to its own enum -- section 23 ("Use
 * canonical enum-like values. No arbitrary strings."). 'source' and
 * 'feature' share the same bounded taxonomy (section 9); an unrecognized
 * value normalizes to 'unknown' rather than passing a raw string through
 * (section 33). An unrecognized entitlement_state/activation_outcome is
 * dropped entirely rather than guessed at.
 */
function scrub(key: KPlusEventProperty, value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  switch (key) {
    case 'source':
    case 'feature':
      return toKPlusSource(value);
    case 'entitlement_state':
      return ENTITLEMENT_STATE_SET.has(value) ? value : undefined;
    case 'activation_outcome':
      return ACTIVATION_OUTCOME_SET.has(value) ? value : undefined;
    default:
      return undefined;
  }
}

function devSink(event: KPlusEvent, payload: KPlusEventPayload): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[kplusAnalytics]', event, payload);
  }
}

let sink: KPlusAnalyticsSink = devSink;

export function setKPlusAnalyticsSink(next: KPlusAnalyticsSink | null): void {
  sink = typeof next === 'function' ? next : devSink;
}

export function resetKPlusAnalyticsSink(): void {
  sink = devSink;
}

export function emitKPlusEvent(event: string, payload: Record<string, unknown> = {}): void {
  try {
    if (!EVENT_SET.has(event)) return;
    const safe: KPlusEventPayload = {};
    for (const [key, value] of Object.entries(payload ?? {})) {
      if (!PROPERTY_SET.has(key)) continue;
      const scrubbed = scrub(key as KPlusEventProperty, value);
      if (scrubbed === undefined) continue;
      (safe as Record<string, unknown>)[key] = scrubbed;
    }
    sink(event as KPlusEvent, safe);
  } catch {
    /* analytics never propagates */
  }
}

export const __kplusAnalyticsInternals = {
  scrub,
  KPLUS_SOURCES,
  ENTITLEMENT_STATES,
  ACTIVATION_OUTCOMES,
};

export type { KPlusSource };
