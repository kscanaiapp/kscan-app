/**
 * Elise Conversation Quality V2 — allowlisted aggregate telemetry.
 *
 * Patterned after services/todayWithElise/analytics.ts: one event, a closed
 * property allowlist, and an enum per property. Every value is a bounded code;
 * there is no field that can carry conversation text, product names, Closet
 * content or style-profile values, and the builder never receives any.
 *
 * NOT BRIDGED. The sink is inert (`null`) until something registers one, and
 * nothing in production does: forwarding to PostHog means adding this sink to
 * `services/analytics/analyticsEventRegistry.ts` and the bridge list in
 * `posthogClient.core.ts`, which the PH35 analytics-governance lane owns. That
 * is a shared-surface follow-up, not something this lane does on its own.
 *
 * ZERO IMPORTS for the same require-map reason as eliseConversationFrame.ts.
 */

export const ELISE_CONVERSATION_EVENT = 'elise_conversation_turn' as const;

const ALLOWED_VALUES: Readonly<Record<string, readonly string[]>> = {
  relation: ['new_task', 'refinement', 'reference', 'rejection', 'correction', 'acceptance'],
  taskKind: [
    'shopping', 'owned_styling', 'styling', 'comparison', 'identification',
    'wardrobe_question', 'packing', 'explanation', 'general',
  ],
  commerce: ['none', 'allow', 'hold_owned_only', 'hold_not_requested'],
  reference: ['none', 'resolved', 'ambiguous', 'out_of_range'],
  validation: ['clean', 'constraint_conflict', 'rejected_repeat', 'both', 'skipped'],
  outcome: ['model_reply', 'local_clarification'],
  constraintBucket: ['0', '1', '2_3', '4_plus'],
  frameMsBucket: ['lt_1', '1_5', '5_20', '20_plus'],
};

const BOOLEAN_PROPERTIES = new Set(['taskReset', 'ownedOnly']);

export const ELISE_CONVERSATION_EVENT_PROPERTIES = Object.freeze([
  ...Object.keys(ALLOWED_VALUES),
  ...BOOLEAN_PROPERTIES,
]);

export type EliseConversationTelemetryPayload = Record<string, string | boolean>;

type Sink = (event: typeof ELISE_CONVERSATION_EVENT, payload: EliseConversationTelemetryPayload) => void;

let sink: Sink | null = null;

/** Registration point. Inert by default; tests register a sink to observe. */
export function setEliseConversationTelemetrySink(next: Sink | null): void {
  sink = next;
}

export function constraintBucket(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2_3';
  return '4_plus';
}

export function frameMsBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1) return 'lt_1';
  if (ms < 5) return '1_5';
  if (ms < 20) return '5_20';
  return '20_plus';
}

/**
 * Scrub to the allowlist. Unknown property -> dropped. Value outside its enum
 * -> dropped. Never throws.
 */
export function scrubEliseConversationPayload(raw: Record<string, unknown>): EliseConversationTelemetryPayload {
  const payload: EliseConversationTelemetryPayload = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (BOOLEAN_PROPERTIES.has(key)) {
      if (typeof value === 'boolean') payload[key] = value;
      continue;
    }
    const allowed = ALLOWED_VALUES[key];
    if (allowed && typeof value === 'string' && allowed.includes(value)) payload[key] = value;
  }
  return payload;
}

export function recordEliseConversationTurn(raw: Record<string, unknown>): void {
  try {
    if (!sink) return;
    sink(ELISE_CONVERSATION_EVENT, scrubEliseConversationPayload(raw));
  } catch {
    // Telemetry never blocks a conversation.
  }
}
