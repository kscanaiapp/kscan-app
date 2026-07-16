// Pure Shared with Me list state helpers (Phase 2B).
// Keeps refresh, actor, and removal races out of UI components.

import type {
  ListSharedRoomsResult,
  SharedRoomMembershipSummary,
} from './sharedRoomMemberships';
import { normalizeRoomShareToken } from './roomDeepLinks';

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
export const SHARED_WITH_ME_REMOVE_ERROR =
  "We couldn't remove that shared room. It's back in your list; try Remove from list again.";

export const SHARED_WITH_ME_EMPTY_TITLE = 'No shared rooms yet';
export const SHARED_WITH_ME_EMPTY_SUBTITLE =
  'Shared rooms will appear here after you open a Dressing Room link.';

/** Dialog-safe title length; matches owned-room title budget. */
export const SHARED_ROOM_DIALOG_TITLE_MAX = 60;
export const SHARED_ROOM_REMOVAL_SUPPRESSION_MAX = 100;

/**
 * Cap how many leading cards get a staggered entrance delay so a long list
 * (many shared rooms) never makes the section take seconds to finish
 * appearing. Cards beyond this index all animate in with the same delay.
 */
export const SHARED_ROOM_ENTER_STAGGER_MAX_INDEX = 8;

export type SharedRoomRemovalSuppression = {
  actorId: string | null;
  tokens: ReadonlySet<string>;
};

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

/** Prevent prior-actor rooms from remaining visible until passive effects run. */
export function isSharedWithMeSnapshotVisibleToActor(input: {
  snapshot: SharedWithMeSnapshot;
  actorId: string | null;
  authLoading: boolean;
}): boolean {
  if (input.authLoading) return false;
  return input.snapshot.actorId === input.actorId;
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
      const aTime = typeof a.room.lastAccessedAt === 'string'
        ? Date.parse(a.room.lastAccessedAt)
        : Number.NaN;
      const bTime = typeof b.room.lastAccessedAt === 'string'
        ? Date.parse(b.room.lastAccessedAt)
        : Number.NaN;
      const aSafe = Number.isFinite(aTime) ? aTime : 0;
      const bSafe = Number.isFinite(bTime) ? bTime : 0;
      if (bSafe !== aSafe) return bSafe - aSafe;
      return a.index - b.index;
    })
    .map((entry) => entry.room);
}

export function isRenderableSharedRoomSummary(
  room: SharedRoomMembershipSummary,
): boolean {
  if (!room || typeof room !== 'object') return false;
  if (!normalizeRoomShareToken(room.shareToken)) return false;
  if (!['available', 'empty', 'unavailable'].includes(room.availability)) return false;
  if (!Number.isSafeInteger(room.itemCount) || room.itemCount < 0) return false;
  if (room.title != null && typeof room.title !== 'string') return false;
  if (typeof room.firstOpenedAt !== 'string' || !Number.isFinite(Date.parse(room.firstOpenedAt))) {
    return false;
  }
  if (typeof room.lastAccessedAt !== 'string' || !Number.isFinite(Date.parse(room.lastAccessedAt))) {
    return false;
  }
  if (
    room.updatedAt != null &&
    (typeof room.updatedAt !== 'string' || !Number.isFinite(Date.parse(room.updatedAt)))
  ) {
    return false;
  }
  if (room.availability === 'empty' && room.itemCount !== 0) return false;
  if (room.availability === 'available' && room.itemCount === 0) return false;
  return true;
}

/** Drop malformed and duplicate rows before rendering stable token keys. */
export function prepareSharedRoomSummaries(
  rooms: SharedRoomMembershipSummary[],
  removedTokens: ReadonlySet<string> = new Set(),
): SharedRoomMembershipSummary[] {
  const seen = new Set<string>();
  const safeRooms: SharedRoomMembershipSummary[] = [];
  for (const room of rooms) {
    if (!isRenderableSharedRoomSummary(room)) continue;
    if (removedTokens.has(room.shareToken) || seen.has(room.shareToken)) continue;
    seen.add(room.shareToken);
    safeRooms.push(room);
  }
  return sortSharedRoomSummaries(safeRooms);
}

export function createSharedRoomRemovalSuppression(
  actorId: string | null,
): SharedRoomRemovalSuppression {
  return { actorId, tokens: new Set() };
}

