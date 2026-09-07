'use strict';

/**
 * PRIMARY V1 RESULTS — spec section 27 (EXTRACTOR VALIDATION).
 *
 * VERDICT_REPRODUCTION_RATE: overall + per defect type -- did the evaluator's
 *   actualVerdict match the synthesizer's known expectedVerdict?
 * EVALUATOR_FALSE_POSITIVE_RATE: rate at which CLEAN (script === 'CLEAN')
 *   cases were NOT scored PASS -- the mandatory negative control.
 * UNDECIDABLE_ACCURACY: rate at which AMBIGUITY-script cases were correctly
 *   scored UNDECIDABLE.
 *
 * A detector that flags every response fails (false-positive rate too high);
 * a detector that misses planted defects fails (reproduction rate too low).
 * Both are reported, neither is hidden behind an average.
 */

function computeVerdictReproduction(cases) {
  const byDefect = {}; // code -> { total, matched }
  let overallTotal = 0;
  let overallMatched = 0;

  let cleanTotal = 0;
  let cleanFalsePositive = 0;

  let ambiguityTotal = 0;
  let ambiguityCorrect = 0;

  for (const c of cases) {
    const matched = c.actualVerdict === c.expectedVerdict;

    if (c.script === 'CLEAN') {
      cleanTotal += 1;
      if (c.actualVerdict !== 'PASS') cleanFalsePositive += 1;
      continue; // CLEAN is scored separately (false-positive rate), not folded into per-defect reproduction
    }

    if (c.script === 'AMBIGUITY') {
      ambiguityTotal += 1;
      if (c.actualVerdict === 'UNDECIDABLE') ambiguityCorrect += 1;
      continue;
    }

    overallTotal += 1;
    if (matched) overallMatched += 1;

    if (!byDefect[c.script]) byDefect[c.script] = { total: 0, matched: 0 };
    byDefect[c.script].total += 1;
    if (matched) byDefect[c.script].matched += 1;
  }

  const perDefect = {};
  for (const [code, { total, matched }] of Object.entries(byDefect)) {
    perDefect[code] = { total, matched, rate: total ? Number((matched / total).toFixed(4)) : null };
  }

  return {
    overall: {
      total: overallTotal,
      matched: overallMatched,
      rate: overallTotal ? Number((overallMatched / overallTotal).toFixed(4)) : null,
    },
    perDefect,
    evaluatorFalsePositiveRate: {
      total: cleanTotal,
      falsePositives: cleanFalsePositive,
      rate: cleanTotal ? Number((cleanFalsePositive / cleanTotal).toFixed(4)) : null,
    },
    undecidableAccuracy: {
      total: ambiguityTotal,
      correct: ambiguityCorrect,
      rate: ambiguityTotal ? Number((ambiguityCorrect / ambiguityTotal).toFixed(4)) : null,
    },
  };
}

module.exports = { computeVerdictReproduction };
