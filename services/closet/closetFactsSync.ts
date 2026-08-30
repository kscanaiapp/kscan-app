// Build 34 / Track B / Phase B2B — cloud Closet FACTS synchronization.
//
// Outbound only. Every function here writes local truth to
// public.user_closet_items (B1A) or reads back exactly enough to know which
// row a local item maps to. It never materializes a remote item locally and
// never reconciles a remote change — that is B2C.
//
// K+ IS NOT CHECKED HERE. B1A's RLS policies already require
// `user_id = auth.uid() AND has_active_k_plus()` on select/insert/update, so a
// non-K+ caller cannot mutate this table at all. The engine checks entitlement
// first to avoid a pointless round trip; this module's correctness does not
// depend on that check having happened.

import { supabase } from '../supabaseClient';
import {
  classifySyncFailure,
  isUniqueViolation,
  projectClosetItemForCloud,
  type ClosetSyncFailureClass,
} from './closetSyncContract';

const CLOSET_TABLE = 'user_closet_items';
/** Server-owned identity/versioning columns this module reads back. */
const IDENTITY_COLUMNS = 'id,row_version,deleted_at';

/**
 * Single result shape with optional fields rather than a discriminated union.
 *
 * This project's tsconfig extends expo/tsconfig.base, which does NOT enable
 * `strict`/`strictNullChecks`, and boolean-literal discriminated unions do not
 * narrow under that setting. services/savedScanMedia.ts reached the same shape
 * for the same reason; matching it keeps one convention across both media
 * sagas instead of introducing a second that only compiles under different
 * flags.
 */
export interface ClosetFactsSyncResult {
  ok: boolean;
  serverId?: string;
  rowVersion?: number;
  failureClass?: ClosetSyncFailureClass;
  detail?: string;
  /** Present only on a conflict: the revision the server actually holds. */
  serverRowVersion?: number;
}

export interface ClosetCloudRowLookup {
  ok: boolean;
  row?: { id: string; row_version: number; deleted_at: string | null } | null;
  failureClass?: ClosetSyncFailureClass;
  detail?: string;
}

function failure(
  error: { code?: string; message?: string; status?: number } | null,
  detail: string,
): ClosetFactsSyncResult {
  return { ok: false, failureClass: classifySyncFailure(error), detail };
}

/**
 * Find this user's existing cloud row for a local client_id.
 *
 * THE CRASH-RECOVERY PRIMITIVE (section 17). The window it closes: the facts
 * INSERT committed server-side, then the app died before the returned id could
 * be written to the sidecar. On restart the client knows only its client_id.
 * Because (user_id, client_id) is UNIQUE, this lookup is exact — it recovers
 * the SAME logical item rather than creating a second one.
 *
 * Tombstoned rows are returned too: a row the user soft-deleted still occupies
 * the unique key, so a later re-sync of that client_id must update THAT row
 * rather than attempt an insert that can only ever fail.
 */
export async function findCloudClosetItemByClientId(
  clientId: string,
): Promise<ClosetCloudRowLookup> {
  const { data, error } = await supabase
    .from(CLOSET_TABLE)
    .select(IDENTITY_COLUMNS)
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) {
    return { ok: false, failureClass: classifySyncFailure(error), detail: 'client_id lookup failed' };
  }
  return { ok: true, row: (data as any) ?? null };
}

/**
 * Create the cloud row for a local item.
 *
 * user_id is NOT sent: B1A's insert-authority trigger stamps it from
 * auth.uid(), so the client cannot choose an owner even by accident. A unique
 * violation means the row already exists (a prior attempt landed, or a
 * concurrent device won the race) and is recovered rather than treated as an
 * error — that is the idempotency contract, not a fallback.
 */
export async function insertCloudClosetItem(
  clientId: string,
  item: Record<string, any>,
): Promise<ClosetFactsSyncResult> {
  const payload = { ...projectClosetItemForCloud(item), client_id: clientId };
  const { data, error } = await supabase
    .from(CLOSET_TABLE)
    .insert(payload)
    .select(IDENTITY_COLUMNS)
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error)) {
      const recovered = await findCloudClosetItemByClientId(clientId);
      if (recovered.ok && recovered.row) {
        return { ok: true, serverId: recovered.row.id, rowVersion: recovered.row.row_version };
      }
      // The insert says the row exists but the select cannot see it. On this
      // table that is an RLS/entitlement condition, not a contract violation.
      return { ok: false, failureClass: 'retryable', detail: 'duplicate row not recoverable' };
    }
    return failure(error, 'facts insert failed');
  }
  if (!data) return { ok: false, failureClass: 'retryable', detail: 'facts insert returned no row' };
  return { ok: true, serverId: (data as any).id, rowVersion: (data as any).row_version };
}

/**
 * Update an existing cloud row, refusing to overwrite a newer server revision.
 *
 * `expectedRowVersion` is the last revision this client observed. The
 * `.eq('row_version', ...)` predicate is what makes the write conditional: if
 * the server has moved on, zero rows match and nothing is overwritten.
 *
 * B2B does NOT merge. A detected conflict retains the local item, records the
 * evidence, and stops — inbound reconciliation is B2C's job, and guessing at a
 * merge here would silently destroy whichever side lost.
 */
export async function updateCloudClosetItem(
  serverId: string,
  expectedRowVersion: number | null,
  item: Record<string, any>,
): Promise<ClosetFactsSyncResult> {
  let query = supabase
    .from(CLOSET_TABLE)
    .update(projectClosetItemForCloud(item))
    .eq('id', serverId);
  if (expectedRowVersion !== null && Number.isFinite(expectedRowVersion)) {
    query = query.eq('row_version', expectedRowVersion);
  }

  const { data, error } = await query.select(IDENTITY_COLUMNS);
  if (error) return failure(error, 'facts update failed');

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) {
    // No row matched. Either the server revision moved (conflict) or the row
    // is no longer visible. Re-read to tell those apart, because they need
    // opposite handling: a conflict must NOT retry, a disappearance must.
    const current = await supabase
      .from(CLOSET_TABLE)
      .select(IDENTITY_COLUMNS)
      .eq('id', serverId)
      .maybeSingle();
    if (current.error) return failure(current.error, 'conflict probe failed');
    if (!current.data) {
      return { ok: false, failureClass: 'retryable', detail: 'cloud row not visible' };
    }
    return {
      ok: false,
      failureClass: 'conflict',
      detail: 'server row_version moved ahead of this client',
      serverRowVersion: (current.data as any).row_version,
    };
  }
  return { ok: true, serverId: rows[0].id, rowVersion: rows[0].row_version };
}

/**
 * Soft-delete (tombstone) the cloud row.
 *
 * B1A exposes NO delete policy — hard delete is not available to any client
 * role, by design. Deletion here is an UPDATE that sets deleted_at, and the
 * eventual hard purge belongs to the account-deletion worker (B1B).
 *
 * Deliberately UNCONDITIONAL on row_version: a delete must win over any
 * concurrent edit (section 30), so making it conditional would let a stale
 * version check keep a row the user has deleted.
 */
export async function tombstoneCloudClosetItem(serverId: string): Promise<ClosetFactsSyncResult> {
  const { data, error } = await supabase
    .from(CLOSET_TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', serverId)
    .select(IDENTITY_COLUMNS);

  if (error) return failure(error, 'tombstone failed');
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) {
    // Nothing to tombstone that this user can see. Treat as done rather than
    // as permanent work: the goal state (no live cloud row) already holds.
    return { ok: true, serverId, rowVersion: 0 };
  }
  return { ok: true, serverId: rows[0].id, rowVersion: rows[0].row_version };
}
