/**
 * The private Dressing Room ↔ Elise orchestration sequence.
 *
 * PRODUCTION CODE, NOT A TEST HELPER. `hooks/usePrivateDressingRoom.ts` is the
 * only production caller and does nothing but publish what this module emits.
 * The Phase 4 tests call the same functions directly, for the reason Phase 3.5
 * established: there is no React test infrastructure in this repository, and a
 * harness that reimplements an ordering proves a sequence production does not
 * run. Ordering lives here so it can only be proven once.
 *
 * WHAT THIS MODULE ENFORCES, in order and without exception:
 *
 *   1. the flag is a PARAMETER, never a module-level read, so both sides of the
 *      nested gate are provable
 *   2. a governed manual action cancels and invalidates any in-flight request
 *      BEFORE it proceeds
 *   3. a response is applied only through `requestContextChange` — the same
 *      governed path the occasion chips use, so confirmation, invalidation and
 *      undo behave identically whether a human or Elise asked
 *   4. nothing is applied that did not pass both the contract validator and the
 *      lifecycle comparison
 *
 * ELISE IS NEVER THE AUTHORITY. It returns at most an occasion the user could
 * have tapped. The composition is always produced by the Phase 2 deterministic
 * composer, reached through the existing context-change flow.
 */

import {
  planAnchorRequest,
  planOccasionRequest,
  type EliseLifecycleSnapshot,
} from './privateDressingRoomEliseProjection';
import {
  sendEliseRequest,
  type EliseInvoke,
  type EliseRequestCoordinator,
} from './privateDressingRoomEliseClient';
import {
  isUnsupportedCasualness,
  resolveMoreCasualOccasion,
} from './privateDressingRoomCasualness';
import { occasionGroupFor } from './privateDressingRoomComposer';
import type { ClosetItemProjection } from './closetItemProjection';
import type {
  PrivateEliseOccasion,
  PrivateEliseResponse,
} from '../types/privateDressingRoomElise';

// ── Published status ─────────────────────────────────────────────────────────

/**
 * The transient Elise status the screen renders.
 *
 * `copyKey` rather than a string: the approved copy lives in one table
 * (privateDressingRoomEliseUx.ts) so a reword never has to hunt through
 * orchestration, and the model can never author what the user reads.
 */
export type EliseStatusKind =
  | 'idle'
  | 'loading'
  | 'success'
  | 'clarification'
  | 'unsupported'
  | 'already_casual'
  | 'capability_unavailable'
  | 'failed';

export type EliseOperation = 'interpret_occasion' | 'build_around_item' | 'make_more_casual';

export type EliseStatus = {
  kind: EliseStatusKind;
  operation: EliseOperation | null;
  /** Filled for success copy that names the result. Never model-authored. */
  occasion?: string;
  itemType?: string;
};

export const IDLE_ELISE_STATUS: EliseStatus = Object.freeze({ kind: 'idle', operation: null });

export type ElisePublisher = {
  setStatus: (status: EliseStatus) => void;
};

/** The governed context change this module is allowed to request. */
export type EliseContextChange =
  | { kind: 'occasion'; occasion: string }
  | { kind: 'anchor'; anchorClosetItemId: string };

export type EliseOrchestrationDeps = {
  eliseEnabled: boolean;
  coordinator: EliseRequestCoordinator;
  publish: ElisePublisher;
  /** The hook's governed context-change entry point. Not a bypass. */
  requestContextChange: (change: EliseContextChange) => Promise<void>;
  /** Lifecycle state, read at request time and again at response time. */
  snapshot: () => EliseLifecycleSnapshot;
  newRequestId: () => string;
  invoke?: EliseInvoke;
};

export type EliseOutcome = {
  applied: boolean;
  status: EliseStatus;
};

