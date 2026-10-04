/**
 * VTO customer discovery -- the ONE presentation model for "where, and
 * whether, should Try It On be visible right now".
 *
 * PURE. No React, no React Native, no network, no device access, no clock.
 * Every surface that makes Virtual Try-On visible (the product control, the
 * Home card, the first-use cue, the K+ benefit) renders what this module
 * returns, so "awareness is coordinated, not repeated" is one set of functions
 * rather than four components each remembering the same rules.
 *
 * WHAT THIS MODULE CONSUMES AND DOES NOT OWN. Every input is somebody else's
 * answer, already resolved:
 *
 *   item eligibility   hooks/useVtoAvailability -> services/vto/vtoEligibility
 *   feature / mode     services/vto/vtoFeatureControl (the remote row)
 *   K+                 hooks/useKPlusEntitlement (the canonical summary)
 *
 * It decides PRESENTATION ONLY. It holds no category list, no entitlement
 * rule, no provider name and no limit, and nothing here can start a
 * generation, open a photo chooser or reach a camera: the strongest thing any
 * function below can return is "render the control", and the control leads to
 * the existing governed sheet, which asks for consent before anything is sent.
 */

// ── Item eligibility, as a customer surface sees it ──────────────────────────

/**
 * Three states, never two. UNRESOLVED exists so a control is not rendered and
 * then withdrawn: until every authority has answered there is nothing to show.
 */
export const VTO_ELIGIBILITY_PRESENTATIONS = [
  'CONFIRMED_ELIGIBLE',
  'CONFIRMED_INELIGIBLE',
  'UNRESOLVED',
] as const;
export type VtoEligibilityPresentation = (typeof VTO_ELIGIBILITY_PRESENTATIONS)[number];

/** The resolved answer hooks/useVtoAvailability already produces. */
export interface VtoAvailabilitySignal {
  /** Usable now: eligible item, feature on, K+ active. */
  available: boolean;
  /** Eligible item, feature on, and K+ is the only thing missing. */
  upgradeOpportunity: boolean;
  /** An authority (remote row or K+) has not answered yet. */
  loading: boolean;
}

/**
 * Maps the existing availability answer onto the three presentation states.
 *
 * A resolver that failed has no state of its own on purpose. The remote reader
 * never throws -- an unreadable row IS the disabled row -- and an unreadable K+
 * answer is `loading`. Both therefore land on a state that renders nothing,
 * which is the fail-closed behaviour: no control, no disabled control, and the
 * rest of the product card untouched. Anything that is not three real booleans
 * is treated the same way.
 */
export function resolveVtoEligibilityPresentation(
  signal: VtoAvailabilitySignal | null | undefined,
): VtoEligibilityPresentation {
  if (
    !signal
    || typeof signal.available !== 'boolean'
    || typeof signal.upgradeOpportunity !== 'boolean'
    || typeof signal.loading !== 'boolean'
  ) {
    return 'UNRESOLVED';
  }
  if (signal.loading) return 'UNRESOLVED';
  if (signal.available || signal.upgradeOpportunity) return 'CONFIRMED_ELIGIBLE';
  return 'CONFIRMED_INELIGIBLE';
}

/**
 * What the product control does.
 *
 *   'try_it_on'  opens the existing try-on sheet (active or complimentary K+)
 *   'unlock'     opens the shared K+ surface (a positively Free actor)
 *   'none'       renders nothing at all
 */
export type VtoProductCta = 'none' | 'try_it_on' | 'unlock';

export function resolveVtoProductCta(
  signal: VtoAvailabilitySignal | null | undefined,
): VtoProductCta {
  if (resolveVtoEligibilityPresentation(signal) !== 'CONFIRMED_ELIGIBLE') return 'none';
  return signal?.available === true ? 'try_it_on' : 'unlock';
}

// ── Where VTO was encountered ────────────────────────────────────────────────

/** Bounded surface attribution. Telemetry accepts these values and no others. */
export const VTO_AWARENESS_SURFACES = [
  'kplus_step6',
  'home',
  'coachmark',
  'product',
  'scan_result',
  'commerce',
] as const;
export type VtoAwarenessSurface = (typeof VTO_AWARENESS_SURFACES)[number];

/** Bounded K+ dimension for awareness telemetry. `resolving` is its own value:
 *  an unknown answer is never reported as Free. */
