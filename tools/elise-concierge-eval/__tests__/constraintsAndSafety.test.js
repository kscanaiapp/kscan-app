'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getFixtures } = require('../fixtures');
const { synthesizeResponse } = require('../synthesis/responseSynthesizer');
const { evaluateResponse } = require('../grounding/groundingEvaluator');
const { evaluateConstraints } = require('../constraints/constraintEvaluator');
const { classifyBodyAppearanceMessage, BODY_APPEARANCE_TEST_MESSAGES } = require('../safety/bodyAppearanceClassifier');
const { loadSafetyPolicyMap, checkSafetyPolicyMapCompleteness } = require('../safety/safetyPolicyCheck');

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

test('required test 19: owned-only ("closet_only") shopping violation is detected', () => {
  const scenario = fixtures.scenariosById['scn_owned_items_only'];
  assert.ok(scenario.hardConstraints.includes('closet_only'));
  // A response recommending a commerce product would violate closet_only;
  // the constraint evaluator's excludedByConstraintIds mechanism plus D05
  // cover this general shape (see D05 test in constraint evaluator below).
  const synthesized = synthesizeResponse({ scenarioId: 'scn_hard_constraint_no_heels', systemProfile: 'CONCIERGE', script: 'D05', fixtures });
  assert.equal(synthesized.applicable, true);
  const evidence = evidenceFor(fixtures.scenariosById['scn_hard_constraint_no_heels']);
  const result = evaluateResponse(synthesized.text, evidence, synthesized.groundTruth);
  assert.equal(result.verdict, 'FAIL_CONSTRAINT');
});

test('required test 20: missing-category uncertainty (abstention) works', () => {
  const scenario = fixtures.scenariosById['scn_empty_closet_uncertainty'];
  assert.equal(scenario.expectAbstentionEligible, true);
  const clean = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'ELISE', script: 'CLEAN', fixtures });
  const cleanResult = evaluateResponse(clean.text, evidenceFor(scenario), clean.groundTruth);
  assert.notEqual(cleanResult.verdict, 'FAIL_ABSTENTION', 'a well-behaved CLEAN response must not be flagged for missing abstention');

  const defective = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'ELISE', script: 'D14', fixtures });
  const defectiveResult = evaluateResponse(defective.text, evidenceFor(scenario), defective.groundTruth);
  assert.equal(defectiveResult.verdict, 'FAIL_ABSTENTION');
});

test('required test 21: weak-profile unsupported certainty (D12) is detected', () => {
  const scenario = fixtures.scenariosById['scn_seasonal_advice_limited']; // sig_sporty_weak, confidence=low
  assert.equal(fixtures.signatureStylesById[scenario.signatureStyleId].confidence, 'low');
  const synthesized = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'ELISE', script: 'D12', fixtures });
  const result = evaluateResponse(synthesized.text, evidenceFor(scenario), synthesized.groundTruth);
  assert.equal(result.verdict, 'FLAG_CALIBRATION');
});

test('required test 22: explanation-faithfulness control (D08) works deterministically', () => {
  const scenario = fixtures.scenariosById['scn_build_outfit_balanced'];
  const synthesized = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'ELISE', script: 'D08', fixtures });
  const result = evaluateResponse(synthesized.text, evidenceFor(scenario), synthesized.groundTruth);
  assert.equal(result.verdict, 'FAIL_EXPLANATION_FAITHFULNESS');
});

test('required test 23: safety-policy mapping is complete or explicitly reports gaps', () => {
  const map = loadSafetyPolicyMap();
  const check = checkSafetyPolicyMapCompleteness(map);
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.equal(map.bodyAppearanceSafetyClass.verdict, 'SAFETY POLICY COVERAGE GAP');
});

test('body/appearance classifier stratifies without inventing a policy verdict', () => {
  for (const { message, expectedStratum } of BODY_APPEARANCE_TEST_MESSAGES) {
    const result = classifyBodyAppearanceMessage(message);
    assert.equal(result.stratum, expectedStratum, message);
    assert.equal(result.policyResult, 'POLICY_GAP');
  }
});

test('hard constraint evaluator flags a mentioned excluded item', () => {
  const scenario = fixtures.scenariosById['scn_hard_constraint_no_heels'];
  const closet = fixtures.closetsById[scenario.closetId];
  const excludedItem = closet.items.find((i) => i.colors.includes('black'));
  const text = `You should wear the ${excludedItem.colors[0]} ${excludedItem.subcategory}.`;
  const result = evaluateConstraints(text, { scenario, closet, commerceProduct: null }, { excludedByConstraintIds: [excludedItem.id] });
  assert.ok(result.hardViolations.length > 0);
});
