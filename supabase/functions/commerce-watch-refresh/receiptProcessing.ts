/**
 * receiptProcessing.ts — N-4: Expo push receipt consumption + dead-token
 * retirement.
 *
 * THE GAP THIS CLOSES. pushDelivery.ts already documents the distinction
 * between an Expo TICKET (the immediate accept/reject from the send call) and
 * a RECEIPT (the later, asynchronous result of actually attempting delivery
 * through FCM/APNs), and already retains the ticket id specifically because a
 * receipt lookup needs it. Nothing ever performed that lookup. A token Expo
 * accepted at send time and only later reports DeviceNotRegistered on stayed
 * registered forever — user_device_push_tokens.revoked_at never advanced, so
 * every future alert kept re-attempting delivery to a route that could never
 * succeed again.
 *
 * THE VENDOR CONTRACT THIS IS WRITTEN AGAINST (verified against
 * expo-server-sdk-node's ExpoClient.ts / ExpoClientValues.ts and Expo's
 * published push-notifications documentation, not from memory):
 *   - POST https://exp.host/--/api/v2/push/getReceipts
 *   - body: { ids: string[] }, at most 300 ids per request
 *   - response: { data?: Record<ticketId, Receipt>, errors?: [...] }
 *   - Receipt = { status: 'ok' } | { status: 'error', message, details?: { error?: ... } }
 *   - documented details.error vocabulary: DeveloperError, DeviceNotRegistered,
 *     ExpoError, InvalidCredentials, MessageRateExceeded, MessageTooBig,
 *     ProviderError
 *   - a ticket id simply absent from `data` means Expo has no verdict yet
 *     (the SDK does not special-case this; Expo's own guidance is to wait
 *     ~15 minutes before a first check)
 *
 * THE CRITICAL INVARIANT. A receipt is a verdict on the EXACT token
 * incarnation it was sent to — never on a device_id or a user_id. A late
 * receipt for a token that has since been refreshed on the same device (the
 * SAME user_device_push_tokens row, push_token column updated in place), or
 * for a device whose custody has moved to a different actor (a NEW row,
 * different id, via claim_device_for_actor retiring the old one), must
 * retire NOTHING. retireStalePushRoute is the one function in this codebase
 * that performs an automatic, receipt-driven retirement, and it is written so
 * that condition is enforced by the database itself, atomically, rather than
 * by an application-level "read, decide, then write" sequence a concurrent
 * write could invalidate between the two steps.
 */
import { envOptional, logEvent, rest } from '../_shared/deletion/common.ts';
import {
  RECEIPT_CHECK_BATCH_CAP,
  RECEIPT_INITIAL_DELAY_MS,
  RECEIPT_MAX_AGE_MS,
  RECEIPT_MAX_ATTEMPTS,
  RECEIPT_MAX_BACKOFF_MS,
  RECEIPT_RETENTION_MS,
} from './watchRefreshConfig.ts';
import { recordPushOperationalEvent, type PushReasonCode } from './pushObservability.ts';

const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

function readEnv(name: string): string | undefined {
  return envOptional(name) ?? undefined;
}

/**
 * SHA-256 hex digest of a push token. Local to this module rather than
 * imported from _shared/deletion/common.ts's hashRestorationToken: same
 * primitive, but this module has no dependency on deletion code, and every
 * other Deno function in this codebase that needs a fingerprint (scan-identify,
 * stylechat-generate, vto-generate) carries its own small copy of exactly this
 * pattern rather than a shared import.
 */
export async function hashPushToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ════════════════════════════════════════════════════════════════════════════
// Classification — pure, and the exact vocabulary this was verified against
// ════════════════════════════════════════════════════════════════════════════

/** The documented details.error vocabulary for both tickets and receipts. */
export const EXPO_ERROR_VOCABULARY = [
  'DeveloperError',
  'DeviceNotRegistered',
  'ExpoError',
  'InvalidCredentials',
  'MessageRateExceeded',
  'MessageTooBig',
  'ProviderError',
] as const;

/**
 * Bounded internal categories. Every one of these — never a raw vendor
 * string — is what reaches storage and observability (§22, §12).
 */
