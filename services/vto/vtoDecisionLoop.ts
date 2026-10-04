/**
 * Pure policy for the VTO result decision loop: TRY -> RESULT -> DECIDE.
 * Commerce supplies opaque Shop/Watch callbacks; this module never constructs
 * destinations, records ownership, or starts generation work.
 */
import type {
  VtoFailure,
  VtoGarmentInput,
  VtoGenerationResult,
  VtoGenerationStatus,
} from '../../types/vto';

export interface VtoResultIdentityInput {
  status: VtoGenerationStatus;
  requestId: string | null;
  garment: VtoGarmentInput | null;
  result: VtoGenerationResult | null;
}

/** A result and its actions belong only to the exact request/product shown. */
export function vtoResultBelongsToProduct(
  snapshot: VtoResultIdentityInput,
  onScreen: VtoGarmentInput | null | undefined,
): boolean {
  if (snapshot.status !== 'success') return false;
  const { result, garment } = snapshot;
  if (!result || !garment || !onScreen) return false;
  if (!garment.productRef || garment.productRef !== onScreen.productRef) return false;
  if (garment.imageUrl !== onScreen.imageUrl) return false;
  return !!snapshot.requestId && result.requestId === snapshot.requestId;
}

export type VtoPrimaryAction = 'shop';
export type VtoSecondaryAction = 'save' | 'watch';
export type VtoTertiaryAction = 'try_again' | 'try_another';

export interface VtoResultActionPlan {
  primary: VtoPrimaryAction | null;
  secondary: readonly VtoSecondaryAction[];
  tertiary: readonly VtoTertiaryAction[];
  shopUnavailable: boolean;
}

export function planVtoResultActions(input: {
  canShop: boolean;
  canWatch: boolean;
  canSave: boolean;
}): VtoResultActionPlan {
  const secondary: VtoSecondaryAction[] = [];
  if (input.canSave) secondary.push('save');
  if (input.canWatch) secondary.push('watch');
  return Object.freeze({
    primary: input.canShop ? 'shop' : null,
    secondary: Object.freeze(secondary),
    tertiary: Object.freeze(['try_again', 'try_another'] as VtoTertiaryAction[]),
    shopUnavailable: !input.canShop,
  });
}

export function vtoFailureOffersRetry(failure: VtoFailure | null | undefined): boolean {
  return !!failure && failure.retryable === true;
}

export function vtoRetryCooldownMs(failure: VtoFailure | null | undefined): number {
  if (!vtoFailureOffersRetry(failure)) return 0;
  const seconds = failure?.retryAfterSeconds;
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0
    ? seconds * 1000
    : 0;
}

export function formatVtoRetryGuidance(retryAfterSeconds: number | null | undefined): string | null {
  if (typeof retryAfterSeconds !== 'number' || !Number.isInteger(retryAfterSeconds)) return null;
  if (retryAfterSeconds <= 0) return null;
  if (retryAfterSeconds <= 5) return 'Try again in a few seconds.';
  if (retryAfterSeconds < 60) {
    return `Try again in about ${Math.ceil(retryAfterSeconds / 5) * 5} seconds.`;
  }
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return minutes === 1 ? 'Try again in about a minute.' : `Try again in about ${minutes} minutes.`;
}

export const VTO_DECISION_COPY = Object.freeze({
  resultEyebrow: 'YOU TRIED',
  decisionPrompt: 'Keep this one, compare, or try another?',
  shopUnavailable: 'This listing has no shop link right now.',
  tryAgain: 'Try again',
  tryAgainHint: 'Creates a new try-on of this same piece',
  tryAnother: 'Try another piece',
  tryAnotherHint: 'Returns to the other options. Your photo stays ready for the next try-on.',
  compareTryOn: 'TRY-ON',
  compareOriginal: 'YOUR PHOTO',
  originalBadge: 'YOUR ORIGINAL PHOTO',
  tryOnBadge: 'AI TRY-ON',
  stillWorking: 'Still working on it. You can minimize and keep shopping.',
  stillWorkingNoMinimize: 'Still working on it.',
} as const);

export const VTO_FORBIDDEN_RESULT_CLAIMS: readonly string[] = Object.freeze([
  'perfect fit', 'fits you', 'your size', 'true to size', 'looks better',
  'best choice', 'suits you', 'you own', 'owned', 'purchased', 'guaranteed',
]);