export const VTO_ACTOR_KPLUS_STATES = ['free', 'active', 'complimentary', 'resolving'] as const;
export type VtoActorKPlusState = (typeof VTO_ACTOR_KPLUS_STATES)[number];

export function resolveVtoActorKPlusState(input: {
  /** Canonical resolved state from the entitlement hook. */
  state: string | null | undefined;
  /** Presentation-only source the canonical summary reports. */
  displaySource?: string | null;
}): VtoActorKPlusState {
  if (input.state === 'active') {
    return input.displaySource === 'complimentary' ? 'complimentary' : 'active';
  }
  if (input.state === 'eligible' || input.state === 'expired') return 'free';
  return 'resolving';
}

// ── Whether VTO may be promoted at all ───────────────────────────────────────

export type VtoSurfaceAvailability = 'available' | 'unavailable' | 'resolving';

export interface VtoSurfaceAvailabilityInput {
  /** The build carries the try-on surface (the shipping flag). */
  uiEnabled: boolean;
  /** A signed-in actor. Awareness is never offered to an anonymous viewer. */
  authenticated: boolean;
  /**
   * The remote row, once read. `null` means not read yet. `awarenessEnabled`
   * false is the operator dimming promotion while generation stays on.
   */
  remote: { enabled: boolean; awarenessEnabled: boolean } | null;
}

/**
 * Can an awareness surface (Home card, first-use cue) be shown?
 *
 * This is deliberately stricter than "can a generation happen": promotion can
 * be dimmed while the feature keeps working, and it is never shown on a guess.
 */
export function resolveVtoSurfaceAvailability(
  input: VtoSurfaceAvailabilityInput,
): VtoSurfaceAvailability {
  if (input.uiEnabled !== true || input.authenticated !== true) return 'unavailable';
  if (!input.remote) return 'resolving';
  if (input.remote.enabled !== true) return 'unavailable';
  if (input.remote.awarenessEnabled !== true) return 'unavailable';
  return 'available';
}

// ── Awareness history ────────────────────────────────────────────────────────

/** What this actor has already seen or done, on this device. */
export interface VtoAwarenessRecord {
  homeCardDismissed: boolean;
  /** The actor opened the try-on surface at least once. */
  initiated: boolean;
  /** A try-on result was presented at least once. */
  completed: boolean;
  /** The first-use cue was answered with "Not now". */
  cueDismissed: boolean;
  /** How many sessions the first-use cue has been presented in. */
  cuePresentations: number;
}

/** This launch only. Never persisted. */
export interface VtoAwarenessSession {
  /** The first-use cue was presented in this session. */
  cueShown: boolean;
  /** Try It On was pitched on the K+ membership step in this session. */
  pitchedAtStep6: boolean;
}

// ── Home discovery card ──────────────────────────────────────────────────────

export const VTO_HOME_CARD_STATES = [
  'NEVER_ENGAGED',
  'HOME_CARD_DISMISSED',
  'VTO_INITIATED',
  'VTO_COMPLETED',
  'VTO_UNAVAILABLE',
  /** Shown on the membership step moments ago: not repeated on arrival. */
  'DEFERRED_AFTER_STEP6',
  /** An input is still unknown. Renders nothing rather than guessing. */
  'UNRESOLVED',
] as const;
export type VtoHomeCardState = (typeof VTO_HOME_CARD_STATES)[number];

export interface VtoHomeCardInput {
  surface: VtoSurfaceAvailability;
  /** `null` until this actor's history has been read. */
  awareness: VtoAwarenessRecord | null;
  session: VtoAwarenessSession;
}

export interface VtoHomeCardDecision {
  state: VtoHomeCardState;
  visible: boolean;
}

/**
 * The Home card's whole lifecycle. Only NEVER_ENGAGED is visible, and every
 * unknown input hides the card: a promotion that appears and then disappears
 * a moment later is worse than one that arrives a beat late.
 */
export function resolveVtoHomeCard(input: VtoHomeCardInput): VtoHomeCardDecision {
  const hidden = (state: VtoHomeCardState): VtoHomeCardDecision => ({ state, visible: false });
  if (input.surface === 'unavailable') return hidden('VTO_UNAVAILABLE');
  if (input.surface !== 'available' || !input.awareness) return hidden('UNRESOLVED');
  if (input.awareness.completed) return hidden('VTO_COMPLETED');
  if (input.awareness.initiated) return hidden('VTO_INITIATED');
  if (input.awareness.homeCardDismissed) return hidden('HOME_CARD_DISMISSED');
  if (input.session.pitchedAtStep6) return hidden('DEFERRED_AFTER_STEP6');
  return { state: 'NEVER_ENGAGED', visible: true };
}

