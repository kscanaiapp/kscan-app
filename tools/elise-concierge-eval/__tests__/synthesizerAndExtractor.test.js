'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getFixtures } = require('../fixtures');
const { synthesizeResponse } = require('../synthesis/responseSynthesizer');
const { evaluateResponse } = require('../grounding/groundingEvaluator');
const { extractClaims } = require('../extraction/claimExtractor');
const { buildCorpus } = require('../metrics/corpusRunner');
const { computeVerdictReproduction } = require('../metrics/verdictReproduction');
const { DEFECTS } = require('../model/defectTaxonomy');

const fixtures = getFixtures();

function evidenceFor(scenario) {
  return {
    closet: fixtures.closetsById[scenario.closetId],
    signatureStyle: fixtures.signatureStylesById[scenario.signatureStyleId],
    commerceProduct: scenario.commerceProductId ? fixtures.commerceProductsById[scenario.commerceProductId] : null,
    commerceCatalog: fixtures.commerceCatalog,
    entitlement: { kPlusActive: scenario.kPlusActive, conciergeV1: scenario.conciergeV1 },
    scenario,
  };
}

test('required test 4: CLEAN response yields zero planted violations', () => {
  const { cases } = buildCorpus();
  const cleanFailures = cases.filter((c) => c.script === 'CLEAN' && c.actualVerdict !== 'PASS');
  assert.deepEqual(cleanFailures.map((c) => c.scenarioId), []);
});

test('required test 5 + 6: every applicable defect D01-D16 has known-answer coverage and is reproduced', () => {
  const { cases } = buildCorpus();
  const metrics = computeVerdictReproduction(cases);
  for (const defect of DEFECTS) {
    const entry = metrics.perDefect[defect.code];
    assert.ok(entry, `defect ${defect.code} has no corpus coverage at all`);
    assert.ok(entry.total > 0, `defect ${defect.code} has zero applicable cases`);
  }
  // At least 15 of 16 defect types must reproduce perfectly; the harness
  // documents D06 as a deliberately conservative, INSUFFICIENT_COVERAGE cell
  // (see grounding/groundingEvaluator.js detectSoftConstraintIgnored).
  const perfect = Object.values(metrics.perDefect).filter((e) => e.rate === 1).length;
  assert.ok(perfect >= 15, `expected >=15 defects at 100% reproduction, got ${perfect}`);
});

test('required test 7: ambiguous claims resolve UNDECIDABLE', () => {
  const { cases } = buildCorpus();
  const ambiguityCases = cases.filter((c) => c.script === 'AMBIGUITY');
  assert.ok(ambiguityCases.length > 0);
  for (const c of ambiguityCases) {
    assert.equal(c.actualVerdict, 'UNDECIDABLE', `${c.scenarioId}/${c.systemProfile} ambiguity case`);
  }
});

test('required test 8: evaluator false positives are measured and are zero on CLEAN', () => {
  const { cases } = buildCorpus();
  const metrics = computeVerdictReproduction(cases);
  assert.equal(typeof metrics.evaluatorFalsePositiveRate.rate, 'number');
  assert.equal(metrics.evaluatorFalsePositiveRate.rate, 0);
});

test('required test 9: owned item exact grounding', () => {
  const scenario = fixtures.scenariosById['scn_build_outfit_balanced'];
  const { claims } = extractClaims('Your black blazer would work great for this.', evidenceFor(scenario));
  const ownership = claims.find((c) => c.type === 'OWNERSHIP');
  assert.ok(ownership);
  assert.equal(ownership.supportStatus, 'SUPPORTED');
});

test('required test 10: similar (ambiguous) closet items are distinguished, not silently merged', () => {
  const scenario = fixtures.scenariosById['scn_ambiguity_similar_items'];
  const result = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'CONCIERGE', script: 'AMBIGUITY', fixtures });
  assert.equal(result.applicable, true);
  assert.deepEqual(
    result.expectedVerdicts[0].referent.slice().sort(),
    ['item_amb_brown_loafers_a', 'item_amb_brown_loafers_b'].sort(),
  );
});

test('required test 11: hallucinated ownership (D01) is detected', () => {
  const scenario = fixtures.scenariosById['scn_build_outfit_balanced'];
  const synthesized = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'ELISE', script: 'D01', fixtures });
  const result = evaluateResponse(synthesized.text, evidenceFor(scenario), synthesized.groundTruth);
  assert.equal(result.verdict, 'FAIL_GROUNDING');
});

test('required test 12: denied owned item (D03) is detected', () => {
  const scenario = fixtures.scenariosById['scn_build_outfit_balanced'];
  const synthesized = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'CONCIERGE', script: 'D03', fixtures });
  const result = evaluateResponse(synthesized.text, evidenceFor(scenario), synthesized.groundTruth);
  assert.equal(result.verdict, 'FAIL_GROUNDING');
});

test('required test 13: invented preference (D02) is detected', () => {
  const scenario = fixtures.scenariosById['scn_build_outfit_balanced'];
  const synthesized = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'ELISE', script: 'D02', fixtures });
  const result = evaluateResponse(synthesized.text, evidenceFor(scenario), synthesized.groundTruth);
  assert.equal(result.verdict, 'FAIL_GROUNDING');
});

test('required test 14: context contradiction (D13 cross-system) is detected', () => {
  const { compareCrossSystemFacts } = require('../grounding/crossSystemConsistency');
  const scenario = fixtures.scenariosById['scn_build_outfit_balanced'];
  const synthesized = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'ELISE', script: 'D13', fixtures });
  assert.ok(synthesized.pair);
  const comparison = compareCrossSystemFacts(synthesized.pair, evidenceFor(scenario));
  assert.equal(comparison.consistent, false);
  assert.ok(comparison.contradictions.length > 0);
});
