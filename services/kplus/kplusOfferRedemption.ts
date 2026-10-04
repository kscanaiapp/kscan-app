/**
 * K+ offer redemption -- the PRESENTATION contract for "Redeem an offer".
 *
 * This module owns what the redemption surface may show and the narrow port
 * through which a submission leaves it. It does NOT own, and never will:
 *
 *   - whether a code is valid, expired, used, or eligible (the server decides);
 *   - what a code grants (no discount, duration, or entitlement is named here);
 *   - K+ authorization (a success NEVER sets local entitlement state -- the
 *     canonical entitlement summary remains the only "You're K+" authority);
 *   - any client-side offer decision or entitlement mutation.
 *
 * The production adapter lives in kplusOfferRedemptionClient.ts so this model
 * and port remain pure and straightforward to exercise.
 */

// ── The port ─────────────────────────────────────────────────────────────────

/**
 * Every answer a redemption attempt can produce, as a closed set. The
 * integration audit's implementation must resolve with one of these and
 * nothing else; unknown answers are coerced to 'ERROR' at the boundary.
 */
export const KPLUS_OFFER_REDEMPTION_RESULTS = [
  'SUCCESS',
  'INVALID',
  'EXPIRED',
  'ALREADY_USED',
  'NOT_ELIGIBLE',
  'UNAVAILABLE',
  'ERROR',
] as const;
export type KPlusOfferRedemptionResult = (typeof KPLUS_OFFER_REDEMPTION_RESULTS)[number];

/**
 * The one seam the later integration pass implements. It receives the
 * customer-entered code with surrounding whitespace removed and resolves with
 * the server's verdict. It must not be answered from client state.
 */
export type KPlusOfferRedemptionPort = (code: string) => Promise<KPlusOfferRedemptionResult>;

/**
 * The honest default while no ingestion authority is wired: offer codes cannot
 * be redeemed right now. No network call, no stored code, no invented outcome.
 */
export const KPLUS_OFFER_REDEMPTION_UNAVAILABLE_PORT: KPlusOfferRedemptionPort = () =>
  Promise.resolve('UNAVAILABLE');

/** A port that throws, resolves junk, or is badly wired degrades to ERROR. */
export function sanitizeOfferRedemptionResult(value: unknown): KPlusOfferRedemptionResult {
  return (KPLUS_OFFER_REDEMPTION_RESULTS as readonly unknown[]).includes(value)
    ? (value as KPlusOfferRedemptionResult)
    : 'ERROR';
}

// ── Input handling ───────────────────────────────────────────────────────────

/**
 * Harmless formatting only: surrounding whitespace is removed. No format
 * validation, no allowlist, no case folding -- whether a code is well-formed
 * is the server's question, not the client's.
 */
export function normalizeOfferCodeInput(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** An empty code cannot be submitted. That is the only client-side rule. */
export function canSubmitOfferCode(normalizedCode: string): boolean {
  return normalizedCode.length > 0;
}

// ── The interaction state machine ────────────────────────────────────────────

export type KPlusRedeemOfferPhase = 'entry' | 'validating' | 'success' | 'failed';

export interface KPlusRedeemOfferState {
  phase: KPlusRedeemOfferPhase;
  /** The code as the customer typed it (display). Never persisted. */
  code: string;
  /** Present only in the failed phase; one of the non-success results. */
  failure: Exclude<KPlusOfferRedemptionResult, 'SUCCESS'> | null;
}

export const KPLUS_REDEEM_OFFER_INITIAL: KPlusRedeemOfferState = Object.freeze({
  phase: 'entry',
  code: '',
  failure: null,
});

export type KPlusRedeemOfferEvent =
  | { type: 'EDIT'; code: string }
  | { type: 'SUBMIT' }
  | { type: 'RESOLVED'; result: KPlusOfferRedemptionResult }
  | { type: 'RESET' };

/**
 * Pure transitions. Two rules carry the safety story:
 *
 *   - SUBMIT is accepted only from entry/failed with a non-empty code, so a
 *     validation in flight cannot be duplicated by a second tap;
 *   - RESOLVED is accepted only from validating, so a stale or stray answer
 *     cannot retroactively change what the customer sees.
 */
export function reduceKPlusRedeemOffer(
  state: KPlusRedeemOfferState,
  event: KPlusRedeemOfferEvent,
): KPlusRedeemOfferState {
  switch (event.type) {
    case 'EDIT':
      if (state.phase === 'validating') return state;
      return { phase: state.phase === 'failed' ? 'entry' : state.phase, code: event.code, failure: null };
    case 'SUBMIT': {
      if (state.phase === 'validating' || state.phase === 'success') return state;
      if (!canSubmitOfferCode(normalizeOfferCodeInput(state.code))) return state;
      return { ...state, phase: 'validating', failure: null };
    }
    case 'RESOLVED': {
      if (state.phase !== 'validating') return state;
      const result = sanitizeOfferRedemptionResult(event.result);
      if (result === 'SUCCESS') return { ...state, phase: 'success', failure: null };
      return { ...state, phase: 'failed', failure: result };
    }
    case 'RESET':
      return KPLUS_REDEEM_OFFER_INITIAL;
    default:
      return state;
  }
}

// ── Copy ─────────────────────────────────────────────────────────────────────

/**
 * Every customer string the redemption surface shows, in one place. Bounded
 * by design: no discount, duration, or entitlement is promised, and no
 * implementation term (server, store, provider) is ever named.
 */
export const KPLUS_REDEEM_OFFER_COPY = Object.freeze({
  title: 'Redeem an offer',
  explanation: 'Enter your K Scan AI offer code.',
  inputLabel: 'Offer code',
  inputHint: 'Enter the code exactly as it appears.',
  submit: 'REDEEM',
  submitA11y: 'Redeem offer code',
  validating: 'Checking your code…',
  cancel: 'Cancel',
  cancelA11y: 'Cancel and return to membership options',
  successTitle: 'Offer received',
  // A success is a receipt, not a membership: the canonical K+ authority
  // confirms the membership, and this copy says exactly that and no more.
  successBody: 'Your code was accepted. Your membership status updates as soon as it is confirmed.',
  successDone: 'DONE',
  failureTitles: Object.freeze({
    INVALID: 'Code not recognized',
    EXPIRED: 'Offer expired',
    ALREADY_USED: 'Code already used',
    NOT_ELIGIBLE: 'Offer not available',
    UNAVAILABLE: 'Offers unavailable',
    ERROR: 'Something went wrong',
  } as const),
  failureBodies: Object.freeze({
    INVALID: 'Check the code and try again.',
    EXPIRED: 'This offer is no longer active.',
    ALREADY_USED: 'This code has already been redeemed.',
    NOT_ELIGIBLE: 'This offer is not available for your account.',
    UNAVAILABLE: 'Offer codes cannot be redeemed right now. Please try again later.',
    ERROR: 'Your code could not be checked. Try again.',
  } as const),
});

/** The announcement a screen reader hears when a submission resolves. */
export function redeemOfferAnnouncement(state: KPlusRedeemOfferState): string | null {
  if (state.phase === 'success') return KPLUS_REDEEM_OFFER_COPY.successTitle;
  if (state.phase === 'failed' && state.failure) {
    return `${KPLUS_REDEEM_OFFER_COPY.failureTitles[state.failure]}. ${KPLUS_REDEEM_OFFER_COPY.failureBodies[state.failure]}`;
  }
  return null;
}
