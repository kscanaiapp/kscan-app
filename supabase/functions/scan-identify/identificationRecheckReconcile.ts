/**
 * Deterministic reconciliation of PRIMARY vs RECHECK into a canonical identity
 * (Phase 7.1 §10).
 *
 * Pure and synchronous. The second pass never wins by default: it wins only
 * where it is both SUPPORTED and STRUCTURALLY ENTITLED to speak. Everything here
 * is biased toward the promotion metric this build is judged on —
 * incorrect→correct minus correct→incorrect — which means a rule that would
 * gain a correction at the cost of an equally likely reversal is not worth
 * having, and abstention beats a coin flip.
 *
 * THE THREE TIERS ARE INDEPENDENT ASSERTIONS. No rule in this file ever copies a
 * value from one tier into another in either direction.
 */

// @ts-ignore Deno local imports require explicit TypeScript extensions.
import { categorySubtypeConflict } from './scannerQualityGate.ts';
// @ts-ignore Deno local imports require explicit TypeScript extensions.
import { isGenericFashionLabel } from './qualityTuneNormalize.ts';
import type { IdentityTriple, RecheckReasonCode } from './identificationRecheckGate.ts';
import {
  RECHECK_CORRECTION_SUPPORT_THRESHOLD,
  RECHECK_NEW_SPECIFICITY_SUPPORT_THRESHOLD,
  // @ts-ignore Deno local imports require explicit TypeScript extensions.
} from './identificationRecheckConfig.ts';

/** Ordered broad → narrow. Index doubles as the tier depth. */
export const IDENTITY_TIERS = ['category', 'clothingType', 'subtype'] as const;
export type IdentityTier = typeof IDENTITY_TIERS[number];

export type FieldOutcome =
  /** Both passes said the same thing. */
  | 'agreed'
  /** Primary said nothing meaningful and the recheck was not entitled to speak. */
  | 'both_absent'
  /** Recheck declined; a declined answer is not evidence against the primary. */
  | 'retained_recheck_abstained'
  /** Recheck contradicted a confident primary without the support to unseat it. */
  | 'retained_primary_supported'
  /** Recheck contradicted a tier the gate never flagged. Not its question to answer. */
  | 'retained_not_disputed'
  /** Recheck filled a blank, with support and within one tier of what was known. */
  | 'accepted_supported_specificity'
  /** Recheck filled a blank it had not earned. Left blank. */
  | 'rejected_unsupported_specificity'
  /** Recheck resolved a flagged inconsistency with stronger support. */
  | 'corrected'
  /** Two plausible values, neither establishable. Left uncertain. */
  | 'abstained_unresolved_conflict'
  /** Survived per-field logic but broke the hierarchy. Narrower tier dropped. */
  | 'dropped_incoherent';

export type ReconciliationFieldResult = {
  tier: IdentityTier;
  primary: string | null;
  recheck: string | null;
  final: string | null;
  outcome: FieldOutcome;
};

export type ReconciliationInput = {
  primary: IdentityTriple;
  recheck: IdentityTriple;
  /** The provider's broad score for the first pass. NULL means unreported. */
  primaryConfidence: number | null;
  /** The recheck's own score. NULL means unreported — never treated as support. */
  recheckConfidence: number | null;
  /** Reasons the gate escalated. Only a flagged field may be overwritten. */
  reasonCodes: RecheckReasonCode[];
};

export type ReconciliationResult = {
  final: IdentityTriple;
  fields: ReconciliationFieldResult[];
  identityChanged: boolean;
  /** Tiers whose final value differs from the primary. */
  fieldsChanged: IdentityTier[];
};

