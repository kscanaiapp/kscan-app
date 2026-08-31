/**
 * Build 5 — the Today → Private Dressing Room handoff.
 *
 * ONE OPERATION, ONE SESSION, ONE NAVIGATION, ONE EVENT.
 *
 * TWO INDEPENDENT GUARDS, AND BOTH ARE REQUIRED:
 *
 *   1. The Phase 1 1500 ms dedupe window (`shouldAcceptPrimaryActionTap`). It
 *      catches the burst — three taps inside half a second — before any work
 *      starts.
 *
 *   2. An IN-FLIGHT LOCK held from acceptance until the operation settles. A
 *      timer alone is not sufficient and this is exactly why: creating a
 *      session, composing, hydrating the active Look and proving it readable
 *      can easily exceed 1500 ms on a cold store, and the moment the window
 *      expires a second tap would start a SECOND session operation against the
 *      same card. The lock does not expire — it is released in `finally`, on
 *      success and on every failure alike.
 *
 * The lock key is (actor, generation, action), so it cannot leak across an
 * actor switch, across a re-evaluated card, or between the primary and
 * secondary actions.
 *
 * NOTHING IS NAVIGATED BEFORE THE DESTINATION CAN READ THE LOOK. The sequence
 * below deliberately proves readability with a real read after persisting,
 * rather than trusting the write's return value — the Dressing Room reads
 * through its own store on mount, and that read is the one that has to succeed.
 */

import {
  buildChangeSomethingIntent,
  buildTapToGetReadyIntent,
  shouldAcceptPrimaryActionTap,
} from './actionRouting.ts';
import type { TodayWithEliseCardState } from '../../types/todayWithElise.ts';

export const TODAY_HANDOFF_OUTCOMES = [
  'opened',
  'ignored_duplicate_tap',
  'ignored_in_flight',
  'refused_stale_card',
  'refused_actor_changed',
  'refused_dependency_unavailable',
  'refused_items_unavailable',
  'failed_session',
  'failed_hydration',
  'failed_unreadable',
] as const;

export type TodayHandoffOutcome = (typeof TODAY_HANDOFF_OUTCOMES)[number];

export type TodayHandoffResult = {
  outcome: TodayHandoffOutcome;
  /** Bounded, deterministic user-facing copy. Never an exception message. */
  message: string | null;
  /** Events this call emitted, in order. Empty for every refusal. */
  emitted: string[];
};

/** Deterministic failure copy. States what happened, offers one next step. */
export const TODAY_HANDOFF_COPY = Object.freeze({
  sessionFailed: "We couldn't open your Dressing Room just now. Try again.",
  hydrationFailed: "We couldn't put this Look together just now. Try again.",
  itemsUnavailable: 'Something in this Look is no longer in your Closet.',
  actorChanged: null,
  staleCard: null,
});

// ── In-flight lock ───────────────────────────────────────────────────────────

const inFlight = new Set<string>();

export function todayHandoffLockKey(input: {
  actorId: string;
  generationToken: string;
  action: string;
}): string {
  return `${input.action}:${input.actorId}:${input.generationToken}`;
}

/** Test seam. Never called by production code. */
export function __resetTodayHandoffLocks(): void {
  inFlight.clear();
}

export function isTodayHandoffInFlight(key: string): boolean {
  return inFlight.has(key);
}

// ── Dependencies ─────────────────────────────────────────────────────────────

/**
 * Everything the handoff touches, injected.
 *
 * Every one of these is bound to an EXISTING Build 3 module by the caller.
 * Injecting them is what lets the whole sequence — including the rapid-tap,
 * actor-switch and unreadable-destination paths — be proved without a device.
 */
