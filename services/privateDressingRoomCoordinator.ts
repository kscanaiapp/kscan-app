/**
 * Private Dressing Room workspace resolution.
 *
 * PURE, and deliberately separate from the React hook that drives it. Everything
 * here is a function of inputs the hook has already gathered — actor state,
 * Closet state, the stored session, the route parameter — so the ordering rules
 * that actually matter can be tested without a renderer.
 *
 * THE ORDERING RULE THIS FILE EXISTS TO ENFORCE:
 *
 *     nothing is "missing" until everything it depends on has finished loading
 *
 * An anchor is not missing while the Closet is still loading, and a route item
 * is not unknown while the actor is still resolving. Getting that wrong shows
 * the user "this garment is gone" during a perfectly normal cold start, so the
 * gate is structural here rather than a condition each screen remembers.
 *
 * The coordinator does not generate outfits, call Elise, save Looks, open
 * commerce, mutate Closet records, or touch a collaborative room. It resolves
 * which of a fixed set of workspace states is true, and nothing else.
 */

import { PRIVATE_DRESSING_ROOM_SESSION_BOUNDS } from '../types/privateDressingRoomSession';
import type {
  PrivateDressingRoomSession,
  PrivateDressingRoomSessionErrorCode,
} from '../types/privateDressingRoomSession';
import type { ClosetItemProjection } from './closetItemProjection';

/**
 * How the actor-scoped Closet read finished.
 *
 * KNOWN LIMITATION, stated rather than hidden: services/closetLibrary.js
 * `loadCloset` catches every internal error and returns `[]`, so a genuine read
 * failure is indistinguishable from an empty Closet at that boundary. This
 * coordinator models the two states separately and the hook reports `failed`
 * only when the call itself rejects. Making the distinction complete requires a
 * typed load result from the Closet domain, which Phase 1 must not change.
 */
export type ClosetLoadStatus = 'loading' | 'loaded' | 'failed';

export type PrivateWorkspaceStatus =
  | 'feature_disabled'
  | 'actor_loading'
  | 'actor_unavailable'
  | 'closet_loading'
  | 'closet_failed'
  | 'session_unrecoverable'
  | 'no_session'
  | 'active';

export type PrivateWorkspaceView = {
  status: PrivateWorkspaceStatus;
  session: PrivateDressingRoomSession | null;
  /** The resolved anchor projection, or null when there is none / it is gone. */
  anchor: ClosetItemProjection | null;
  /** The session references an anchor the Closet can no longer resolve. */
  anchorMissing: boolean;
  /** True only once the Closet has actually loaded and holds nothing. */
  closetEmpty: boolean;
  closetItems: readonly ClosetItemProjection[];
  /** A route-supplied closetItemId that does not belong to this actor's Closet. */
  routeItemUnavailable: boolean;
  /** The stored session was restored from the backup copy. */
  recoveredFromBackup: boolean;
  errorCode: PrivateDressingRoomSessionErrorCode | null;
  /** An explicit user-driven reset can clear the current failure. */
  canReset: boolean;
};

/** The session-store result shape the coordinator consumes. */
export type CoordinatorSessionInput = {
  ok: boolean;
  session: PrivateDressingRoomSession | null;
  recovered: 'primary' | 'backup' | 'none';
  errorCode: PrivateDressingRoomSessionErrorCode | null;
  recoverable: boolean;
} | null;

/**
 * Normalize a route-supplied Closet item id.
 *
 * Treated as an OPAQUE REQUEST, never as authority. expo-router hands back
 * `string | string[] | undefined`, so an array — which is what a duplicated
 * query parameter produces — is refused rather than silently taking its first
 * element. The bound is the session contract's own id ceiling, so a link cannot
 * push an unbounded string into a comparison loop.
 *
 * Returning a value here means only "this is a well-formed request". Whether it
 * names a garment this actor owns is decided later, against the loaded Closet.
 */
export function normalizeRouteClosetItemId(value: unknown): string | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.anchorClosetItemId) return null;
  return text;
}

function findProjection(
  items: readonly ClosetItemProjection[],
  id: string | null,
): ClosetItemProjection | null {
  if (!id) return null;
  for (const item of items) {
    if (item && item.id === id) return item;
  }
  return null;
}

const EMPTY_VIEW: Omit<PrivateWorkspaceView, 'status'> = {
  session: null,
  anchor: null,
  anchorMissing: false,
  closetEmpty: false,
  closetItems: [],
  routeItemUnavailable: false,
  recoveredFromBackup: false,
  errorCode: null,
  canReset: false,
};

/**
 * Resolve the single workspace state that is true right now.
 *
 * The order of the gates below IS the loading sequence: feature, actor, Closet,
 * session, then reconciliation. Each gate returns early precisely so that a
 * later gate can assume everything before it has resolved.
 */
