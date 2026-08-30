/**
 * Build 5 — Today with Elise V1 deterministic priority engine.
 *
 * Exactly one priority may control the card. Evaluation is pure and
 * deterministic for the same input snapshot.
 *
 * Priority order (locked):
 *   1. Recent unfinished Look
 *   2. Today’s owned-item Look
 *   3. Continue recent styling
 *   4. Closet action
 *   5. Onboarding
 *
 * Tie-break: within the same priority rank, prefer the candidate with the
 * newer updatedAtMs / lookKey lexicographic order as documented below.
 * Never merge priorities into a dashboard.
 */

import type {
  TodayWithEliseActionSpec,
  TodayWithEliseCardState,
  TodayWithEliseItemRef,
  TodayWithEliseSnapshot,
} from '../../types/todayWithElise.ts';
import { TODAY_WITH_ELISE_PRIORITY_RANK } from '../../types/todayWithElise.ts';

function noneAction(): TodayWithEliseActionSpec {
  return {
    action: 'none',
    labelKey: 'action.none',
    target: 'none',
    runnable: false,
  };
}

function primary(
  action: TodayWithEliseActionSpec['action'],
  labelKey: string,
  target: TodayWithEliseActionSpec['target'],
  runnable: boolean,
): TodayWithEliseActionSpec {
  return { action, labelKey, target, runnable };
}

function secondaryChangeSomething(runnable: boolean): TodayWithEliseActionSpec {
  return {
    action: 'change_something',
    labelKey: 'action.change_something',
    target: 'elise_modification',
    runnable,
  };
}

function baseState(
  snapshot: TodayWithEliseSnapshot,
  partial: Omit<
    TodayWithEliseCardState,
    'actorId' | 'actorEpoch' | 'generationToken'
  >,
): TodayWithEliseCardState {
  return {
    ...partial,
    actorId: snapshot.actorId,
    actorEpoch: snapshot.actorEpoch,
    generationToken: snapshot.generationToken,
  };
}

function isStale(snapshot: TodayWithEliseSnapshot): boolean {
  if (snapshot.sourceCapturedAtMs == null) return false;
  if (!Number.isFinite(snapshot.sourceCapturedAtMs)) return true;
  if (snapshot.sourceCapturedAtMs > snapshot.evaluatedAtMs) return true;
  return snapshot.evaluatedAtMs - snapshot.sourceCapturedAtMs > snapshot.maxSourceAgeMs;
}

function canOpenDressingRoom(snapshot: TodayWithEliseSnapshot): boolean {
  return snapshot.capabilities.privateDressingRoomActive === true;
}

/**
 * Evaluate the Today with Elise card state from a frozen snapshot.
 *
 * Fail-closed order before priority:
 *   unauthorized → malformed → flag off → stale → priority scan → fallback
 */