export type TodayHandoffDeps = {
  /** Build 3: create-or-reuse the actor's one private session. */
  startSession: (
    actorRequest: unknown,
    input: { anchorClosetItemId?: string | null; occasion?: string | null },
  ) => Promise<{ ok: boolean; session: unknown }>;
  /** Build 3: the actor-scoped typed Closet read. */
  loadCloset: (actorId: string, options: { actorRequest: unknown }) => Promise<{
    ok: boolean;
    items: unknown[];
  }>;
  project: (items: unknown[]) => Array<{ id: string }>;
  /** Build 3: compose from a known-good context and persist. */
  composeAndPersist: (input: {
    actorRequest: unknown;
    session: unknown;
    items: unknown[];
    closetOk: boolean;
    isCurrent: () => boolean;
    isActorCurrent: () => boolean;
  }) => Promise<{ composition: { looks: Array<{ lookId: string }> } | null }>;
  /** Build 3: persist which composed option is current. */
  setActiveLook: (
    actorRequest: unknown,
    input: { lookId: string; expectedFingerprint: string },
  ) => Promise<{ ok: boolean; stale?: boolean }>;
  /** Build 3: the read the DESTINATION will perform on mount. */
  loadComposition: (
    actorRequest: unknown,
    expectedFingerprint: string,
  ) => Promise<{ ok: boolean; composition: { activeLookId: string | null } | null }>;
  fingerprintFor: (session: unknown) => string;
  createActorRequest: () => unknown;
  isActorRequestCurrent: (request: unknown) => boolean;
  liveActor: () => { actorId: string | null; epoch: number };
  navigate: (route: string) => void;
  emit: (event: string, payload: Record<string, unknown>) => void;
  now: () => number;
};

export type TodayHandoffInput = {
  card: TodayWithEliseCardState;
  /** The generation token the card was committed under. */
  generationToken: string;
  actorId: string;
  actorEpoch: number;
  /** The composer context the card previewed with. Handed off unchanged. */
  anchorClosetItemId: string | null;
  occasion: string | null;
  route: string;
  dressingRoomActive: boolean;
  analyticsPayload: Record<string, unknown>;
  /** True while the live card still carries this generation token. */
  isCardCurrent: () => boolean;
};

function refuse(outcome: TodayHandoffOutcome, message: string | null = null): TodayHandoffResult {
  return { outcome, message, emitted: [] };
}

/**
 * Open the Private Dressing Room on the Look the card showed.
 *
 * The order below is the contract, and no step may be reordered:
 *
 *   1  the card is still the committed one          (stale card → refuse)
 *   2  the actor and epoch are unchanged            (switch → refuse)
 *   3  the dependency can complete                  (gate off → refuse)
 *   4  the rapid-tap window accepts                 (burst → ignore)
 *   5  the in-flight lock is taken                  (pending → ignore)
 *   6  the referenced garments are revalidated      (deleted → refuse)
 *   7  the session is created or reused             (Build 3 contract)
 *   8  the Look is composed, persisted and made active
 *   9  the destination's own read proves it readable
 *  10  navigate, then emit exactly two events
 *
 * Steps 1–3 come BEFORE the lock so a refusal costs nothing and cannot leave a
 * lock behind. Steps 6–9 come AFTER it so no two of them can interleave.
 */
