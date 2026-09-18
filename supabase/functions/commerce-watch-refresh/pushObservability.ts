/**
 * pushObservability.ts — N-5: privacy-safe notification lifecycle
 * observability.
 *
 * THE GAP THIS CLOSES. N-1 through N-4 and RP-104/RP-109 made the
 * notification system substantially safer, but almost none of it left any
 * trace: registration, ticket, receipt, retirement, revoke and worker
 * outcomes were either entirely silent or logged as ad hoc, uncoordinated
 * strings scattered across index.ts. There was no way to answer "was this
 * device registered / did Expo accept the ticket / was the failed route
 * actually retired / was it stale because the token had refreshed" without
 * reading source and re-deriving the answer from first principles.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE. We need enough information to
 * diagnose why an alert failed without recording what the alert said, who
 * the person is, or the delivery secret used to reach their device. Every
 * event this module can emit is drawn from closed, bounded vocabularies —
 * never a raw string, a vendor response, an error message, or a stack trace.
 * `recordPushOperationalEvent` is deliberately NOT `recordEvent(name: string,
 * payload: any)`: a generic unconstrained sink is exactly how PII leaks in
 * later, once someone is in a hurry.
 *
 * STORAGE DECISION (N-5 §6). Structured console logs via the existing
 * logEvent/alertEvent primitives (supabase/functions/_shared/deletion/
 * common.ts) — already the established mechanism for every other
 * commerce-watch-refresh signal (watchlist_worker_claim,
 * watchlist_create_failed, etc.) — are the event-stream authority here. No
 * new table. The one durable correlation surface this module needs (was a
 * specific receipt's retirement attempt a success, a stale-token no-op, or
 * an actor-change no-op) is already available on watchlist_push_receipts
 * (N-4) via retirement_outcome/last_error_category; this module only refines
 * the classification recorded there, it does not duplicate it into a second
 * table. provider_security_events (the one existing operational-event table
 * in this codebase) was evaluated and rejected: its event_type CHECK
 * constraint is closed to provider-abuse concepts (throttled,
 * temporarily_blocked, reservation_denied, ...) with no notification
 * semantics, and widening a security-abuse ledger with unrelated delivery
 * events would conflate two concerns that are deliberately separate.
 *
 * FAILURE SAFETY (N-5 §17). recordPushOperationalEvent never throws and is
 * never awaited by a caller in a way that could block or fail the operation
 * it observes — every call site fires it after the real state transition has
 * already happened (or alongside a fire-and-forget attempt boundary), never
 * as a gate in front of one.
 */
import { alertEvent, logEvent } from '../_shared/deletion/common.ts';

// ════════════════════════════════════════════════════════════════════════════
// Closed vocabularies — the entire contract surface of this module
// ════════════════════════════════════════════════════════════════════════════

export const PUSH_EVENT_TYPES = [
  // Registration lifecycle
  'push_registration_started',
  'push_registration_succeeded',
  'push_registration_rejected',
  'push_token_refreshed',
  'push_route_revoked',
  // Send / ticket lifecycle
  'push_send_attempted',
  'push_ticket_accepted',
  'push_ticket_rejected',
  // Receipt lifecycle
  'push_receipt_pending',
  'push_receipt_success',
  'push_receipt_transient',
  'push_receipt_terminal_failure',
  'push_receipt_expired',
  // Retirement lifecycle (always paired with a device_not_registered receipt)
  'push_route_retired_dead_token',
  'push_route_retirement_noop_stale_token',
  'push_route_retirement_noop_actor_changed',
  // Device custody
  'push_device_claimed',
  'push_device_claim_rejected',
  // Worker lifecycle
  'watchlist_worker_started',
  'watchlist_worker_disabled',
  'watchlist_worker_completed',
  'watchlist_worker_failed',
] as const;

export type PushEventType = (typeof PUSH_EVENT_TYPES)[number];

const PUSH_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PUSH_EVENT_TYPES);

/**
 * Bounded reason codes for every rejection/failure/no-op event. The
 * vendor-derived subset (device_not_registered..unknown_malformed) mirrors
 * receiptProcessing.ts's ReceiptCategory 1:1 on purpose — one shared
 * vocabulary, not a parallel interpretation of the same vendor contract.
 */
