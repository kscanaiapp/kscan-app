'use strict';

/**
 * COVERAGE SUPPRESSION — spec section 20: "Metrics from an under-covered
 * cell are suppressed as INSUFFICIENT_COVERAGE (do not average into a
 * headline number)."
 *
 * D06 SOFT_CONSTRAINT_IGNORED is the concrete instance in this corpus: the
 * grounding evaluator's detectSoftConstraintIgnored (grounding/
 * groundingEvaluator.js) deliberately checks ONLY an explicit
 * scenario.softConstraints signal, not the Signature Style preference
 * fallback the defect injector uses when no explicit soft constraint exists
 * (to avoid false-positiving the CLEAN negative control -- see that
 * module's comments). That means every D06 case built from the preference
 * fallback has NO detector coverage at all, by design, not by omission --
 * and must be reported as INSUFFICIENT_COVERAGE and excluded from the
 * headline VERDICT_REPRODUCTION_RATE rather than silently averaged in as a
 * failure.
 */

function isD06ExplicitCoverageCase(corpusCase, scenariosById) {
  if (corpusCase.script !== 'D06') return true; // rule only applies to D06
  const manifest = corpusCase.injectedDefectManifest;
  if (!manifest || !manifest.plantedClaim) return true;
  const scenario = scenariosById[corpusCase.scenarioId];
  const explicitSignal = scenario.softConstraints && scenario.softConstraints[0];
  return Boolean(explicitSignal) && manifest.plantedClaim.referent === explicitSignal;
}

/**
 * @returns {{ suppressed: object[], covered: object[], suppressionNotes: string[] }}
 */
function partitionSuppressedCases(cases, scenariosById) {
  const suppressed = [];
  const covered = [];
  for (const c of cases) {
    if (isD06ExplicitCoverageCase(c, scenariosById)) covered.push(c);
    else suppressed.push(c);
  }
  const suppressionNotes = suppressed.length
    ? [
        `INSUFFICIENT_COVERAGE: ${suppressed.length} D06 SOFT_CONSTRAINT_IGNORED case(s) built from the Signature Style preference fallback (no explicit scenario.softConstraints signal) have no detector coverage by design and are EXCLUDED from the headline VERDICT_REPRODUCTION_RATE. See grounding/groundingEvaluator.js detectSoftConstraintIgnored and metrics/coverageSuppression.js.`,
      ]
    : [];
  return { suppressed, covered, suppressionNotes };
}

module.exports = { isD06ExplicitCoverageCase, partitionSuppressedCases };
