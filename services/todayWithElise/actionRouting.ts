/**
 * Build 5 — action routing contracts for Today with Elise V1.
 *
 * Tap to Get Ready must open Private Dressing Rooms with Build 3 ownership
 * resolution, approved Closet identities, and source attribution
 * `today_with_elise`. No automatic commerce. No Home-only outfit editor.
 */

export const TODAY_WITH_ELISE_SOURCE_ATTRIBUTION = 'today_with_elise' as const;

export type TodayPrimaryRouteIntent =
  | {
      kind: 'tap_to_get_ready';
      target: 'private_dressing_room';
      actorId: string;
      itemRefs: ReadonlyArray<{ closetItemId: string; slot: string }>;
      source: typeof TODAY_WITH_ELISE_SOURCE_ATTRIBUTION;
      loadRecommendedLookImmediately: true;
      useBuild3OwnershipResolution: true;
      automaticCommerce: false;
      dedupeKey: string;
    }
  | {
      kind: 'continue_your_look';
      target: 'private_dressing_room';
      actorId: string;
      sessionId: string;
      source: typeof TODAY_WITH_ELISE_SOURCE_ATTRIBUTION;
      automaticCommerce: false;
      dedupeKey: string;
    }
  | {
      kind: 'open_look';
      target: 'saved_look_detail';
      actorId: string;
      savedLookId: string;
      source: typeof TODAY_WITH_ELISE_SOURCE_ATTRIBUTION;
      automaticCommerce: false;
      dedupeKey: string;
    }
  | {
      kind: 'review_items';
      target: 'closet_review';
      actorId: string;
      source: typeof TODAY_WITH_ELISE_SOURCE_ATTRIBUTION;
      automaticCommerce: false;
      dedupeKey: string;
    }
  | {
      kind: 'add_your_first_item';
      target: 'closet_intake';
      actorId: string;
      source: typeof TODAY_WITH_ELISE_SOURCE_ATTRIBUTION;
      automaticCommerce: false;
      dedupeKey: string;
    };

export type TodaySecondaryRouteIntent = {
  kind: 'change_something';
  target: 'elise_modification';
  actorId: string;
  /** Uses existing Build 3 Private DR Elise modification flow. */
  useExistingBuild3ModificationFlow: true;
  source: typeof TODAY_WITH_ELISE_SOURCE_ATTRIBUTION;
  dedupeKey: string;
};

const recentPrimaryDedupe = new Map<string, number>();

/** Rapid-tap guard window for primary Dressing Room session creation. */
export const TODAY_PRIMARY_ACTION_DEDUPE_MS = 1500;

/**
 * Returns true when this primary action should proceed; false when a duplicate
 * rapid tap should be ignored to avoid duplicate session creation.
 */
export function shouldAcceptPrimaryActionTap(
  dedupeKey: string,
  nowMs: number,
  windowMs: number = TODAY_PRIMARY_ACTION_DEDUPE_MS,
): boolean {
  if (typeof dedupeKey !== 'string' || !dedupeKey) return false;
  if (!Number.isFinite(nowMs)) return false;
  const prior = recentPrimaryDedupe.get(dedupeKey);
  if (prior != null && nowMs - prior < windowMs) {
    return false;
  }
  recentPrimaryDedupe.set(dedupeKey, nowMs);
  return true;
}

/** Test seam. */
export function __resetTodayPrimaryActionDedupe(): void {
  recentPrimaryDedupe.clear();
}

export function buildTapToGetReadyIntent(args: {
  actorId: string;
  itemRefs: ReadonlyArray<{ closetItemId: string; slot: string }>;
  generationToken: string;
}): TodayPrimaryRouteIntent {
  return {
    kind: 'tap_to_get_ready',
    target: 'private_dressing_room',
    actorId: args.actorId,
    itemRefs: args.itemRefs,
    source: TODAY_WITH_ELISE_SOURCE_ATTRIBUTION,
    loadRecommendedLookImmediately: true,
    useBuild3OwnershipResolution: true,
    automaticCommerce: false,
    dedupeKey: `tap_to_get_ready:${args.actorId}:${args.generationToken}`,
  };
}

export function buildChangeSomethingIntent(args: {
  actorId: string;
  generationToken: string;
}): TodaySecondaryRouteIntent {
  return {
    kind: 'change_something',
    target: 'elise_modification',
    actorId: args.actorId,
    useExistingBuild3ModificationFlow: true,
    source: TODAY_WITH_ELISE_SOURCE_ATTRIBUTION,
    dedupeKey: `change_something:${args.actorId}:${args.generationToken}`,
  };
}

/** Handoff checklist for Phase 2 implementers and hostile audit. */
export const TAP_TO_GET_READY_REQUIREMENTS = Object.freeze([
  'open_private_dressing_rooms',
  'preserve_active_actor',
  'preserve_approved_closet_item_identity',
  'load_recommended_look_immediately',
  'source_attribution_today_with_elise',
  'use_build3_ownership_resolution',
  'avoid_automatic_commerce',
  'dedupe_rapid_taps',
  'permit_save_discard_elise_modification',
] as const);
