/**
 * Type surface for services/actorContext.js — the canonical actor authority.
 *
 * The implementation stays JavaScript on purpose: services/library.js and other
 * non-React persistence code must be able to validate a request without a React
 * tree, and stale `finally` handlers must remain rejectable after unmount.
 * This declaration only lets TypeScript consumers (services/actorScope.ts and
 * the feature hooks) use it without casting.
 */

export type ActorContextSnapshot = {
  actorId: string | null;
  epoch: number;
};

export type ActorRequest = {
  actorId: string | null;
  epoch: number;
  requestId: string;
};

export type WriteAuthority =
  | { ok: true; ownerId: string | null }
  | { ok: false; reason: string };

export function advanceActorEpoch(nextActorId: string | null): ActorContextSnapshot;
export function getActorContext(): ActorContextSnapshot;
export function createActorRequest(): ActorRequest;
export function isActorRequestCurrent(request: unknown): boolean;
/**
 * Accepts `unknown` deliberately: the implementation validates the shape and
 * fails closed ('missing_actor_context' / 'stale_actor_context') on anything
 * malformed, and several stores hand it a value they have not narrowed yet.
 * Declaring a narrower parameter here would be stricter than the real contract.
 */
export function resolveWriteAuthority(
  request: unknown,
  declaredOwnerId?: string | null,
): WriteAuthority;
export function __resetActorContextForTests(): void;
