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

/** Dialog-safe title length; matches owned-room title budget. */
export const SHARED_ROOM_DIALOG_TITLE_MAX = 60;

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

/**
 * Backend list_shared_rooms_for_me orders by last_accessed_at desc, share_id.
 * Re-apply a stable lastAccessedAt descending sort so client order remains safe
 * even if a row timestamp is missing/malformed.
 */
export function sortSharedRoomSummaries(
  rooms: SharedRoomMembershipSummary[],
): SharedRoomMembershipSummary[] {
  return rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => {
      const aTime = Date.parse(a.room.lastAccessedAt);
      const bTime = Date.parse(b.room.lastAccessedAt);
      const aSafe = Number.isFinite(aTime) ? aTime : 0;
      const bSafe = Number.isFinite(bTime) ? bTime : 0;
      if (bSafe !== aSafe) return bSafe - aSafe;
      return a.index - b.index;
    })
    .map((entry) => entry.room);
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

  const rooms = sortSharedRoomSummaries(
    result.rooms.filter((room) => !removedTokens.has(room.shareToken)),
  );
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
  return sortSharedRoomSummaries([...rooms, room]);
}

export function sharedRoomDisplayTitle(room: SharedRoomMembershipSummary): string {
  return room.title?.trim() || 'Shared Dressing Room';
}

/** Truncate for confirmation dialogs without mutating the stored title. */
export function formatSharedRoomDialogTitle(
  title: string,
  maxLength: number = SHARED_ROOM_DIALOG_TITLE_MAX,
): string {
  const cleaned = String(title ?? '').trim() || 'Shared Dressing Room';
  if (cleaned.length <= maxLength) return cleaned;
  if (maxLength <= 1) return '…';
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
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

export type SharedWithMeSectionPresentation = {
  showLoading: boolean;
  showTemporaryFailure: boolean;
  showRetry: boolean;
  showEmpty: boolean;
  showRooms: boolean;
  sectionSubtitle: string;
  failureBody: string | null;
  emptyTitle: string | null;
  emptySubtitle: string | null;
};

/**
 * Deterministic Shared with Me section presentation.
 * Missing/undeployed list RPC maps to temporary_failure — never empty.
 * Removing the final room maps to the normal empty copy.
 */
export function getSharedWithMeSectionPresentation(input: {
  phase: SharedWithMePhase;
  rooms: SharedRoomMembershipSummary[];
  loading: boolean;
}): SharedWithMeSectionPresentation {
  const temporaryFailure = input.phase === 'temporary_failure';
  const empty = input.phase === 'empty';
  const showLoading = input.loading;
  const showTemporaryFailure = temporaryFailure;
  const showEmpty = !showLoading && empty && !temporaryFailure;
  const showRooms = !showLoading && input.rooms.length > 0;

  let sectionSubtitle: string;
  if (showLoading) {
    sectionSubtitle = 'Loading shared rooms';
  } else if (temporaryFailure) {
    sectionSubtitle = 'Could not refresh';
  } else if (empty) {
    sectionSubtitle = 'No shared rooms yet';
  } else {
    const count = input.rooms.length;
    sectionSubtitle = `${count} shared room${count === 1 ? '' : 's'}`;
  }

  return {
    showLoading,
    showTemporaryFailure,
    showRetry: showTemporaryFailure,
    showEmpty,
    showRooms,
    sectionSubtitle,
    failureBody: showTemporaryFailure ? SHARED_WITH_ME_REFRESH_ERROR : null,
    emptyTitle: showEmpty ? SHARED_WITH_ME_EMPTY_TITLE : null,
    emptySubtitle: showEmpty ? SHARED_WITH_ME_EMPTY_SUBTITLE : null,
  };
}

/** Apply optimistic removal; last room becomes the normal empty state. */
export function applySuccessfulFinalSharedRoomRemoval(
  previous: SharedWithMeSnapshot,
  shareToken: string,
): SharedWithMeSnapshot {
  const rooms = applyOptimisticSharedRoomRemoval(previous.rooms, shareToken);
  if (rooms.length === 0) {
    return {
      ...previous,
      rooms,
      phase: 'empty',
      errorMessage: null,
    };
  }
  return {
    ...previous,
    rooms,
    phase: previous.phase === 'temporary_failure' ? 'temporary_failure' : 'ready',
    errorMessage: previous.phase === 'temporary_failure' ? previous.errorMessage : null,
  };
}

/**
 * Simulate the removal-versus-stale-refresh race for tests:
 * start with a list, apply an optimistic removal, then apply an older
 * refresh payload that still contains the removed room.
 */
export function applyStaleRefreshAfterRemoval(input: {
  previous: SharedWithMeSnapshot;
  generation: number;
  actorId: string;
  removedToken: string;
  staleRooms: SharedRoomMembershipSummary[];
}): SharedWithMeSnapshot | null {
  const removedTokens = new Set([input.removedToken]);
  const afterRemoval: SharedWithMeSnapshot = {
    ...input.previous,
    rooms: applyOptimisticSharedRoomRemoval(input.previous.rooms, input.removedToken),
    phase: 'ready',
  };
  return applySharedWithMeListResult({
    previous: afterRemoval,
    generation: input.generation,
    actorId: input.actorId,
    result: { ok: true, rooms: input.staleRooms },
    removedTokens,
  });
}
