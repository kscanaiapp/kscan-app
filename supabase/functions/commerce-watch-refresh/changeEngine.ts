// changeEngine.ts — K5-C4: deterministic price/availability change engine.
//
// No LLM, no AI provider, no model call of any kind (§41, §57, §66: "LLM
// CALLS PER REFRESH: 0"). Pure functions over already-parsed numbers — every
// currency parse happens before this module is called (parseOfferPrice, the
// existing canonicalCommerce.ts authority), so nothing here touches a raw
// price string.

export type WatchObservationStatus = 'resolved' | 'not_resolved' | 'currency_mismatch';

export type WatchEventType =
  | 'price_decreased'
  | 'price_increased'
  | 'target_price_reached'
  | 'listing_unavailable'
  | 'listing_available_again';

export type RefreshStatus =
  | 'available'
  | 'unavailable'
  | 'unchanged'
  | 'error'
  | 'provider_unavailable'
  | 'currency_mismatch';

export interface WatchState {
  currency: string;
  currentPriceAmount: number | null;
  targetPriceAmount: number | null;
  watchIntent: 'just_watching' | 'buy_under';
  targetReachedAt: string | null;
  lastStatus: 'unchecked' | 'available' | 'unavailable' | 'error';
  consecutiveFailures: number;
}

/**
 * What the refresh call actually observed, already parsed. `status`:
 *   - 'resolved'          — a numeric price was read for this listing
 *   - 'not_resolved'      — the provider call failed/timed out/rate-limited/
 *                           errored; NOT evidence the listing is gone (§40)
 *   - 'currency_mismatch' — a price was read but in a different currency
 *                           than the watch was created in (§35)
 */
export interface WatchObservation {
  status: WatchObservationStatus;
  priceAmount: number | null;
  currency: string | null;
}

export interface ChangeEngineResult {
  refreshStatus: RefreshStatus;
  newCurrentPriceAmount: number | null;
  newLastStatus: WatchState['lastStatus'];
  newConsecutiveFailures: number;
  newTargetReachedAt: string | null;
  event: { type: WatchEventType; priceAmount: number | null; currency: string | null } | null;
}

/** Event priority for the "strongest event wins, one per cycle" rule (§44). */
const EVENT_PRIORITY: Record<WatchEventType, number> = {
  target_price_reached: 4,
  listing_available_again: 3,
  price_decreased: 2,
  price_increased: 1,
  listing_unavailable: 0,
};

function strongest(
  candidates: Array<{ type: WatchEventType; priceAmount: number | null; currency: string | null } | null>,
): ChangeEngineResult['event'] {
  let best: ChangeEngineResult['event'] = null;
  for (const c of candidates) {
    if (!c) continue;
    if (!best || EVENT_PRIORITY[c.type] > EVENT_PRIORITY[best.type]) best = c;
  }
  return best;
}

/**
 * Evaluate one refresh cycle. Never throws; never needs the watch id, user
 * id, or anything beyond the numbers passed in — persistence is entirely the
 * caller's job (index.ts), which keeps this testable without a database.
 */
export function evaluateWatchRefresh(
  watch: WatchState,
  observation: WatchObservation,
  opts: { unavailableAfterFailures: number; observedAt: string },
): ChangeEngineResult {
  if (observation.status === 'currency_mismatch') {
    // §35: never update target crossing, never create a price event, never
    // FX-convert. The listing was resolved, so this is not a failure to
    // resolve — last_status / consecutive_failures are untouched.
    return {
      refreshStatus: 'currency_mismatch',
      newCurrentPriceAmount: watch.currentPriceAmount,
      newLastStatus: watch.lastStatus === 'unchecked' ? 'available' : watch.lastStatus,
      newConsecutiveFailures: 0,
      newTargetReachedAt: watch.targetReachedAt,
      event: null,
    };
  }

  if (observation.status === 'not_resolved') {
    const failures = watch.consecutiveFailures + 1;
    const degrade = failures >= opts.unavailableAfterFailures;
    const wasAvailable = watch.lastStatus === 'available';
    return {
      // 'error' below the threshold: a single/few misses is not evidence of
      // anything (§40). Only crossing the threshold may claim unavailable.
      refreshStatus: degrade ? 'unavailable' : 'error',
      newCurrentPriceAmount: watch.currentPriceAmount,
      newLastStatus: degrade ? 'unavailable' : 'error',
      newConsecutiveFailures: failures,
      newTargetReachedAt: watch.targetReachedAt,
      event: degrade && wasAvailable
        ? { type: 'listing_unavailable', priceAmount: null, currency: null }
        : null,
    };
  }

  // observation.status === 'resolved'
  const newPrice = observation.priceAmount;
  const previousPrice = watch.currentPriceAmount;
  const wasUnavailable = watch.lastStatus === 'unavailable' || watch.lastStatus === 'error';

  const priceEvent: ChangeEngineResult['event'] =
    previousPrice !== null && newPrice !== null && newPrice !== previousPrice
      ? {
        type: newPrice < previousPrice ? 'price_decreased' : 'price_increased',
        priceAmount: newPrice,
        currency: watch.currency,
      }
      : null;

  const recoveryEvent: ChangeEngineResult['event'] = wasUnavailable
    ? { type: 'listing_available_again', priceAmount: newPrice, currency: watch.currency }
    : null;

  // Target crossing (§42): previous comparable price > target AND new <= target.
  // Only fires once — a target already reached (targetReachedAt set) never
  // re-fires on further drops, matching "one meaningful event per refresh
  // cycle" without needing separate suppression state.
  let newTargetReachedAt = watch.targetReachedAt;
  let targetEvent: ChangeEngineResult['event'] = null;
  if (
    watch.watchIntent === 'buy_under' &&
    watch.targetPriceAmount !== null &&
    watch.targetReachedAt === null &&
    newPrice !== null &&
    newPrice <= watch.targetPriceAmount &&
    (previousPrice === null || previousPrice > watch.targetPriceAmount)
  ) {
    newTargetReachedAt = opts.observedAt;
    targetEvent = { type: 'target_price_reached', priceAmount: newPrice, currency: watch.currency };
  }

  const event = strongest([targetEvent, recoveryEvent, priceEvent]);

  return {
    refreshStatus: event ? 'available' : previousPrice === newPrice && !wasUnavailable ? 'unchanged' : 'available',
    newCurrentPriceAmount: newPrice,
    newLastStatus: 'available',
    newConsecutiveFailures: 0,
    newTargetReachedAt,
    event,
  };
}