export async function openTodayDressingRoom(
  deps: TodayHandoffDeps,
  input: TodayHandoffInput,
): Promise<TodayHandoffResult> {
  // 1. The card must still be the one the user tapped.
  if (!input.isCardCurrent()) return refuse('refused_stale_card', TODAY_HANDOFF_COPY.staleCard);
  if (input.card?.generationToken !== input.generationToken) {
    return refuse('refused_stale_card', TODAY_HANDOFF_COPY.staleCard);
  }

  // 2. The actor and the epoch it was evaluated under must be unchanged.
  const live = deps.liveActor();
  if (live.actorId !== input.actorId || live.epoch !== input.actorEpoch) {
    return refuse('refused_actor_changed', TODAY_HANDOFF_COPY.actorChanged);
  }

  // 3. No dead action, ever. A card that reached here with the gate off is a
  //    bug upstream, and refusing is the only safe answer.
  if (!input.dressingRoomActive) return refuse('refused_dependency_unavailable');

  const intent = buildTapToGetReadyIntent({
    actorId: input.actorId,
    itemRefs: input.card.itemRefs,
    generationToken: input.generationToken,
  });

  // 4. The burst guard.
  if (!shouldAcceptPrimaryActionTap(intent.dedupeKey, deps.now())) {
    return refuse('ignored_duplicate_tap');
  }

  // 5. The lock. Held until this operation settles, however it settles.
  const lockKey = todayHandoffLockKey({
    actorId: input.actorId,
    generationToken: input.generationToken,
    action: 'primary',
  });
  if (inFlight.has(lockKey)) return refuse('ignored_in_flight');
  inFlight.add(lockKey);

  try {
    const actorRequest = deps.createActorRequest();
    const isCurrent = () =>
      deps.isActorRequestCurrent(actorRequest) && input.isCardCurrent();

    // 6. Revalidate every referenced garment against the Closet as it is NOW.
    //    A Look assembled a minute ago must not open around a deleted item.
    const closet = await deps.loadCloset(input.actorId, { actorRequest });
    if (!isCurrent()) return refuse('refused_actor_changed');
    if (!closet.ok) return refuse('failed_session', TODAY_HANDOFF_COPY.sessionFailed);

    const projections = deps.project(closet.items ?? []);
    const owned = new Set(projections.map((item) => item.id));
    const referenced = (input.card.itemRefs ?? []).map((ref) => ref.closetItemId);
    if (referenced.length > 0 && !referenced.every((id) => owned.has(id))) {
      return refuse('refused_items_unavailable', TODAY_HANDOFF_COPY.itemsUnavailable);
    }
    if (input.anchorClosetItemId && !owned.has(input.anchorClosetItemId)) {
      return refuse('refused_items_unavailable', TODAY_HANDOFF_COPY.itemsUnavailable);
    }

    // 7. Create or reuse. Build 3 guarantees exactly one active session per
    //    actor and updates the existing one in place, so a rapid tap that
    //    somehow reached here still cannot fork a second workspace.
    const session = await deps.startSession(actorRequest, {
      anchorClosetItemId: input.anchorClosetItemId,
      occasion: input.occasion,
    });
    if (!isCurrent()) return refuse('refused_actor_changed');
    if (!session.ok || !session.session) {
      return refuse('failed_session', TODAY_HANDOFF_COPY.sessionFailed);
    }

    // 8. Compose, persist, and make the Look active — so the destination opens
    //    ON the Look rather than on an empty workspace.
    const fingerprint = deps.fingerprintFor(session.session);
    const composed = await deps.composeAndPersist({
      actorRequest,
      session: session.session,
      items: projections,
      closetOk: true,
      isCurrent,
      isActorCurrent: () => deps.isActorRequestCurrent(actorRequest),
    });
    if (!isCurrent()) return refuse('refused_actor_changed');
    const firstLook = composed?.composition?.looks?.[0] ?? null;
    if (!firstLook) return refuse('failed_hydration', TODAY_HANDOFF_COPY.hydrationFailed);

    const activated = await deps.setActiveLook(actorRequest, {
      lookId: firstLook.lookId,
      expectedFingerprint: fingerprint,
    });
    if (!isCurrent()) return refuse('refused_actor_changed');
    if (!activated.ok || activated.stale) {
      return refuse('failed_hydration', TODAY_HANDOFF_COPY.hydrationFailed);
    }

    // 9. Prove the DESTINATION can read it. A write that succeeded and a read
    //    that succeeds are different claims, and only the second one keeps the
    //    user off a blank room.
    const readback = await deps.loadComposition(actorRequest, fingerprint);
    if (!isCurrent()) return refuse('refused_actor_changed');
    if (!readback.ok || !readback.composition || !readback.composition.activeLookId) {
      return refuse('failed_unreadable', TODAY_HANDOFF_COPY.hydrationFailed);
    }

    // 10. Navigate, then report. Reporting after navigation means a refused or
    //     failed handoff can never appear in the funnel as an opened one.
    deps.navigate(input.route);
    const payload = { ...input.analyticsPayload, action: intent.kind };
    deps.emit('today_with_elise_primary_action', payload);
    deps.emit('today_with_elise_dressing_room_opened', payload);
    return {
      outcome: 'opened',
      message: null,
      emitted: ['today_with_elise_primary_action', 'today_with_elise_dressing_room_opened'],
    };
  } finally {
    inFlight.delete(lockKey);
  }
}

// ── Closet destinations ──────────────────────────────────────────────────────

export type TodayClosetActionInput = {
  card: TodayWithEliseCardState;
  generationToken: string;
  actorId: string;
  actorEpoch: number;
  route: string;
  analyticsPayload: Record<string, unknown>;
  isCardCurrent: () => boolean;
};

/**
 * Navigate to a Closet destination.
 *
 * SEPARATE FROM THE DRESSING ROOM PATH because there is genuinely nothing to
 * create, hydrate or prove readable — the Closet route reads its own state on
 * mount. What it shares, and MUST share, is the tap guard: three taps on
 * "Add More Items" have to produce one navigation and one event exactly as
 * three taps on "Tap to Get Ready" do. Routing this through the same dedupe
 * key is why that holds without a second implementation of it.
 *
 * No lock: with no asynchronous operation there is no window for a second tap
 * to interleave with, and claiming otherwise would be theatre.
 */
