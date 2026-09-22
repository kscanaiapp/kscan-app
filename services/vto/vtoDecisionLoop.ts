/**
 * The VTO result decision loop: TRY -> RESULT -> DECIDE.
 *
 * Pure and dependency-free apart from the VTO types, so every rule the result
 * screen depends on is executed by `node --test` rather than inferred from a
 * component (`__tests__/vtoDecisionLoop.test.js`). The sheet renders what this
 * module decides; it re-derives none of it.
 *
 * WHAT THIS MODULE DECIDES
 *   - whether a result may be shown for the product on screen at all
 *     (BLOCK-VTO-DL-00: result product == entry product, fail closed);
 *   - the action hierarchy -- one primary, then secondary, then tertiary --
 *     so the result is never an equal-weight wall of buttons;
 *   - how a server's Retry-After guidance is phrased, and how long the local
 *     retry control stays disabled.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE
 *   - which try-on mode a product gets (services/vto/vtoModeAuthority.ts);
 *   - where Shop goes, whether a listing is buyable, or whether it can be
 *     watched -- the product surface decides those and hands VTO opaque
 *     callbacks, or nothing. VTO only asks "was I given one?";
 *   - anything about ownership. TRY != SAVE != WATCH != SHOP != OWN, and no
 *     value this module returns records any of them.
 */

import type {
  VtoFailure,
  VtoGarmentInput,
  VtoGenerationResult,
  VtoGenerationStatus,
} from '../../types/vto';

// ─── Identity ─────────────────────────────────────────────────────────────────

/** The slice of the store snapshot the identity rule reads. */
export interface VtoResultIdentityInput {
  status: VtoGenerationStatus;
  requestId: string | null;
  garment: VtoGarmentInput | null;
  result: VtoGenerationResult | null;
}

/**
 * BLOCK-VTO-DL-00. A result may be presented -- and its actions offered --
 * only for the exact product it was generated for.
 *
 * The store's stale-result rule already stops a late completion landing after
 * a newer request, and the hook reattaches the session photo when the product
 * changes. This is the last line: if a snapshot ever pairs a result with a
 * different product than the one on screen (a different productRef, or the
 * same ref with a different garment image, which is what the generation
 * actually used), the sheet shows no result and no Shop/Watch/Save for it.
 * Fail closed: missing identity on either side is a mismatch.
 */
export function vtoResultBelongsToProduct(
  snapshot: VtoResultIdentityInput,
  onScreen: VtoGarmentInput | null | undefined,
): boolean {
  if (snapshot.status !== 'success') return false;
  const { result, garment } = snapshot;
  if (!result || !garment || !onScreen) return false;
  if (!garment.productRef || garment.productRef !== onScreen.productRef) return false;
  if (garment.imageUrl !== onScreen.imageUrl) return false;
  // The result must be the one this snapshot's request produced.
  return !!snapshot.requestId && result.requestId === snapshot.requestId;
}

// ─── Action hierarchy ─────────────────────────────────────────────────────────

export type VtoPrimaryAction = 'shop';
export type VtoSecondaryAction = 'save' | 'watch';
export type VtoTertiaryAction = 'try_again' | 'try_another';

export interface VtoResultActionPlan {
  /** At most one filled button. Shop, and only when a purchase path exists. */
  primary: VtoPrimaryAction | null;
  secondary: readonly VtoSecondaryAction[];
  tertiary: readonly VtoTertiaryAction[];
  /**
   * True when the product surface supplied no purchase path. The sheet says
   * so in words instead of rendering a disabled -- or worse, active -- Shop
   * button (BLOCK-VTO-DL-04).
   */
  shopUnavailable: boolean;
}

export interface VtoResultActionInput {
  /** The surface handed VTO an `onShop` for this product. */
  canShop: boolean;
  /** The surface handed VTO an `onWatch` for this product. */
  canWatch: boolean;
  /** A validated result exists that the Dressing Room bridge can save. */
  canSave: boolean;
}

