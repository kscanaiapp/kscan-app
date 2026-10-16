/**
 * VTO operational telemetry (allowlisted sink).
 *
 * Patterned on services/kplus/kplusTelemetry.ts -- NOT a second analytics
 * vendor. Failures never propagate into the try-on flow.
 *
 * EXPLICITLY NEVER EMITTED: the person image, its URI, its base64, any
 * signed URL, the garment binary, a raw provider response, a provider
 * secret, a prompt, or anything about the user's body. The allowlist below
 * is the whole vocabulary -- an unknown event or property is dropped, not
 * passed through, so adding a dimension is a deliberate edit here.
 *
 * Dimensions are content-free and bucketed so that cost/latency/quality can
 * be estimated once a real provider is attached, without retaining anything
 * about the person.
 */

export const VTO_EVENTS = [
  'vto_entry_impression',
  'vto_entry_tap',
  // Customer-activation awareness. These say WHERE Try It On was put in front
  // of someone (`surface`) and what they did with it -- never anything about
  // the item, the person or a photo. Separate from the two entry events above,
  // which describe the try-on sheet itself: an awareness impression happens
  // before any sheet exists, on a surface that cannot start a generation.
  'vto_awareness_impression',
  'vto_awareness_tap',
  'vto_awareness_dismissed',
  'vto_person_selected',
  'vto_request_start',
  'vto_request_success',
  'vto_request_failure',
  'vto_request_cancelled',
  'vto_request_superseded',
  'vto_retry',
  'vto_result_compare_toggle',
  // Surface-collapse events. Content-free: they say the sheet was collapsed or
  // restored, never anything about the photo, the result, or the person.
  'vto_minimized',
  'vto_restored',
  'vto_result_save_opened',
  'vto_result_viewed',
  'vto_result_shop',
  'vto_result_watch',
  'vto_result_try_another',
  /** Emitted only after the Dressing Room write confirms. */
  'vto_result_saved',
  'vto_exited',
  // Live/AI Photo mode choice. Content-free: it records WHICH of the two
  // visualization modes the customer selected and nothing about the person,
  // the photo, the camera, or the session. Added deliberately rather than
  // reusing 'vto_entry_impression', which means something else -- a mode
  // toggle is not an entry impression, and logging it as one would put a
  // false number in front of whoever reads this later.
  'vto_mode_selected',
  // ELISE CONTEXTUAL OFFER. The funnel for the app-owned offer Elise's reply
  // can carry. Named for the seam rather than the surface, and emitted through
  // this sink so they inherit its closed property allowlist: an offer event can
  // carry an origin, a bounded K+ bucket and a bounded reason, and nothing that
  // identifies the garment, the binding, the message or the customer.
  'elise_vto_offer_rendered',
  'elise_vto_offer_tapped',
  'elise_vto_offer_unavailable',
  'elise_vto_offer_kplus_gate',
  'elise_vto_offer_launched',
] as const;

export type VtoEvent = (typeof VTO_EVENTS)[number];

export const VTO_EVENT_PROPERTIES = [
  'origin',
  /** Which awareness surface: one of VTO_AWARENESS_SURFACES, nothing else. */
  'surface',
  /** 'free' | 'active' | 'complimentary' | 'resolving'. Never an account id. */
  'actor_kplus_state',
  'provider',
  'slot',
  'category',
  'failureCode',
  'retryCount',
  'latencyMs',
  'inputBucket',
  'outputBucket',
  'eligibility',
  /** 'live' | 'ai_photo'. The mode name only -- never a capability reason,
   *  a device identifier, or anything about why Live was or was not offered. */
  'mode',
  /** Why an Elise offer could not launch. One of a closed set, see below. */
  'reasonCode',
  /** Which entry point the funnel step belongs to: one of VTO_ENTRY_POINTS in
   *  vtoOrigins.ts. Derived from origin/surface at emit time when the caller
   *  did not supply it, so every step of one funnel carries the same value. */
  'entry_point',
] as const;

export type VtoEventProperty = (typeof VTO_EVENT_PROPERTIES)[number];

export type VtoEventPayload = Partial<
  Record<VtoEventProperty, string | number | boolean | null>
>;

export type VtoAnalyticsSink = (event: VtoEvent, payload: VtoEventPayload) => void;

