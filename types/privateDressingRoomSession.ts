// The PRIVATE Dressing Room session (Build 3: Dressing Rooms V1, Phase 1).
//
// DOMAIN BOUNDARY. This is a device-local, single-actor, TEMPORARY workspace
// living under /stylist/dressing-room. It is not, and must never be confused
// with, the collaborative cloud Dressing Room product (`/dressing-rooms`,
// types/styleObjects.ts, services/dressingRoomCollaboration.ts) which has
// Supabase records, RLS, membership, reactions and public share tokens. Nothing
// in this file reads or writes a collaborative room, and the two domains
// deliberately share no type name, no storage namespace and no manifest.
//
// WHAT THIS OWNS: which Closet garment the user is building around, and for what
// occasion. That is all.
//
// WHAT THIS DOES NOT OWN, by construction rather than by convention:
//
//     session  !=  outfit
//
// A session is scratch state. A future Saved Look is a durable outfit record
// with its own identity and lifecycle. So there is no lookId, no savedLookId, no
// item array, no swap history, no commerce or receipt state, and no Elise
// conversation state here. Phase 2 composes outfits ON TOP of this workspace; it
// does not widen it.
//
// CLOSET REMAINS AUTHORITATIVE. The session stores an anchor *reference* only.
// Title, image, taxonomy and every other garment fact is resolved live through
// services/closetLibrary.js + services/closetItemProjection.ts. Copying that
// metadata in here would create a second, silently stale source of truth for a
// garment the user can edit or delete at any time.

export const PRIVATE_DRESSING_ROOM_SESSION_SCHEMA_VERSION = 1 as const;

/**
 * The highest schema version this build can interpret. A record above this is
 * refused rather than read with the wrong rules — a newer build's session must
 * never be downgraded by an older one.
 */
export const PRIVATE_DRESSING_ROOM_SESSION_MAX_SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Phase 1 has exactly two states. `discarded` is retained rather than deleted so
 * that "the session you had is gone, deliberately" is distinguishable from "no
 * session was ever here", which is what lets the Stylist entry choose between
 * Start and Resume without guessing.
 */
export const PRIVATE_DRESSING_ROOM_SESSION_STATUSES = ['active', 'discarded'] as const;

export type PrivateDressingRoomSessionStatus =
  (typeof PRIVATE_DRESSING_ROOM_SESSION_STATUSES)[number];

/**
 * ACTOR IDENTITY follows the established repository partition contract
 * (services/actorContext.js):
 *   - `actorId: string` — an authenticated Supabase user id.
 *   - `actorId: null`   — the signed-out device-local partition. On iOS this is
 *                         a real durable partition, exactly as it is for the
 *                         Closet; it is not an error state.
 *
 * The runtime actor EPOCH is deliberately absent. An epoch is a live process
 * counter used to reject stale in-flight work; persisting it would freeze a
 * value that is meaningless on the next launch.
 */
export type PrivateDressingRoomSession = {
  sessionId: string;
  actorId: string | null;
  /** A Build 2 Closet item id. A REFERENCE — never resolved garment metadata. */
  anchorClosetItemId: string | null;
  occasion: string | null;
  status: PrivateDressingRoomSessionStatus;
  /** ISO 8601. Immutable for the life of the session. */
  createdAt: string;
  /** ISO 8601. Advances on every successful mutation. */
  updatedAt: string;
  schemaVersion: typeof PRIVATE_DRESSING_ROOM_SESSION_SCHEMA_VERSION;
};

/**
 * The complete set of persisted keys. Reconstruction is allowlisted against
 * this, so a record that arrives carrying unknown fields — a future build's, or
 * a tampered file's — cannot smuggle them forward simply by existing on disk.
 */
export const PRIVATE_DRESSING_ROOM_SESSION_FIELDS = Object.freeze([
  'sessionId',
  'actorId',
  'anchorClosetItemId',
  'occasion',
  'status',
  'createdAt',
  'updatedAt',
  'schemaVersion',
]);

/** Bounds. Ids match the Closet projection's 200-char id ceiling. */
export const PRIVATE_DRESSING_ROOM_SESSION_BOUNDS = Object.freeze({
  sessionId: 200,
  actorId: 200,
  anchorClosetItemId: 200,
  occasion: 120,
});

/**
 * Why a stored session could not be produced. Returned as a TYPED result rather
 * than thrown, so the workspace can explain the failure and offer a reset
 * instead of silently minting a replacement over data the user may still want.
 */
export type PrivateDressingRoomSessionErrorCode =
  | 'session_store_unreadable'
  | 'session_store_future_schema'
  | 'session_store_corrupt'
  | 'session_persist_failed'
  | 'missing_actor_context'
  | 'stale_actor_context';
