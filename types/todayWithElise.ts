/**
 * Build 5 — Today with Elise V1 card-state contracts.
 *
 * ELISE VERSION: Elise V3 — Proactive Intelligence
 * ENGINEERING PROGRAM: Build 5
 * FIRST PRODUCT SURFACE: Today with Elise V1
 *
 * PURE CONTRACT SURFACE. No Closet binaries, no image URIs, no raw wardrobe
 * dumps, and no UI rendering live here. Phase 2 may project these states onto
 * Home; Phase 1 only defines the discriminators and the fields every state must
 * carry.
 *
 * Actor scope is REQUIRED on every non-loading terminal state. Missing actor
 * fails closed to `unauthorized` rather than inventing a signed-out Today card.
 */

/** Stable identifiers for the discriminated card-state union. */
export const TODAY_WITH_ELISE_STATE_IDS = [
  'loading',
  'unfinished_look',
  'today_owned_look',
  'recent_styling',
  'closet_action',
  'onboarding',
  'partial_look',
  'unavailable',
  'stale',
  'incompatible',
  'unauthorized',
  'fallback',
] as const;

export type TodayWithEliseStateId = (typeof TODAY_WITH_ELISE_STATE_IDS)[number];

/**
 * Priority ranks that may control the card. Exactly one may win.
 * Lower number = higher priority. See priorityEngine.
 */
export const TODAY_WITH_ELISE_PRIORITIES = [
  'unfinished_look',
  'today_owned_look',
  'recent_styling',
  'closet_action',
  'onboarding',
] as const;

export type TodayWithElisePriority = (typeof TODAY_WITH_ELISE_PRIORITIES)[number];

export const TODAY_WITH_ELISE_PRIORITY_RANK: Readonly<
  Record<TodayWithElisePriority, number>
> = Object.freeze({
  unfinished_look: 1,
  today_owned_look: 2,
  recent_styling: 3,
  closet_action: 4,
  onboarding: 5,
});

/** Primary actions the card may expose. Dead actions are prohibited. */
export const TODAY_WITH_ELISE_PRIMARY_ACTIONS = [
  'tap_to_get_ready',
  'continue_your_look',
  'open_look',
  'review_items',
  'add_your_first_item',
  'none',
] as const;

export type TodayWithElisePrimaryAction =
  (typeof TODAY_WITH_ELISE_PRIMARY_ACTIONS)[number];

export const TODAY_WITH_ELISE_SECONDARY_ACTIONS = [
  'change_something',
  'none',
] as const;

export type TodayWithEliseSecondaryAction =
  (typeof TODAY_WITH_ELISE_SECONDARY_ACTIONS)[number];

export type TodayWithEliseCompleteness =
  | 'complete'
  | 'partial'
  | 'ineligible'
  | 'unknown'
  | 'n_a';

export type TodayWithEliseSource =
  | 'private_dressing_room_session'
  | 'saved_look'
  | 'owned_closet_composition'
  | 'closet_review_queue'
  | 'onboarding_empty_closet'
  | 'system_fallback'
  | 'actor_gate'
  | 'stale_refusal'
  | 'malformed_refusal';

export type TodayWithEliseAnalyticsClass =
  | 'eligible'
  | 'impression'
  | 'fallback'
  | 'partial'
  | 'unavailable'
  | 'unauthorized'
  | 'suppressed';

/**
 * Approved item reference only — stable Closet / Saved Look ids.
 * Never carries image binaries, local paths, or free-form titles.
 */
export type TodayWithEliseItemRef = {
  closetItemId: string;
  slot:
    | 'top'
    | 'bottom'
    | 'dress'
    | 'outerwear'
    | 'footwear'
    | 'accessory'
    | 'unknown';
};

export type TodayWithEliseActionSpec = {
  action: TodayWithElisePrimaryAction | TodayWithEliseSecondaryAction;
  /** Human label key for deterministic copy — not free-form model text. */
  labelKey: string;
  /**
   * Route or handoff intent. Concrete navigation is Phase 2; the contract only
   * names the approved target family.
   */
  target:
    | 'private_dressing_room'
    | 'saved_look_detail'
    | 'closet_review'
    | 'closet_intake'
    | 'elise_modification'
    | 'none';
  /**
   * True when the action cannot complete under current capability gates.
   * Priority engine must never emit a primary action with runnable=false.
   */
  runnable: boolean;
};

export type TodayWithEliseCardBase = {
  stateId: TodayWithEliseStateId;
  /** Authenticated actor id, or null only for loading/unauthorized. */
  actorId: string | null;
  /** Actor epoch captured when this card state was produced. */
  actorEpoch: number | null;
  headlineKey: string;
  explanationKey: string;
  primaryAction: TodayWithEliseActionSpec;
  secondaryAction: TodayWithEliseActionSpec | null;
  itemRefs: readonly TodayWithEliseItemRef[];
  completeness: TodayWithEliseCompleteness;
  source: TodayWithEliseSource;
  weatherDependent: boolean;
  dressingRoomDependent: boolean;
  analyticsClass: TodayWithEliseAnalyticsClass;
  /**
   * Safe fallback stateId to render if this state's dependencies become
   * unavailable after selection (e.g. Dressing Room flag flipped off).
   */
  safeFallbackStateId: TodayWithEliseStateId;
};

export type TodayWithEliseCardState = TodayWithEliseCardBase & {
  /** Winning priority when this is a priority-driven state; null otherwise. */
  priority: TodayWithElisePriority | null;
  /** Opaque generation token for stale-completion protection. */
  generationToken: string;
};

/** Snapshot inputs the priority engine evaluates. No raw Closet blobs. */
export type TodayWithEliseSnapshot = {
  actorId: string | null;
  actorEpoch: number;
  generationToken: string;
  /** Wall-clock ms used for staleness and day-boundary checks. */
  evaluatedAtMs: number;
  /** Max age for snapshot source data before refusal. */
  maxSourceAgeMs: number;
  sourceCapturedAtMs: number | null;
  unfinishedLook: {
    sessionId: string;
    savedLookId: string | null;
    updatedAtMs: number;
    itemRefs: readonly TodayWithEliseItemRef[];
  } | null;
  todayOwnedLook: {
    lookKey: string;
    completeness: 'complete' | 'partial';
    itemRefs: readonly TodayWithEliseItemRef[];
    dayKey: string;
  } | null;
  recentStyling: {
    sessionId: string;
    updatedAtMs: number;
    itemRefs: readonly TodayWithEliseItemRef[];
  } | null;
  closetAction: {
    kind: 'review_queue' | 'empty_prompt';
    pendingCount: number;
  } | null;
  onboarding: {
    closetItemCount: number;
  } | null;
  capabilities: {
    todayWithEliseActive: boolean;
    privateDressingRoomActive: boolean;
    weatherActive: boolean;
    generatedGreetingActive: boolean;
  };
  malformed: boolean;
};