export function openTodayClosetDestination(
  deps: Pick<TodayHandoffDeps, 'navigate' | 'emit' | 'now' | 'liveActor'>,
  input: TodayClosetActionInput,
): TodayHandoffResult {
  if (!input.isCardCurrent()) return refuse('refused_stale_card');
  if (input.card?.generationToken !== input.generationToken) {
    return refuse('refused_stale_card');
  }

  const live = deps.liveActor();
  if (live.actorId !== input.actorId || live.epoch !== input.actorEpoch) {
    return refuse('refused_actor_changed');
  }

  const dedupeKey = `closet:${input.actorId}:${input.generationToken}`;
  if (!shouldAcceptPrimaryActionTap(dedupeKey, deps.now())) {
    return refuse('ignored_duplicate_tap');
  }

  deps.navigate(input.route);
  deps.emit('today_with_elise_primary_action', {
    ...input.analyticsPayload,
    action: input.card.primaryAction?.action,
  });
  return { outcome: 'opened', message: null, emitted: ['today_with_elise_primary_action'] };
}

// ── Change Something ─────────────────────────────────────────────────────────

export type TodayModifyInput = {
  card: TodayWithEliseCardState;
  generationToken: string;
  actorId: string;
  actorEpoch: number;
  route: string;
  dressingRoomActive: boolean;
  eliseModificationActive: boolean;
  analyticsPayload: Record<string, unknown>;
  isCardCurrent: () => boolean;
};

/**
 * Open the EXISTING Build 3 Elise modification flow on the active Look.
 *
 * IT CREATES NOTHING. No second session, no second Look, no Home-only editor,
 * and no route parameter that the Build 3 contract does not already define —
 * the workspace route reads the actor's one active session and its active Look
 * on mount, so arriving there IS arriving on the Look, with the Ask Elise and
 * Make It More Casual affordances the Dressing Room already owns.
 *
 * `/stylist/dressing-room` therefore takes no argument here on purpose. The
 * alternative — inventing `?mode=modify` or a `modifyLook()` API — would be a
 * contract Build 3 does not have.
 *
 * The same actor, epoch, generation, dedupe and lock rules as the primary
 * action apply, under a separate lock so the two actions cannot block each
 * other.
 */
export function openTodayEliseModification(
  deps: Pick<TodayHandoffDeps, 'navigate' | 'emit' | 'now' | 'liveActor'>,
  input: TodayModifyInput,
): TodayHandoffResult {
  if (!input.isCardCurrent()) return refuse('refused_stale_card');
  if (input.card?.generationToken !== input.generationToken) {
    return refuse('refused_stale_card');
  }

  const live = deps.liveActor();
  if (live.actorId !== input.actorId || live.epoch !== input.actorEpoch) {
    return refuse('refused_actor_changed');
  }

  // Both gates, because modification needs the flow AND the workspace under it.
  if (!input.dressingRoomActive || !input.eliseModificationActive) {
    return refuse('refused_dependency_unavailable');
  }

  const intent = buildChangeSomethingIntent({
    actorId: input.actorId,
    generationToken: input.generationToken,
  });
  if (!shouldAcceptPrimaryActionTap(intent.dedupeKey, deps.now())) {
    return refuse('ignored_duplicate_tap');
  }

  const lockKey = todayHandoffLockKey({
    actorId: input.actorId,
    generationToken: input.generationToken,
    action: 'secondary',
  });
  // Symmetry with the primary action, and a reentrancy backstop — but the
  // dedupe window above is the operative guard here, because this path performs
  // no asynchronous work for a lock to span. Said plainly rather than implied.
  if (inFlight.has(lockKey)) return refuse('ignored_in_flight');
  inFlight.add(lockKey);
  try {
    deps.navigate(input.route);
    // `source` is NOT overwritten with the routing attribution: on an event it
    // means which Build 3 domain produced the card, and every Today event
    // originates from Today by definition.
    const payload = { ...input.analyticsPayload, action: intent.kind };
    deps.emit('today_with_elise_secondary_action', payload);
    // DELIBERATELY NOT `today_with_elise_look_modified` HERE. Opening the
    // modification flow is not a modification, and reporting it as one would
    // put a click in the funnel where an outcome belongs. That event is emitted
    // only when a later generation observes that the Look actually changed.
    return {
      outcome: 'opened',
      message: null,
      emitted: ['today_with_elise_secondary_action'],
    };
  } finally {
    inFlight.delete(lockKey);
  }
}
