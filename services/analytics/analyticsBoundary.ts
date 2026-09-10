/**
 * PH35-R3 — the runtime analytics boundary.
 *
 * Every payload reaching the vendor passes through here. Nothing else in the
 * app may call the PostHog SDK, so this is the last and only gate.
 *
 * WHY IT EXISTS EVEN THOUGH THE SINKS ALREADY VALIDATE: the five feature
 * telemetry modules each enforce their own event and property allowlist, and
 * they do it well. But the adapter's bridge target was an exported function
 * with no runtime contract of its own, so anything holding a reference to it
 * could send an arbitrary event name and an arbitrary object straight to
 * `posthog.capture` — measured, not assumed: a probe pushed free text, a
 * signed URL, an email, a JWT, a UUID, a base64 data URI, a file path, a
 * nested object, an array of user content and a raw stack trace, and all of
 * it crossed verbatim. A sixth sink with no allowlist already exists in the
 * tree (style-chat/eliseVisualAttachmentTelemetry.ts) and is one line away
 * from being bridged.
 *
 * This module makes that structurally impossible rather than merely
 * discouraged. It duplicates some of what the sinks already do; that
 * redundancy is the point — the sinks are the first line and are free to be
 * stricter, this is the floor nothing gets under.
 *
 * DESIGN: explicit allowlists and simple shape rules, not a privacy engine.
 * Unknown event -> the whole event is dropped. Unknown property -> stripped.
 * Unsafe value -> stripped. Analytics never throws into product code.
 */

import { ANALYTICS_EVENT_REGISTRY } from './analyticsEventRegistry';

export type AnalyticsPrimitive = string | number | boolean | null;

/**
 * A governed value looks like an enum, a bucket or a bounded code. The shape
 * cannot express a URL or URI (no `/`), an email (no `@`), a query string
 * (no `?` or `&`), a file path, whitespace-separated prose, or a newline —
 * which is what keeps free text, stack traces and media paths out by
 * construction rather than by pattern-matching each one.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Shapes that survive SAFE_TOKEN but must still never be sent. Each one is an
 * identifier or opaque blob, not a bounded product dimension.
 */
const REJECTED_SHAPES: readonly RegExp[] = [
  // UUID — a Supabase user id, item id or session id would pass SAFE_TOKEN.
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // JWT / signed token — dots and base64url also pass SAFE_TOKEN.
  /^ey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/,
  // Long opaque blob: base64-ish or hex with no word structure. Real enum and
  // bucket values are short and readable; this is not.
  /^[A-Za-z0-9+/=]{40,}$/,
  /^[0-9a-f]{32,}$/i,
];

function isSafeString(value: string): boolean {
  if (!SAFE_TOKEN.test(value)) return false;
  return !REJECTED_SHAPES.some((shape) => shape.test(value));
}

/**
 * Returns the value if it may be sent, or `undefined` if it must be stripped.
 * Objects and arrays are always stripped: a nested structure is unbounded by
 * definition and cannot be reviewed by an allowlist.
 */
export function sanitizeAnalyticsValue(value: unknown): AnalyticsPrimitive | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return isSafeString(value) ? value : undefined;
  return undefined;
}

export interface AnalyticsBoundaryResult {
  allowed: boolean;
  /** Reason the event was dropped entirely. Absent when `allowed`. */
  reason?: 'unknown_event' | 'invalid_event_name';
  payload: Record<string, AnalyticsPrimitive>;
  /** Property keys removed, for tests and local diagnosis. */
  strippedKeys: string[];
}

/**
 * Validate one event against the registry. Callers get a payload containing
 * only registered properties carrying values that survived the sanitizer.
 */
export function applyAnalyticsBoundary(
  event: unknown,
  payload: unknown,
): AnalyticsBoundaryResult {
  const empty = { payload: {}, strippedKeys: [] as string[] };

  if (typeof event !== 'string' || event.length === 0) {
    return { allowed: false, reason: 'invalid_event_name', ...empty };
  }

  const registered = ANALYTICS_EVENT_REGISTRY.get(event);
  if (!registered) {
    // Fail closed: an unregistered event is dropped whole, not forwarded
    // with its properties stripped. A name nobody reviewed is itself data.
    return { allowed: false, reason: 'unknown_event', ...empty };
  }

  const safe: Record<string, AnalyticsPrimitive> = {};
  const strippedKeys: string[] = [];

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (!registered.properties.has(key)) {
        strippedKeys.push(key);
        continue;
      }
      const sanitized = sanitizeAnalyticsValue(value);
      if (sanitized === undefined) {
        strippedKeys.push(key);
        continue;
      }
      safe[key] = sanitized;
    }
  }

  return { allowed: true, payload: safe, strippedKeys };
}

/** Test seam only. Not used by production code. */
export const __analyticsBoundaryInternals = { SAFE_TOKEN, REJECTED_SHAPES, isSafeString };
