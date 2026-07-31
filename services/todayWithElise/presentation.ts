/**
 * Build 5 — display projection for the Today with Elise card.
 *
 * The Phase 1 card state is a CONTRACT, not a view model: it carries stable
 * item ids and copy KEYS, deliberately never titles, image paths or prose. This
 * file is the one place those keys become strings and those ids become
 * garments, so the contract stays free of presentation and the card component
 * stays free of lookups.
 *
 * IT ADDS NO STATE AND DECIDES NO PRIORITY. Everything below is a function of a
 * card the engine already produced.
 *
 * ONE DELIBERATE ACTION PROJECTION LIVES HERE — the partial-Look downgrade
 * documented on `projectPartialLookActions`. It changes which approved action a
 * partial Look offers; it never changes which state won.
 */

import type {
  TodayWithEliseActionSpec,
  TodayWithEliseCardState,
  TodayWithEliseItemRef,
} from '../../types/todayWithElise';
import {
  resolveDaypart,
  resolveTodayDeterministicCopy,
  type TodayCopyContext,
} from './copyTemplates';
import type { TodayClosetProjection } from './orchestrator';

/** Bounded label vocabulary. Deterministic templates only — never model text. */
export const TODAY_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'action.tap_to_get_ready': 'Tap to Get Ready',
  'action.continue_your_look': 'Continue Your Look',
  'action.open_look': 'Open Look',
  'action.review_items': 'Review Closet Items',
  'action.add_your_first_item': 'Add Your First Item',
  'action.add_more_items': 'Add More Items',
  'action.change_something': 'Change Something',
  'action.none': '',
});

export const TODAY_SLOT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  top: 'Top',
  bottom: 'Bottom',
  dress: 'Dress',
  outerwear: 'Outerwear',
  footwear: 'Shoes',
  accessory: 'Accessory',
  unknown: 'Item',
});

/** "Missing shoes", "Missing a top and shoes" — specific, never a shrug. */
const MISSING_SLOT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  top: 'a top',
  bottom: 'a bottom',
  dress: 'a dress',
  outerwear: 'a layer',
  footwear: 'shoes',
  accessory: 'an accessory',
});

export function describeTodayMissingSlots(slots: readonly string[]): string | null {
  const listed = (slots ?? []).map((slot) => MISSING_SLOT_NAMES[slot]).filter(Boolean);
  if (listed.length === 0) return null;
  if (listed.length === 1) return `Add ${listed[0]} to complete this Look.`;
  if (listed.length === 2) return `Add ${listed[0]} and ${listed[1]} to complete this Look.`;
  return `Add ${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]} to complete this Look.`;
}

// ── Action projection ────────────────────────────────────────────────────────

const CLOSET_INTAKE_ACTION: TodayWithEliseActionSpec = Object.freeze({
  action: 'add_your_first_item',
  labelKey: 'action.add_more_items',
  target: 'closet_intake',
  runnable: true,
});

/**
 * A partial Look offers a Closet action, never a Dressing Room action.
 *
 * WHY, in one sentence: an incomplete outfit's honest next step is completing
 * it, and "Tap to Get Ready" on a Look with no shoes promises a readiness the
 * Look does not have.
 *
 * WHY IT IS A PROJECTION AND NOT AN ENGINE CHANGE: the priority engine decides
 * WHICH state is true, and `partial_look` is still exactly the true state. What
 * changes is which approved action that state exposes, which the Phase 1
 * contract already models as a per-state property (`TodayWithEliseActionSpec`,
 * with `runnable` documented as "the action cannot complete under current
 * capability gates"). Editing the engine instead would fork the ranking logic
 * Phase 1 owns; this leaves the ranking untouched and is applied at exactly one
 * call site, after evaluation.
 *
 * `change_something` is dropped for the same reason: there is no complete Look
 * to modify yet.
 */
export function projectPartialLookActions(
  card: TodayWithEliseCardState,
): TodayWithEliseCardState {
  if (!card || card.stateId !== 'partial_look') return card;
  return {
    ...card,
    primaryAction: CLOSET_INTAKE_ACTION,
    secondaryAction: null,
    dressingRoomDependent: false,
  };
}

const NO_ACTION: TodayWithEliseActionSpec = Object.freeze({
  action: 'none',
  labelKey: 'action.none',
  target: 'none',
  runnable: false,
});

