// Build 34 / Track B / Phase B3 — Historical Closet migration engine.
//
// The orchestrator, and ONLY the orchestrator. It answers exactly one
// question per pass — "which pre-existing local items have never touched
// cloud sync, and should a bounded batch of them be handed to B2B now?" —
// and then hands them to the EXISTING B2B outbound engine unchanged.
//
// PIPELINE (per pass):
//   flag + K+ gate + cooldown
//     -> load local Closet + full sidecar (one read each, no network)
//     -> select up to CLOSET_HISTORICAL_MIGRATION_BATCH_SIZE eligible items
//        (closetHistoricalMigrationContract.ts, pure)
//     -> markClosetItemForSync(...) for each — the SAME function B2B's own
//        save/edit path uses, so an enrolled item is indistinguishable from
//        an opportunistically-synced one from that point on
//     -> resumeClosetSync('legacy_migration') ONCE — B2B's own engine (facts
//        upsert, B2A sanitize, media upload, conflict detection, retry/
//        backoff) does every remaining step; nothing here re-implements any
//        of it
//
// B3 NEVER TALKS TO SUPABASE, NEVER TALKS TO B2A, AND NEVER WRITES CLOSET
// FACTS OR MEDIA ITSELF. If B2B's flag or K+ ends up not eligible when
// `resumeClosetSync` actually runs, the marked items simply sit as `pending`
// sidecar entries — a correct, non-destructive resting state — until the next
// trigger finds B2B eligible and picks them up. No rollback is needed because
// nothing irreversible happened.
//
// THERE IS NO BACKGROUND SCHEDULER. A pass runs only when the Closet screen
// gains focus, the same trigger B2B and B2C already use.

import { CLOSET_LEGACY_MIGRATION_V1, CLOSET_CLOUD_SYNC_V1 } from '../../constants/featureFlags';
import { createActorRequest, isActorRequestCurrent } from '../actorContext';
import { getKPlusEntitlementSnapshot } from '../kplus/kplusEntitlementStore';
import { loadCloset, CLOSET_ITEM_MAX_SUPPORTED_SCHEMA_VERSION } from '../closetLibrary';
import { supabase } from '../supabaseClient';
import { emitClosetCandidateEvent } from '../closetTelemetry';
import { listClosetSyncEntries } from './closetSyncStore';
import { markClosetItemForSync, runClosetSyncPass } from './closetSyncEngine';
import {
  isClosetHistoricalMigrationCooldownElapsed,
  selectClosetHistoricalMigrationCandidates,
  CLOSET_HISTORICAL_MIGRATION_BATCH_SIZE,
  type ClosetHistoricalMigrationCandidateItem,
} from './closetHistoricalMigrationContract';

/** True only when BOTH the migration flag and B2B's own outbound flag are on,
 *  AND K+ is actively entitled. Requiring B2B's flag too is deliberate:
 *  enrolling an item into a sync engine that is itself disabled would only
 *  populate the sidecar with `pending` entries no pass will ever act on until
 *  B2B is separately turned on — harmless, but pointless work this pass
 *  should not bother doing. */
export function isClosetHistoricalMigrationEligibleNow(
  migrationFlagEnabled: boolean = CLOSET_LEGACY_MIGRATION_V1,
  cloudSyncFlagEnabled: boolean = CLOSET_CLOUD_SYNC_V1,
  kplusState: string = getKPlusEntitlementSnapshot().state,
): boolean {
  return migrationFlagEnabled === true && cloudSyncFlagEnabled === true && kplusState === 'active';
}

export interface ClosetHistoricalMigrationPassResult {
  ran: boolean;
  skippedReason?: 'flag_disabled' | 'not_kplus' | 'signed_out' | 'already_running' | 'cooldown';
  eligible: number;
  marked: number;
}

function emptyMigrationResult(
  skippedReason: ClosetHistoricalMigrationPassResult['skippedReason'],
): ClosetHistoricalMigrationPassResult {
  return { ran: false, skippedReason, eligible: 0, marked: 0 };
}

function bucketCount(n: number): string {
  if (n <= 0) return '0';
  if (n >= 9) return '9_plus';
  return String(n);
}

async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Single-flight, like closetSyncEngine.ts and closetRestoreEngine.ts. */
let inFlightMigrationPass: Promise<ClosetHistoricalMigrationPassResult> | null = null;

/** In-memory only, mirrors closetRestoreEngine.ts's lastRestoreAttempt exactly:
 *  resets on account change and app restart, never persisted (Addendum D). */
let lastMigrationAttempt: { actorId: string | null; atMs: number } | null = null;