/**
 * The result screen's hierarchy (brief §31):
 *
 *   primary    SHOP            -- when buyable
 *   secondary  SAVE, WATCH     -- each only when its path exists
 *   tertiary   TRY AGAIN, TRY ANOTHER
 *
 * Compare is not in the plan: it is a view control on the image itself, not
 * a decision, and it never leaves the device.
 */
export function planVtoResultActions(input: VtoResultActionInput): VtoResultActionPlan {
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

/**
 * The Live decision exit (brief §13). Live renders nothing persistent, so
 * there is no result to save and no photo to compare: the customer gets the
 * commerce decisions the surface already offers, plus a way back to the
 * other options. No frame is captured to make this symmetrical with Photo.
 */
export function planVtoLiveDecision(input: { canShop: boolean; canWatch: boolean }): {
  actions: readonly ('shop' | 'watch' | 'try_another')[];
} {
  const actions: ('shop' | 'watch' | 'try_another')[] = [];
  if (input.canShop) actions.push('shop');
  if (input.canWatch) actions.push('watch');
  actions.push('try_another');
  return Object.freeze({ actions: Object.freeze(actions) });
}

// ─── Failure recovery ─────────────────────────────────────────────────────────

/**
 * Whether the failed state may offer a new attempt at all.
 *
 * A non-retryable failure gets no regenerate button. In particular
 * `request_in_flight` must not: the button used to call `retry`, which opens a
 * NEW intent -- a new idempotency key, so a second paid generation while the
 * first may still be running. That is exactly the duplicate the server's
 * reservation had just suppressed (BLOCK-VTO31-01).
 */
export function vtoFailureOffersRetry(failure: VtoFailure | null | undefined): boolean {
  return !!failure && failure.retryable === true;
}

/** Milliseconds the local Try again control stays disabled, from guidance. */
export function vtoRetryCooldownMs(failure: VtoFailure | null | undefined): number {
  if (!vtoFailureOffersRetry(failure)) return 0;
  const seconds = failure?.retryAfterSeconds;
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0
    ? seconds * 1000
    : 0;
}

/**
 * Customer phrasing of Retry-After guidance. Approximate on purpose ("about"),
 * because it is the vendor's estimate, not K Scan's promise. Null when there
 * is no guidance -- the failure copy already says "shortly" honestly.
 */
export function formatVtoRetryGuidance(retryAfterSeconds: number | null | undefined): string | null {
  if (typeof retryAfterSeconds !== 'number' || !Number.isInteger(retryAfterSeconds)) return null;
  if (retryAfterSeconds <= 0) return null;
  if (retryAfterSeconds <= 5) return 'Try again in a few seconds.';
  if (retryAfterSeconds < 60) {
    // Rounded up to the next 5s: "about 32 seconds" reads falsely precise.
    const rounded = Math.ceil(retryAfterSeconds / 5) * 5;
    return `Try again in about ${rounded} seconds.`;
  }
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return minutes === 1 ? 'Try again in about a minute.' : `Try again in about ${minutes} minutes.`;
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

/**
 * Result-screen copy. Kept here so the negative controls can read it without
 * a renderer. None of it claims fit, size, ownership, or a recommendation:
 * the result is decision support, and the decision is the customer's.
 */
export const VTO_DECISION_COPY = Object.freeze({
  resultEyebrow: 'YOU TRIED',
  decisionPrompt: 'Keep this one, compare, or try another?',
  liveDecisionPrompt: 'Looks good?',
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

/**
 * Words the result surface must never use about a try-on (brief §29, §39,
 * BLOCK-VTO-DL-08). Pinned against every string above and the sheet source.
 */
export const VTO_FORBIDDEN_RESULT_CLAIMS: readonly string[] = Object.freeze([
  'perfect fit',
  'fits you',
  'your size',
  'true to size',
  'looks better',
  'best choice',
  'suits you',
  'you own',
  'owned',
  'purchased',
  'guaranteed',
]);
