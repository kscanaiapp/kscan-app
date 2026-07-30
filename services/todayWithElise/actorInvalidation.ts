/**
 * Build 5 — actor invalidation helpers for Today with Elise V1.
 *
 * Reuses services/actorContext.js epoch semantics. This module only defines
 * the Today-card generation token + commit gate so Home orchestration can
 * prove:
 *   - Actor A result cannot appear for Actor B
 *   - Actor switch invalidates pending Actor A work
 *   - Logout invalidates pending and resolved card state
 *   - Missing actor fails closed
 *   - Reauthentication cannot revive an obsolete recommendation
 *   - Background completion cannot overwrite a newer actor snapshot
 */

export type TodayCardOrchestrationHandle = {
  actorId: string | null;
  actorEpoch: number;
  generationToken: string;
};

let generationCounter = 0;

export function createTodayCardGenerationToken(actorEpoch: number): string {
  generationCounter += 1;
  return `today_${actorEpoch}_${generationCounter}`;
}

/** Test seam. */
export function __resetTodayCardGenerationCounter(): void {
  generationCounter = 0;
}

/**
 * Capture a handle at the start of an async Today-card evaluation.
 * Callers must also capture createActorRequest() from actorContext.
 */
export function beginTodayCardEvaluation(args: {
  actorId: string | null;
  actorEpoch: number;
}): TodayCardOrchestrationHandle {
  return {
    actorId:
      typeof args.actorId === 'string' && args.actorId.trim()
        ? args.actorId.trim()
        : null,
    actorEpoch: args.actorEpoch,
    generationToken: createTodayCardGenerationToken(args.actorEpoch),
  };
}

/**
 * Commit gate for async completion. Requires live actor context + handle match.
 */
export function canCommitTodayCardResult(args: {
  handle: TodayCardOrchestrationHandle;
  liveActorId: string | null;
  liveActorEpoch: number;
  /** Optional: isActorRequestCurrent from actorContext. */
  actorRequestCurrent: boolean;
}): boolean {
  if (!args.handle || typeof args.handle !== 'object') return false;
  if (args.actorRequestCurrent !== true) return false;
  if (args.handle.actorEpoch !== args.liveActorEpoch) return false;
  const live =
    typeof args.liveActorId === 'string' && args.liveActorId.trim()
      ? args.liveActorId.trim()
      : null;
  const handled =
    typeof args.handle.actorId === 'string' && args.handle.actorId.trim()
      ? args.handle.actorId.trim()
      : null;
  if (live === null || handled === null) return false;
  return live === handled;
}

/**
 * Logout / actor-switch invalidation: drop any resolved card state that does
 * not match the live handle.
 */
export function invalidateTodayCardStateIfStale<T extends {
  actorId: string | null;
  actorEpoch: number | null;
  generationToken: string;
}>(
  state: T | null,
  live: TodayCardOrchestrationHandle,
): T | null {
  if (!state) return null;
  if (state.generationToken !== live.generationToken) return null;
  if (state.actorEpoch !== live.actorEpoch) return null;
  const liveActor =
    typeof live.actorId === 'string' && live.actorId.trim()
      ? live.actorId.trim()
      : null;
  const stateActor =
    typeof state.actorId === 'string' && state.actorId.trim()
      ? state.actorId.trim()
      : null;
  if (liveActor === null || stateActor === null || liveActor !== stateActor) {
    return null;
  }
  return state;
}
