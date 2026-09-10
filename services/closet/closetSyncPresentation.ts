// Closet Experience V1 — sync and restore, in customer language (PR A1, sections 31/32).
//
// WHAT THIS IS: a pure mapping from the sync sidecar's INTERNAL vocabulary to the
// few words a person should actually read on a Closet header.
//
// WHAT IT IS NOT:
//
//     presentation  !=  a second sync state machine
//
// It computes nothing about what should sync, retries nothing, and writes
// nothing. `closetSyncEngine` / `closetRestoreEngine` remain the only authorities
// on sync state; this file only decides how to say what they already decided.
//
// SECTION 32 IS ENFORCED HERE BY CONSTRUCTION. The words `row_version`,
// `tombstone`, `pagination`, `PRE-B2B`, `sidecar`, `pending_delete`, `blocked`
// and every `ClosetSyncFailureClass` value are absent from every string this
// module can return. A test asserts that.
//
// LOCAL-FIRST (section 33): every state below is ADVISORY. None of them is a
// reason to hide, block or degrade the Closet itself. "Not syncing" is a fact
// about the cloud copy, never about whether the user owns their items.

import type { ClosetSyncEntry } from './closetSyncContract';

export const CLOSET_SYNC_PRESENTATION_VERSION = 1;

/**
 * What a person can be told about their Closet's cloud copy.
 *
 * Deliberately a SMALL closed set. Every additional state is another sentence a
 * user has to interpret, and the internal machine already has six states plus
 * four failure classes plus two conflict kinds — surfacing that granularity
 * would be exposing the machine, which is exactly what section 32 forbids.
 */
export type ClosetSyncPresentationTone = 'neutral' | 'progress' | 'attention';

export type ClosetSyncPresentation = {
  version: typeof CLOSET_SYNC_PRESENTATION_VERSION;
  /** Stable id for tests and telemetry. NEVER rendered. */
  id:
    | 'unavailable'
    | 'up_to_date'
    | 'syncing'
    | 'restoring'
    | 'offline'
    | 'needs_attention';
  /** The one line a person reads. */
  label: string;
  /** Optional second line. Null when the label says enough. */
  detail: string | null;
  tone: ClosetSyncPresentationTone;
};

function present(
  id: ClosetSyncPresentation['id'],
  label: string,
  detail: string | null,
  tone: ClosetSyncPresentationTone,
): ClosetSyncPresentation {
  return { version: CLOSET_SYNC_PRESENTATION_VERSION, id, label, detail, tone };
}

export type ClosetSyncPresentationInput = {
  /**
   * Is cloud sync available to this actor at all?
   *
   * Supplied by the caller from the CANONICAL authority
   * (`isClosetCloudSyncEligible`), never re-derived here — section 13 says
   * consume the entitlement predicate, do not reimplement it.
   */
  eligible: boolean;
  /**
   * True while entitlement is still RESOLVING (section 12).
   *
   * RESOLVING IS NOT INACTIVE. While this is true the surface shows nothing at
   * all rather than "not available", because claiming a capability is absent
   * before the authority answered is how a paying user gets told they are not
   * one.
   */
  resolving: boolean;
  /** The actor's own sidecar partition. */
  entries: Readonly<Record<string, ClosetSyncEntry>>;
  /** True when a restore pass is currently running. */
  restoreInFlight?: boolean;
  /** Last observed connectivity, when the caller knows it. `undefined` = unknown. */
  online?: boolean;
};

/**
 * Decide what to say.
 *
 * ORDER MATTERS and is the whole design:
 *
 *   1. resolving   — say nothing (section 12)
 *   2. ineligible  — say nothing here; availability messaging is the shared K+
 *                    Early Access surface's job, not a status pill's
 *   3. attention   — a permanent refusal or a conflict needs a human
 *   4. restoring   — inbound work is the most interesting thing happening
 *   5. offline     — only claimed when the caller actually KNOWS we are offline
 *   6. syncing     — outbound work in flight
 *   7. up to date  — the default, and only reachable when nothing above applies
 *
 * "Up to date" is LAST on purpose. It is the only reassuring state, so it must
 * be unreachable while any unresolved work exists — a status pill that says
 * everything is fine while an item is stuck is worse than no pill.
 */
export function presentClosetSyncStatus(
  input: ClosetSyncPresentationInput,
): ClosetSyncPresentation | null {
  if (input.resolving) return null;
  if (!input.eligible) return null;

  const entries = Object.values(input.entries ?? {});

  let attention = 0;
  let inFlight = 0;

  for (const entry of entries) {
    if (!entry) continue;

    // A deterministic refusal, or a server row that moved on under us, will not
    // resolve itself by waiting. Everything else is retryable and therefore
    // ordinary in-flight work, not a problem to report.
    const stuck =
      entry.lastFailureClass === 'permanent' ||
      entry.lastFailureClass === 'conflict' ||
      entry.mediaState === 'blocked';

    if (stuck) {
      attention += 1;
      continue;
    }

    if (entry.state === 'pending' || entry.state === 'pending_delete' || entry.state === 'error') {
      inFlight += 1;
    } else if (entry.mediaState === 'pending') {
      inFlight += 1;
    }
  }

  if (attention > 0) {
    return present(
      'needs_attention',
      'Some items need attention',
      attention === 1
        ? "1 item couldn't be saved to your other devices. Your Closet on this device is unaffected."
        : `${attention} items couldn't be saved to your other devices. Your Closet on this device is unaffected.`,
      'attention',
    );
  }

  if (input.restoreInFlight) {
    return present('restoring', 'Restoring your Closet', 'Bringing in items from your other devices.', 'progress');
  }

  // Only claim offline when the caller actually knows. `undefined` means the
  // surface has no connectivity signal, and guessing "offline" from a failed
  // request is how a working Closet gets labelled broken.
  if (input.online === false && inFlight > 0) {
    return present(
      'offline',
      'Offline',
      "Your Closet works offline. We'll finish saving to your other devices when you're back online.",
      'neutral',
    );
  }

  if (inFlight > 0) {
    return present(
      'syncing',
      'Syncing',
      inFlight === 1 ? 'Saving 1 item to your other devices.' : `Saving ${inFlight} items to your other devices.`,
      'progress',
    );
  }

  return present('up_to_date', 'Up to date', 'Your Closet is available on your devices.', 'neutral');
}

/**
 * Restore outcome, in customer language (section 32).
 *
 * Takes the counters `runClosetRestorePass` already returns. `null` means "say
 * nothing" — a pass that did not run, or ran and changed nothing on a Closet
 * that was already current, is not news.
 */
export function presentClosetRestoreOutcome(result: {
  ran: boolean;
  materialized: number;
  updated: number;
  deleted: number;
  conflicts: number;
  failed: number;
}): { id: 'restored' | 'nothing_new' | 'needs_attention' | 'unavailable'; label: string } | null {
  if (!result || !result.ran) return null;

  if (result.conflicts > 0 || result.failed > 0) {
    return { id: 'needs_attention', label: 'Some items need attention' };
  }

  const changed = result.materialized + result.updated + result.deleted;
  if (changed > 0) {
    return {
      id: 'restored',
      label: changed === 1 ? 'Restored 1 item' : `Restored ${changed} items`,
    };
  }

  return { id: 'nothing_new', label: 'Nothing new to restore' };
}
