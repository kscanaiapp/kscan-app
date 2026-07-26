/**
 * Actor context and epoch for Recent Scan account isolation.
 *
 * A captured `userId` alone is not sufficient to reject a stale asynchronous
 * result: User A can sign out and sign back in as User A while an old request
 * is still in flight, and the ID would still match. Every actor transition
 * therefore advances a monotonic epoch, and an in-flight operation is only
 * allowed to commit when BOTH the actor id and the epoch it captured are still
 * current.
 *
 * Actor identity contract:
 *   - `actorId: string` — an authenticated Supabase user id.
 *   - `actorId: null`   — the signed-out device-local context. On iOS this is a
 *                         real, durable partition (ownerless records); it is not
 *                         an error state.
 *
 * This module is deliberately module-scoped rather than React state: the
 * persistence layer in services/library.js must be able to validate a request
 * without a React tree, and stale `finally` handlers must be rejectable after
 * a component has unmounted.
 */

let currentActorId = null;
let currentEpoch = 0;
let requestCounter = 0;

function normalizeActorId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Advance to a new actor context. Call on EVERY authentication transition,
 * including signed-out -> A, A -> B, A -> signed-out, and A -> signed-out -> A.
 * The epoch always increments, even when the resulting actor id is unchanged,
 * so a request captured before a sign-out/sign-in cycle is still rejected.
 */
export function advanceActorEpoch(nextActorId) {
  currentActorId = normalizeActorId(nextActorId);
  currentEpoch += 1;
  return { actorId: currentActorId, epoch: currentEpoch };
}

export function getActorContext() {
  return { actorId: currentActorId, epoch: currentEpoch };
}

/**
 * Capture the (actorId, actorEpoch, requestId) triple an asynchronous operation
 * must carry. Pass the result to every persistence call the operation makes.
 */
export function createActorRequest() {
  requestCounter += 1;
  return {
    actorId: currentActorId,
    epoch: currentEpoch,
    requestId: `scanreq_${currentEpoch}_${requestCounter}_${Math.floor(Math.random() * 1e9).toString(36)}`,
  };
}

/**
 * True only when the captured request still matches the live actor context.
 * Fails closed on anything malformed.
 */
export function isActorRequestCurrent(request) {
  if (!request || typeof request !== 'object') return false;
  if (typeof request.epoch !== 'number' || !Number.isFinite(request.epoch)) return false;
  if (typeof request.requestId !== 'string' || !request.requestId) return false;
  if (request.epoch !== currentEpoch) return false;
  return normalizeActorId(request.actorId) === currentActorId;
}

/**
 * Authenticated ownership authority (see docs/account-isolation contract).
 *
 * UI callers may not choose an ownerId. Ownership is derived here from the
 * captured actor context, and any disagreement fails closed.
 *
 * @returns {{ok: true, ownerId: string|null} | {ok: false, reason: string}}
 */
export function resolveWriteAuthority(request, declaredOwnerId = undefined) {
  if (!request || typeof request !== 'object') {
    return { ok: false, reason: 'missing_actor_context' };
  }
  if (!isActorRequestCurrent(request)) {
    return { ok: false, reason: 'stale_actor_context' };
  }
  const actorId = normalizeActorId(request.actorId);

  // A caller may echo the owner it believes it is writing for. It may never
  // choose a different one, and it may never downgrade an authenticated write
  // to an ownerless one.
  if (declaredOwnerId !== undefined) {
    const declared = normalizeActorId(declaredOwnerId);
    if (declared !== actorId) {
      return {
        ok: false,
        reason: actorId === null ? 'ownerless_context_declared_owner' : 'owner_mismatch',
      };
    }
  }

  // actorId === null is the signed-out device-local partition: a durable,
  // intentional ownerless write on iOS.
  return { ok: true, ownerId: actorId };
}

/** Test seam only. Not used by production code. */
export function __resetActorContextForTests() {
  currentActorId = null;
  currentEpoch = 0;
  requestCounter = 0;
}
