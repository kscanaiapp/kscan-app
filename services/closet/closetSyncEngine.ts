// Build 34 / Track B / Phase B2B — Closet cloud sync engine.
//
// The orchestrator. Owns the order of operations, the entitlement gate, the
// single-flight guard, restart discovery, and the stale-operation checks that
// decide whether an async result is still allowed to become authoritative.
//
// PIPELINE (per item, strictly ordered):
//   local mutation has ALREADY succeeded (never gated on any of this)
//     -> durable sync state          (sidecar entry, survives restart)
//     -> K+ eligibility              (existing entitlement authority)
//     -> facts upsert                (B1A; recovers server id by client_id)
//     -> persist local <-> server id (closes the crash window)
//     -> B2A sanitize                (closetMediaPrivacy — the only pixel source)
//     -> SAFE?  yes: upload primary + thumbnail -> READY
//               no : facts stay synced, media blocked, local item untouched
//
// MEDIA CONCURRENCY IS ONE ITEM AT A TIME, deliberately: B2A decodes, detects
// faces, masks and re-encodes a full-resolution image, and running several of
// those concurrently is how a mobile process gets killed for memory. The whole
// pass is therefore serial; facts-only work is cheap enough that splitting it
// out for parallelism would add a second concurrency regime for no measured
// gain.
//
// THERE IS NO BACKGROUND SCHEDULER. A pass runs when something asks for one
// (a save, opening the Closet, app foreground, manual retry). This mirrors
// services/closetCandidateClassification.js, which reached the same conclusion:
// a persistent timer service is its own subsystem with its own lifecycle.

import { CLOSET_CLOUD_SYNC_V1 } from '../../constants/featureFlags';
import { createActorRequest, isActorRequestCurrent } from '../actorContext';
import { getKPlusEntitlementSnapshot } from '../kplus/kplusEntitlementStore';
import { loadCloset } from '../closetLibrary';
import { supabase } from '../supabaseClient';
import { emitClosetCandidateEvent } from '../closetTelemetry';
import {
  createSyncEntry,
  needsSyncWork,
  type ClosetSyncEntry,
} from './closetSyncContract';
import {
  getClosetSyncEntry,
  listClosetSyncEntries,
  updateClosetSyncEntry,
} from './closetSyncStore';
import {
  findCloudClosetItemByClientId,
  insertCloudClosetItem,
  tombstoneCloudClosetItem,
  updateCloudClosetItem,
} from './closetFactsSync';
import { releaseClosetItemMedia, uploadClosetItemMedia } from './closetMediaSync';

/** True only when the rollout flag is on AND K+ is actively entitled. */
export function isClosetCloudSyncEligible(
  flagEnabled: boolean = CLOSET_CLOUD_SYNC_V1,
  kplusState: string = getKPlusEntitlementSnapshot().state,
): boolean {
  return flagEnabled === true && kplusState === 'active';
}

/**
 * Single-flight. A save, a Closet-open and an app-foreground can all fire in
 * the same tick; without this they would run three overlapping passes over the
 * same items. A pass already running is joined, not duplicated.
 */
let inFlightPass: Promise<ClosetSyncPassResult> | null = null;

export interface ClosetSyncPassResult {
  ran: boolean;
  skippedReason?: 'flag_disabled' | 'not_kplus' | 'signed_out' | 'already_running';
  processed: number;
  synced: number;
  blocked: number;
  failed: number;
  deleted: number;
}

function emptyResult(skippedReason: ClosetSyncPassResult['skippedReason']): ClosetSyncPassResult {
  return { ran: false, skippedReason, processed: 0, synced: 0, blocked: 0, failed: 0, deleted: 0 };
}

/**
 * Mark an item as needing cloud sync.
 *
 * Called AFTER a successful local create/edit. This is the ONLY way an item
 * acquires a sidecar entry through the normal path, which is precisely what
 * keeps B2B out of B3's territory: an untouched pre-existing local item never
 * gets one, so a discovery pass never sees it.
 *
 * Never throws and never blocks: a failure here degrades the item to
 * local-only, which is the correct, non-destructive direction.
 */
export async function markClosetItemForSync(ownerId: string | null, clientId: string): Promise<void> {
  if (!clientId) return;
  await updateClosetSyncEntry(ownerId, clientId, (current) => {
    if (!current) return createSyncEntry({ state: 'pending' });
    if (current.state === 'pending_delete') return current; // delete always wins
    return {
      ...current,
      state: 'pending',
      // A fresh user edit is new work, not a continuation of an old failure's
      // backoff, and it clears a prior conflict/permanent verdict because the
      // payload being sent is genuinely different now.
      attemptCount: 0,
      lastAttemptAt: null,
      lastFailureClass: null,
      conflictExpectedRowVersion: null,
    };
  });
}

