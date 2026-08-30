/**
 * Build 5 — what a committed Today card reports, and what it may never carry.
 *
 * THE PAYLOAD IS BUILT FROM THE CARD STATE, NOT FROM THE SOURCES. The card
 * carries stateId, priority, completeness, source and analyticsClass — bounded
 * enum values, every one of them. It does not carry the actor id, the Closet,
 * the Look, an image path, a token, a location or any user prose, so those
 * cannot reach a payload assembled from it even by mistake. The Phase 1 sink
 * then drops anything outside its own allowlist, which is a second independent
 * gate rather than the only one.
 *
 * DEDUPE IS PER COMMITTED GENERATION. A generation token is minted once per
 * evaluation and only a committed evaluation reports, so a rerender, a stale
 * completion and a refused commit all emit nothing.
 */

import type { TodayWithEliseCardState } from '../../types/todayWithElise.ts';
import {
  emitTodayWithEliseEvent,
  emitTodayWithEliseImpression,
} from './analytics.ts';
import { resolveDaypart } from './copyTemplates.ts';

/** Analytics-safe descriptor for one committed card. Enums and booleans only. */
export function todayEventPayload(
  card: TodayWithEliseCardState,
  platform: string,
  nowMs?: number,
): Record<string, unknown> {
  return {
    stateId: card.stateId,
    priority: card.priority ?? null,
    completeness: card.completeness,
    source: card.source,
    analyticsClass: card.analyticsClass,
    weatherUsed: card.weatherDependent === true,
    platform,
    daypart: resolveDaypart(nowMs === undefined ? new Date() : new Date(nowMs)),
  };
}

/**
 * States that are a refusal rather than a recommendation.
 *
 * They render, but they are not "eligible" and they are not an impression of a
 * recommendation — calling them one would inflate the top of the funnel with
 * cards that never offered anything.
 */
const REFUSAL_STATES = new Set([
  'unauthorized',
  'unavailable',
  'incompatible',
  'stale',
  'loading',
]);

export type TodayReportOptions = {
  card: TodayWithEliseCardState;
  platform: string;
  nowMs?: number;
  /** Injected for tests; defaults to the Phase 1 allowlisted sink. */
  emit?: typeof emitTodayWithEliseEvent;
  emitImpression?: typeof emitTodayWithEliseImpression;
};

/**
 * Report one committed card. Idempotent per generation token.
 *
 * Returns which events were emitted so a test can assert the exact set without
 * reaching into the sink.
 */
export function reportTodayCardCommitted(options: TodayReportOptions): string[] {
  const emit = options.emit ?? emitTodayWithEliseEvent;
  const emitImpression = options.emitImpression ?? emitTodayWithEliseImpression;
  const card = options.card;
  const emitted: string[] = [];
  if (!card || typeof card !== 'object') return emitted;

  const payload = todayEventPayload(card, options.platform, options.nowMs);

  // The impression is the dedupe authority: everything else in this function is
  // emitted only when the impression was genuinely new, so a second call for the
  // same generation reports nothing at all.
  const isNew = emitImpression({ generationToken: card.generationToken, payload });
  if (!isNew) return emitted;
  emitted.push('today_with_elise_impression');

  if (!REFUSAL_STATES.has(card.stateId) && card.analyticsClass !== 'suppressed') {
    if (card.stateId === 'fallback') {
      emit('today_with_elise_fallback_rendered', payload);
      emitted.push('today_with_elise_fallback_rendered');
    } else {
      emit('today_with_elise_eligible', payload);
      emitted.push('today_with_elise_eligible');
      if (card.stateId === 'partial_look') {
        emit('today_with_elise_partial_look_shown', payload);
        emitted.push('today_with_elise_partial_look_shown');
      }
    }
  }

  return emitted;
}
