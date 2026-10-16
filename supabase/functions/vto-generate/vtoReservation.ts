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


/**
 * VTO-002/003: the RPC contract is attempt-scoped. NEVER fall back to the old
 * key-only RPCs: they can settle a different attempt after a lease rollover.
 */
export type VtoReservationOutcome =
  | { outcome: 'reserved'; used: number; dailyLimit: number; attemptId: string }
  | { outcome: 'duplicate'; used: number; dailyLimit: number; priorStatus: string | null; taskId: string | null; attemptId: string | null }
  | { outcome: 'quota_exceeded'; used: number; dailyLimit: number }
  | { outcome: 'unavailable' };

type Rpc = (fnName: string, body: Record<string, unknown>) => Promise<Response>;

export async function reserveVtoGeneration(
  userId: string,
  idempotencyKey: string,
  deps?: { rpc?: Rpc; dailyLimit?: number; leaseMinutes?: number },
): Promise<VtoReservationOutcome> {
  const call = deps?.rpc ?? rpc;
  try {
    const response = await call('reserve_vto_generation_v2', {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
      p_daily_limit: deps?.dailyLimit ?? vtoDailyLimit(),
    });
    if (!response.ok) return { outcome: 'unavailable' };
    const data = await response.json();
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.outcome !== 'string') return { outcome: 'unavailable' };
    const used = Number(row.used) || 0;
    const dailyLimit = Number(row.daily_limit) || 0;
    if (row.outcome === 'reserved') {
      if (typeof row.attempt_id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(row.attempt_id)) {
        return { outcome: 'unavailable' };
      }
      return { outcome: 'reserved', used, dailyLimit, attemptId: row.attempt_id };
    }
    if (row.outcome === 'duplicate') return {
      outcome: 'duplicate', used, dailyLimit,
      priorStatus: typeof row.prior_status === 'string' ? row.prior_status : null,
      taskId: typeof row.provider_task_id === 'string' ? row.provider_task_id : null,
      attemptId: typeof row.attempt_id === 'string' ? row.attempt_id : null,
    };
    if (row.outcome === 'quota_exceeded') return { outcome: 'quota_exceeded', used, dailyLimit };
    return { outcome: 'unavailable' };
  } catch {
    return { outcome: 'unavailable' };
  }
}

/**
 * Preserve task identity durably BEFORE polling. If this fails, the provider
 * was already invoked and no additional task is submitted by this request.
 */
export async function recordVtoProviderTask(
  userId: string, idempotencyKey: string, attemptId: string,
  taskId: string, provider?: string | null, deps?: { rpc?: Rpc },
): Promise<boolean> {
  try {
    const result = await (deps?.rpc ?? rpc)('record_vto_task_v2', {
      p_user_id: userId, p_idempotency_key: idempotencyKey,
      p_attempt_id: attemptId, p_task_id: taskId, p_provider: provider ?? null,
    });
    return result.ok && (await result.json()) === true;
  } catch { return false; }
}

/** An accepted or uncertain provider call is NEVER released on RPC failure. */
export async function completeVtoGeneration(
  userId: string, idempotencyKey: string,
  status: 'succeeded' | 'failed', provider?: string | null,
  attemptId?: string, deps?: { rpc?: Rpc }, uncertain = false,
  resultDigest?: string | null,
): Promise<boolean> {
  if (!attemptId) return false;
  try {
    const response = await (deps?.rpc ?? rpc)('settle_vto_generation_v2', {
      p_user_id: userId, p_idempotency_key: idempotencyKey,
      p_attempt_id: attemptId,
      p_action: uncertain ? 'uncertain' : status,
      p_provider: provider ?? null,
      p_result_digest: resultDigest ?? null,
    });
    return response.ok && (await response.json()) === true;
  } catch { return false; }
}

export async function releaseVtoGeneration(
  userId: string, idempotencyKey: string, provider?: string | null,
  attemptId?: string, deps?: { rpc?: Rpc },
): Promise<boolean> {
  if (!attemptId) return false;
  try {
    const response = await (deps?.rpc ?? rpc)('settle_vto_generation_v2', {
      p_user_id: userId, p_idempotency_key: idempotencyKey,
      p_attempt_id: attemptId, p_action: 'release',
      p_provider: provider ?? null,
      p_result_digest: null,
    });
    return response.ok && (await response.json()) === true;
  } catch { return false; }
}