/**
 * The status a NON-SUCCESS response publishes, or null when it is a success.
 *
 * EXHAUSTIVE ON PURPOSE. Device QA found `safe_failure` being published as
 * `unsupported`, because the code was `if (status !== 'success') unsupported`.
 * For build_around_item that rendered "This item can't be used as the anchor for
 * a look yet." for what was actually a transient backend failure — telling the
 * user their garment is unusable when the truth was "try again". A backend
 * failure and an unsupported request are different facts and must not share a
 * bucket.
 */
function statusKindFor(
  status: PrivateEliseResponse['status'],
): Exclude<EliseStatusKind, 'idle' | 'loading' | 'success' | 'already_casual'> | null {
  switch (status) {
    case 'success':
      return null;
    case 'clarification_required':
      return 'clarification';
    case 'unsupported':
      return 'unsupported';
    case 'safe_failure':
    case 'invalid_request':
      // Both are "we could not do this", not "this is not supported".
      return 'failed';
    default:
      return 'failed';
  }
}

function published(publish: ElisePublisher, status: EliseStatus): EliseOutcome {
  // TEMPORARY QA DIAGNOSTIC (Phase 4 final blocker window). REMOVE BEFORE COMMIT.
  if (typeof __DEV__ !== 'undefined' && __DEV__ === true) {
    console.log(`[elise-life] status_published kind=${status.kind} op=${status.operation ?? "none"}`);
  }
  publish.setStatus(status);
  return { applied: status.kind === 'success', status };
}

// ── Capability A: bounded occasion interpretation ────────────────────────────

/**
 * Interprets a short occasion description and, on success, applies it through
 * the governed context-change flow.
 *
 * The applied value is one of the six occasions the contract permits, every one
 * of which the composer already resolves — so an accepted result is always a
 * change the user could have made with the existing chips.
 */
export async function interpretOccasion(
  deps: EliseOrchestrationDeps,
  input: { instruction: string; currentOccasion: string | null },
): Promise<EliseOutcome> {
  if (!deps.eliseEnabled) return { applied: false, status: IDLE_ELISE_STATUS };

  const requestId = deps.newRequestId();
  const planned = planOccasionRequest({
    requestId,
    instruction: input.instruction,
    occasion: input.currentOccasion,
    occasionGroup: occasionGroupFor(input.currentOccasion),
  });
  if (!planned.ok) {
    return published(deps.publish, { kind: 'unsupported', operation: 'interpret_occasion' });
  }

  const started = deps.coordinator.begin({
    plan: planned.plan,
    intent: 'interpret_occasion',
    snapshot: deps.snapshot(),
  });
  deps.publish.setStatus({ kind: 'loading', operation: 'interpret_occasion' });

  const outcome = await sendEliseRequest({
    plan: planned.plan,
    intent: 'interpret_occasion',
    signal: started.signal,
    invoke: deps.invoke,
  });

  // A cancelled request is not a failure and shows nothing at all.
  if (outcome.kind === 'cancelled') {
    return { applied: false, status: IDLE_ELISE_STATUS };
  }
  if (outcome.kind === 'capability_unavailable') {
    return published(deps.publish, {
      kind: 'capability_unavailable',
      operation: 'interpret_occasion',
    });
  }
  if (outcome.kind === 'failed') {
    return published(deps.publish, { kind: 'failed', operation: 'interpret_occasion' });
  }

  const acceptance = deps.coordinator.accept({
    generation: started.generation,
    response: outcome.response,
    now: deps.snapshot(),
  });
  // Stale: no mutation, no copy, no error. The state it was computed for is
  // gone, and saying so would be noise about a request the user has moved past.
  if (!acceptance.accepted) return { applied: false, status: IDLE_ELISE_STATUS };

  const response = acceptance.response;
  const nonSuccess = statusKindFor(response.status);
  if (nonSuccess) {
    return published(deps.publish, { kind: nonSuccess, operation: 'interpret_occasion' });
  }
  if (!response.normalizedOccasion) {
    return published(deps.publish, { kind: 'unsupported', operation: 'interpret_occasion' });
  }

  const occasion: PrivateEliseOccasion = response.normalizedOccasion;
  await deps.requestContextChange({ kind: 'occasion', occasion });
  return published(deps.publish, {
    kind: 'success',
    operation: 'interpret_occasion',
    occasion,
  });
}