/**
 * Reconstruct the work list from durable state.
 *
 * The queue is derived, never stored. Restart recovery is exactly this
 * function: load the local Closet, load the sidecar, and ask each entry
 * whether it still has outstanding work.
 */
export async function discoverPendingWork(
  ownerId: string | null,
  nowMs: number = Date.now(),
): Promise<Array<{ clientId: string; entry: ClosetSyncEntry; item: Record<string, any> | null }>> {
  const [entries, localItems] = await Promise.all([
    listClosetSyncEntries(ownerId),
    loadCloset(ownerId).catch(() => []),
  ]);
  const byId = new Map<string, Record<string, any>>();
  for (const item of localItems as Array<Record<string, any>>) {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  }

  const work: Array<{ clientId: string; entry: ClosetSyncEntry; item: Record<string, any> | null }> = [];
  for (const [clientId, entry] of Object.entries(entries)) {
    const item = byId.get(clientId) ?? null;
    // A locally-absent item with a live (non-delete) entry means the record was
    // removed without going through markClosetItemPendingDelete. Its cloud row
    // must still be tombstoned, so treat local absence as authoritative
    // deletion rather than dropping the evidence.
    if (!item && entry.state !== 'pending_delete') {
      if (entry.serverId) {
        work.push({ clientId, entry: { ...entry, state: 'pending_delete' }, item: null });
      }
      continue;
    }
    if (needsSyncWork(entry, item?.updatedAt ?? null, nowMs)) {
      work.push({ clientId, entry, item });
    }
  }
  return work;
}

async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Run one outbound sync pass.
 *
 * Safe to call repeatedly and from several triggers at once. Never throws,
 * never blocks a local Closet operation, and never runs work for an account
 * other than the one currently signed in.
 */
export async function runClosetSyncPass(options: { reason?: string } = {}): Promise<ClosetSyncPassResult> {
  if (inFlightPass) {
    // Join the running pass rather than starting a second one. Its result is
    // reported as `already_running` so a caller can tell the difference.
    await inFlightPass.catch(() => null);
    return emptyResult('already_running');
  }
  const pass = executePass(options).catch(
    (): ClosetSyncPassResult => ({ ran: true, processed: 0, synced: 0, blocked: 0, failed: 0, deleted: 0 }),
  );
  inFlightPass = pass;
  try {
    return await pass;
  } finally {
    inFlightPass = null;
  }
}

async function executePass(options: { reason?: string }): Promise<ClosetSyncPassResult> {
  if (!CLOSET_CLOUD_SYNC_V1) return emptyResult('flag_disabled');

  // Entitlement is evaluated HERE, when the attempt actually runs — never
  // cached onto the item. That is what makes reactivation work with no special
  // case: an item parked while K+ was expired simply becomes eligible again on
  // the next pass (section 27).
  if (getKPlusEntitlementSnapshot().state !== 'active') return emptyResult('not_kplus');

  const userId = await currentUserId();
  if (!userId) return emptyResult('signed_out');

  // Captured ONCE for the whole pass. Every commit re-validates against it, so
  // a sign-out or account switch mid-pass stops further authoritative writes.
  const actorRequest = createActorRequest();
  if (!isActorRequestCurrent(actorRequest)) return emptyResult('signed_out');

  const work = await discoverPendingWork(userId);
  const result: ClosetSyncPassResult = {
    ran: true,
    processed: 0,
    synced: 0,
    blocked: 0,
    failed: 0,
    deleted: 0,
  };
  if (work.length === 0) return result;

  emitClosetCandidateEvent('closet_sync_started', {
    countBucket: work.length >= 9 ? '9_plus' : String(work.length),
  });

  // SERIAL BY DESIGN. See the media-concurrency note at the top of this file.
  for (const unit of work) {
    // Re-check between items, not just at the start: a pass over many items
    // can outlive the session that began it.
    if (!isActorRequestCurrent(actorRequest)) break;
    result.processed += 1;
    const outcome = await syncOneItem({
      userId,
      clientId: unit.clientId,
      entry: unit.entry,
      item: unit.item,
      actorRequest,
    });
    if (outcome === 'synced') result.synced += 1;
    else if (outcome === 'blocked') result.blocked += 1;
    else if (outcome === 'deleted') result.deleted += 1;
    else if (outcome === 'failed') result.failed += 1;
  }

  return result;
}

type ItemOutcome = 'synced' | 'blocked' | 'failed' | 'deleted' | 'skipped';

