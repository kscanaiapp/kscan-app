/**
 * Deterministic identification-quality gate (Phase 7.1).
 *
 * Decides ONLY whether a first-pass fashion identity is CLEAR or
 * REVIEW_REQUIRED, and returns machine-readable reasons. It is pure, synchronous
 * and provider-free: it is NOT a second classifier, on-device or otherwise, and
 * it never looks at commerce.
 *
 * WHAT IT READS — real fields the scanner already produces, nothing invented:
 *   - the normalized V2 taxonomy triple (category / clothingType / subtype)
 *   - `confidence_score` from the provider, carried as globalConfidence
 *   - the consistency conflicts already recorded by scannerQualityGate
 *   - the quality band already computed by scannerQualityGate
 *   - the visual observations already carried on the V2 evidence array
 *
 * NO NEW CONFIDENCE FIELD IS INTRODUCED. The scanner supplies one broad provider
 * score; this gate consumes that one rather than minting a parallel number that
 * would immediately disagree with it.
 *
 * WHY A REASON CODE CAN BE ABSENT: the brief lists MULTIPLE_PLAUSIBLE_IDENTITIES
 * as a candidate. No current scanner field carries a runner-up identity for a
 * single resolved garment — the V2 `conflicts` array is always emitted empty, and
 * `candidates` describes DIFFERENT garments in a multi-item image, not competing
 * readings of one garment. Implementing that code would mean inventing the signal
 * it claims to report, so it is deliberately not implemented.
 */

// @ts-ignore Deno local imports require explicit TypeScript extensions.
import { categorySubtypeConflict } from './scannerQualityGate.ts';
// @ts-ignore Deno local imports require explicit TypeScript extensions.
import { isGenericFashionLabel } from './qualityTuneNormalize.ts';
// @ts-ignore Deno local imports require explicit TypeScript extensions.
import { RECHECK_LOW_CONFIDENCE_THRESHOLD } from './identificationRecheckConfig.ts';

export type IdentificationGateDecision = 'CLEAR' | 'REVIEW_REQUIRED';

/**
 * Implemented reason codes.
 *
 * SUFFICIENT codes describe the garment identity itself being uncertain or
 * self-contradictory; any one of them escalates.
 *
 * CORROBORATING codes describe the model speculating about an ATTRIBUTE of the
 * garment (its brand, its material). They are recorded because they are real
 * signals of a speculative answer and are worth measuring, but they never spend
 * a provider call on their own — §6 is explicit that an unknown brand or a
 * missing attribute is not by itself a reason to escalate.
 */
export const RECHECK_SUFFICIENT_REASONS = [
  'LOW_IDENTITY_CONFIDENCE',
  'CATEGORY_TYPE_CONFLICT',
  'TYPE_SUBTYPE_CONFLICT',
  'AMBIGUOUS_SUBTYPE',
  'INSUFFICIENT_VISUAL_EVIDENCE',
] as const;

export const RECHECK_CORROBORATING_REASONS = [
  'BRAND_IDENTITY_CONFLICT',
  'MATERIAL_IDENTITY_CONFLICT',
] as const;

export type RecheckSufficientReason = typeof RECHECK_SUFFICIENT_REASONS[number];
export type RecheckCorroboratingReason = typeof RECHECK_CORROBORATING_REASONS[number];
export type RecheckReasonCode = RecheckSufficientReason | RecheckCorroboratingReason;

/** The taxonomy triple, as three independent assertions. */
export type IdentityTriple = {
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
};

export type IdentificationGateInput = {
  identity: IdentityTriple;
  /** The provider's single broad score. NULL means "not reported", never "low". */
  globalConfidence: number | null;
  /** Conflict codes already recorded by scannerQualityGate for this scan. */
  consistencyConflictCodes: string[];
  /** Band already computed by scannerQualityGate, when intelligence is enabled. */
  qualityBand: 'high' | 'moderate' | 'low' | null;
  /** Visual observations carried on the normalized result. */
  visualObservations: string[];
  /** True only for a classified, identity-bearing outcome. */
  identityBearing: boolean;
};

export type IdentificationGateResult = {
  decision: IdentificationGateDecision;
  /** Every reason observed, sufficient and corroborating, in stable order. */
  reasonCodes: RecheckReasonCode[];
  /** The subset that actually justified escalation. Empty when CLEAR. */
  triggeringReasonCodes: RecheckSufficientReason[];
};

