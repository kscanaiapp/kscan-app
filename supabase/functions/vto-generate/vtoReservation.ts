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
  | { outcome: 'reserved'; used: number; dailyLimit: number }
  | { outcome: 'duplicate'; used: number; dailyLimit: number; priorStatus: string | null }
  | { outcome: 'quota_exceeded'; used: number; dailyLimit: number }
  /** The reservation could not be read/written. FAIL CLOSED: no provider work. */
  | { outcome: 'unavailable' };

type Rpc = (fnName: string, body: Record<string, unknown>) => Promise<Response>;

export async function reserveVtoGeneration(
  userId: string,
  idempotencyKey: string,
  deps?: { rpc?: Rpc; dailyLimit?: number; leaseMinutes?: number },
): Promise<VtoReservationOutcome> {
  const call = deps?.rpc ?? rpc;
  try {
    const response = await call('reserve_vto_generation', {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
      p_daily_limit: deps?.dailyLimit ?? vtoDailyLimit(),
      p_lease_minutes: deps?.leaseMinutes ?? vtoLeaseMinutes(),
    });
    if (!response.ok) return { outcome: 'unavailable' };
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || typeof row.outcome !== 'string') return { outcome: 'unavailable' };
    const used = Number(row.used) || 0;
    const dailyLimit = Number(row.daily_limit) || 0;
    if (row.outcome === 'reserved') return { outcome: 'reserved', used, dailyLimit };
    if (row.outcome === 'quota_exceeded') return { outcome: 'quota_exceeded', used, dailyLimit };
    if (row.outcome === 'duplicate') {
      return {
        outcome: 'duplicate',
        used,
        dailyLimit,
        priorStatus: typeof row.prior_status === 'string' ? row.prior_status : null,
      };
    }
    return { outcome: 'unavailable' };
  } catch {
    return { outcome: 'unavailable' };
  }
}

/**
 * Settle a reservation. Best-effort by design: the paid call has already
 * happened, so a bookkeeping failure must not change what the user is told.
 * An unsettled row simply ages out of its lease.
 */
export async function completeVtoGeneration(
  userId: string,
  idempotencyKey: string,
  status: 'succeeded' | 'failed',
  provider?: string | null,
  deps?: { rpc?: Rpc },
): Promise<void> {
  const call = deps?.rpc ?? rpc;
  try {
    await call('complete_vto_generation', {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
      p_status: status,
      p_provider: provider ?? null,
    });
  } catch {
    // Intentionally silent — see above.
  }
}