// ── Capability B: Build Around This ──────────────────────────────────────────

/**
 * Validates a Build Around This instruction and sets the chosen anchor.
 *
 * OWNERSHIP IS ALWAYS PROVEN LOCALLY. The anchor must be in this actor's loaded
 * Closet and classify to a supported slot before any request is made; an
 * unsupported category returns a governed result and leaves state untouched
 * rather than asking the backend about a garment the composer cannot anchor.
 *
 * The anchor the client chose is the anchor applied. The response is used only
 * to confirm and, when offered, to interpret the occasion — never to pick a
 * different garment.
 */
export async function buildAroundItem(
  deps: EliseOrchestrationDeps,
  input: {
    instruction: string;
    anchorClosetItemId: string;
    closetItems: readonly ClosetItemProjection[];
    currentOccasion: string | null;
  },
): Promise<EliseOutcome> {
  if (!deps.eliseEnabled) return { applied: false, status: IDLE_ELISE_STATUS };

  const requestId = deps.newRequestId();
  const planned = planAnchorRequest({
    requestId,
    instruction: input.instruction,
    anchorClosetItemId: input.anchorClosetItemId,
    closetItems: input.closetItems,
    occasion: input.currentOccasion,
    occasionGroup: occasionGroupFor(input.currentOccasion),
  });
  if (!planned.ok) {
    return published(deps.publish, { kind: 'unsupported', operation: 'build_around_item' });
  }

  const started = deps.coordinator.begin({
    plan: planned.plan,
    intent: 'build_around_item',
    snapshot: deps.snapshot(),
  });
  deps.publish.setStatus({ kind: 'loading', operation: 'build_around_item' });

  const outcome = await sendEliseRequest({
    plan: planned.plan,
    intent: 'build_around_item',
    signal: started.signal,
    invoke: deps.invoke,
  });

  if (outcome.kind === 'cancelled') return { applied: false, status: IDLE_ELISE_STATUS };
  if (outcome.kind === 'capability_unavailable') {
    return published(deps.publish, {
      kind: 'capability_unavailable',
      operation: 'build_around_item',
    });
  }
  if (outcome.kind === 'failed') {
    return published(deps.publish, { kind: 'failed', operation: 'build_around_item' });
  }

  const acceptance = deps.coordinator.accept({
    generation: started.generation,
    response: outcome.response,
    now: deps.snapshot(),
  });
  if (!acceptance.accepted) return { applied: false, status: IDLE_ELISE_STATUS };

  const response = acceptance.response;
  const nonSuccess = statusKindFor(response.status);
  if (nonSuccess) {
    return published(deps.publish, { kind: nonSuccess, operation: 'build_around_item' });
  }
  // The returned alias must decode, through THIS request's map, to the anchor
  // the client selected. Anything else is a rejection, not a correction.
  const resolved = acceptance.plan.aliases.get(response.anchorRef ?? '') ?? null;
  if (resolved !== input.anchorClosetItemId) {
    return published(deps.publish, { kind: 'failed', operation: 'build_around_item' });
  }

  await deps.requestContextChange({
    kind: 'anchor',
    anchorClosetItemId: input.anchorClosetItemId,
  });
  return published(deps.publish, {
    kind: 'success',
    operation: 'build_around_item',
    // Named from the anchor's OWN normalized taxonomy, so the approved success
    // copy reads "Building around your trousers." rather than falling back to a
    // progress message. Never provider-authored.
    itemType: describeAnchorType(input.anchorClosetItemId, input.closetItems),
  });
}