export const PUSH_REASON_CODES = [
  // Registration
  'permission_not_granted',
  'feature_disabled',
  'missing_push_capability',
  'invalid_token_registration',
  'account_not_eligible',
  'registration_rpc_failed',
  // Revoke / claim
  'already_inactive',
  'revoke_rpc_failed',
  'claim_rpc_failed',
  // Vendor-derived (ticket + receipt share this vocabulary)
  'device_not_registered',
  'transient_provider_failure',
  'rate_limited',
  'payload_failure',
  'credential_configuration_failure',
  'developer_error',
  'unknown_malformed',
  'network_error',
  // Retirement no-op attribution
  'stale_token',
  'actor_changed',
  // Receipt lifecycle bounds
  'receipt_expired',
  // Worker
  'worker_disabled',
  'worker_claim_failed',
  'worker_threw',
] as const;

export type PushReasonCode = (typeof PUSH_REASON_CODES)[number];

const PUSH_REASON_CODE_SET: ReadonlySet<string> = new Set(PUSH_REASON_CODES);

/** Coarse stage, for filtering a log stream without parsing event names. */
export const PUSH_EVENT_COMPONENTS = [
  'registration',
  'revoke',
  'claim',
  'send',
  'receipt',
  'retirement',
  'worker',
] as const;

export type PushEventComponent = (typeof PUSH_EVENT_COMPONENTS)[number];

const PUSH_EVENT_COMPONENT_SET: ReadonlySet<string> = new Set(PUSH_EVENT_COMPONENTS);

/**
 * Bounded counter keys a worker-run summary may carry. Closed so a future
 * edit cannot silently start aggregating something identifying (e.g. a
 * per-provider or per-retailer count) into what must stay a small set of
 * anonymous integers.
 */
const COUNTER_KEYS = [
  'receiptsChecked',
  'receiptsPending',
  'receiptsSuccess',
  'receiptsTransient',
  'receiptsTerminal',
  'deadRoutesRetired',
  'staleReceiptsIgnored',
  'watchesEvaluated',
  'pushesAttempted',
  'pushTicketsAccepted',
  'pushTicketsRejected',
  'durationMs',
] as const;

type CounterKey = (typeof COUNTER_KEYS)[number];
const COUNTER_KEY_SET: ReadonlySet<string> = new Set(COUNTER_KEYS);

export type PushOperationalCounters = Partial<Record<CounterKey, number>>;

// ════════════════════════════════════════════════════════════════════════════
// The one narrow emission API
// ════════════════════════════════════════════════════════════════════════════

export interface PushOperationalEventInput {
  type: PushEventType;
  reason?: PushReasonCode;
  component: PushEventComponent;
  /** Truncated user_device_push_tokens row id — never the push token itself. */
  routeId?: string;
  /** Truncated watchlist_push_receipts row id. */
  receiptId?: string;
  /** Opaque per-worker-run correlation id, not tied to any one user. */
  operationId?: string;
  counters?: PushOperationalCounters;
}

/**
 * Bounded prefix length for any row-identity correlation field. Matches the
 * `.slice(0, 8)` convention already used for watchId elsewhere in this file
 * — enough for an operator to correlate repeated events about the same row
 * without the log line carrying a replayable full UUID.
 */
const ID_PREFIX_LEN = 8;

/**
 * Content-pattern guard, independent of the field allowlist below. Even a
 * value passed under an allowed key (routeId, receiptId, operationId) is
 * scanned so a coding mistake that hands this function a raw token, a bearer
 * header, or an email cannot reach the log by accident (§23: "do not rely on
 * developer discipline alone").
 */