export type ReceiptCategory =
  | 'success'
  | 'device_not_registered'
  | 'transient_provider_failure'
  | 'rate_limited'
  | 'payload_failure'
  | 'credential_configuration_failure'
  | 'developer_error'
  | 'unknown_malformed'
  | 'not_yet_available';

export interface ReceiptClassification {
  category: ReceiptCategory;
  /** RETIRE_ROUTE? — only ever true for device_not_registered. */
  retire: boolean;
  /** RETRY_RECEIPT? — true only for the categories that stay pending. */
  retryable: boolean;
  /** MARK_TERMINAL? — the inverse of retryable, restated for readability at call sites. */
  terminal: boolean;
}

const CLASSIFICATION: Record<ReceiptCategory, Omit<ReceiptClassification, 'category'>> = {
  success: { retire: false, retryable: false, terminal: true },
  device_not_registered: { retire: true, retryable: false, terminal: true },
  transient_provider_failure: { retire: false, retryable: true, terminal: false },
  rate_limited: { retire: false, retryable: true, terminal: false },
  payload_failure: { retire: false, retryable: false, terminal: true },
  credential_configuration_failure: { retire: false, retryable: false, terminal: true },
  developer_error: { retire: false, retryable: false, terminal: true },
  unknown_malformed: { retire: false, retryable: false, terminal: true },
  not_yet_available: { retire: false, retryable: true, terminal: false },
};

function classify(category: ReceiptCategory): ReceiptClassification {
  return { category, ...CLASSIFICATION[category] };
}

/**
 * Classifies ONE entry from Expo's getReceipts response `data` map.
 * `entry` is `undefined` when the ticket id was absent from `data` entirely
 * — Expo's documented "no verdict yet" case, never treated as an error.
 *
 * Fails closed (§12, hostile test §25): anything that is not exactly the
 * shape the vendor documents — a non-object, a status that is neither 'ok'
 * nor 'error', an error entry whose details.error is missing or not in the
 * verified vocabulary — becomes unknown_malformed. It is never treated as
 * success and it never retires a route.
 */