const EVENT_SET = new Set<string>(VTO_EVENTS);
const PROPERTY_SET = new Set<string>(VTO_EVENT_PROPERTIES);
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Properties whose value must be a member of a closed set, not merely a
 * safe-looking string. A value outside the set is dropped, exactly like an
 * unknown property.
 *
 * The two sets mirror VTO_AWARENESS_SURFACES and VTO_ACTOR_KPLUS_STATES in
 * services/vto/vtoDiscovery.ts. They are written out here rather than imported
 * so this sink keeps having no dependencies at all;
 * __tests__/vtoCustomerActivation.test.js pins the two copies equal.
 */
export const VTO_BOUNDED_PROPERTY_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  surface: Object.freeze(['kplus_step6', 'home', 'coachmark', 'product', 'scan_result', 'commerce']),
  actor_kplus_state: Object.freeze(['free', 'active', 'complimentary', 'resolving']),
  // Mirrors VTO_ENTRY_POINTS in services/vto/vtoOrigins.ts; pinned equal by
  // __tests__/vtoEntryPointTaxonomy.test.js.
  entry_point: Object.freeze(['home_studio', 'elise', 'visual_search', 'closet', 'product_card']),
  // Mirrors EliseVtoUnavailableReason plus the two decisions the offer makes
  // itself. A reason outside this set is dropped like any unknown value.
  reasonCode: Object.freeze([
    'binding_missing',
    'candidate_missing',
    'fingerprint_changed',
    'media_missing',
    'account_changed',
    'not_available',
  ]),
});

/**
 * Mirror of resolveVtoEntryPoint in services/vto/vtoOrigins.ts, which is the
 * canonical, documented mapping. Written out here, not imported, for the same
 * reason as the sets above; __tests__/vtoEntryPointTaxonomy.test.js runs both
 * over every origin x surface combination and fails on any difference.
 */
function deriveEntryPoint(origin: unknown, surface: unknown): string | null {
  const o = typeof origin === 'string' ? origin : null;
  const s = typeof surface === 'string' ? surface : null;
  if (o === 'elise') return 'elise';
  if (o === 'closet_item') return 'closet';
  if (o === 'scan_result') return 'visual_search';
  if (o === 'commerce_product') return s === 'scan_result' ? 'visual_search' : 'product_card';
  if (o !== null) return null;
  if (s === 'home') return 'home_studio';
  if (s === 'scan_result') return 'visual_search';
  if (s === 'product' || s === 'commerce') return 'product_card';
  return null;
}

function scrub(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return SAFE_STRING.test(value) ? value : undefined;
  return undefined;
}

/** Coarse dimension bucket. Deliberately lossy: an exact pixel size is a
 *  weak fingerprint of a specific photo, a bucket is not. */
export function dimensionBucket(width: number | null | undefined, height: number | null | undefined): string {
  const w = typeof width === 'number' && Number.isFinite(width) ? width : 0;
  const h = typeof height === 'number' && Number.isFinite(height) ? height : 0;
  const longest = Math.max(w, h);
  if (longest <= 0) return 'unknown';
  if (longest <= 512) return 'le512';
  if (longest <= 1024) return 'le1024';
  if (longest <= 2048) return 'le2048';
  return 'gt2048';
}

function devSink(event: VtoEvent, payload: VtoEventPayload): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[vtoAnalytics]', event, payload);
  }
}

let sink: VtoAnalyticsSink = devSink;

export function setVtoAnalyticsSink(next: VtoAnalyticsSink | null): void {
  sink = typeof next === 'function' ? next : devSink;
}

export function resetVtoAnalyticsSink(): void {
  sink = devSink;
}

export function emitVtoEvent(event: string, payload: Record<string, unknown> = {}): void {
  try {
    if (!EVENT_SET.has(event)) return;
    const safe: VtoEventPayload = {};
    for (const [key, value] of Object.entries(payload ?? {})) {
      if (!PROPERTY_SET.has(key)) continue;
      const scrubbed = scrub(value);
      if (scrubbed === undefined) continue;
      const bounded = VTO_BOUNDED_PROPERTY_VALUES[key];
      if (bounded && !(typeof scrubbed === 'string' && bounded.includes(scrubbed))) continue;
      (safe as Record<string, unknown>)[key] = scrubbed;
    }
    // One entry-point identity for the whole funnel. A supplied, bounded value
    // wins; otherwise it is derived from origin/surface. Unattributable events
    // simply carry none -- an entry point is never guessed.
    if (safe.entry_point === undefined) {
      const entryPoint = deriveEntryPoint(payload?.origin, payload?.surface);
      if (entryPoint !== null) safe.entry_point = entryPoint;
    }
    sink(event as VtoEvent, safe);
  } catch {
    /* analytics never propagates */
  }
}

export const __vtoAnalyticsInternals = { scrub, SAFE_STRING };
