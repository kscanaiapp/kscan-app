// Pure Shared with Me list state helpers (Phase 2B).
// Keeps refresh, actor, and removal races out of UI components.

import type {
  ListSharedRoomsResult,
  SharedRoomMembershipSummary,
} from './sharedRoomMemberships';

export type SharedWithMePhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'temporary_failure'
  | 'unauthenticated';

export type SharedWithMeSnapshot = {
  phase: SharedWithMePhase;
  rooms: SharedRoomMembershipSummary[];
  actorId: string | null;
  generation: number;
  errorMessage: string | null;
};

export const SHARED_WITH_ME_REFRESH_ERROR =
  "We couldn't refresh your shared rooms.";

export const SHARED_WITH_ME_EMPTY_TITLE = 'No shared rooms yet';
export const SHARED_WITH_ME_EMPTY_SUBTITLE =
  'Shared rooms will appear here after you open a Dressing Room link.';

export function createSharedWithMeSnapshot(actorId: string | null = null): SharedWithMeSnapshot {
  return {
    phase: actorId ? 'loading' : 'unauthenticated',
    rooms: [],
    actorId,
    generation: 0,
    errorMessage: null,
  };
}

export function clearSharedWithMeForActorChange(
  previous: SharedWithMeSnapshot,
  nextActorId: string | null,
): SharedWithMeSnapshot {
  return {
    phase: nextActorId ? 'loading' : 'unauthenticated',
    rooms: [],
    actorId: nextActorId,
    generation: previous.generation + 1,
    errorMessage: null,
  };
}

export function beginSharedWithMeLoad(
  previous: SharedWithMeSnapshot,
  actorId: string,
): SharedWithMeSnapshot {
  return {
    ...previous,
    actorId,
    phase: previous.rooms.length > 0 ? previous.phase : 'loading',
    generation: previous.generation + 1,
    errorMessage: previous.rooms.length > 0 ? previous.errorMessage : null,
  };
}

export function applySharedWithMeListResult(input: {
  previous: SharedWithMeSnapshot;
  generation: number;
  actorId: string;
  result: ListSharedRoomsResult;
  removedTokens: ReadonlySet<string>;
}): SharedWithMeSnapshot | null {
  const { previous, generation, actorId, result, removedTokens } = input;
  if (previous.generation !== generation) return null;
  if (previous.actorId !== actorId) return null;

  if (result.ok === false) {
    if (result.reason === 'unauthenticated') {
      return {
        phase: 'unauthenticated',
        rooms: [],
        actorId: null,
        generation: previous.generation,
        errorMessage: null,
      };
    }

    // temporary_failure: preserve prior successful in-memory rooms
    if (previous.rooms.length > 0) {
      return {
        ...previous,
        phase: 'temporary_failure',
        errorMessage: SHARED_WITH_ME_REFRESH_ERROR,
      };
    }

    return {
      phase: 'temporary_failure',
      rooms: [],
      actorId,
      generation: previous.generation,
      errorMessage: SHARED_WITH_ME_REFRESH_ERROR,
    };
  }

  const rooms = result.rooms.filter((room) => !removedTokens.has(room.shareToken));
  return {
    phase: rooms.length === 0 ? 'empty' : 'ready',
    rooms,
    actorId,
    generation: previous.generation,
    errorMessage: null,
  };
}

export function applyOptimisticSharedRoomRemoval(
  rooms: SharedRoomMembershipSummary[],
  shareToken: string,
): SharedRoomMembershipSummary[] {
  return rooms.filter((room) => room.shareToken !== shareToken);
}

export function restoreSharedRoomAfterFailedRemoval(
  rooms: SharedRoomMembershipSummary[],
  room: SharedRoomMembershipSummary,
): SharedRoomMembershipSummary[] {
  if (rooms.some((entry) => entry.shareToken === room.shareToken)) {
    return rooms;
  }
  return [...rooms, room].sort((a, b) => {
    const aTime = Date.parse(a.lastAccessedAt) || 0;
    const bTime = Date.parse(b.lastAccessedAt) || 0;
    return bTime - aTime;
  });
}

export function sharedRoomDisplayTitle(room: SharedRoomMembershipSummary): string {
  if (room.availability === 'unavailable') {
    return room.title?.trim() || 'Shared Dressing Room';
  }
  return room.title?.trim() || 'Shared Dressing Room';
}

export function sharedRoomAccessibilityLabel(room: SharedRoomMembershipSummary): string {
  const title = sharedRoomDisplayTitle(room);
  if (room.availability === 'unavailable') {
    return `Shared Dressing Room, ${title}, no longer available`;
  }
  const count = room.itemCount;
  return `Shared Dressing Room, ${title}, ${count} item${count === 1 ? '' : 's'}`;
}

export function canOpenSharedRoom(room: SharedRoomMembershipSummary): boolean {
  return room.availability === 'available' || room.availability === 'empty';
}

export function buildSharedRoomNativePath(shareToken: string): string {
  return `/rooms/${encodeURIComponent(shareToken)}`;
}

export function sharedRoomItemCountLabel(room: SharedRoomMembershipSummary): string {
  if (room.availability === 'unavailable') {
    return 'UNAVAILABLE';
  }
  const count = room.itemCount;
  return `${count} ITEM${count === 1 ? '' : 'S'}`;
}