// ── "Meaningfully viewed" ────────────────────────────────────────────────────

/**
 * An eligible product object existing in a list is not a view. The control has
 * to have sat, whole, inside the visible window of a focused screen for a
 * continuous dwell before it counts.
 */
export const VTO_MEANINGFUL_VIEW = Object.freeze({
  /** Continuous time the whole control must stay in the window. */
  dwellMs: 1200,
  /** How often a candidate control is measured. */
  sampleMs: 400,
});

export interface VtoWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True only when the WHOLE measured rect lies inside the window. */
export function isVtoRectInWindow(
  rect: VtoWindowRect | null | undefined,
  viewport: { width: number; height: number } | null | undefined,
): boolean {
  if (!rect || !viewport) return false;
  const values = [rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return false;
  // An unmounted or clipped native view measures as zero-size.
  if (rect.width <= 0 || rect.height <= 0) return false;
  return (
    rect.x >= 0
    && rect.y >= 0
    && rect.x + rect.width <= viewport.width
    && rect.y + rect.height <= viewport.height
  );
}

export interface VtoViewDwell {
  /** When the current unbroken in-window run began, or null if not in one. */
  visibleSinceMs: number | null;
}

export const VTO_VIEW_DWELL_IDLE: VtoViewDwell = Object.freeze({ visibleSinceMs: null });

export interface VtoViewSample {
  inWindow: boolean;
  /** The host screen is focused and the app is in the foreground. */
  stable: boolean;
  nowMs: number;
}

/**
 * Advances the dwell by one measurement. Leaving the window or losing
 * stability resets the run to zero -- a view is continuous or it is not a view.
 */
export function advanceVtoViewDwell(
  previous: VtoViewDwell,
  sample: VtoViewSample,
  dwellMs: number = VTO_MEANINGFUL_VIEW.dwellMs,
): { dwell: VtoViewDwell; meaningfullyViewed: boolean } {
  if (!sample.inWindow || !sample.stable) {
    return { dwell: VTO_VIEW_DWELL_IDLE, meaningfullyViewed: false };
  }
  const since = previous.visibleSinceMs ?? sample.nowMs;
  return {
    dwell: { visibleSinceMs: since },
    meaningfullyViewed: sample.nowMs - since >= dwellMs,
  };
}

// ── First-use cue ────────────────────────────────────────────────────────────

/** The cue is offered in at most this many sessions before it retires itself,
 *  whether or not it was ever answered. */
export const VTO_CUE_MAX_PRESENTATIONS = 2;

/** Everything that makes this the wrong moment for an education cue. */
export interface VtoCueCollisions {
  /** K+ has not answered. The cue must not guess which control it points at. */
  kplusResolving: boolean;
  /** Another modal or sheet is presenting on, or over, the host surface. */
  modalPresenting: boolean;
  /** A try-on request is in flight anywhere. */
  vtoRequestActive: boolean;
  /** A K+ purchase or restore is processing. */
  purchaseInFlight: boolean;
  /** The host screen is not focused: it is covered, or mid-transition. */
  surfaceUnstable: boolean;
  /** The app is not foreground-active: a system photo chooser, the camera, or
   *  a store sheet is in front of it. */
  appInactive: boolean;
}

export const VTO_CUE_NO_COLLISIONS: VtoCueCollisions = Object.freeze({
  kplusResolving: false,
  modalPresenting: false,
  vtoRequestActive: false,
  purchaseInFlight: false,
  surfaceUnstable: false,
  appInactive: false,
});

export function hasVtoCueCollision(collisions: VtoCueCollisions): boolean {
  return (
    collisions.kplusResolving
    || collisions.modalPresenting
    || collisions.vtoRequestActive
    || collisions.purchaseInFlight
    || collisions.surfaceUnstable
    || collisions.appInactive
  );
}

export type VtoCueReason =
  | 'show'
  | 'surface_unavailable'
  | 'history_unknown'
  | 'not_eligible'
  | 'not_viewed'
  | 'already_used'
  | 'dismissed'
  | 'retired'
  | 'shown_this_session'
  | 'pitched_at_step6'
  | 'collision';

export interface VtoCueInput {
  surface: VtoSurfaceAvailability;
  cta: VtoProductCta;
  meaningfullyViewed: boolean;
  awareness: VtoAwarenessRecord | null;
  session: VtoAwarenessSession;
  collisions: VtoCueCollisions;
}

export interface VtoCueDecision {
  show: boolean;
  reason: VtoCueReason;
}

/**
 * Should the first-use cue appear for THIS encounter?
 *
 * The permanent reasons are checked before the momentary ones, so a customer
 * who said "Not now" is never re-evaluated at all. A collision is the last
 * check and it is neither a queue nor a verdict: the cue is deferred for this
 * encounter only, and a later, stable encounter is evaluated from the top.
 */
export function resolveVtoFirstUseCue(input: VtoCueInput): VtoCueDecision {
  const no = (reason: VtoCueReason): VtoCueDecision => ({ show: false, reason });
  if (input.surface !== 'available') return no('surface_unavailable');
  if (!input.awareness) return no('history_unknown');
  if (input.cta === 'none') return no('not_eligible');
  if (input.awareness.initiated || input.awareness.completed) return no('already_used');
  if (input.awareness.cueDismissed) return no('dismissed');
  if (input.awareness.cuePresentations >= VTO_CUE_MAX_PRESENTATIONS) return no('retired');
  if (input.session.cueShown) return no('shown_this_session');
  if (input.session.pitchedAtStep6) return no('pitched_at_step6');
  if (!input.meaningfullyViewed) return no('not_viewed');
  if (hasVtoCueCollision(input.collisions)) return no('collision');
  return { show: true, reason: 'show' };
}

/**
 * One product card's cue encounter.
 *
 *   'watching'   measuring; nothing decided
 *   'presented'  this card is showing the cue
 *   'deferred'   the view completed at the wrong moment, so nothing is shown
 *                NOW. Deferring records nothing: it is not an impression, not a
 *                dismissal, and it does not touch the session's or the
 *                account's history, so the education is still owed.
 *
 * WHAT ENDS A DEFERRAL. Not the collision clearing: a cue that appeared the
 * moment another modal closed would be the queue this policy forbids. A
 * deferred encounter ends when the customer has moved on and come back -- the
 * control leaves the window (`left_window`), or a new product surface mounts,
 * which starts at 'watching' by construction. That later encounter is judged
 * from the top, against every limit, exactly like a first one.
 */
export type VtoCueEncounter = 'watching' | 'presented' | 'deferred';

export function advanceVtoCueEncounter(
  current: VtoCueEncounter,
  event:
    | { type: 'viewed'; decision: VtoCueDecision }
    | { type: 'left_window' },
): VtoCueEncounter {
  if (event.type === 'left_window') return current === 'presented' ? 'presented' : 'watching';
  if (current !== 'watching') return current;
  return event.decision.show ? 'presented' : 'deferred';
}

/**
 * Does this decision leave anything behind?
 *
 * Only an actual presentation does. Every refusal -- and a collision above all
 * -- must leave the account's history, the session's one presentation and the
 * telemetry exactly as they were, or a busy moment would quietly use up the
 * one chance to introduce the feature.
 */
export function vtoCueDecisionRecordsPresentation(decision: VtoCueDecision): boolean {
  return decision.show === true && decision.reason === 'show';
}

// ── Copy ─────────────────────────────────────────────────────────────────────

/**
 * Every customer string the awareness layer adds, in one place.
 *
 * Bounded by what the shipping feature does: an AI visualization on a photo
 * the customer chooses. Nothing here speaks about fit, size, measurement,
 * exactness or image quality, and nothing names a daily number -- the server
 * owns the limit and reports it when it is reached.
 */
export const VTO_DISCOVERY_COPY = Object.freeze({
  title: 'Try it on with AI',
  benefitBody: 'See how an eligible look might work on you before you buy.',
  homeBody: 'Scan or open an eligible look to see it on you.',
  homePrimary: 'SCAN A LOOK',
  homePrimaryA11y: 'Scan a look to try on',
  homePrimaryHint: 'Opens the scanner. Eligible items show a Try It On button.',
  homeDismissA11y: 'Dismiss the Try It On tip',
  cueBody: 'You can preview this look on a photo of yourself.',
  cuePrimary: 'TRY IT ON',
  cueDismiss: 'NOT NOW',
  cueDismissA11y: 'Not now. Hides this tip.',
  productLabel: 'TRY IT ON',
  productUnlockLabel: 'TRY IT ON · K+',
});
