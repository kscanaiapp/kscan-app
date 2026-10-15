/**
 * SEC-KPLUS-004 — paid-provider quota and idempotency for VTO.
 *
 * vto-generate calls a PAID third-party provider. Before this module there was
 * no quota and no idempotency at all, so one user intent could produce unbounded
 * paid work: a double tap or a retry after the generation timeout started a
 * second billable job, and nothing capped how many an actor could run in a day.
 *
 * Deliberately thin: all the actual logic lives in the reserve/complete RPCs
 * (20260831130000_vto_generation_reservations.sql), which follow the shape the
 * project already uses for request-linked quota (stylechat_quota_events). This
 * file only builds the idempotency identity and speaks to those RPCs.
 */

import { rpc } from '../_shared/deletion/common.ts';

/** Daily paid-generation cap per actor. Env-overridable for staging. */
export function vtoDailyLimit(): number {
  const raw = Deno.env.get('VTO_DAILY_GENERATION_LIMIT');
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

/** How long an in-flight reservation blocks a duplicate. */
export function vtoLeaseMinutes(): number {
  const raw = Deno.env.get('VTO_RESERVATION_LEASE_MINUTES');
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build the idempotency identity for one generation.
 *
 * Composed of safe CANONICAL inputs:
 *   - the actor (from the verified JWT, never the body),
 *   - the canonical garment/product identity,
 *   - a DIGEST of the person input — never the bytes, so no private user media
 *     is ever stored in or derivable from the key,
 *   - the caller's own request generation, so an explicit user Retry with the
 *     same photo and garment is a NEW intent rather than a silent replay.
 *
 * Two rapid taps carry the same request generation and therefore collapse to
 * one paid job; a deliberate Retry carries a new one and is honoured.
 */
export async function buildVtoIdempotencyKey(input: {
  userId: string;
  productRef: string;
  garmentImageUrl: string;
  personDataUri: string;
  requestGeneration?: string | null;
}): Promise<string> {
  const personDigest = await sha256Hex(input.personDataUri);
  const generation = typeof input.requestGeneration === 'string'
    && /^[A-Za-z0-9_.:-]{1,64}$/.test(input.requestGeneration.trim())
    ? input.requestGeneration.trim()
    : 'default';
  return await sha256Hex(
    [input.userId, input.productRef, input.garmentImageUrl, personDigest, generation].join('|'),
  );
}

export type VtoReservationOutcome =
  | { outcome: 'reserved'; used: number; dailyLimit: number; attemptId: string }
  | { outcome: 'duplicate'; used: number; dailyLimit: number; priorStatus: string | null }
  | { outcome: 'quota_exceeded'; used: number; dailyLimit: number }
  | { outcome: 'unavailable' };

type Rpc = (fnName: string, body: Record<string, unknown>) => Promise<Response>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validAttemptId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
async function settled(call: Rpc, fn: string, args: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await call(fn, args);
    if (!response.ok) return false;
    const value = await response.json();
    return value === true;
  } catch { return false; }
}

/** The v2 RPC returns a NEW UUID attempt lease from the SAME atomic insert. */
export async function reserveVtoGeneration(
  userId: string, idempotencyKey: string,
  deps?: { rpc?: Rpc; dailyLimit?: number; leaseMinutes?: number },
): Promise<VtoReservationOutcome> {
  const call = deps?.rpc ?? rpc;
  try {
    const response = await call('reserve_vto_generation_v2', {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
      p_daily_limit: deps?.dailyLimit ?? vtoDailyLimit(),
      p_lease_minutes: deps?.leaseMinutes ?? vtoLeaseMinutes(),
    });
    if (!response.ok) return { outcome: 'unavailable' };
    const data = await response.json();
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.outcome !== 'string') return { outcome: 'unavailable' };
    const used = Number(row.used) || 0, dailyLimit = Number(row.daily_limit) || 0;
    if (row.outcome === 'reserved') {
      if (!validAttemptId(row.attempt_id)) return { outcome: 'unavailable' };
      return { outcome: 'reserved', used, dailyLimit, attemptId: row.attempt_id };
    }
    if (row.outcome === 'duplicate') return {
      outcome: 'duplicate', used, dailyLimit,
      priorStatus: typeof row.prior_status === 'string' ? row.prior_status : null,
    };
    if (row.outcome === 'quota_exceeded') return { outcome: 'quota_exceeded', used, dailyLimit };
    return { outcome: 'unavailable' };
  } catch { return { outcome: 'unavailable' }; }
}

/** Receipt is written immediately when the vendor returns task_id, before polling. */
export async function recordVtoProviderTask(
  userId: string, idempotencyKey: string, attemptId: string, provider: string, taskId: string,
  deps?: { rpc?: Rpc },
): Promise<boolean> {
  if (!validAttemptId(attemptId) || !taskId || taskId.length > 200) return false;
  return settled(deps?.rpc ?? rpc, 'record_vto_provider_task_v2', {
    p_user_id: userId, p_idempotency_key: idempotencyKey, p_attempt_id: attemptId,
    p_provider: provider, p_task_id: taskId,
  });
}

/** Only an in-flight, task-free exact attempt can be released. */
export async function releaseVtoGeneration(
  userId: string, idempotencyKey: string, attemptId: string, provider?: string | null,
  deps?: { rpc?: Rpc },
): Promise<boolean> {
  if (!validAttemptId(attemptId)) return false;
  return settled(deps?.rpc ?? rpc, 'release_vto_generation_v2', {
    p_user_id: userId, p_idempotency_key: idempotencyKey, p_attempt_id: attemptId,
    p_provider: provider ?? null,
  });
}

/** A success means the CURRENT in-flight attempt was durably committed. */
export async function completeVtoGeneration(
  userId: string, idempotencyKey: string, attemptId: string,
  status: 'succeeded' | 'failed', provider?: string | null,
  deps?: { rpc?: Rpc },
): Promise<boolean> {
  if (!validAttemptId(attemptId)) return false;
  return settled(deps?.rpc ?? rpc, 'complete_vto_generation_v2', {
    p_user_id: userId, p_idempotency_key: idempotencyKey, p_attempt_id: attemptId,
    p_status: status, p_provider: provider ?? null,
  });
}

/** Manual/operator or on-demand recovery: never refunds or re-dispatches. */
export async function reconcileStaleVtoGeneration(
  userId: string, deps?: { rpc?: Rpc; olderThanMinutes?: number },
): Promise<number | null> {
  const call = deps?.rpc ?? rpc;
  try {
    const response = await call('reconcile_stale_vto_generation_v2', {
      p_user_id: userId, p_older_than_minutes: deps?.olderThanMinutes ?? 20,
    });
    if (!response.ok) return null;
    const count = await response.json();
    return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
  } catch { return null; }
}
