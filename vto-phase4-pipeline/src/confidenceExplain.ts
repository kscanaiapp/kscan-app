import type { ConfidenceComponents } from './types';

/**
 * Phase 4.2 §22-§23: every confidence-based terminal decision must expose
 * WHICH component limited it and what that component measured. Phase 4.1's
 * Gate E baseline could only report `EXTRACTION_UNRELIABLE: aggregate
 * confidence 0.42 is below the eligibility threshold` — which is precisely
 * the "aggregate confidence failed" non-answer §22 forbids. Two of the four
 * original EASY failures were unattributable for exactly this reason (see
 * docs/vto-phase4-2-addressability.md, ORIGINAL EASY CASES).
 *
 * This module is the SINGLE place component coercion happens. `eligibility.
 * overallConfidence` delegates here so that the explanation and the gate can
 * never disagree — a diagnostic that reports a different limiting value than
 * the number the gate actually used would be worse than no diagnostic.
 */

/**
 * The six component scores, in a fixed order. Named explicitly so that a
 * component which is missing entirely (rather than merely low) is still
 * examined instead of being skipped.
 */
export const CONFIDENCE_COMPONENT_KEYS = [
  'shotClassification',
  'segmentation',
  'anchorCompleteness',
  'geometryValidity',
  'sourceQuality',
  'productFidelity',
] as const satisfies readonly (keyof ConfidenceComponents)[];

export type ConfidenceComponentKey = (typeof CONFIDENCE_COMPONENT_KEYS)[number];

/** Why a component's raw value was not usable as-is. `null` when it was well-formed. */
export type MalformedReason =
  | 'ABSENT'
  | 'NOT_A_NUMBER'
  | 'NAN'
  | 'INFINITE'
  | 'BELOW_RANGE'
  | 'ABOVE_RANGE';

export interface ConfidenceComponentDetail {
  key: ConfidenceComponentKey;
  /** The coerced score actually used by the gate. Always a finite number in [0,1]. */
  score: number;
  /**
   * A sanitized rendering of what was actually present, so a hostile audit
   * can distinguish "measured 0.0" from "was `undefined`" from "was `NaN`" —
   * three very different defects that Phase 4.1 collapsed into one.
   */
  observed: string;
  /** Null when the raw value was a finite number within [0,1]. */
  malformedReason: MalformedReason | null;
}

export interface ConfidenceExplanation {
  overall: number;
  /**
   * Every component tied at the minimum, in `CONFIDENCE_COMPONENT_KEYS`
   * order. Plural because ties are common and real: a HARD rejection
   * typically zeroes segmentation, anchorCompleteness, geometryValidity and
   * productFidelity simultaneously, and naming only the first would
   * misattribute a four-way structural failure to one stage.
   */
  limitingComponents: ConfidenceComponentKey[];
  /** Convenience alias for `limitingComponents[0]` (§23 permits either shape). */
  limitingComponent: ConfidenceComponentKey;
  components: ConfidenceComponentDetail[];
  /** Components whose raw value was not a finite number in [0,1]. Non-empty means the item failed CLOSED. */
  malformedComponents: ConfidenceComponentKey[];
}

/**
 * Classifies a raw component value, returning the fail-closed score and the
 * reason it was unusable (if any). A component that is absent, `NaN`,
 * `Infinity`, negative, above 1, or not a number at all scores 0 — never an
 * absent constraint (Phase 4.1 GATE-E-INT-001, preserved verbatim here and
 * regression-tested in eligibility.test.ts / confidenceExplain.test.ts).
 */
function classifyComponent(key: ConfidenceComponentKey, raw: unknown): ConfidenceComponentDetail {
  const wellFormed = (score: number): ConfidenceComponentDetail => ({
    key,
    score,
    observed: String(score),
    malformedReason: null,
  });
  const malformed = (reason: MalformedReason, observed: string): ConfidenceComponentDetail => ({
    key,
    score: 0,
    observed,
    malformedReason: reason,
  });

  if (raw === undefined) return malformed('ABSENT', 'undefined');
  if (raw === null) return malformed('ABSENT', 'null');
  if (typeof raw !== 'number') return malformed('NOT_A_NUMBER', `${typeof raw}`);
  if (Number.isNaN(raw)) return malformed('NAN', 'NaN');
  if (!Number.isFinite(raw)) return malformed('INFINITE', raw > 0 ? 'Infinity' : '-Infinity');
  if (raw < 0) return malformed('BELOW_RANGE', String(raw));
  if (raw > 1) return malformed('ABOVE_RANGE', String(raw));
  return wellFormed(raw);
}

export function explainConfidence(components: ConfidenceComponents): ConfidenceExplanation {
  const details = CONFIDENCE_COMPONENT_KEYS.map((key) =>
    classifyComponent(key, (components as unknown as Record<string, unknown> | null | undefined)?.[key]),
  );

  let overall = 1;
  for (const d of details) if (d.score < overall) overall = d.score;

  // Strict equality against the computed minimum is safe here: `overall` is
  // literally one of the `score` values (assigned, not recomputed), so no
  // floating-point drift can occur between the two.
  const limitingComponents = details.filter((d) => d.score === overall).map((d) => d.key);

  return {
    overall,
    limitingComponents,
    limitingComponent: limitingComponents[0],
    components: details,
    malformedComponents: details.filter((d) => d.malformedReason !== null).map((d) => d.key),
  };
}
