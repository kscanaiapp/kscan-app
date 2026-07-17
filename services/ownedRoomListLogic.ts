import type { DressingRoom, Look } from '../types/styleObjects';

export type OwnedRoomListSnapshot<T> = {
  actorId: string | null;
  generation: number;
  items: T[];
  errorMessage: string | null;
  loading: boolean;
};

export function createOwnedRoomListSnapshot<T>(
  actorId: string | null,
  generation = 0,
): OwnedRoomListSnapshot<T> {
  return {
    actorId,
    generation,
    items: [],
    errorMessage: null,
    loading: Boolean(actorId),
  };
}

export function clearOwnedRoomListForActorChange<T>(
  previous: OwnedRoomListSnapshot<T>,
  nextActorId: string | null,
): OwnedRoomListSnapshot<T> {
  return createOwnedRoomListSnapshot<T>(nextActorId, previous.generation + 1);
}

export function beginOwnedRoomListLoad<T>(
  previous: OwnedRoomListSnapshot<T>,
  actorId: string,
  generation: number,
): OwnedRoomListSnapshot<T> {
  return {
    actorId,
    generation,
    // Keep prior items for the same actor while refreshing so a transient
    // failure cannot flash an empty owned-room grid.
    items: previous.actorId === actorId ? previous.items : [],
    errorMessage: null,
    loading: true,
  };
}

/**
 * Apply a list response only when generation + actor still match.
 * Stale success/empty/error results return null so callers keep current state.
 */
export function applyOwnedRoomListResult<T>(args: {
  previous: OwnedRoomListSnapshot<T>;
  generation: number;
  actorId: string | null;
  items?: T[] | null;
  errorMessage?: string | null;
}): OwnedRoomListSnapshot<T> | null {
  const { previous, generation, actorId, items = null, errorMessage = null } = args;
  if (previous.generation !== generation) return null;
  if (previous.actorId !== actorId) return null;

  if (errorMessage) {
    return {
      ...previous,
      loading: false,
      errorMessage,
      // Preserve current items; stale/temporary errors must not wipe rooms.
      items: previous.items,
    };
  }

  return {
    actorId,
    generation,
    items: Array.isArray(items) ? items : [],
    errorMessage: null,
    loading: false,
  };
}

/**
 * Suppress a stale removal/update that targets a prior actor or generation.
 * Returns the next item list, or null when the mutation must be ignored.
 */
export function applyOwnedRoomLocalMutation<T extends { id: string }>(args: {
  previous: OwnedRoomListSnapshot<T>;
  actorId: string | null;
  generation: number;
  mutate: (items: T[]) => T[];
}): OwnedRoomListSnapshot<T> | null {
  const { previous, actorId, generation, mutate } = args;
  if (previous.generation !== generation) return null;
  if (previous.actorId !== actorId) return null;
  return {
    ...previous,
    items: mutate(previous.items),
  };
}

export type OwnedDressingRoomSnapshot = OwnedRoomListSnapshot<DressingRoom>;
export type OwnedLookSnapshot = OwnedRoomListSnapshot<Look>;