export async function runClosetHistoricalMigrationPass(
  options: { reason?: string; nowMs?: number; bypassCooldown?: boolean } = {},
): Promise<ClosetHistoricalMigrationPassResult> {
  if (inFlightMigrationPass) {
    await inFlightMigrationPass.catch(() => null);
    return emptyMigrationResult('already_running');
  }
  const pass = executeMigrationPass(options).catch(
    (): ClosetHistoricalMigrationPassResult => ({ ran: true, eligible: 0, marked: 0 }),
  );
  inFlightMigrationPass = pass;
  try {
    return await pass;
  } finally {
    inFlightMigrationPass = null;
  }
}

async function executeMigrationPass(options: {
  reason?: string;
  nowMs?: number;
  bypassCooldown?: boolean;
}): Promise<ClosetHistoricalMigrationPassResult> {
  if (!CLOSET_LEGACY_MIGRATION_V1) return emptyMigrationResult('flag_disabled');
  // Evaluated HERE, fresh, every attempt — the same "no special case for
  // reactivation" pattern every other Track B engine in this file uses.
  if (!isClosetHistoricalMigrationEligibleNow()) return emptyMigrationResult('not_kplus');

  const userId = await currentUserId();
  if (!userId) return emptyMigrationResult('signed_out');

  const actorRequest = createActorRequest();
  if (!isActorRequestCurrent(actorRequest)) return emptyMigrationResult('signed_out');

  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  if (
    !options.bypassCooldown &&
    !isClosetHistoricalMigrationCooldownElapsed(lastMigrationAttempt, userId, nowMs)
  ) {
    return emptyMigrationResult('cooldown');
  }
  lastMigrationAttempt = { actorId: userId, atMs: nowMs };

  const [localItems, syncEntries] = await Promise.all([
    loadCloset(userId).catch(() => []) as Promise<Array<Record<string, any>>>,
    listClosetSyncEntries(userId),
  ]);

  const candidateItems: ClosetHistoricalMigrationCandidateItem[] = (
    Array.isArray(localItems) ? localItems : []
  )
    .filter((item) => item && typeof item.id === 'string')
    .map((item) => ({
      id: item.id,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null,
      schemaVersion: Number.isFinite(item.schemaVersion) ? item.schemaVersion : null,
    }));
  const clientIdsWithSyncEntry = new Set<string>(Object.keys(syncEntries));

  const selected = selectClosetHistoricalMigrationCandidates(
    candidateItems,
    clientIdsWithSyncEntry,
    CLOSET_ITEM_MAX_SUPPORTED_SCHEMA_VERSION,
    CLOSET_HISTORICAL_MIGRATION_BATCH_SIZE,
  );

  const result: ClosetHistoricalMigrationPassResult = { ran: true, eligible: selected.length, marked: 0 };
  if (selected.length === 0) return result;

  emitClosetCandidateEvent('closet_migration_started', { countBucket: bucketCount(selected.length) });

  // Re-check right before the authoritative write: a sign-out mid-selection
  // must not enroll items under an actor that is no longer current.
  if (!isActorRequestCurrent(actorRequest)) return { ...result, eligible: selected.length, marked: 0 };

  for (const clientId of selected) {
    if (!isActorRequestCurrent(actorRequest)) break;
    // The SAME function B2B's save/edit path calls. From this point on, a
    // migrated item is architecturally indistinguishable from one the user
    // just edited — there is no separate "migrated" state anywhere.
    await markClosetItemForSync(userId, clientId);
    result.marked += 1;
  }

  emitClosetCandidateEvent('closet_migration_batch_marked', { countBucket: bucketCount(result.marked) });

  // Hand off to B2B's existing engine ONCE for the whole batch. B2B is
  // single-flight and serial by design (facts, then B2A sanitize, then
  // media), so this pass's job ends here regardless of how long that
  // outbound work takes.
  if (result.marked > 0) {
    await runClosetSyncPass({ reason: 'legacy_migration' });
  }

  emitClosetCandidateEvent('closet_migration_completed', { countBucket: bucketCount(result.marked) });
  return result;
}

/**
 * Opportunistic trigger for Closet-open (and app-foreground while the Closet
 * screen is active) — identical trigger shape to resumeClosetSync and
 * resumeClosetRestore. Safe to call as often as a caller likes: single-flight
 * plus the cooldown collapse overlapping/rapid triggers into at most one real
 * pass.
 */
export async function resumeClosetHistoricalMigration(reason: string): Promise<void> {
  try {
    await runClosetHistoricalMigrationPass({ reason });
  } catch {
    /* migration never affects the local Closet's own outcome */
  }
}

/** Test seam only. */
export const __closetHistoricalMigrationEngineInternals = {
  resetInFlight: () => {
    inFlightMigrationPass = null;
  },
  resetCooldown: () => {
    lastMigrationAttempt = null;
  },
};
