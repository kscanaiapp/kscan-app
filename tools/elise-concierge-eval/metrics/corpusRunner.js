'use strict';

/**
 * Builds the full synthetic corpus (every scenario x systemProfile x script
 * cell, per spec section 20 "minimum useful coverage" -- not a blind
 * Cartesian product padded with impossible cases) and runs the grounding
 * evaluator over it, BLIND to the synthesizer's expected verdict, then joins
 * the two for scoring. D13 is handled separately because it produces a
 * response PAIR rather than single text.
 */

const { getFixtures } = require('../fixtures');
const { synthesizeResponse, SYSTEM_PROFILES } = require('../synthesis/responseSynthesizer');
const { evaluateResponse } = require('../grounding/groundingEvaluator');
const { compareCrossSystemFacts } = require('../grounding/crossSystemConsistency');
const { DEFECTS } = require('../model/defectTaxonomy');

const SCRIPTS = ['CLEAN', 'AMBIGUITY', ...DEFECTS.map((d) => d.code)];

function evidenceFor(scenario, fixtures) {
  return {
    closet: fixtures.closetsById[scenario.closetId],
    signatureStyle: fixtures.signatureStylesById[scenario.signatureStyleId],
    commerceProduct: scenario.commerceProductId ? fixtures.commerceProductsById[scenario.commerceProductId] : null,
    commerceCatalog: fixtures.commerceCatalog,
    entitlement: { kPlusActive: scenario.kPlusActive, conciergeV1: scenario.conciergeV1 },
    scenario,
  };
}

/**
 * @param {object} [options] - extraction tolerance options forwarded to the evaluator
 * @returns {{ cases: object[], skipped: object[] }}
 */
function buildCorpus(options = {}) {
  const fixtures = getFixtures();
  const cases = [];
  const skipped = [];

  for (const scenario of fixtures.scenarios) {
    for (const systemProfile of SYSTEM_PROFILES) {
      for (const script of SCRIPTS) {
        const synthesized = synthesizeResponse({ scenarioId: scenario.id, systemProfile, script, fixtures });
        if (!synthesized.applicable) {
          skipped.push({ scenarioId: scenario.id, systemProfile, script, reason: synthesized.reason });
          continue;
        }

        const evidence = evidenceFor(scenario, fixtures);

        if (synthesized.pair) {
          // D13: pair-shaped, scored via cross-system comparison, not the
          // single-text grounding evaluator.
          const comparison = compareCrossSystemFacts(synthesized.pair, evidence);
          const actualVerdict = comparison.consistent ? 'PASS' : 'FAIL_CROSS_SYSTEM_CONSISTENCY';
          cases.push({
            scenarioId: scenario.id,
            systemProfile,
            script,
            taskId: scenario.taskId,
            expectedVerdict: synthesized.expectedVerdicts[0].verdict,
            actualVerdict,
            pair: synthesized.pair,
            comparison,
            groundTruth: synthesized.groundTruth,
          });
          continue;
        }

        const result = evaluateResponse(synthesized.text, evidence, synthesized.groundTruth, options);
        cases.push({
          scenarioId: scenario.id,
          systemProfile,
          script,
          taskId: scenario.taskId,
          text: synthesized.text,
          expectedVerdict: synthesized.expectedVerdicts[0].verdict,
          actualVerdict: result.verdict,
          findings: result.findings,
          claims: result.claims,
          groundTruth: synthesized.groundTruth,
        });
      }
    }
  }

  return { cases, skipped };
}

module.exports = { buildCorpus, SCRIPTS, evidenceFor };