async function recordFailure(
  userId: string,
  clientId: string,
  failureClass: ClosetSyncEntry['lastFailureClass'],
  patch: Partial<ClosetSyncEntry> = {},
): Promise<void> {
  await updateClosetSyncEntry(userId, clientId, (current) => {
    const base = current ?? createSyncEntry();
    return {
      ...base,
      ...patch,
      state: base.state === 'pending_delete' ? 'pending_delete' : 'error',
      attemptCount: base.attemptCount + 1,
      lastAttemptAt: new Date().toISOString(),
      lastFailureClass: failureClass,
    };
  });
  emitClosetCandidateEvent(failureClass === 'conflict' ? 'closet_sync_conflict' : 'closet_sync_failed', {
    outcome: failureClass ?? 'unknown',
  });
}

async function syncOneItem(input: {
  userId: string;
  clientId: string;
  entry: ClosetSyncEntry;
  item: Record<string, any> | null;
  actorRequest: ReturnType<typeof createActorRequest>;
}): Promise<ItemOutcome> {
  const { userId, clientId, entry, item, actorRequest } = input;

  // ── Deletion wins over everything else ──────────────────────────────────
  if (entry.state === 'pending_delete' || !item) {
    if (!entry.serverId) {
      await updateClosetSyncEntry(userId, clientId, () => null);
      return 'deleted';
    }
    const tombstone = await tombstoneCloudClosetItem(entry.serverId);
    if (!tombstone.ok) {
      await recordFailure(userId, clientId, tombstone.failureClass);
      return 'failed';
    }
    const mediaRelease = await releaseClosetItemMedia(userId, entry.serverId);
    if (!mediaRelease.ok) {
      // The cloud row IS tombstoned — that is never rolled back; tombstoning
      // is idempotent, so a later retry re-running it is harmless. Only the
      // Storage cleanup failed, and Storage failures arrive through `error`,
      // not exceptions, so a bare await here would have silently looked like
      // success. Preserve pending_delete so a later pass retries the release
      // instead of the sidecar entry — and the discoverability it provides —
      // disappearing while the objects are still live.
      await updateClosetSyncEntry(userId, clientId, (current) => {
        const base = current ?? entry;
        return {
          ...base,
          state: 'pending_delete',
          attemptCount: base.attemptCount + 1,
          lastAttemptAt: new Date().toISOString(),
          lastFailureClass: 'retryable',
        };
      });
      emitClosetCandidateEvent('closet_sync_retry', { outcome: 'retryable' });
      return 'failed';
    }
    // Evidence has served its purpose; the entry is removed so it stops being
    // discovered as work.
    await updateClosetSyncEntry(userId, clientId, () => null);
    emitClosetCandidateEvent('closet_sync_tombstoned', { outcome: 'deleted' });
    return 'deleted';
  }

  // Captured now, compared before every authoritative commit. If the user
  // edits or deletes the item while the network work is in flight, this value
  // changes (or the item vanishes) and the stale result is refused.
  const operationUpdatedAt: string | null = item.updatedAt ?? null;

  const isStillCurrent = async (): Promise<boolean> => {
    if (!isActorRequestCurrent(actorRequest)) return false;
    const live = await getClosetSyncEntry(userId, clientId);
    // A delete recorded while this operation was running supersedes it.
    if (live?.state === 'pending_delete') return false;
    const items = (await loadCloset(userId).catch(() => [])) as Array<Record<string, any>>;
    const current = items.find((candidate) => candidate?.id === clientId);
    if (!current) return false; // deleted mid-flight
    return (current.updatedAt ?? null) === operationUpdatedAt;
  };

  // ── Facts ────────────────────────────────────────────────────────────────
  let serverId = entry.serverId;
  let rowVersion = entry.serverRowVersion;
  const factsAreCurrent =
    entry.state === 'synced' && !!serverId && entry.syncedLocalUpdatedAt === operationUpdatedAt;

  if (!factsAreCurrent) {
    // CRASH RECOVERY (section 17). A previous attempt reached the point of
    // writing, so a cloud row may exist even though this device never learned
    // its id. Recover it by client_id instead of inserting a duplicate.
    if (!serverId && entry.factsAttempted) {
      const recovered = await findCloudClosetItemByClientId(clientId);
      if (!recovered.ok) {
        await recordFailure(userId, clientId, recovered.failureClass);
        return 'failed';
      }
      if (recovered.row) {
        serverId = recovered.row.id;
        rowVersion = recovered.row.row_version;
      }
    }

    // Durable BEFORE the write, so the crash window above is always detectable.
    if (!entry.factsAttempted) {
      await updateClosetSyncEntry(userId, clientId, (current) => ({
        ...(current ?? createSyncEntry()),
        factsAttempted: true,
      }));
    }

    const facts = serverId
      ? await updateCloudClosetItem(serverId, rowVersion, item)
      : await insertCloudClosetItem(clientId, item);

    if (!facts.ok) {
      await recordFailure(userId, clientId, facts.failureClass, {
        conflictExpectedRowVersion: facts.serverRowVersion ?? null,
      });
      return 'failed';
    }

    // Nothing may be recorded as synced for an operation that has gone stale.
    if (!(await isStillCurrent())) return 'skipped';

    serverId = facts.serverId;
    rowVersion = facts.rowVersion;
    await updateClosetSyncEntry(userId, clientId, (current) => ({
      ...(current ?? createSyncEntry()),
      state: 'synced',
      serverId,
      serverRowVersion: rowVersion,
      factsAttempted: true,
      syncedLocalUpdatedAt: operationUpdatedAt,
      attemptCount: 0,
      lastAttemptAt: new Date().toISOString(),
      lastFailureClass: null,
      conflictExpectedRowVersion: null,
    }));
    emitClosetCandidateEvent('closet_facts_synced', { outcome: 'synced' });
  }

  // ── Media ────────────────────────────────────────────────────────────────
  // Facts are authoritative at this point and STAY authoritative regardless of
  // what happens below: a media failure never undoes a facts sync.
  const localImageUri = typeof item.imageUri === 'string' ? item.imageUri : null;
  if (!serverId || !localImageUri) return 'synced';

  const liveEntry = await getClosetSyncEntry(userId, clientId);
  if (liveEntry?.mediaState === 'ready' && entry.syncedLocalUpdatedAt === operationUpdatedAt) {
    return 'synced';
  }

  await updateClosetSyncEntry(userId, clientId, (current) => ({
    ...(current ?? createSyncEntry()),
    mediaState: 'pending',
  }));

  const media = await uploadClosetItemMedia({
    userId,
    serverItemId: serverId,
    localImageUri,
    isStillCurrent,
  });

  /**
   * The media saga's own writes bump row_version server-side, so the newest
   * revision it observed replaces the one the facts write recorded. Skipping
   * this is what made a later edit fail as a phantom conflict.
   *
   * DELETE STILL WINS. If a delete was recorded while the media work was in
   * flight, `pending_delete` is preserved rather than being overwritten by any
   * of the media outcomes below — none of which may resurrect the item.
   */
  const applyMediaOutcome = (patch: Partial<ClosetSyncEntry>) =>
    updateClosetSyncEntry(userId, clientId, (current) => {
      const base = current ?? createSyncEntry();
      if (base.state === 'pending_delete') {
        return { ...base, serverRowVersion: media.rowVersion ?? base.serverRowVersion };
      }
      return {
        ...base,
        ...patch,
        serverRowVersion: media.rowVersion ?? base.serverRowVersion,
      };
    });

  if (media.ok) {
    await applyMediaOutcome({
      state: 'synced',
      mediaState: 'ready',
      blockedReason: null,
      attemptCount: 0,
      lastAttemptAt: new Date().toISOString(),
      lastFailureClass: null,
    });
    emitClosetCandidateEvent('closet_media_synced', { outcome: 'ready' });
    return 'synced';
  }

  if (media.blocked) {
    // A deterministic privacy refusal. The facts row remains synced, the local
    // image remains exactly where it is, and this does NOT retry — re-running
    // the same detector over the same pixels can only reach the same verdict.
    // It affects this one item's media, never the user's whole Closet.
    await applyMediaOutcome({
      state: 'synced',
      mediaState: 'blocked',
      blockedReason: media.reason,
      lastAttemptAt: new Date().toISOString(),
      lastFailureClass: 'permanent',
    });
    emitClosetCandidateEvent('closet_media_blocked', { errorCode: media.reason });
    return 'blocked';
  }

  const liveBeforeFailure = await getClosetSyncEntry(userId, clientId);
  await applyMediaOutcome({
    // Facts stay synced; only the media attempt failed. This is a legitimate
    // resting state, not a corrupt one (section 18).
    state: 'synced',
    mediaState: 'pending',
    attemptCount: (liveBeforeFailure?.attemptCount ?? 0) + 1,
    lastAttemptAt: new Date().toISOString(),
    lastFailureClass: media.failureClass,
  });
  emitClosetCandidateEvent('closet_sync_retry', { outcome: media.failureClass });
  return 'failed';
}

/** Test seam only. */
export const __closetSyncEngineInternals = {
  resetInFlight: () => {
    inFlightPass = null;
  },
};
