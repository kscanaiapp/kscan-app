/**
 * "Make It More Casual" — deterministic, fully on-device.
 *
 * NO BACKEND CALL. NO AI. This capability is a one-step descent through the
 * occasion groups the Phase 2 composer already scores, and the recomposition is
 * the ordinary production composer run again with a different occasion. Nothing
 * here asks a model anything, and the result must never be described as
 * AI-generated.
 *
 * WHAT IT DOES NOT ADD, because each would be a second styling opinion the
 * product has not earned:
 *   - a formality score
 *   - material-based casualness heuristics
 *   - colour-based casualness heuristics
 *   - silhouette ranking
 *   - hidden AI scoring
 *
 * The ONLY new thing is an ORDERING of the existing
 * types/privateDressingRoomComposition#PRIVATE_OCCASION_GROUPS values. That
 * ordering is not a score: it is the answer to "which of these six existing
 * groups is one step less formal", and it is deliberately partial — `travel` and
 * `neutral` sit outside the formality ladder and have no less-formal step, which
 * is a supported unsupported result rather than a guess.
 *
 * WHY THE OCCASION AND NOT THE GROUP IS WRITTEN. A session stores
 * `occasion: string | null`, and the composer derives the group from it through
 * occasionGroupFor(). Writing a group directly would create a second source of
 * truth the composer never reads, so this maps the target group back to a
 * canonical occasion value the composer already resolves — preferring one of the
 * route's own chips so the change is representable in the manual control the
 * user could have used instead.
 */

import { occasionGroupFor } from './privateDressingRoomComposer';
import type { PrivateOccasionGroup } from '../types/privateDressingRoomComposition';

/**
 * One step less formal, over the four groups that form a formality ladder.
 *
 * `travel` is an orthogonal context rather than a formality level — a travel
 * look is not "more formal than casual" — so it has no descent. `neutral` means
 * no occasion signal at all, and there is nothing to make more casual.
 */
const LESS_FORMAL_GROUP: Readonly<Record<PrivateOccasionGroup, PrivateOccasionGroup | null>> =
  Object.freeze({
    evening: 'work',
    work: 'smart_casual',
    smart_casual: 'casual',
    casual: null,
    travel: null,
    neutral: null,
  });

/**
 * The canonical occasion value written for each group.
 *
 * Work, Weekend and the rest are the route's own chips
 * (app/stylist/dressing-room/index.tsx#OCCASIONS). 'Smart' has no chip but is a
 * verified token in the composer's own OCCASION_GROUPS table, reachable today
 * through free text. Every value here round-trips: occasionGroupFor(value)
 * returns the group it is listed under, and a test proves it.
 */
const OCCASION_FOR_GROUP: Readonly<Record<PrivateOccasionGroup, string | null>> = Object.freeze({
  evening: 'Dinner',
  work: 'Work',
  smart_casual: 'Smart',
  casual: 'Weekend',
  travel: 'Travel',
  neutral: null,
});

export type CasualnessOutcome =
  | {
      supported: true;
      /** The occasion to write to the session. */
      occasion: string;
      fromGroup: PrivateOccasionGroup;
      toGroup: PrivateOccasionGroup;
    }
  | {
      supported: false;
      reason: 'already_most_casual' | 'no_supported_transition';
      fromGroup: PrivateOccasionGroup;
    };

/**
 * Resolves the next-less-formal occasion for the current one.
 *
 * PURE. Takes the session's occasion text, returns either the occasion to move
 * to or a typed reason there is none. It never composes, never persists, and
 * never mutates — the caller runs the existing governed context-change flow with
 * the returned occasion, which is what keeps confirmation, invalidation and undo
 * behaving exactly as they do for a manual occasion change.
 */
export function resolveMoreCasualOccasion(
  currentOccasion: string | null | undefined,
): CasualnessOutcome {
  const fromGroup = occasionGroupFor(currentOccasion);
  const toGroup = LESS_FORMAL_GROUP[fromGroup];

  if (!toGroup) {
    return {
      supported: false,
      // `casual` is genuinely the floor; travel and neutral are simply not on
      // the ladder. The distinction matters because they need different copy.
      reason: fromGroup === 'casual' ? 'already_most_casual' : 'no_supported_transition',
      fromGroup,
    };
  }

  const occasion = OCCASION_FOR_GROUP[toGroup];
  if (!occasion) {
    return { supported: false, reason: 'no_supported_transition', fromGroup };
  }
  return { supported: true, occasion, fromGroup, toGroup };
}

/** True when the action should be offered at all for this occasion. */
export function canMakeMoreCasual(currentOccasion: string | null | undefined): boolean {
  return resolveMoreCasualOccasion(currentOccasion).supported;
}
