// Receipt & Purchase Intelligence V1 — governed telemetry sink.
//
// Built on the same two-allowlist discipline as services/closetTelemetry.ts and
// bridged to PostHog only through services/analytics (the governed boundary).
// No component calls an analytics SDK directly.
//
// ALLOWED (spec section 38): count buckets, a document-confidence bucket, the
// input tier, a failure class, correction counts per coarse field group, and a
// completion state.
//
// NEVER EMITTED, by construction: merchant, item names, brand, colour, size,
// price, currency, SKU, GTIN, receipt text, the receipt image, order numbers,
// email, phone, address, card data, any value the customer typed, and any raw
// provider error. No property below can carry free text: every string value
// must match SAFE_STRING, which cannot express a word with a space, a URL or
// an email.
//
// THIS FILE HAS NO IMPORTS: the analytics probe loads it natively.

export const PURCHASE_IMPORT_EVENTS = [
  'purchase_import_started',
  'purchase_import_extraction_completed',
  'purchase_import_reviewed',
  'purchase_import_confirmed',
  'purchase_import_failed',
] as const;
export type PurchaseImportEvent = typeof PURCHASE_IMPORT_EVENTS[number];

export const PURCHASE_IMPORT_EVENT_PROPERTIES = [
  'inputTier',
  'candidateCountBucket',
  'confirmedCountBucket',
  'rejectedCountBucket',
  'excludedCountBucket',
  'documentConfidenceBucket',
  'failureClass',
  'correctionCountBucket',
  'correctionsNaming',
  'correctionsMaker',
  'correctionsClassification',
  'correctionsAppearance',
  'correctionsFit',
  'correctionsMoney',
  'photoCountBucket',
  'completionState',
] as const;
export type PurchaseImportEventProperty = typeof PURCHASE_IMPORT_EVENT_PROPERTIES[number];

export type PurchaseImportEventPayload = Partial<
  Record<PurchaseImportEventProperty, string | number | boolean | null>
>;

export type PurchaseImportTelemetrySink = (
  event: PurchaseImportEvent,
  payload: PurchaseImportEventPayload,
) => void;

const EVENT_SET = new Set<string>(PURCHASE_IMPORT_EVENTS);
const PROPERTY_SET = new Set<string>(PURCHASE_IMPORT_EVENT_PROPERTIES);
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Counts are bounded to small integers; anything else is dropped. */
const MAX_COUNT_VALUE = 100;

function scrub(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= MAX_COUNT_VALUE ? value : undefined;
  }
  if (typeof value === 'string') return SAFE_STRING.test(value) ? value : undefined;
  return undefined;
}

/** Coarse count bucket. Open-ended buckets use `_plus` (a `+` would be scrubbed). */
export function countBucket(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 4) return '2_4';
  if (n <= 9) return '5_9';
  return '10_plus';
}

/** Document-confidence bucket. The raw score never leaves the device. */
export function confidenceBucket(score: number): string {
  if (!Number.isFinite(score)) return 'unknown';
  if (score < 0.5) return 'below_floor';
  if (score < 0.7) return 'low';
  if (score < 0.9) return 'medium';
  return 'high';
}

function devSink(event: PurchaseImportEvent, payload: PurchaseImportEventPayload): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[purchaseImportTelemetry]', event, payload);
  }
}

let sink: PurchaseImportTelemetrySink = devSink;

/** Replace the sink. The analytics bridge and tests are the only callers. */
export function setPurchaseImportTelemetrySink(next: PurchaseImportTelemetrySink | null): void {
  sink = typeof next === 'function' ? next : devSink;
}

export function resetPurchaseImportTelemetrySink(): void {
  sink = devSink;
}

/** Emit one bounded event. Never throws. */
export function emitPurchaseImportEvent(event: string, payload: Record<string, unknown> = {}): void {
  try {
    if (!EVENT_SET.has(event)) return;
    const safe: PurchaseImportEventPayload = {};
    for (const [key, value] of Object.entries(payload ?? {})) {
      if (!PROPERTY_SET.has(key)) continue;
      const scrubbed = scrub(value);
      if (scrubbed === undefined) continue;
      (safe as Record<string, unknown>)[key] = scrubbed;
    }
    sink(event as PurchaseImportEvent, safe);
  } catch {
    /* telemetry never propagates */
  }
}

/** Test seam only. */
export const __purchaseImportTelemetryInternals = { scrub, SAFE_STRING };
