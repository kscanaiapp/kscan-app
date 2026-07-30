/**
 * Build 5 — Today with Elise V1 analytics (allowlisted sink).
 *
 * Patterned after services/closetTelemetry.ts. NOT a second analytics SDK
 * vendor. Allowlisted events + properties only. Failures never propagate.
 *
 * Primary funnel:
 *   impression → primary_action → dressing_room_opened → look_modified|saved → later return
 *
 * Card tap rate alone is not success.
 */

export const TODAY_WITH_ELISE_EVENTS = [
  'today_with_elise_eligible',
  'today_with_elise_impression',
  'today_with_elise_primary_action',
  'today_with_elise_secondary_action',
  'today_with_elise_dismissed',
  'today_with_elise_fallback_rendered',
  'today_with_elise_dressing_room_opened',
  'today_with_elise_look_modified',
  'today_with_elise_look_saved',
  'today_with_elise_partial_look_shown',
] as const;

export type TodayWithEliseEvent = (typeof TODAY_WITH_ELISE_EVENTS)[number];

export const TODAY_WITH_ELISE_EVENT_PROPERTIES = [
  'stateId',
  'priority',
  'action',
  'completeness',
  'source',
  'analyticsClass',
  'weatherUsed',
  'platform',
  'daypart',
  'deduped',
] as const;

export type TodayWithEliseEventProperty =
  (typeof TODAY_WITH_ELISE_EVENT_PROPERTIES)[number];

export type TodayWithEliseEventPayload = Partial<
  Record<TodayWithEliseEventProperty, string | number | boolean | null>
>;

export type TodayWithEliseAnalyticsSink = (
  event: TodayWithEliseEvent,
  payload: TodayWithEliseEventPayload,
) => void;

/** Explicitly prohibited payload categories (asserted by tests). */
export const TODAY_WITH_ELISE_PROHIBITED_PAYLOADS = Object.freeze([
  'raw_prompts',
  'raw_images',
  'image_references',
  'local_file_paths',
  'freeform_user_text',
  'email',
  'access_tokens',
  'precise_location',
  'raw_wardrobe_state',
  'complete_look_contents',
  'unapproved_persistent_actor_identifiers',
  'external_raw_saved_look_ids',
] as const);

const EVENT_SET = new Set<string>(TODAY_WITH_ELISE_EVENTS);
const PROPERTY_SET = new Set<string>(TODAY_WITH_ELISE_EVENT_PROPERTIES);
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

function scrub(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return SAFE_STRING.test(value) ? value : undefined;
  return undefined;
}

function devSink(event: TodayWithEliseEvent, payload: TodayWithEliseEventPayload): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[todayWithEliseAnalytics]', event, payload);
  }
}

let sink: TodayWithEliseAnalyticsSink = devSink;

/** Impression dedupe: one impression per generationToken per process. */
const impressedGenerations = new Set<string>();

export function setTodayWithEliseAnalyticsSink(
  next: TodayWithEliseAnalyticsSink | null,
): void {
  sink = typeof next === 'function' ? next : devSink;
}

export function resetTodayWithEliseAnalyticsSink(): void {
  sink = devSink;
}

export function __resetTodayWithEliseImpressionDedupe(): void {
  impressedGenerations.clear();
}

/**
 * Emit one bounded event. Unknown names/properties dropped. No offline queue
 * (same rationale as closetTelemetry — no reusable durable queue pattern).
 */
export function emitTodayWithEliseEvent(
  event: string,
  payload: Record<string, unknown> = {},
): void {
  try {
    if (!EVENT_SET.has(event)) return;
    const safe: TodayWithEliseEventPayload = {};
    for (const [key, value] of Object.entries(payload ?? {})) {
      if (!PROPERTY_SET.has(key)) continue;
      const scrubbed = scrub(value);
      if (scrubbed === undefined) continue;
      (safe as Record<string, unknown>)[key] = scrubbed;
    }
    sink(event as TodayWithEliseEvent, safe);
  } catch {
    /* analytics never propagates */
  }
}

/**
 * Impression with generation-token dedupe. Returns whether the event emitted.
 */
export function emitTodayWithEliseImpression(args: {
  generationToken: string;
  payload?: Record<string, unknown>;
}): boolean {
  try {
    if (
      typeof args.generationToken !== 'string' ||
      !args.generationToken ||
      !SAFE_STRING.test(args.generationToken)
    ) {
      return false;
    }
    if (impressedGenerations.has(args.generationToken)) {
      emitTodayWithEliseEvent('today_with_elise_impression', {
        ...(args.payload ?? {}),
        deduped: true,
      });
      return false;
    }
    impressedGenerations.add(args.generationToken);
    emitTodayWithEliseEvent('today_with_elise_impression', {
      ...(args.payload ?? {}),
      deduped: false,
    });
    return true;
  } catch {
    return false;
  }
}

export const __todayWithEliseAnalyticsInternals = { scrub, SAFE_STRING };