/** One backend page is bounded to 100, so suppression never needs to exceed it. */
export function rememberRemovedSharedRoomToken(
  current: SharedRoomRemovalSuppression,
  actorId: string,
  shareToken: string,
  maxSize: number = SHARED_ROOM_REMOVAL_SUPPRESSION_MAX,
): SharedRoomRemovalSuppression {
  const next = new Set(current.actorId === actorId ? current.tokens : []);
  next.delete(shareToken);
  next.add(shareToken);
  while (next.size > Math.max(1, maxSize)) {
    const oldest = next.values().next().value;
    if (typeof oldest !== 'string') break;
    next.delete(oldest);
  }
  return { actorId, tokens: next };
}

export function forgetRemovedSharedRoomToken(
  current: SharedRoomRemovalSuppression,
  actorId: string,
  shareToken: string,
): SharedRoomRemovalSuppression {
  if (current.actorId !== actorId) return current;
  const next = new Set(current.tokens);
  next.delete(shareToken);
  return { actorId, tokens: next };
}

export function clearSharedRoomRemovalSuppression(
  current: SharedRoomRemovalSuppression,
  actorId: string,
): SharedRoomRemovalSuppression {
  return current.actorId === actorId
    ? createSharedRoomRemovalSuppression(actorId)
    : current;
}

export function removedSharedRoomTokensForActor(
  current: SharedRoomRemovalSuppression,
  actorId: string,
): ReadonlySet<string> {
  return current.actorId === actorId ? current.tokens : new Set();
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
        // The response still belongs to the actor that started the request.
        // Keep that key so render visibility remains actor-scoped while the
        // auth context catches up with the rejected session.
        actorId,
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

  const rooms = prepareSharedRoomSummaries(result.rooms, removedTokens);
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

export function restoreSharedRoomAfterFailedRemovalForActor(input: {
  previous: SharedWithMeSnapshot;
  operationActorId: string;
  room: SharedRoomMembershipSummary;
}): SharedWithMeSnapshot | null {
  if (input.previous.actorId !== input.operationActorId) return null;
  const rooms = restoreSharedRoomAfterFailedRemoval(input.previous.rooms, input.room);
  return {
    ...input.previous,
    rooms,
    phase: rooms.length === 0 ? 'empty' : 'ready',
    errorMessage: null,
  };
}

export function sharedRoomDisplayTitle(room: SharedRoomMembershipSummary): string {
  return typeof room.title === 'string' && room.title.trim()
    ? room.title.trim()
    : 'Shared Dressing Room';
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
    return `Shared Dressing Room, ${title}, no longer available, shared, view only`;
  }
  const count = Number.isSafeInteger(room.itemCount) && room.itemCount >= 0
    ? room.itemCount
    : 0;
  return `Shared Dressing Room, ${title}, ${count} item${count === 1 ? '' : 's'}, shared, view only`;
}

export function canOpenSharedRoom(room: SharedRoomMembershipSummary): boolean {
  return Boolean(normalizeRoomShareToken(room.shareToken)) &&
    (room.availability === 'available' || room.availability === 'empty');
}

export function buildSharedRoomNativePath(shareToken: string): string | null {
  const normalizedToken = normalizeRoomShareToken(shareToken);
  return normalizedToken ? `/rooms/${encodeURIComponent(normalizedToken)}` : null;
}

/**
 * Deterministic, reduced-motion-agnostic entrance delay for a shared room
 * card at a given position. Motion components decide whether to apply this
 * at all (reduced motion should always pass a delay of 0 regardless of what
 * this returns); this only owns the stagger math so it is unit-testable
 * without a React/Animated runtime.
 */
export function sharedRoomEnterDelayMs(
  index: number,
  staggerMs: number,
  maxIndex: number = SHARED_ROOM_ENTER_STAGGER_MAX_INDEX,
): number {
  if (!Number.isFinite(index) || index < 0) return 0;
  if (!Number.isFinite(staggerMs) || staggerMs <= 0) return 0;
  const cappedIndex = Math.min(Math.floor(index), Math.max(0, maxIndex));
  return cappedIndex * staggerMs;
}

export function sharedRoomItemCountLabel(room: SharedRoomMembershipSummary): string {
  if (room.availability === 'unavailable') {
    return 'UNAVAILABLE';
  }
  const count = Number.isSafeInteger(room.itemCount) && room.itemCount >= 0
    ? room.itemCount
    : 0;
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