function present(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A label that is present but carries no identifying power — "unknown", "item",
 * "fashion item". Treated as an ASSERTION THE MODEL DECLINED TO MAKE rather than
 * as a value, which is why it can signal ambiguity while a plain null cannot.
 */
function isVacuous(value: string | null): boolean {
  if (!present(value)) return false;
  const trimmed = value.trim();
  if (/^(unknown|n\/a|none|null|undefined|other)$/i.test(trimmed)) return true;
  return isGenericFashionLabel(trimmed);
}

/** Present AND meaningful — a real assertion about the garment. */
function isAsserted(value: string | null): value is string {
  return present(value) && !isVacuous(value);
}

/**
 * Evaluates the first-pass identity.
 *
 * CONSERVATIVE BY CONSTRUCTION. None of the following escalates on its own,
 * because none is evidence that the identity is WRONG — only that it is terse:
 *   - clothingType null            (the middle tier is frequently unreported)
 *   - subtype null                 (absence is not ambiguity)
 *   - brand unknown or absent
 *   - any optional attribute missing
 *   - a null confidence score      (unreported is not low)
 *   - anything at all about Product Match, similarity, or the Closet — none of
 *     which is even accepted as an input to this function
 */
export function evaluateIdentificationGate(
  input: IdentificationGateInput,
): IdentificationGateResult {
  const reasons = new Set<RecheckReasonCode>();

  // A non-identity-bearing outcome has no identity to correct. Re-asking the
  // same evidence cannot manufacture visual information that was not there, so
  // insufficient-evidence and non-fashion results are never escalated: that
  // would spend a call on a scan whose answer is already the honest one.
  if (!input.identityBearing) {
    return { decision: 'CLEAR', reasonCodes: [], triggeringReasonCodes: [] };
  }

  const { category, clothingType, subtype } = input.identity;

  // ── Contradiction between tiers ────────────────────────────────────────────
  // Real evidence that the identity disagrees with itself. Each pair is checked
  // only when BOTH of its members are actually asserted: a missing tier cannot
  // contradict anything.
  if (isAsserted(category) && isAsserted(clothingType)) {
    if (categorySubtypeConflict(category, clothingType)) {
      reasons.add('CATEGORY_TYPE_CONFLICT');
    }
  }
  if (isAsserted(clothingType) && isAsserted(subtype)) {
    if (categorySubtypeConflict(clothingType, subtype)) {
      reasons.add('TYPE_SUBTYPE_CONFLICT');
    }
  }
  // scannerQualityGate already detected and SUPPRESSED a category/subtype
  // conflict upstream, so the contradiction is no longer visible in the triple.
  // Its recorded code is the only surviving evidence that it happened.
  if (input.consistencyConflictCodes.includes('category_subtype_conflict')) {
    reasons.add('TYPE_SUBTYPE_CONFLICT');
  }

  // ── Uncertainty in the identity itself ─────────────────────────────────────
  // Strictly `!== null` first: an unreported score must never be read as 0.
  if (
    input.globalConfidence !== null &&
    input.globalConfidence <= RECHECK_LOW_CONFIDENCE_THRESHOLD
  ) {
    reasons.add('LOW_IDENTITY_CONFIDENCE');
  }

  // Asserted-but-vacuous specificity: the model produced a subtype slot filled
  // with a non-answer. That is ambiguity it reported, not detail it omitted —
  // which is exactly why a plain null subtype does NOT reach here.
  if (isAsserted(category) && isVacuous(subtype)) {
    reasons.add('AMBIGUOUS_SUBTYPE');
  }

  // A specific claim carrying no observation behind it. `visual_observation` is
  // the scanner's only record of what it actually saw, so a narrow assertion
  // made with an empty one is unsupported specificity at the source.
  const hasObservation = input.visualObservations.some((o) => present(o));
  if (!hasObservation && (isAsserted(subtype) || isAsserted(clothingType))) {
    reasons.add('INSUFFICIENT_VISUAL_EVIDENCE');
  }

  // ── Corroborating-only signals ─────────────────────────────────────────────
  // Recorded for telemetry; never sufficient. A suppressed brand or material
  // says the model speculated about an attribute, not that it misidentified the
  // garment.
  if (input.consistencyConflictCodes.includes('unsupported_brand')) {
    reasons.add('BRAND_IDENTITY_CONFLICT');
  }
  if (input.consistencyConflictCodes.includes('unsupported_material')) {
    reasons.add('MATERIAL_IDENTITY_CONFLICT');
  }

  // Stable, vocabulary-ordered output so telemetry can be grouped reliably.
  const ordered: RecheckReasonCode[] = [
    ...RECHECK_SUFFICIENT_REASONS.filter((code) => reasons.has(code)),
    ...RECHECK_CORROBORATING_REASONS.filter((code) => reasons.has(code)),
  ];
  const triggering = RECHECK_SUFFICIENT_REASONS.filter((code) => reasons.has(code));

  return {
    decision: triggering.length > 0 ? 'REVIEW_REQUIRED' : 'CLEAR',
    reasonCodes: ordered,
    triggeringReasonCodes: [...triggering],
  };
}

/**
 * Which request shapes may be rechecked at all.
 *
 * Detection is excluded because it answers "how many garments are here", not
 * "what is this garment" — §12 requires the recheck to attach to the RESOLVED
 * garment, and during detection none has been resolved yet. Text mode is
 * excluded because there is no scan evidence to look at again.
 */
export type RecheckEligibleMode = 'legacy_single_item' | 'selected_item';

export function isRecheckEligibleMode(
  requestMode: string,
): requestMode is RecheckEligibleMode {
  return requestMode === 'legacy_single_item' || requestMode === 'selected_item';
}