/**
 * A short, lower-cased garment word for the success copy.
 *
 * Most specific field first, matching the slot classifier's own precedence. It
 * returns undefined rather than a guess when the record carries no taxonomy —
 * the copy layer then uses a completed-sounding fallback.
 */
function describeAnchorType(
  anchorClosetItemId: string,
  closetItems: readonly ClosetItemProjection[],
): string | undefined {
  const item = (closetItems ?? []).find((entry) => entry && entry.id === anchorClosetItemId);
  if (!item) return undefined;
  const label = item.subtype ?? item.clothingType ?? item.category;
  if (typeof label !== 'string' || !label.trim()) return undefined;
  return label.trim().toLowerCase().slice(0, 40);
}

/**
 * The single bounded entry point, dispatching by whether an anchor exists.
 *
 * WHY THIS AND NOT A THIRD SURFACE. Phase 4 is forbidden from adding another
 * Build Around This entry, and it does not need one: the two intents are the
 * same user act — describing what they want — and differ only in whether there
 * is already a garment to build around. One "Other…" sheet therefore serves
 * both, and the existing Closet-detail action and in-room anchor control keep
 * their current, authoritative behaviour untouched.
 */
export async function askElise(
  deps: EliseOrchestrationDeps,
  input: {
    instruction: string;
    currentOccasion: string | null;
    anchorClosetItemId: string | null;
    closetItems: readonly ClosetItemProjection[];
  },
): Promise<EliseOutcome> {
  // Guarded here as well as in both delegates. The flag check is a local
  // property of every public entry point rather than something inherited, so a
  // later refactor that does work before dispatching cannot lose it.
  if (!deps.eliseEnabled) return { applied: false, status: IDLE_ELISE_STATUS };

  if (input.anchorClosetItemId) {
    return buildAroundItem(deps, {
      instruction: input.instruction,
      anchorClosetItemId: input.anchorClosetItemId,
      closetItems: input.closetItems,
      currentOccasion: input.currentOccasion,
    });
  }
  return interpretOccasion(deps, {
    instruction: input.instruction,
    currentOccasion: input.currentOccasion,
  });
}

// ── Capability C: Make It More Casual (no backend) ───────────────────────────

/**
 * Steps the current look one level less formal, entirely on device.
 *
 * NO REQUEST IS MADE and no coordinator generation is consumed — but any
 * IN-FLIGHT request is still cancelled first, because this is a governed manual
 * context change and a late response must not land on top of it.
 */
export async function makeMoreCasual(
  deps: EliseOrchestrationDeps,
  input: { currentOccasion: string | null },
): Promise<EliseOutcome> {
  if (!deps.eliseEnabled) return { applied: false, status: IDLE_ELISE_STATUS };

  deps.coordinator.cancel();

  const step = resolveMoreCasualOccasion(input.currentOccasion);
  if (isUnsupportedCasualness(step)) {
    return published(deps.publish, {
      kind: step.reason === 'already_most_casual' ? 'already_casual' : 'unsupported',
      operation: 'make_more_casual',
    });
  }

  await deps.requestContextChange({ kind: 'occasion', occasion: step.occasion });
  return published(deps.publish, {
    kind: 'success',
    operation: 'make_more_casual',
    occasion: step.occasion,
  });
}

// ── Manual actions ───────────────────────────────────────────────────────────

/**
 * Every governed manual context change routes through here first.
 *
 * Required ordering: abort the active request, invalidate its generation, clear
 * the transient status, and only then let the manual flow proceed. Calling this
 * before opening the confirmation modal is what stops a response landing while
 * the modal is open and mutating the composition the modal is asking about.
 */
export function cancelActiveEliseRequest(deps: {
  coordinator: EliseRequestCoordinator;
  publish: ElisePublisher;
}): void {
  deps.coordinator.cancel();
  deps.publish.setStatus(IDLE_ELISE_STATUS);
}