/**
 * Drop any action whose Build 3 dependency cannot complete.
 *
 * A DEAD CONTROL IS THE WORST OUTCOME AVAILABLE HERE. It teaches the user the
 * feature is broken, and unlike a missing control it cannot be explained. So an
 * action survives only when the gates that own its destination are ALL on.
 *
 * THE TWO GATES ARE GENUINELY DIFFERENT, AND THIS IS WHY THIS FUNCTION EXISTS
 * SEPARATELY FROM THE PRIORITY ENGINE:
 *
 *   - Opening the workspace needs `PRIVATE_DRESSING_ROOM_V1`. The priority
 *     engine already refuses to select a Dressing Room state without it, so the
 *     primary downgrade below is defence in depth rather than the live path —
 *     and a test asserts the engine never reaches it.
 *
 *   - MODIFYING a Look needs `PRIVATE_DRESSING_ROOM_ELISE_ACTIVE`, which is
 *     nested two levels deeper (workspace → interactions → Elise). The engine
 *     has no knowledge of that gate: the Phase 1 snapshot contract carries one
 *     Dressing Room capability, not three. "Change Something" with the
 *     workspace on and Elise off is therefore a REAL reachable configuration in
 *     which the engine emits a secondary action whose destination cannot act,
 *     and this is the only place that can refuse it.
 *
 * Both gates are read from the existing Build 3 constants by the caller. Build 5
 * defines no availability flag, no route-existence probe and no Home-specific
 * capability test of its own.
 */
export function projectCapabilityGatedActions(
  card: TodayWithEliseCardState,
  capabilities: { dressingRoomActive: boolean; eliseModificationActive: boolean },
): TodayWithEliseCardState {
  if (!card) return card;

  const primaryNeedsRoom =
    card.primaryAction?.target === 'private_dressing_room' ||
    card.primaryAction?.target === 'elise_modification';
  const primary =
    primaryNeedsRoom && !capabilities.dressingRoomActive ? NO_ACTION : card.primaryAction;

  const secondaryTarget = card.secondaryAction?.target ?? null;
  const secondaryBlocked =
    (secondaryTarget === 'private_dressing_room' && !capabilities.dressingRoomActive) ||
    (secondaryTarget === 'elise_modification' &&
      !(capabilities.dressingRoomActive && capabilities.eliseModificationActive));
  const secondary = secondaryBlocked ? null : card.secondaryAction;

  if (primary === card.primaryAction && secondary === card.secondaryAction) return card;
  return { ...card, primaryAction: primary, secondaryAction: secondary };
}

// ── Route resolution ─────────────────────────────────────────────────────────

export type TodayRouteTarget = TodayWithEliseActionSpec['target'];

/**
 * The concrete route for an approved action target.
 *
 * Every destination here already exists. Build 5 introduces no route, no route
 * parameter and no navigation contract of its own: the private Dressing Room is
 * reached exactly as the Stylist entry reaches it, and the Closet exactly as the
 * Home feature grid reaches it.
 */
export function resolveTodayRoute(
  target: TodayRouteTarget,
  options: { closetSeparationActive: boolean },
): string | null {
  switch (target) {
    case 'private_dressing_room':
    case 'elise_modification':
      return '/stylist/dressing-room';
    case 'saved_look_detail':
      return '/stylist/saved-looks';
    case 'closet_review':
    case 'closet_intake':
      return options?.closetSeparationActive ? '/library?section=closet' : '/library';
    case 'none':
    default:
      return null;
  }
}

// ── Card presentation ────────────────────────────────────────────────────────

export type TodayItemDisplay = {
  closetItemId: string;
  slotLabel: string;
  /** Garment title, or the slot label when the record carries none. */
  title: string;
  imageUri: string | null;
};

export type TodayCardPresentation = {
  headline: string;
  explanation: string;
  /** Only ever present slots; a missing slot is never rendered as an item. */
  items: TodayItemDisplay[];
  /** Placeholder tiles for slots the Look does not have. */
  missingSlotLabels: string[];
  missingSummary: string | null;
  primaryLabel: string | null;
  secondaryLabel: string | null;
  /** True when the card offers nothing to tap. Fallback and refusals only. */
  actionless: boolean;
  /** Screen-reader summary for the whole card. */
  accessibilityLabel: string;
};