function present(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isVacuous(value: string | null): boolean {
  if (!present(value)) return false;
  const trimmed = value.trim();
  if (/^(unknown|n\/a|none|null|undefined|other)$/i.test(trimmed)) return true;
  return isGenericFashionLabel(trimmed);
}

/** A real assertion about the garment, as opposed to a filled-in non-answer. */
function isAsserted(value: string | null): value is string {
  return present(value) && !isVacuous(value);
}

/** Comparison is case- and separator-insensitive: `wide_leg_jeans` === `Wide Leg Jeans`. */
function sameLabel(a: string, b: string): boolean {
  const canon = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  return canon(a) === canon(b);
}

/**
 * Which tiers each reason code calls into question.
 *
 * A field the gate did NOT flag is not up for correction: the recheck was asked
 * about a specific dispute, and letting it rewrite an unrelated, unchallenged
 * field is how a second opinion turns into a second guess.
 */
const REASON_IMPLICATED_TIERS: Record<RecheckReasonCode, IdentityTier[]> = {
  LOW_IDENTITY_CONFIDENCE: ['category', 'clothingType', 'subtype'],
  CATEGORY_TYPE_CONFLICT: ['category', 'clothingType'],
  TYPE_SUBTYPE_CONFLICT: ['clothingType', 'subtype'],
  AMBIGUOUS_SUBTYPE: ['subtype'],
  INSUFFICIENT_VISUAL_EVIDENCE: ['clothingType', 'subtype'],
  // Attribute-level speculation. It never licenses rewriting the garment's
  // taxonomy, so it implicates no tier.
  BRAND_IDENTITY_CONFLICT: [],
  MATERIAL_IDENTITY_CONFLICT: [],
};

function isTierImplicated(tier: IdentityTier, reasonCodes: RecheckReasonCode[]): boolean {
  return reasonCodes.some((code) => (REASON_IMPLICATED_TIERS[code] ?? []).includes(tier));
}

/** Deepest tier index the primary actually asserted; -1 if it asserted none. */
function deepestAssertedIndex(triple: IdentityTriple): number {
  let deepest = -1;
  IDENTITY_TIERS.forEach((tier, index) => {
    if (isAsserted(triple[tier])) deepest = index;
  });
  return deepest;
}

/**
 * Does the recheck agree with everything the primary actually claimed?
 *
 * This is the corroboration test that earns the recheck the right to ADD detail.
 * A second pass that disagrees about what the garment broadly is has not
 * confirmed the primary — it has proposed a different item, and its extra
 * specificity is about that different item rather than about this one.
 */
function corroboratesAssertedTiers(input: ReconciliationInput): boolean {
  for (const tier of IDENTITY_TIERS) {
    const primaryValue = input.primary[tier];
    if (!isAsserted(primaryValue)) continue;
    const recheckValue = input.recheck[tier];
    // Silence is not disagreement: the recheck may simply not have restated it.
    if (!isAsserted(recheckValue)) continue;
    if (!sameLabel(primaryValue, recheckValue)) return false;
  }
  return true;
}

export function reconcileIdentification(
  input: ReconciliationInput,
): ReconciliationResult {
  const recheckSupport = input.recheckConfidence;
  const corroborates = corroboratesAssertedTiers(input);
  const primaryDeepest = deepestAssertedIndex(input.primary);

  const fields: ReconciliationFieldResult[] = IDENTITY_TIERS.map((tier, tierIndex) => {
    const primaryValue = input.primary[tier];
    const recheckValue = input.recheck[tier];
    const primaryAsserted = isAsserted(primaryValue);
    const recheckAsserted = isAsserted(recheckValue);

    const base = { tier, primary: primaryValue, recheck: recheckValue };

    // Neither pass committed to anything. Stay uncertain.
    if (!primaryAsserted && !recheckAsserted) {
      return { ...base, final: null, outcome: 'both_absent' as const };
    }

    // The recheck had nothing to say here. Silence is not a refutation.
    if (primaryAsserted && !recheckAsserted) {
      return {
        ...base,
        final: primaryValue,
        outcome: 'retained_recheck_abstained' as const,
      };
    }

    // ── New specificity: the recheck wants to fill a blank ──────────────────
    if (!primaryAsserted && recheckAsserted) {
      // A populated field is not evidence. Three independent conditions must
      // ALL hold, and the structural one cannot be bought with confidence:
      //
      //  1. explicit support at or above the new-specificity floor;
      //  2. agreement with everything the primary did claim;
      //  3. at most ONE tier deeper than the deepest tier already established.
      //
      // (3) is what stops a second pass from leaping over an unestablished
      // middle tier — naming a precise subtype for a garment whose family was
      // never determined is a guess dressed as a refinement, however
      // confidently it is stated.
      const supported = recheckSupport !== null &&
        recheckSupport >= RECHECK_NEW_SPECIFICITY_SUPPORT_THRESHOLD;
      const withinOneTier = tierIndex <= primaryDeepest + 1;

      if (supported && corroborates && withinOneTier) {
        return {
          ...base,
          final: recheckValue,
          outcome: 'accepted_supported_specificity' as const,
        };
      }
      return {
        ...base,
        final: null,
        outcome: 'rejected_unsupported_specificity' as const,
      };
    }

    // ── Both asserted ──────────────────────────────────────────────────────
    if (primaryAsserted && recheckAsserted && sameLabel(primaryValue, recheckValue)) {
      // Agreement retains the PRIMARY spelling, so a rechecked scan and an
      // identical un-rechecked scan cannot produce different strings.
      return { ...base, final: primaryValue, outcome: 'agreed' as const };
    }

    // Genuine disagreement.
    const implicated = isTierImplicated(tier, input.reasonCodes);

    // A tier the gate never disputed is not in play. The recheck was asked
    // about a specific uncertainty; drifting onto an unchallenged tier is the
    // second pass changing the subject, not answering the question.
    //
    // RETAINED, NOT ABSTAINED. Abstention is the honest answer for a field whose
    // dispute could not be settled — but nobody disputed this one, so blanking
    // it would manufacture a correct→unknown reversal out of the recheck's own
    // wandering. That is precisely the movement the promotion metric punishes.
    if (!implicated) {
      return { ...base, final: primaryValue, outcome: 'retained_not_disputed' as const };
    }

    const recheckStrong = recheckSupport !== null &&
      recheckSupport >= RECHECK_CORRECTION_SUPPORT_THRESHOLD &&
      (input.primaryConfidence === null || recheckSupport > input.primaryConfidence);

    // Supported correction: the gate identified this tier as disputed AND the
    // recheck answers it with strictly stronger support than the first pass.
    if (recheckStrong) {
      return { ...base, final: recheckValue, outcome: 'corrected' as const };
    }

    // A confident primary is not unseated by an unsupported contradiction.
    const primaryStrong = input.primaryConfidence !== null &&
      input.primaryConfidence >= RECHECK_CORRECTION_SUPPORT_THRESHOLD;
    if (primaryStrong && !recheckStrong) {
      return {
        ...base,
        final: primaryValue,
        outcome: 'retained_primary_supported' as const,
      };
    }

    // Two plausible values and nothing to separate them. Overwriting would be a
    // coin flip and retaining would be pretending the conflict did not happen,
    // so the contract's uncertainty value is the honest answer.
    return {
      ...base,
      final: null,
      outcome: 'abstained_unresolved_conflict' as const,
    };
  });

  // ── Hierarchical coherence ─────────────────────────────────────────────────
  // Applied broad → narrow over the surviving values. When an adjacent pair
  // contradicts, the NARROWER tier is dropped: the broader assertion is the
  // better-supported one, and dropping it instead would leave a specific label
  // orphaned under a category that was never established. Nothing is ever
  // copied between tiers to force agreement.
  const byTier = new Map<IdentityTier, ReconciliationFieldResult>(
    fields.map((f) => [f.tier, f]),
  );
  for (let i = 1; i < IDENTITY_TIERS.length; i += 1) {
    const narrower = byTier.get(IDENTITY_TIERS[i])!;
    if (!isAsserted(narrower.final)) continue;
    // Compare against the nearest surviving broader tier, so a dropped middle
    // tier still leaves category↔subtype checked rather than silently unpaired.
    let broaderValue: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = byTier.get(IDENTITY_TIERS[j])!.final;
      if (isAsserted(candidate)) {
        broaderValue = candidate;
        break;
      }
    }
    if (broaderValue === null) continue;
    if (categorySubtypeConflict(broaderValue, narrower.final as string)) {
      byTier.set(IDENTITY_TIERS[i], {
        ...narrower,
        final: null,
        outcome: 'dropped_incoherent',
      });
    }
  }

  const resolved = IDENTITY_TIERS.map((tier) => byTier.get(tier)!);
  const final: IdentityTriple = {
    category: resolved[0].final,
    clothingType: resolved[1].final,
    subtype: resolved[2].final,
  };

  // "Changed" is measured against what the primary would have delivered. A
  // primary value that was vacuous ("unknown") and a final null are the same
  // absence of an assertion, so that is not counted as a change.
  const fieldsChanged = resolved
    .filter((f) => {
      const before = isAsserted(f.primary) ? f.primary : null;
      const after = isAsserted(f.final) ? f.final : null;
      if (before === null && after === null) return false;
      if (before === null || after === null) return true;
      return !sameLabel(before, after);
    })
    .map((f) => f.tier);

  return {
    final,
    fields: resolved,
    identityChanged: fieldsChanged.length > 0,
    fieldsChanged,
  };
}