export function evaluateTodayWithEliseCard(
  snapshot: TodayWithEliseSnapshot,
): TodayWithEliseCardState {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      stateId: 'fallback',
      actorId: null,
      actorEpoch: null,
      generationToken: 'invalid',
      headlineKey: 'headline.fallback',
      explanationKey: 'explanation.fallback',
      primaryAction: noneAction(),
      secondaryAction: null,
      itemRefs: Object.freeze([]) as TodayWithEliseItemRef[],
      completeness: 'n_a',
      source: 'system_fallback',
      weatherDependent: false,
      dressingRoomDependent: false,
      analyticsClass: 'fallback',
      safeFallbackStateId: 'fallback',
      priority: null,
    };
  }

  if (typeof snapshot.actorId !== 'string' || !snapshot.actorId.trim()) {
    return baseState(snapshot, {
      stateId: 'unauthorized',
      headlineKey: 'headline.unauthorized',
      explanationKey: 'explanation.unauthorized',
      primaryAction: noneAction(),
      secondaryAction: null,
      itemRefs: Object.freeze([]) as TodayWithEliseItemRef[],
      completeness: 'n_a',
      source: 'actor_gate',
      weatherDependent: false,
      dressingRoomDependent: false,
      analyticsClass: 'unauthorized',
      safeFallbackStateId: 'unauthorized',
      priority: null,
    });
  }

  if (snapshot.malformed === true) {
    return baseState(snapshot, {
      stateId: 'incompatible',
      headlineKey: 'headline.incompatible',
      explanationKey: 'explanation.incompatible',
      primaryAction: noneAction(),
      secondaryAction: null,
      itemRefs: Object.freeze([]) as TodayWithEliseItemRef[],
      completeness: 'ineligible',
      source: 'malformed_refusal',
      weatherDependent: false,
      dressingRoomDependent: false,
      analyticsClass: 'unavailable',
      safeFallbackStateId: 'fallback',
      priority: null,
    });
  }

  if (!snapshot.capabilities?.todayWithEliseActive) {
    return baseState(snapshot, {
      stateId: 'unavailable',
      headlineKey: 'headline.unavailable',
      explanationKey: 'explanation.unavailable',
      primaryAction: noneAction(),
      secondaryAction: null,
      itemRefs: Object.freeze([]) as TodayWithEliseItemRef[],
      completeness: 'n_a',
      source: 'system_fallback',
      weatherDependent: false,
      dressingRoomDependent: false,
      analyticsClass: 'suppressed',
      safeFallbackStateId: 'unavailable',
      priority: null,
    });
  }

  if (isStale(snapshot)) {
    return baseState(snapshot, {
      stateId: 'stale',
      headlineKey: 'headline.stale',
      explanationKey: 'explanation.stale',
      primaryAction: noneAction(),
      secondaryAction: null,
      itemRefs: Object.freeze([]) as TodayWithEliseItemRef[],
      completeness: 'unknown',
      source: 'stale_refusal',
      weatherDependent: false,
      dressingRoomDependent: false,
      analyticsClass: 'unavailable',
      safeFallbackStateId: 'fallback',
      priority: null,
    });
  }

  const drOpen = canOpenDressingRoom(snapshot);

  // 1. Unfinished Look
  if (snapshot.unfinishedLook) {
    const runnable = drOpen;
    if (!runnable) {
      // No dead primary action — demote rather than expose Continue Your Look.
    } else {
      return baseState(snapshot, {
        stateId: 'unfinished_look',
        headlineKey: 'headline.unfinished_look',
        explanationKey: 'explanation.unfinished_look',
        primaryAction: primary(
          'continue_your_look',
          'action.continue_your_look',
          'private_dressing_room',
          true,
        ),
        secondaryAction: secondaryChangeSomething(drOpen),
        itemRefs: snapshot.unfinishedLook.itemRefs,
        completeness: 'partial',
        source: 'private_dressing_room_session',
        weatherDependent: false,
        dressingRoomDependent: true,
        analyticsClass: 'eligible',
        safeFallbackStateId: 'fallback',
        priority: 'unfinished_look',
      });
    }
  }

  // 2. Today’s owned-item Look
  if (snapshot.todayOwnedLook) {
    const complete = snapshot.todayOwnedLook.completeness === 'complete';
    const runnable = drOpen;
    if (runnable) {
      return baseState(snapshot, {
        stateId: complete ? 'today_owned_look' : 'partial_look',
        headlineKey: complete
          ? 'headline.today_owned_look'
          : 'headline.partial_look',
        explanationKey: complete
          ? 'explanation.today_owned_look'
          : 'explanation.partial_look',
        primaryAction: primary(
          'tap_to_get_ready',
          'action.tap_to_get_ready',
          'private_dressing_room',
          true,
        ),
        secondaryAction: secondaryChangeSomething(true),
        itemRefs: snapshot.todayOwnedLook.itemRefs,
        completeness: complete ? 'complete' : 'partial',
        source: 'owned_closet_composition',
        weatherDependent: snapshot.capabilities.weatherActive,
        dressingRoomDependent: true,
        analyticsClass: complete ? 'eligible' : 'partial',
        safeFallbackStateId: 'fallback',
        priority: 'today_owned_look',
      });
    }
  }

  // 3. Continue recent styling
  if (snapshot.recentStyling) {
    if (drOpen) {
      return baseState(snapshot, {
        stateId: 'recent_styling',
        headlineKey: 'headline.recent_styling',
        explanationKey: 'explanation.recent_styling',
        primaryAction: primary(
          'continue_your_look',
          'action.continue_your_look',
          'private_dressing_room',
          true,
        ),
        secondaryAction: secondaryChangeSomething(true),
        itemRefs: snapshot.recentStyling.itemRefs,
        completeness: 'partial',
        source: 'private_dressing_room_session',
        weatherDependent: false,
        dressingRoomDependent: true,
        analyticsClass: 'eligible',
        safeFallbackStateId: 'fallback',
        priority: 'recent_styling',
      });
    }
  }

  // 4. Closet action
  if (snapshot.closetAction) {
    const review = snapshot.closetAction.kind === 'review_queue';
    return baseState(snapshot, {
      stateId: 'closet_action',
      headlineKey: review
        ? 'headline.closet_review'
        : 'headline.closet_action',
      explanationKey: review
        ? 'explanation.closet_review'
        : 'explanation.closet_action',
      primaryAction: primary(
        review ? 'review_items' : 'add_your_first_item',
        review ? 'action.review_items' : 'action.add_your_first_item',
        review ? 'closet_review' : 'closet_intake',
        true,
      ),
      secondaryAction: null,
      itemRefs: Object.freeze([]) as TodayWithEliseItemRef[],
      completeness: 'n_a',
      source: review ? 'closet_review_queue' : 'onboarding_empty_closet',
      weatherDependent: false,
      dressingRoomDependent: false,
      analyticsClass: 'eligible',
      safeFallbackStateId: 'fallback',
      priority: 'closet_action',
    });
  }

  // 5. Onboarding
  if (
    snapshot.onboarding &&
    Number.isFinite(snapshot.onboarding.closetItemCount) &&
    snapshot.onboarding.closetItemCount <= 0
  ) {
    return baseState(snapshot, {
      stateId: 'onboarding',
      headlineKey: 'headline.onboarding',
      explanationKey: 'explanation.onboarding',
      primaryAction: primary(
        'add_your_first_item',
        'action.add_your_first_item',
        'closet_intake',
        true,
      ),
      secondaryAction: null,
      itemRefs: Object.freeze([]) as TodayWithEliseItemRef[],
      completeness: 'n_a',
      source: 'onboarding_empty_closet',
      weatherDependent: false,
      dressingRoomDependent: false,
      analyticsClass: 'eligible',
      safeFallbackStateId: 'fallback',
      priority: 'onboarding',
    });
  }

  return baseState(snapshot, {
    stateId: 'fallback',
    headlineKey: 'headline.fallback',
    explanationKey: 'explanation.fallback',
    primaryAction: noneAction(),
    secondaryAction: null,
    itemRefs: Object.freeze([]) as TodayWithEliseItemRef[],
    completeness: 'n_a',
    source: 'system_fallback',
    weatherDependent: false,
    dressingRoomDependent: false,
    analyticsClass: 'fallback',
    safeFallbackStateId: 'fallback',
    priority: null,
  });
}