export function classifyReceiptEntry(entry: unknown): ReceiptClassification {
  if (entry === undefined) return classify('not_yet_available');
  if (entry === null || typeof entry !== 'object') return classify('unknown_malformed');
  const record = entry as Record<string, unknown>;

  if (record.status === 'ok') return classify('success');
  if (record.status !== 'error') return classify('unknown_malformed');

  const details = record.details;
  const errorCode =
    details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>).error
      : undefined;

  switch (errorCode) {
    case 'DeviceNotRegistered':
      return classify('device_not_registered');
    case 'ProviderError':
      return classify('transient_provider_failure');
    case 'MessageRateExceeded':
      return classify('rate_limited');
    case 'MessageTooBig':
      return classify('payload_failure');
    case 'InvalidCredentials':
      return classify('credential_configuration_failure');
    case 'DeveloperError':
      return classify('developer_error');
    case 'ExpoError':
      // ExpoError is documented but deliberately not treated as retryable:
      // it signals an internal Expo-side problem with no token-fault
      // implication, closest in shape to the other non-retirement terminal
      // categories rather than to our own transient-provider bucket.
      return classify('unknown_malformed');
    default:
      // Any string outside the verified vocabulary, or no details.error at
      // all on an error-status entry: fail closed, never guess.
      return classify('unknown_malformed');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Retry / expiry bounds — pure
// ════════════════════════════════════════════════════════════════════════════

export type ReceiptScheduleDecision =
  | { action: 'retry'; nextCheckAt: string }
  | { action: 'expire' };

/**
 * Bounded backoff for a still-pending (or transient/rate-limited) receipt.
 * Doubles per attempt from RECEIPT_INITIAL_DELAY_MS, capped at
 * RECEIPT_MAX_BACKOFF_MS. Expires — never retries indefinitely — once either
 * the attempt budget or the age budget is exhausted, whichever comes first
 * (§17: "no infinite pending receipt queue").
 */
export function computeNextReceiptCheck(params: {
  attemptCount: number;
  createdAtMs: number;
  nowMs: number;
}): ReceiptScheduleDecision {
  const nextAttempt = params.attemptCount + 1;
  if (nextAttempt >= RECEIPT_MAX_ATTEMPTS) return { action: 'expire' };
  if (params.nowMs - params.createdAtMs >= RECEIPT_MAX_AGE_MS) return { action: 'expire' };

  const backoffMs = Math.min(
    RECEIPT_INITIAL_DELAY_MS * 2 ** params.attemptCount,
    RECEIPT_MAX_BACKOFF_MS,
  );
  return { action: 'retry', nextCheckAt: new Date(params.nowMs + backoffMs).toISOString() };
}

// ════════════════════════════════════════════════════════════════════════════
// Ticket creation — persist the pending receipt (impure)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Records that a ticket was accepted and its receipt still needs checking.
 * Never throws — receipt tracking is delivery hygiene, not the send itself,
 * and a failure here must never be mistaken for a failed push (the push
 * already succeeded at the ticket level by the time this is called).
 *
 * Idempotent by construction: `on_conflict=ticket_id` with
 * `resolution=merge-duplicates` means persisting the same ticket id twice
 * writes the same row once, never creating a duplicate pending row.
 */
export async function persistPendingPushReceipt(params: {
  ticketId: string;
  tokenRowId: string;
  pushToken: string;
  userId: string;
}): Promise<void> {
  try {
    const fingerprint = await hashPushToken(params.pushToken);
    const response = await rest('watchlist_push_receipts?on_conflict=ticket_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        ticket_id: params.ticketId,
        token_row_id: params.tokenRowId,
        token_fingerprint: fingerprint,
        user_id: params.userId,
      }),
    });
    if (!response.ok) {
      logEvent('watchlist_receipt_persist_failed', { status: response.status });
      return;
    }
    // N-5: the ticket was accepted and its receipt is now tracked. Emitted
    // AFTER the write commits, never before -- see drainEligiblePushReceipts
    // below for the same discipline on the consuming side.
    recordPushOperationalEvent({
      type: 'push_receipt_pending',
      component: 'receipt',
      routeId: params.tokenRowId,
    });
  } catch {
    logEvent('watchlist_receipt_persist_failed', { status: 'threw' });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Retirement — the one safety-critical write, shared by both the immediate
// ticket-error path (index.ts) and the deferred receipt-drain path below.
// ════════════════════════════════════════════════════════════════════════════

export type RetirementOutcome = 'retired' | 'skipped_stale';

/**
 * Retires user_device_push_tokens row `tokenRowId` IF AND ONLY IF it is still
 * live (revoked_at is null) AND its CURRENT push_token still equals
 * `expectedPushToken`. Both conditions are evaluated by PostgREST as part of
 * ONE atomic UPDATE statement — there is no read-then-write gap a concurrent
 * register_device_push_token (token refresh) or claim_device_for_actor
 * (custody transfer) could land inside. If either condition no longer holds
 * by the time this UPDATE runs, it matches zero rows and is a safe no-op:
 * that is the token-refresh race and the cross-actor race both closed by the
 * same mechanism (§9, §10).
 *
 * `expectedPushToken` is the raw token value, held only for the duration of
 * this call and never persisted here — exactly the same discipline
 * register_device_push_token already applies to the token it stores.
 */
export async function retireStalePushRoute(params: {
  tokenRowId: string;
  expectedPushToken: string;
}): Promise<RetirementOutcome> {
  const path =
    `user_device_push_tokens?id=eq.${encodeURIComponent(params.tokenRowId)}` +
    `&revoked_at=is.null&push_token=eq.${encodeURIComponent(params.expectedPushToken)}`;
  const response = await rest(path, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  if (!response.ok) return 'skipped_stale';
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? 'retired' : 'skipped_stale';
}

/**
 * Same atomic guarantee as retireStalePushRoute, for the deferred path where
 * only the stored fingerprint (not the raw token) is available. Reads the
 * CURRENT token row, hashes its CURRENT push_token, and only issues the
 * conditional retirement PATCH — keyed on that current token value — if the
 * hash still matches. The hash comparison here is what DECIDES whether to
 * attempt retirement; the PATCH's own `push_token=eq.<value just read>`
 * filter is what makes the actual write race-safe regardless of anything
 * that happened between the read and the write (a second refresh landing in
 * that gap simply makes the value no longer match at PATCH time too).
 */
export async function retireIfFingerprintStillMatches(params: {
  tokenRowId: string;
  expectedFingerprint: string;
}): Promise<RetirementOutcome> {
  const readResponse = await rest(
    `user_device_push_tokens?id=eq.${encodeURIComponent(params.tokenRowId)}&revoked_at=is.null&select=push_token`,
    { method: 'GET' },
  );
  if (!readResponse.ok) return 'skipped_stale';
  const rows = (await readResponse.json().catch(() => [])) as Array<{ push_token?: string }>;
  const currentToken = rows[0]?.push_token;
  if (!currentToken) return 'skipped_stale';

  const currentFingerprint = await hashPushToken(currentToken);
  if (currentFingerprint !== params.expectedFingerprint) return 'skipped_stale';

  return retireStalePushRoute({ tokenRowId: params.tokenRowId, expectedPushToken: currentToken });
}

/**
 * N-5, observability-only. retireIfFingerprintStillMatches has already run
 * and decided 'skipped_stale' by the time this is called — this function
 * never influences that decision and never retries it. It exists only to
 * attribute WHY the fingerprint no longer matched, for diagnostics: is the
 * same device_id now held by a different, currently-live route (an actor
 * change via claim_device_for_actor), or not (an ordinary token refresh, an
 * explicit off, or a logout revoke by the same actor)? A second, read-only
 * lookup, performed only on this rare no-op branch — never on the success
 * path, never per-push.
 *
 * Deliberately does NOT write to watchlist_push_receipts.retirement_outcome:
 * that column's CHECK constraint ('retired' | 'skipped_stale' only) is N-4
 * schema this repair does not touch (no migration — see pushObservability.ts
 * header). The finer attribution lives only in the emitted event.
 *
 * Fails closed to the less specific, not the more alarming, bucket: any read
 * failure or ambiguous row state returns 'stale_token'.
 */
async function classifyRetirementNoop(tokenRowId: string): Promise<'stale_token' | 'actor_changed'> {
  try {
    const readResponse = await rest(
      `user_device_push_tokens?id=eq.${encodeURIComponent(tokenRowId)}&select=device_id,user_id,revoked_at`,
      { method: 'GET' },
    );
    if (!readResponse.ok) return 'stale_token';
    const rows = (await readResponse.json().catch(() => [])) as Array<{
      device_id?: string;
      user_id?: string;
      revoked_at?: string | null;
    }>;
    const row = rows[0];
    if (!row || !row.device_id || !row.user_id) return 'stale_token';
    // Still live but the fingerprint didn't match: the same route refreshed
    // its own token in place — never an actor change, since device_id and
    // user_id here are this row's own and are unchanged.
    if (row.revoked_at == null) return 'stale_token';

    const siblingResponse = await rest(
      `user_device_push_tokens?device_id=eq.${encodeURIComponent(row.device_id)}` +
        `&user_id=neq.${encodeURIComponent(row.user_id)}&revoked_at=is.null&select=id&limit=1`,
      { method: 'GET' },
    );
    if (!siblingResponse.ok) return 'stale_token';
    const siblings = (await siblingResponse.json().catch(() => [])) as Array<{ id?: string }>;
    return Array.isArray(siblings) && siblings.length > 0 ? 'actor_changed' : 'stale_token';
  } catch {
    return 'stale_token';
  }
}

/**
 * Every ReceiptCategory except 'success'/'not_yet_available' shares its exact
 * string with a PushReasonCode (the two vocabularies were deliberately kept
 * in lockstep — see pushObservability.ts's header). This performs no
 * translation, only a type-safe narrowing for the observability call sites
 * below; the switch is exhaustive so an added ReceiptCategory forces this to
 * be updated too.
 */
function receiptCategoryToReasonCode(category: ReceiptCategory): PushReasonCode | undefined {
  switch (category) {
    case 'device_not_registered':
    case 'transient_provider_failure':
    case 'rate_limited':
    case 'payload_failure':
    case 'credential_configuration_failure':
    case 'developer_error':
    case 'unknown_malformed':
      return category;
    case 'success':
    case 'not_yet_available':
      return undefined;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Draining — the deferred receipt-consumption entry point
// ════════════════════════════════════════════════════════════════════════════

interface PendingReceiptRow {
  id: string;
  ticket_id: string;
  token_row_id: string;
  token_fingerprint: string;
  attempt_count: number;
  created_at: string;
}

type ExpoReceiptEntry = { status?: unknown; message?: unknown; details?: unknown };
type ExpoReceiptsResponse = { data?: Record<string, ExpoReceiptEntry> };

export interface DrainSummary {
  checked: number;
  success: number;
  retired: number;
  staleSkipped: number;
  stillPending: number;
  expired: number;
  terminalOther: number;
}

const EMPTY_SUMMARY: DrainSummary = {
  checked: 0,
  success: 0,
  retired: 0,
  staleSkipped: 0,
  stillPending: 0,
  expired: 0,
  terminalOther: 0,
};

/**
 * Checks every receipt currently due (state='pending', next_check_at in the
 * past), up to RECEIPT_CHECK_BATCH_CAP, in exactly ONE getReceipts call — the
 * whole point of "batch" is that this never loops or retries within one
 * invocation (§16: "do not repeatedly hit Expo in the same invocation").
 * Never throws: a failure here must not block the watch-refresh work the
 * caller performs afterward.
 */
export async function drainEligiblePushReceipts(): Promise<DrainSummary> {
  try {
    const nowIso = new Date().toISOString();
    const dueResponse = await rest(
      `watchlist_push_receipts?state=eq.pending&next_check_at=lte.${encodeURIComponent(nowIso)}` +
        `&select=id,ticket_id,token_row_id,token_fingerprint,attempt_count,created_at` +
        `&order=next_check_at.asc&limit=${RECEIPT_CHECK_BATCH_CAP}`,
      { method: 'GET' },
    );
    if (!dueResponse.ok) return EMPTY_SUMMARY;
    const due = (await dueResponse.json().catch(() => [])) as PendingReceiptRow[];
    if (!Array.isArray(due) || due.length === 0) return EMPTY_SUMMARY;

    const expoResponse = await fetch(EXPO_RECEIPTS_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(readEnv('EXPO_PUSH_ACCESS_TOKEN')
          ? { Authorization: `Bearer ${readEnv('EXPO_PUSH_ACCESS_TOKEN')}` }
          : {}),
      },
      body: JSON.stringify({ ids: due.map((r) => r.ticket_id) }),
    });

    // A failed Expo call is exactly the not-yet-available case for every row
    // in this batch: retain pending state, schedule a retry, never treat a
    // transport failure as a verdict of any kind.
    const receiptData: Record<string, ExpoReceiptEntry> = expoResponse.ok
      ? ((await expoResponse.json().catch(() => ({}))) as ExpoReceiptsResponse).data ?? {}
      : {};

    const summary: DrainSummary = { ...EMPTY_SUMMARY, checked: due.length };
    const nowMs = Date.now();

    for (const row of due) {
      const classification = classifyReceiptEntry(receiptData[row.ticket_id]);

      // N-5: every emission below fires AFTER the corresponding write has
      // already committed (or, for the transient/retry branch, after the
      // retry itself is scheduled) — never before the outcome is known. The
      // old call here fired at classification time, ahead of the retirement
      // attempt's actual result; that was the exact defect N-5 exists to fix
      // (see this file's own header and pushObservability.ts's header).

      if (classification.category === 'success') {
        await patchReceiptTerminal(row.id, 'success', classification.category);
        summary.success += 1;
        recordPushOperationalEvent({
          type: 'push_receipt_success',
          component: 'receipt',
          receiptId: row.id,
          routeId: row.token_row_id,
        });
        continue;
      }

      if (classification.category === 'device_not_registered') {
        const outcome = await retireIfFingerprintStillMatches({
          tokenRowId: row.token_row_id,
          expectedFingerprint: row.token_fingerprint,
        });
        await patchReceiptTerminal(row.id, 'device_not_registered', classification.category, outcome);
        if (outcome === 'retired') {
          summary.retired += 1;
          recordPushOperationalEvent({
            type: 'push_route_retired_dead_token',
            component: 'retirement',
            reason: 'device_not_registered',
            receiptId: row.id,
            routeId: row.token_row_id,
          });
        } else {
          summary.staleSkipped += 1;
          // Observability-only secondary read (§ retirement attribution) —
          // never changes the outcome already decided above, and never
          // touches watchlist_push_receipts.retirement_outcome.
          const attribution = await classifyRetirementNoop(row.token_row_id);
          recordPushOperationalEvent({
            type:
              attribution === 'actor_changed'
                ? 'push_route_retirement_noop_actor_changed'
                : 'push_route_retirement_noop_stale_token',
            component: 'retirement',
            reason: attribution,
            receiptId: row.id,
            routeId: row.token_row_id,
          });
        }
        continue;
      }

      if (classification.retryable) {
        const decision = computeNextReceiptCheck({
          attemptCount: row.attempt_count,
          createdAtMs: new Date(row.created_at).getTime(),
          nowMs,
        });
        if (decision.action === 'expire') {
          await patchReceiptTerminal(row.id, 'expired', 'expired');
          summary.expired += 1;
          recordPushOperationalEvent({
            type: 'push_receipt_expired',
            component: 'receipt',
            reason: 'receipt_expired',
            receiptId: row.id,
            routeId: row.token_row_id,
          });
        } else {
          await patchReceiptRetry(row.id, row.attempt_count, decision.nextCheckAt, classification.category);
          summary.stillPending += 1;
          recordPushOperationalEvent({
            type: 'push_receipt_transient',
            component: 'receipt',
            reason: receiptCategoryToReasonCode(classification.category),
            receiptId: row.id,
            routeId: row.token_row_id,
          });
        }
        continue;
      }

      // Every remaining terminal-but-not-device_not_registered category:
      // payload_failure, credential_configuration_failure, developer_error,
      // unknown_malformed. None retire a route.
      await patchReceiptTerminal(row.id, 'terminal_other', classification.category);
      summary.terminalOther += 1;
      recordPushOperationalEvent({
        type: 'push_receipt_terminal_failure',
        component: 'receipt',
        reason: receiptCategoryToReasonCode(classification.category),
        receiptId: row.id,
        routeId: row.token_row_id,
      });
    }

    return summary;
  } catch {
    return EMPTY_SUMMARY;
  }
}

/**
 * Conditional on state=eq.pending (idempotency, §15): if a concurrent
 * invocation already moved this row to a terminal state, this PATCH matches
 * zero rows and changes nothing rather than overwriting a terminal verdict.
 */
async function patchReceiptTerminal(
  id: string,
  state: 'success' | 'device_not_registered' | 'terminal_other' | 'expired',
  errorCategory: ReceiptCategory | 'expired',
  retirementOutcome?: RetirementOutcome,
): Promise<void> {
  try {
    await rest(`watchlist_push_receipts?id=eq.${encodeURIComponent(id)}&state=eq.pending`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        state,
        last_error_category: errorCategory === 'success' ? null : errorCategory,
        retirement_outcome: retirementOutcome ?? null,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {
    // Best-effort: a receipt-bookkeeping write failure must never surface as
    // a delivery/refresh failure. The row simply retries on the next sweep.
  }
}

async function patchReceiptRetry(
  id: string,
  currentAttemptCount: number,
  nextCheckAt: string,
  errorCategory: ReceiptCategory,
): Promise<void> {
  try {
    await rest(`watchlist_push_receipts?id=eq.${encodeURIComponent(id)}&state=eq.pending`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        attempt_count: currentAttemptCount + 1,
        next_check_at: nextCheckAt,
        last_error_category: errorCategory === 'not_yet_available' ? null : errorCategory,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {
    // Same rationale as patchReceiptTerminal.
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Retention — bounded cleanup of terminal rows (§7, §20)
// ════════════════════════════════════════════════════════════════════════════

/** Deletes terminal receipt rows older than RECEIPT_RETENTION_MS. Never throws. */
export async function pruneOldPushReceipts(): Promise<void> {
  try {
    const cutoffIso = new Date(Date.now() - RECEIPT_RETENTION_MS).toISOString();
    await rest(
      `watchlist_push_receipts?state=neq.pending&updated_at=lt.${encodeURIComponent(cutoffIso)}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
    );
  } catch {
    // Retention is hygiene, not correctness — a failed prune changes nothing
    // about delivery safety and simply retries on the next sweep.
  }
}
