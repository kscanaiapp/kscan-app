/**
 * Terminal-deletion reconciliation.
 *
 * Asks the backend, for each pending marker this device holds, whether that
 * lifecycle has actually reached a terminal purge — and, only then, destroys
 * that owner's local data and retires the marker.
 *
 * NO POLLING, NO TIMERS, NO BACKGROUND EXECUTION. This runs at the same two
 * boundaries services/auth/appleCredentialState.ts uses: authenticated
 * bootstrap completing, and a real background/inactive -> active transition.
 * That is a deliberate copy of the most conservative lifecycle pattern already
 * in the app. There is no `setInterval`, no background fetch, no silent push,
 * no background task and no new iOS background mode anywhere in this repair.
 *
 * IT DOES NOT BELONG TO THE CURRENT ACTOR. This is the one place in the app
 * where acting on behalf of a NON-current actor is correct: actor A's purge is
 * confirmed after A is gone, often while B is signed in. Every decision is
 * therefore driven by the marker's own stored owner scope, never by the live
 * actor context, and the purge primitives it calls take that owner explicitly.
 * The corollary is enforced too — nothing here reads, writes or resets any
 * current-actor runtime state.
 *
 * ORDER OF DESTRUCTION. Local data first, marker last. A crash between them
 * leaves a marker whose lifecycle is already purged, and the next boundary
 * simply repeats an idempotent cleanup. The reverse order would lose the
 * capability while data remained, permanently and silently.
 */

import { fetchDeletionStatus, type DeletionStatusOutcome } from './deletionStatusClient';
import {
  listPendingDeletions,
  removePendingDeletion,
  updatePendingDeletion,
  type PendingDeletionRecord,
} from './pendingDeletionStore';
import { decideTerminalAction, isBindingQueryable } from './terminalDeletionDecision';
import { purgeOwnerScopedLocalData, type OwnerPurgeResult } from './ownerTerminalPurge';

/**
 * Upper bound on markers handled per boundary. A device realistically holds
 * one or two; the cap exists so a corrupted or adversarially large index
 * cannot turn a foreground transition into an unbounded burst of requests.
 */
export const MAX_MARKERS_PER_RECONCILE = 4;

export type ReconcileOutcome = {
  recordId: string;
  action: 'purged' | 'released' | 'retained' | 'skipped';
  reason: string;
};

export type ReconcileSummary = {
  ran: boolean;
  outcomes: ReconcileOutcome[];
};

type Deps = Partial<{
  list: typeof listPendingDeletions;
  update: typeof updatePendingDeletion;
  remove: typeof removePendingDeletion;
  fetchStatus: (receipt: string) => Promise<DeletionStatusOutcome>;
  purge: (ownerId: string) => Promise<OwnerPurgeResult>;
  now: () => Date;
}>;

/**
 * Module-scoped in-flight guard, matching the shape used by
 * services/auth/appleCredentialState.ts.
 *
 * Overlapping foreground events are common (a resume that also completes an
 * auth bootstrap), and two concurrent runs would issue duplicate lookups and,
 * worse, two concurrent purges of the same owner. The second caller collapses
 * onto the first rather than queueing behind it: by the time it would run, the
 * first has already read the same state.
 */
let inFlight: Promise<ReconcileSummary> | null = null;

/** Test seam. Not used by production code. */
export function __resetTerminalReconcilerForTests(): void {
  inFlight = null;
}

async function reconcileOne(
  record: PendingDeletionRecord,
  deps: Deps,
): Promise<ReconcileOutcome> {
  const update = deps.update ?? updatePendingDeletion;
  const remove = deps.remove ?? removePendingDeletion;
  const fetchStatus = deps.fetchStatus ?? fetchDeletionStatus;
  const purge = deps.purge ?? purgeOwnerScopedLocalData;
  const now = deps.now ?? (() => new Date());

  // A marker the backend never bound, or whose capability is gone, can never
  // resolve a lifecycle. It is kept as an explicit record of that condition and
  // never produces a network call.
  if (!isBindingQueryable(record.bindingState) || !record.receipt) {
    return { recordId: record.recordId, action: 'skipped', reason: `binding_${record.bindingState}` };
  }

  const outcome = await fetchStatus(record.receipt);
  const decision = decideTerminalAction(outcome, record.bindingState);
  const checkedAt = now().toISOString();
  const observedState = outcome.kind === 'lifecycle' ? outcome.state : outcome.kind;

  if (decision.action === 'release') {
    // The account is usable again. The marker goes; every byte of local data
    // stays exactly where it is. No purge primitive is reachable from here.
    await remove(record.recordId);
    return { recordId: record.recordId, action: 'released', reason: decision.reason };
  }

  if (decision.action === 'retain') {
    await update(record.recordId, { lastCheckedAt: checkedAt, lastKnownState: observedState });
    return { recordId: record.recordId, action: 'retained', reason: decision.reason };
  }

  // decision.action === 'purge' — the double lock held.
  await update(record.recordId, {
    purgeState: 'in_progress',
    lastCheckedAt: checkedAt,
    lastKnownState: 'purged',
  });

  const result = await purge(record.ownerId);

  if (!result.complete) {
    // Partial cleanup is NOT completion. The marker survives so the remaining
    // subsystems are retried at the next boundary; every step is idempotent, so
    // the ones that already succeeded are no-ops on the retry.
    await update(record.recordId, { purgeState: 'in_progress' });
    const failed = result.steps.filter((s) => !s.ok).map((s) => s.step);
    return {
      recordId: record.recordId,
      action: 'retained',
      reason: `purge_incomplete:${failed.join(',') || 'unknown'}`,
    };
  }

  await update(record.recordId, { purgeState: 'complete' });
  // LAST: the capability and the marker are destroyed only now.
  await remove(record.recordId);
  return { recordId: record.recordId, action: 'purged', reason: 'terminal' };
}

/**
 * One reconciliation pass over every marker this device holds.
 *
 * Never throws. A failure anywhere degrades to "retain", which costs the user
 * nothing but a retained copy of their own data and one more attempt later.
 */
export function reconcileTerminalDeletions(deps: Deps = {}): Promise<ReconcileSummary> {
  if (inFlight) return inFlight;

  const run = (async (): Promise<ReconcileSummary> => {
    const list = deps.list ?? listPendingDeletions;
    let records: PendingDeletionRecord[] = [];
    try {
      records = await list();
    } catch {
      return { ran: false, outcomes: [] };
    }
    if (records.length === 0) return { ran: true, outcomes: [] };

    // Deterministic and bounded: oldest lifecycle first, so a long-standing
    // marker is never starved by newer ones under the cap.
    const ordered = [...records]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.recordId.localeCompare(b.recordId))
      .slice(0, MAX_MARKERS_PER_RECONCILE);

    const outcomes: ReconcileOutcome[] = [];
    for (const record of ordered) {
      try {
        outcomes.push(await reconcileOne(record, deps));
      } catch {
        outcomes.push({ recordId: record.recordId, action: 'retained', reason: 'reconcile_error' });
      }
    }
    return { ran: true, outcomes };
  })();

  inFlight = run.finally(() => {
    if (inFlight === run) inFlight = null;
  }) as Promise<ReconcileSummary>;

  return inFlight;
}