/**
 * Tie-break helper for equal-rank unfinished candidates.
 * Newer updatedAtMs wins; if equal, lexicographically greater sessionId wins.
 */
export function tieBreakUnfinished(
  a: { sessionId: string; updatedAtMs: number },
  b: { sessionId: string; updatedAtMs: number },
): { sessionId: string; updatedAtMs: number } {
  if (a.updatedAtMs !== b.updatedAtMs) {
    return a.updatedAtMs > b.updatedAtMs ? a : b;
  }
  return a.sessionId >= b.sessionId ? a : b;
}

export function priorityRankOf(
  priority: keyof typeof TODAY_WITH_ELISE_PRIORITY_RANK,
): number {
  return TODAY_WITH_ELISE_PRIORITY_RANK[priority];
}

/**
 * Stale-completion guard for async Home orchestration.
 * A resolved card may apply only when generation + actor + epoch still match.
 */
export function isTodayCardResultCurrent(
  live: { actorId: string | null; actorEpoch: number; generationToken: string },
  result: TodayWithEliseCardState,
): boolean {
  if (!result || typeof result !== 'object') return false;
  if (result.generationToken !== live.generationToken) return false;
  if (result.actorEpoch !== live.actorEpoch) return false;
  const liveActor =
    typeof live.actorId === 'string' && live.actorId.trim()
      ? live.actorId.trim()
      : null;
  const resultActor =
    typeof result.actorId === 'string' && result.actorId.trim()
      ? result.actorId.trim()
      : null;
  return liveActor === resultActor;
}