const FORBIDDEN_VALUE_PATTERNS: RegExp[] = [
  /ExpoPushToken\[/i,
  /ExponentPushToken\[/i,
  /\bpush_token\b/i,
  /\baccess_token\b/i,
  /\brefresh_token\b/i,
  /\bauthorization\b/i,
  /\bbearer\s/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // email-shaped
];

function containsForbiddenContent(value: string): boolean {
  return FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function sanitizeId(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (containsForbiddenContent(value)) return undefined;
  return value.slice(0, ID_PREFIX_LEN);
}

function sanitizeCounters(counters: PushOperationalCounters | undefined): PushOperationalCounters | undefined {
  if (!counters || typeof counters !== 'object') return undefined;
  const safe: PushOperationalCounters = {};
  let any = false;
  for (const [key, value] of Object.entries(counters)) {
    if (!COUNTER_KEY_SET.has(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    // Bounded and non-negative: a counter is a count, never a signed delta
    // or an unbounded duration that could encode something else.
    safe[key as CounterKey] = Math.max(0, Math.min(value, 1_000_000));
    any = true;
  }
  return any ? safe : undefined;
}

/**
 * THE one way notification lifecycle events reach the log stream.
 *
 * Validates every field against its closed vocabulary and scans every string
 * value for forbidden content before it ever reaches logEvent/alertEvent.
 * Unknown event types, unknown reason codes, unknown components, and any
 * object key outside this exact interface are dropped, never passed through
 * — this function does not accept a generic payload object at all, so there
 * is no `...rest` spread that could leak an unexpected field.
 *
 * Never throws. A malformed call (an invalid type, for instance — which can
 * only happen from a caller bypassing TypeScript, e.g. a test) is recorded
 * as a single bounded alert naming only the rejection reason, never the
 * invalid input itself, and the function returns without emitting the
 * original event. This is the enforcement half of §25's "tests should reject
 * unknown event names and unknown fields" — rejection is structural, not
 * merely typed.
 */
export function recordPushOperationalEvent(input: PushOperationalEventInput): void {
  try {
    if (!input || typeof input !== 'object') return;
    if (!PUSH_EVENT_TYPE_SET.has(input.type)) {
      alertEvent('push_observability_rejected_input', { field: 'type' });
      return;
    }
    if (!PUSH_EVENT_COMPONENT_SET.has(input.component)) {
      alertEvent('push_observability_rejected_input', { field: 'component' });
      return;
    }
    if (input.reason !== undefined && !PUSH_REASON_CODE_SET.has(input.reason)) {
      alertEvent('push_observability_rejected_input', { field: 'reason' });
      return;
    }

    const fields: Record<string, unknown> = { component: input.component };
    if (input.reason !== undefined) fields.reason = input.reason;
    const routeId = sanitizeId(input.routeId);
    if (routeId) fields.routeId = routeId;
    const receiptId = sanitizeId(input.receiptId);
    if (receiptId) fields.receiptId = receiptId;
    const operationId = sanitizeId(input.operationId);
    if (operationId) fields.operationId = operationId;
    const counters = sanitizeCounters(input.counters);
    if (counters) fields.counters = counters;

    logEvent(input.type, fields);
  } catch {
    // §17: telemetry can never propagate a failure into the operation it is
    // observing. Swallow unconditionally.
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Shared vendor-error → bounded reason mapping (ticket path + receipt path)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Maps a raw Expo `details.error` string (ticket-level or receipt-level —
 * both share the same documented vocabulary, see receiptProcessing.ts's own
 * header for the verified vendor contract) to a bounded PushReasonCode.
 * Anything outside the verified vocabulary — including undefined — maps to
 * 'unknown_malformed' rather than being passed through, so an unrecognized
 * or future vendor string can never reach a durable event as free text.
 */
export function mapVendorErrorToReasonCode(rawErrorCode: string | undefined): PushReasonCode {
  switch (rawErrorCode) {
    case 'DeviceNotRegistered':
      return 'device_not_registered';
    case 'ProviderError':
      return 'transient_provider_failure';
    case 'MessageRateExceeded':
      return 'rate_limited';
    case 'MessageTooBig':
      return 'payload_failure';
    case 'InvalidCredentials':
      return 'credential_configuration_failure';
    case 'DeveloperError':
      return 'developer_error';
    case 'network_error':
      return 'network_error';
    default:
      if (typeof rawErrorCode === 'string' && rawErrorCode.startsWith('http_')) {
        return 'transient_provider_failure';
      }
      return 'unknown_malformed';
  }
}
