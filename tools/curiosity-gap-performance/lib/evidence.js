'use strict';
/**
 * Evidence classes — the load-bearing honesty rule of this lab.
 *
 * WHY THIS EXISTS: a performance lab that cannot generate live traffic will
 * always be tempted to present an assumption as a measurement. Every timing
 * fact in this lab carries exactly one evidence class, and the three classes
 * are never allowed to merge silently:
 *
 *   PROVEN   — directly demonstrable from source at the bound SHA. Timeout
 *              constants, await order, fan-in shape, compression quality,
 *              transport encoding, response gating, render guards.
 *   OBSERVED — derived from evidence ALREADY COMMITTED to this repository
 *              before this lane started. No new traffic was generated to get
 *              it. Requires an exact provenance string (file + locator).
 *   MODELED  — a synthetic assumption the structural model consumes. Never a
 *              measurement. Must carry a provenance rationale and must survive
 *              a sweep, not a single point value.
 *
 * The one rule that matters: a MODELED input can never be relabelled by
 * arithmetic. Any derived value whose inputs include a MODELED term is itself
 * MODELED. `combineEvidence` is the only sanctioned way to derive a class.
 */

const EVIDENCE_CLASSES = Object.freeze(['PROVEN', 'OBSERVED', 'MODELED']);

/** Strength order for combination: the weakest input wins. */
const STRENGTH = Object.freeze({ PROVEN: 3, OBSERVED: 2, MODELED: 1 });

function isEvidenceClass(value) {
  return typeof value === 'string' && EVIDENCE_CLASSES.includes(value);
}

function assertEvidenceClass(value, context) {
  if (!isEvidenceClass(value)) {
    throw new TypeError(
      `evidence class must be one of ${EVIDENCE_CLASSES.join('|')}, got ${JSON.stringify(value)}` +
        (context ? ` (${context})` : ''),
    );
  }
  return value;
}

/**
 * Derive the evidence class of a value computed from several inputs.
 *
 * Deliberately pessimistic: mixing a PROVEN timeout with a MODELED provider
 * latency yields MODELED, never "mostly proven". This is the function that
 * stops the lab laundering assumptions into measurements.
 */
function combineEvidence(classes) {
  if (!Array.isArray(classes) || classes.length === 0) {
    throw new TypeError('combineEvidence requires a non-empty array of evidence classes');
  }
  let weakest = 'PROVEN';
  for (const c of classes) {
    assertEvidenceClass(c, 'combineEvidence input');
    if (STRENGTH[c] < STRENGTH[weakest]) weakest = c;
  }
  return weakest;
}

/**
 * An evidence-tagged fact. `provenance` is mandatory for OBSERVED and MODELED
 * because an unattributed observation is indistinguishable from an invention.
 */
function fact(value, evidenceClass, provenance) {
  assertEvidenceClass(evidenceClass, 'fact()');
  if (evidenceClass !== 'PROVEN' && (typeof provenance !== 'string' || provenance.trim() === '')) {
    throw new TypeError(`${evidenceClass} facts require a non-empty provenance string`);
  }
  if (evidenceClass === 'PROVEN' && (typeof provenance !== 'string' || provenance.trim() === '')) {
    throw new TypeError('PROVEN facts require a source locator as provenance (file:line)');
  }
  return Object.freeze({ value, evidence_class: evidenceClass, provenance });
}

/**
 * Guard used by the report writers: a timing number may only be described with
 * the word "measured" when it is OBSERVED or PROVEN. MODELED numbers must be
 * rendered with the MODELED label attached.
 */
function assertNotPresentedAsMeasurement(evidenceClass, label) {
  if (evidenceClass === 'MODELED') {
    throw new Error(
      `refusing to present a MODELED value as a measurement: ${label}. ` +
        'Label it MODELED and show its assumptions adjacent.',
    );
  }
  return true;
}

module.exports = {
  EVIDENCE_CLASSES,
  isEvidenceClass,
  assertEvidenceClass,
  combineEvidence,
  fact,
  assertNotPresentedAsMeasurement,
};
