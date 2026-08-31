/**
 * Actor scope — the shared stale-work guard for actor-bound async results.
 *
 * This is a THIN, TYPED SEAM over the project's existing actor authority in
 * services/actorContext.js. It deliberately introduces NO second actor
 * framework: the epoch, the transition point and the fail-closed comparison all
 * still live in actorContext, which AuthSessionContext advances from
 * resetActorScopedRuntimeState() on every authentication transition.
 *
 * Why a seam at all: the correctness rule
 *
 *     capture BEFORE await  ->  await  ->  re-validate AFTER await
 *                           ->  discard with ZERO mutation if stale
 *
 * was being re-implemented (badly, or not at all) in each feature hook. Several
 * of them guarded on `isAuthenticated`, or on a captured `user.id`, neither of
 * which is actor identity:
 *
 *   - `isAuthenticated` stays true across an A -> B account switch, so the
 *     guard never fires at all.
 *   - a captured id alone cannot reject work started during a PREVIOUS
 *     A -> B -> A cycle, because the id matches again. Only the monotonic
 *     epoch distinguishes those two generations of A.
 *
 * Usage:
 *
 *     const scope = captureActorScope();
 *     const data = await loadSomething();
 *     if (!isActorScopeCurrent(scope)) return;   // stale: mutate NOTHING
 *     setState(data);
 *
 * Re-validate after EVERY await that precedes an actor-bound mutation, not just
 * the first one — an actor can change during any of them.
 */

// The canonical authority. JavaScript by design (it must be callable from the
// non-React persistence layer); typed via services/actorContext.d.ts.
import {
  createActorRequest,
  getActorContext,
  isActorRequestCurrent,
} from './actorContext';

export type ActorScope = {
  readonly actorId: string | null;
  readonly epoch: number;
  readonly requestId: string;
};

/**
 * Capture the current actor generation. Call this BEFORE starting asynchronous
 * work whose result would mutate actor-bound state.
 */
export function captureActorScope(): ActorScope {
  return createActorRequest();
}

/**
 * True only when the captured scope is still the live actor generation.
 *
 * Fails closed: a malformed scope, a changed actor id, or a changed epoch all
 * return false. Because the epoch increments on EVERY transition, a scope
 * captured during the first A of an A -> B -> A sequence is correctly rejected
 * even though the actor id matches again.
 */
export function isActorScopeCurrent(scope: ActorScope | null | undefined): boolean {
  return isActorRequestCurrent(scope);
}

/** The live actor id, or null for the signed-out device-local partition. */
export function currentActorId(): string | null {
  return getActorContext().actorId;
}

/**
 * Stable identity string for the live actor generation.
 *
 * Use as a React dependency / reset key where a component must re-run when the
 * ACTOR changes — `isAuthenticated` and `user?.id` both miss transitions this
 * catches (B -> A returns the same id but a new epoch).
 */
export function currentActorScopeKey(): string {
  const { actorId, epoch } = getActorContext();
  return `${actorId ?? 'anonymous'}#${epoch}`;
}