function labelFor(spec: TodayWithEliseActionSpec | null, card: TodayWithEliseCardState): string | null {
  if (!spec || spec.action === 'none' || !spec.runnable) return null;
  // Onboarding is the only place "first" is true. A non-empty Closet that needs
  // more pieces must not be told it has none.
  if (spec.labelKey === 'action.add_your_first_item' && card.stateId !== 'onboarding') {
    return TODAY_ACTION_LABELS['action.add_more_items'];
  }
  const label = TODAY_ACTION_LABELS[spec.labelKey];
  return label ? label : null;
}

function copyStateFor(card: TodayWithEliseCardState): TodayCopyContext['stateId'] {
  if (card.stateId === 'closet_action') {
    return card.source === 'closet_review_queue' ? 'closet_review' : 'closet_action';
  }
  switch (card.stateId) {
    case 'unfinished_look':
    case 'today_owned_look':
    case 'recent_styling':
    case 'partial_look':
    case 'onboarding':
    case 'stale':
    case 'unauthorized':
    case 'unavailable':
    case 'incompatible':
      return card.stateId;
    default:
      return 'fallback';
  }
}

/**
 * Project one committed card into display strings and garment rows.
 *
 * NOTHING PRIVATE CROSSES THIS BOUNDARY IN THE OTHER DIRECTION: ids and image
 * URIs stay inside the returned object for local rendering and are never
 * reachable from analytics, which reads the card state instead.
 */
export function projectTodayCard(input: {
  card: TodayWithEliseCardState;
  projections: readonly TodayClosetProjection[];
  missingSlots: readonly string[];
  nowMs?: number;
}): TodayCardPresentation {
  const card = input.card;
  const byId = new Map<string, TodayClosetProjection>();
  for (const item of input.projections ?? []) {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  }

  const copy = resolveTodayDeterministicCopy({
    daypart: resolveDaypart(input.nowMs === undefined ? new Date() : new Date(input.nowMs)),
    weatherAvailable: false,
    stateId: copyStateFor(card),
  });

  const items: TodayItemDisplay[] = [];
  for (const ref of (card.itemRefs ?? []) as readonly TodayWithEliseItemRef[]) {
    const projection = byId.get(ref.closetItemId) ?? null;
    const slotLabel = TODAY_SLOT_LABELS[ref.slot] ?? TODAY_SLOT_LABELS.unknown;
    items.push({
      closetItemId: ref.closetItemId,
      slotLabel,
      title: projection?.title?.trim() ? projection.title.trim() : slotLabel,
      imageUri: projection?.thumbnailUri ?? projection?.imageUri ?? null,
    });
  }

  const missingSlotLabels = (input.missingSlots ?? [])
    .map((slot) => TODAY_SLOT_LABELS[slot])
    .filter(Boolean) as string[];

  const primaryLabel = labelFor(card.primaryAction, card);
  const secondaryLabel = labelFor(card.secondaryAction, card);
  const missingSummary =
    card.stateId === 'partial_look' ? describeTodayMissingSlots(input.missingSlots ?? []) : null;

  const spokenItems = items.map((item) => `${item.slotLabel}: ${item.title}`).join(', ');
  const spokenMissing = missingSlotLabels.length
    ? ` Missing ${missingSlotLabels.join(', ')}.`
    : '';
  const accessibilityLabel = [
    'Today with Elise.',
    copy.explanation,
    spokenItems ? ` ${spokenItems}.` : '',
    spokenMissing,
  ]
    .join('')
    .trim();

  return {
    headline: copy.headline,
    explanation: missingSummary ? `${copy.explanation} ${missingSummary}` : copy.explanation,
    items,
    missingSlotLabels,
    missingSummary,
    primaryLabel,
    secondaryLabel,
    actionless: primaryLabel === null && secondaryLabel === null,
    accessibilityLabel,
  };
}

/** Missing slots for a card, taken from the eligibility outcome that made it. */
export function missingSlotsFor(
  outcome: { status: string; missingSlots?: readonly string[] } | null | undefined,
): readonly string[] {
  if (!outcome || outcome.status !== 'partial') return [];
  return outcome.missingSlots ?? [];
}
