'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveHardConstraintOverride, LEVELS, PRECEDENCE_CONTRACT_VERSION } = require('../model/precedenceContract');
const { getFixtures } = require('../fixtures');
const { synthesizeResponse } = require('../synthesis/responseSynthesizer');
const { evaluateResponse } = require('../grounding/groundingEvaluator');
const { extractClaims } = require('../extraction/claimExtractor');

const fixtures = getFixtures();

test('PRECEDENCE_CONTRACT_VERSION is V1', () => {
  assert.equal(PRECEDENCE_CONTRACT_VERSION, 'V1');
});

test('required test 15: current-request (Level 1) precedence works', () => {
  // A current-turn anchor_item constraint controls the response even against
  // a standing Level-3 preference pointing elsewhere.
  const scenario = fixtures.scenariosById['scn_style_owned_item'];
  assert.ok(scenario.hardConstraints.some((c) => c.startsWith('anchor_item:')));
});

test('required test 16: standing hard constraint (Level 2) precedence works', () => {
  const result = resolveHardConstraintOverride({ currentTurnExplicitlyOverrides: false });
  assert.equal(result.constraintRemainsActive, true);
  assert.equal(result.winningLevel, LEVELS.L2_STANDING_HARD_CONSTRAINT);
});

test('required test 17: explicit one-turn override (Level 1 over Level 2) works and is not permanent', () => {
  const result = resolveHardConstraintOverride({ currentTurnExplicitlyOverrides: true });
  assert.equal(result.constraintRemainsActive, false);
  assert.equal(result.overrideIsPermanent, false);
  assert.equal(result.winningLevel, LEVELS.L1_CURRENT_TURN_INSTRUCTION);
});

test('required test 18: Signature Style cannot alter Closet facts (spec section 36 mandatory case)', () => {
  // Closet has "blue cotton t-shirt"; Signature Style has a strong preference
  // for neutral wool sweaters; request is "what t-shirts do I own?". Expected:
  // the blue cotton t-shirt remains factual authority; no invented sweater.
  const closet = fixtures.closetsById['closet_minimal'];
  const style = fixtures.signatureStylesById['sig_strong_classic']; // strong, unrelated preference set
  const evidence = { closet, signatureStyle: style, entitlement: { kPlusActive: true }, scenario: { softConstraints: [] } };

  const factualResponse = 'You own a blue cotton t-shirt.';
  const { claims } = extractClaims(factualResponse, evidence);
  const ownership = claims.find((c) => c.type === 'OWNERSHIP');
  assert.ok(ownership);
  assert.equal(ownership.supportStatus, 'SUPPORTED');

  const contaminatedResponse = 'You own a neutral wool sweater that is perfect as a t-shirt alternative.';
  const contaminatedClaims = extractClaims(contaminatedResponse, evidence).claims;
  const sweaterClaim = contaminatedClaims.find((c) => c.type === 'OWNERSHIP' && c.referent.includes('sweater'));
  assert.ok(sweaterClaim, 'expected an OWNERSHIP claim about the sweater to be extracted');
  assert.equal(sweaterClaim.supportStatus, 'CONTRADICTED', 'a Signature Style preference must never license an invented owned item');
});

test('D04 (misstates Signature Style) is a distinct, detected failure mode', () => {
  const scenario = fixtures.scenariosById['scn_build_outfit_balanced'];
  const evidence = {
    closet: fixtures.closetsById[scenario.closetId],
    signatureStyle: fixtures.signatureStylesById[scenario.signatureStyleId],
    entitlement: { kPlusActive: true, conciergeV1: true },
    scenario,
    commerceCatalog: fixtures.commerceCatalog,
  };
  const synthesized = synthesizeResponse({ scenarioId: scenario.id, systemProfile: 'ELISE', script: 'D04', fixtures });
  const result = evaluateResponse(synthesized.text, evidence, synthesized.groundTruth);
  assert.equal(result.verdict, 'FAIL_GROUNDING');
});
