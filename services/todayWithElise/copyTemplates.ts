/**
 * Build 5 — deterministic copy templates for Today with Elise V1.
 *
 * One or two short sentences. Truthful. No unsupported personal claims,
 * pressure commerce, retailer favoritism, fabricated weather, or raw model
 * dependency. Generated greeting variation is deferred.
 */

export type TodayDaypart = 'morning' | 'afternoon' | 'evening';

export type TodayCopyContext = {
  daypart: TodayDaypart;
  weatherAvailable: boolean;
  stateId:
    | 'unfinished_look'
    | 'today_owned_look'
    | 'recent_styling'
    | 'closet_action'
    | 'closet_review'
    | 'partial_look'
    | 'onboarding'
    | 'fallback'
    | 'stale'
    | 'unauthorized'
    | 'unavailable'
    | 'incompatible';
};

const DAYPART_OPENERS: Readonly<Record<TodayDaypart, string>> = Object.freeze({
  morning: 'Good morning.',
  afternoon: 'Good afternoon.',
  evening: 'Good evening.',
});

const STATE_LINES: Readonly<Record<TodayCopyContext['stateId'], string>> =
  Object.freeze({
    unfinished_look: 'You have a Look still open. Continue where you left off.',
    today_owned_look: 'Here is one Look from pieces you own. Tap to get ready.',
    recent_styling: 'Pick up your recent styling session when you are ready.',
    closet_action: 'A small Closet step will make today’s picks sharper.',
    closet_review: 'A few Closet items are ready for a quick review.',
    partial_look:
      'Here is a partial Look from pieces you own. You can finish it in your Dressing Room.',
    onboarding: 'Add your first Closet item so Elise can suggest Looks you own.',
    fallback: 'Elise is ready when you are. Open Closet or start a scan.',
    stale: 'Today’s suggestion expired. Refresh Home to try again.',
    unauthorized: 'Sign in to see a personalized Look for today.',
    unavailable: 'Today with Elise is not available in this build.',
    incompatible: 'Today’s suggestion could not be prepared from this Closet data.',
  });

/**
 * Resolve bounded deterministic copy. Never invents weather details.
 */
export function resolveTodayDeterministicCopy(
  context: TodayCopyContext,
): { headline: string; explanation: string } {
  const opener = DAYPART_OPENERS[context.daypart] ?? DAYPART_OPENERS.afternoon;
  const stateLine = STATE_LINES[context.stateId] ?? STATE_LINES.fallback;

  let weatherLine = '';
  if (context.weatherAvailable) {
    weatherLine = ' Local weather can refine outerwear when available.';
  }

  // Unauthorized / unavailable / stale keep a single-purpose explanation.
  if (
    context.stateId === 'unauthorized' ||
    context.stateId === 'unavailable' ||
    context.stateId === 'stale' ||
    context.stateId === 'incompatible'
  ) {
    return { headline: opener, explanation: stateLine };
  }

  return {
    headline: opener,
    explanation: `${stateLine}${weatherLine}`.trim(),
  };
}

export function resolveDaypart(now: Date = new Date()): TodayDaypart {
  const hour = now.getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/** Template keys Phase 2 UI binds to — keep stable. */
export const TODAY_COPY_TEMPLATE_KEYS = Object.freeze([
  'morning',
  'afternoon',
  'evening',
  'weather.available',
  'weather.unavailable',
  'unfinished_look',
  'recent_styling',
  'closet_review',
  'partial_look',
  'onboarding',
  'fallback',
] as const);