export function resolvePrivateWorkspaceView(input: {
  enabled: boolean;
  actorLoading: boolean;
  closetStatus: ClosetLoadStatus;
  closetItems: readonly ClosetItemProjection[];
  session: CoordinatorSessionInput;
  routeClosetItemId?: unknown;
}): PrivateWorkspaceView {
  if (!input.enabled) return { ...EMPTY_VIEW, status: 'feature_disabled' };

  // The actor gate comes before the Closet gate because an unresolved actor
  // means we do not yet know WHOSE Closet to read.
  if (input.actorLoading) return { ...EMPTY_VIEW, status: 'actor_loading' };

  if (input.closetStatus === 'loading') return { ...EMPTY_VIEW, status: 'closet_loading' };

  // A Closet that failed to load is NOT an empty Closet. Conflating them would
  // invite the user to start building an outfit from a wardrobe that is merely
  // unreadable right now.
  if (input.closetStatus === 'failed') return { ...EMPTY_VIEW, status: 'closet_failed' };

  const closetItems = Array.isArray(input.closetItems) ? input.closetItems : [];
  const closetEmpty = closetItems.length === 0;

  // The session has not been read yet.
  if (!input.session) {
    return { ...EMPTY_VIEW, status: 'closet_loading', closetItems, closetEmpty };
  }

  if (!input.session.ok) {
    const code = input.session.errorCode;
    const actorProblem = code === 'missing_actor_context' || code === 'stale_actor_context';
    return {
      ...EMPTY_VIEW,
      status: actorProblem ? 'actor_unavailable' : 'session_unrecoverable',
      closetItems,
      closetEmpty,
      errorCode: code,
      canReset: !actorProblem && input.session.recoverable === true,
    };
  }

  const routeId = normalizeRouteClosetItemId(input.routeClosetItemId);
  const routeMatch = findProjection(closetItems, routeId);
  // A route id that is unknown, or belongs to another actor, is reported the
  // SAME way: unavailable. The workspace must not become an oracle for whether
  // some other account owns a given garment.
  const routeItemUnavailable = routeId !== null && routeMatch === null;

  const session = input.session.session;
  const recoveredFromBackup = input.session.recovered === 'backup';

  if (!session) {
    return {
      ...EMPTY_VIEW,
      status: 'no_session',
      closetItems,
      closetEmpty,
      routeItemUnavailable,
      recoveredFromBackup,
    };
  }

  const anchor = findProjection(closetItems, session.anchorClosetItemId);
  // Safe to compute now, and only now: the Closet has loaded, so "not found"
  // genuinely means the garment is gone rather than not yet read.
  const anchorMissing = session.anchorClosetItemId !== null && anchor === null;

  return {
    status: 'active',
    session,
    anchor,
    anchorMissing,
    closetEmpty,
    closetItems,
    routeItemUnavailable,
    recoveredFromBackup,
    errorCode: null,
    canReset: false,
  };
}

/**
 * Decide what a route-supplied Closet item should do to the stored session.
 *
 * Returns the anchor to persist, or null when the route asked for nothing
 * actionable. Deliberately conservative: an unresolved or unowned id is never
 * written, so a crafted link cannot park a foreign id in the user's session.
 */
export function resolveRouteAnchorIntent(view: PrivateWorkspaceView, routeValue: unknown): string | null {
  const routeId = normalizeRouteClosetItemId(routeValue);
  if (!routeId) return null;
  if (view.status !== 'active' && view.status !== 'no_session') return null;
  if (view.routeItemUnavailable) return null;
  if (findProjection(view.closetItems, routeId) === null) return null;
  if (view.session && view.session.anchorClosetItemId === routeId) return null;
  return routeId;
}

/** Copy for each workspace state. Kept here so both platforms read identically. */
export const PRIVATE_WORKSPACE_COPY = Object.freeze({
  actorLoading: 'Getting things ready…',
  actorUnavailable: 'Sign in to use your Dressing Room.',
  closetLoading: 'Loading your Closet…',
  closetFailed: "We couldn't open your Closet just now.",
  closetEmpty: 'Add something to your Closet to build an outfit around it.',
  noSession: 'Start a Dressing Room to build an outfit around a piece you own.',
  unrecoverable: "We couldn't restore your previous Dressing Room session.",
  futureSchema: 'This session was created by a newer version of K Scan.',
  recovered: 'We restored your Dressing Room session.',
  anchorMissing: "The piece you were building around isn't in your Closet anymore.",
  routeItemUnavailable: "That piece isn't in your Closet.",
  ready: 'Your Dressing Room is ready for outfit building.',
  reset: 'Reset session',
  discard: 'Discard session',
});
