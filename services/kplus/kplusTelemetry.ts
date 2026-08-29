/**
 * K+ product-funnel telemetry (allowlisted sink). Patterned after
 * services/todayWithElise/analytics.ts / services/closetTelemetry.ts --
 * NOT a second analytics SDK vendor. Failures never propagate and never
 * affect entitlement/activation business logic.
 */

export const KPLUS_EVENTS = [
  'kplus_gate_impression',
  'kplus_sheet_open',
  'kplus_activation_start',
  'kplus_activation_success',
  'kplus_activation_failure',
  'kplus_status_view',
  'kplus_expired',
  'kplus_feature_gate_open',
] as const;

export type KPlusEvent = (typeof KPLUS_EVENTS)[number];

export const KPLUS_EVENT_PROPERTIES = ['source', 'gateState', 'outcome', 'surface'] as const;

export type KPlusEventProperty = (typeof KPLUS_EVENT_PROPERTIES)[number];

export type KPlusEventPayload = Partial<Record<KPlusEventProperty, string | number | boolean | null>>;

export type KPlusAnalyticsSink = (event: KPlusEvent, payload: KPlusEventPayload) => void;

/** Explicitly prohibited: no email, raw UUID, freeform text, or content of
 *  any kind ever crosses this module's allowlist boundary. */
const EVENT_SET = new Set<string>(KPLUS_EVENTS);
const PROPERTY_SET = new Set<string>(KPLUS_EVENT_PROPERTIES);
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

function scrub(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return SAFE_STRING.test(value) ? value : undefined;
  return undefined;
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
      const scrubbed = scrub(value);
      if (scrubbed === undefined) continue;
      (safe as Record<string, unknown>)[key] = scrubbed;
    }
    sink(event as KPlusEvent, safe);
  } catch {
    /* analytics never propagates */
  }
}

export const __kplusAnalyticsInternals = { scrub, SAFE_STRING };
