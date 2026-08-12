// Anchor preflight for entering the private Dressing Room from elsewhere.
//
// THIS IS NOT A STYLING ENGINE, AND IT MUST NEVER BECOME ONE. Build 3 owns
// session creation, composition, active-Look persistence and rendering, and the
// route already accepts an anchor: `/stylist/dressing-room?closetItemId=<id>`
// (privateDressingRoomCoordinator.ts#resolveRouteAnchorIntent — the same
// contract app/library.tsx uses). Reimplementing any of that here would produce
// a second outfit builder with its own drift.
//
// WHAT THIS DOES OWN is the question the route cannot answer before it is
// mounted: will the destination actually honour this anchor?
//
// THE SILENT FAILURE THIS EXISTS TO PREVENT. `resolveRouteAnchorIntent` returns
// null — and the anchor is dropped without a word — when the id is not found in
// the actor's own Closet. Navigating anyway would open a Dressing Room that
// quietly styles something else, which is worse than not navigating: the user
// asked for THAT piece. So the anchor is proved present, through the same typed
// read and the same projection boundary the workspace itself uses, BEFORE the
// route is pushed.
//
// WHY IT LIVES HERE AND NOT UNDER services/style-chat. Reading the Closet is a
// Dressing Room concern, and the release gate in
// __tests__/eliseClosetTransactionSeparation.test.js requires that no Elise
// source file import the Closet orchestrator. `privateDressingRoomLifecycle.ts`
// already reads the Closet from exactly here, so this follows the established
// structure rather than relocating around a gate: this module knows nothing
// about chat, attachments or Elise, and takes an anchor id its caller has
// already established the right to use.
//
// NO NEW PERSISTENCE. Nothing here writes: not a session, not a composition, not
// a Look, not a row. The only effect of a successful preflight is that the
// caller is cleared to navigate.

import { PRIVATE_DRESSING_ROOM_V1 } from '../constants/featureFlags';
import { isActorRequestCurrent } from './actorContext';
import { loadClosetTyped } from './closetLibrary';
import { getClosetItemProjections } from './closetItemProjection';

/**
 * Bounded refusal codes.
 *
 * Serializable enums, never an exception message or a path: this runs beside
 * persistence and telemetry, and a raw error string is how a filesystem path
 * reaches a log line.
 */
export const DRESSING_ROOM_ANCHOR_REFUSALS = [
  'feature_disabled',
  'no_actor',
  'no_anchor',
  'actor_changed',
  'closet_unavailable',
  'anchor_missing',
] as const;
export type DressingRoomAnchorRefusal = (typeof DRESSING_ROOM_ANCHOR_REFUSALS)[number];

export type DressingRoomAnchorAllowed = { ok: true; closetItemId: string };
export type DressingRoomAnchorRefused = { ok: false; reason: DressingRoomAnchorRefusal };
export type DressingRoomAnchorDecision = DressingRoomAnchorAllowed | DressingRoomAnchorRefused;

/**
 * Explicit type guard rather than `if (!decision.ok)`.
 *
 * This project compiles without strictNullChecks (expo/tsconfig.base), where
 * truthiness narrowing on a boolean-literal discriminant does not reliably
 * eliminate the other member. A user-defined guard narrows either way, so the
 * refusal branch can read `reason` without a cast.
 */
export function isAnchorRefused(
  decision: DressingRoomAnchorDecision,
): decision is DressingRoomAnchorRefused {
  return decision.ok !== true;
}

/** User-facing copy per refusal. Honest about what is and is not saved. */
export const DRESSING_ROOM_ANCHOR_MESSAGES: Readonly<
  Record<DressingRoomAnchorRefusal, string>
> = Object.freeze({
  feature_disabled: 'Your Dressing Room is not available in this build yet.',
  no_actor: 'Sign in to style this piece.',
  no_anchor: 'Save this piece to your Closet first, then Elise can build a Look around it.',
  actor_changed: 'The signed-in account changed. Open your Closet to continue.',
  closet_unavailable: "We couldn't read your Closet just now. Try again in a moment.",
  anchor_missing:
    "This piece isn't in your Closet yet. Save it, then Elise can build a Look around it.",
});

export type AnchorPreflightDeps = {
  /** Injected so the decision is testable without a filesystem or a renderer. */
  loadCloset?: typeof loadClosetTyped;
  isActorCurrent?: (request: unknown) => boolean;
  featureEnabled?: boolean;
};

/**
 * Decide whether an anchored Dressing Room entry may navigate.
 *
 * Order is load-bearing and cheapest-first: the flag, the actor and the anchor
 * cost nothing, and only then is the Closet read. An entry that was never
 * entitled to run does not touch storage.
 */
export async function preflightDressingRoomAnchor(
  input: { closetItemId: string | null | undefined; actorId: string | null; actorRequest: unknown },
  deps: AnchorPreflightDeps = {},
): Promise<DressingRoomAnchorDecision> {
  const enabled = deps.featureEnabled ?? PRIVATE_DRESSING_ROOM_V1;
  if (!enabled) return { ok: false, reason: 'feature_disabled' };

  const actorId = typeof input.actorId === 'string' ? input.actorId.trim() : '';
  if (!actorId) return { ok: false, reason: 'no_actor' };

  const closetItemId =
    typeof input.closetItemId === 'string' ? input.closetItemId.trim() : '';
  if (!closetItemId) return { ok: false, reason: 'no_anchor' };

  const loadCloset = deps.loadCloset ?? loadClosetTyped;
  const isCurrent = deps.isActorCurrent ?? isActorRequestCurrent;

  // EXPLICIT actor id. The argument-less form of this loader reads every account
  // stored on the device, so passing it through is not optional.
  const result = await loadCloset(actorId, { actorRequest: input.actorRequest });
  if (!isCurrent(input.actorRequest)) return { ok: false, reason: 'actor_changed' };
  if (!result || result.ok !== true) return { ok: false, reason: 'closet_unavailable' };

  // The SAME projection the workspace reads, so "present" here means present
  // there. A row that fails to project is not an anchor the destination can use.
  const present = getClosetItemProjections(result.items).some((item) => item.id === closetItemId);
  if (!present) return { ok: false, reason: 'anchor_missing' };

  return { ok: true, closetItemId };
}

/**
 * The route the anchor is handed to. Exported so callers and their tests name
 * the same destination, and so nothing has to spell the path twice.
 */
export const PRIVATE_DRESSING_ROOM_ROUTE = '/stylist/dressing-room' as const;

/** The exact params object the existing route contract expects. */
export function dressingRoomAnchorParams(closetItemId: string): { closetItemId: string } {
  return { closetItemId };
}
