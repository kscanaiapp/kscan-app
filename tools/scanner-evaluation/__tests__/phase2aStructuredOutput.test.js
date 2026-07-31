'use strict';

/**
 * Phase 2A structured-output hardening.
 *
 * Two things are proved here.
 *
 * FIRST, the invariants that already held must still hold: one schema boundary,
 * invalid output blocked before scoring, a transport failure never re-labelled a
 * parse failure, transient and permanent 429 kept distinct, abstention kept
 * distinct from incorrect and from not_measured, an empty brand never concrete,
 * and no denominator, taxonomy-hash or scoring-contract drift.
 *
 * SECOND, the new candidate-scoped layer must be report-only. A guard that
 * quietly rewrote an unsupported claim into an abstention would turn a false
 * positive into a correct answer and inflate the candidate's score for
 * behaviour it got wrong. Several tests below exist purely to prove that does
 * not happen.
 *
 * No provider transport is involved. Nothing here makes a network call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const candidateRegistry = require('../lib/candidateRegistry');
const candidateValidation = require('../lib/candidateValidation');
const liveAdapter = require('../lib/liveAdapter');
const normalizedResultValidation = require('../lib/normalizedResultValidation');
const scoreFields = require('../lib/scoreFields');
const scoringProjection = require('../lib/scoringProjection');
const taxonomy = require('../lib/errorTaxonomy');

const CONTROL = candidateRegistry.CONTROL_VERSION;
const CANDIDATE = candidateRegistry.PHASE2A_VERSION;

/** A schema-valid V2 result. Overrides are applied to `item` unless nested. */
function v2Result(overrides = {}) {
  const base = {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req-0001',
    status: 'completed',
    resolutionLevel: 'subtype',
    item: {
      category: 'footwear',
      subtype: 'low_top_sneaker',
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: 'red', secondary: ['white'] },
      material: ['canvas'],
      silhouette: ['low profile'],
      pattern: ['solid'],
      attributes: { pockets: [], visible: [], distinctive: [] },
    },
    confidence: { category: 0.82, subtype: null, brand: null, modelFamily: null, exactProduct: null },
    exactProduct: null,
    evidence: [{ evidenceId: 'ev-1', observations: ['A red low-top sneaker.'] }],
    conflicts: [],
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.82 },
  };
  const merged = { ...base, ...overrides };
  if (overrides.item) merged.item = { ...base.item, ...overrides.item };
  if (overrides.compatibility) merged.compatibility = { ...base.compatibility, ...overrides.compatibility };
  return merged;
}

function validated(result) {
  const validation = normalizedResultValidation.validateNormalizedResult(result);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  return validation.value;
}

// ── One canonical schema boundary ───────────────────────────────────────────

test('the schema boundary is the only place output validity is decided', () => {
  // Malformed JSON.
  const malformed = normalizedResultValidation.validateNormalizedResult('I could not analyse that image.');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.failureCode, 'provider_output_invalid');

  // Valid JSON, invalid schema.
  const wrongShape = normalizedResultValidation.validateNormalizedResult({ result: 'ok', data: { thing: 'a shoe' } });
  assert.equal(wrongShape.ok, false);
  assert.equal(wrongShape.failureCode, 'provider_output_invalid');

  // Valid schema, unsupported enum value.
  const badStatus = normalizedResultValidation.validateNormalizedResult(v2Result({ status: 'mostly_completed' }));
  assert.equal(badStatus.ok, false);
  assert.equal(badStatus.errors.some((e) => e.path === 'status'), true);
});

test('neither the projection nor candidate validation can be reached around the schema boundary', () => {
  for (const invalid of ['not json', { result: 'ok' }, null, [], { contractVersion: 'fashion-identification-v1' }]) {
    assert.throws(() => scoringProjection.projectV2ForScoring(invalid), /requires/);
    assert.throws(
      () => candidateValidation.findCandidateViolations(invalid, { candidateVersion: CANDIDATE }),
      /schema-validated V2 result/
    );
  }
});

// ── Transport failures are never parse failures ─────────────────────────────

test('a request that never returned is a transport terminal, not a parse failure', () => {
  const timeout = liveAdapter.classifyOutcome({
    providerAttempts: [{ httpStatus: 0, errorCategory: 'timeout' }],
    v2Present: false,
    observed: null,
  });
  assert.equal(timeout.status, 'provider_timeout');
  assert.equal(timeout.stage, 'transport');

  const record = liveAdapter.buildCaseRecord({
    caseId: 'c1',
    report: { providerAttempts: [{ httpStatus: 0, errorCategory: 'timeout' }], v2Present: false, observed: null },
    runIdentityRecord: { runId: 'r', datasetVersion: '0.3.1', candidateVersion: CANDIDATE },
    outcome: timeout,
    attemptsUsed: 1,
    costUsd: 0,
  });
  assert.equal(record.parseStatus, 'not_reached', 'a response that never arrived cannot have failed to parse');
  assert.equal(record.status, 'provider_timeout');
  assert.equal(record.candidateVersion, CANDIDATE);
});

test('a blocked non-provider host is an isolation terminal and also never reaches parsing', () => {
  const blocked = liveAdapter.classifyOutcome({
    providerAttempts: [],
    counters: { unexpectedNetworkAttempts: 1 },
  });
  assert.equal(blocked.status, 'network_blocked');
  assert.equal(blocked.stage, 'isolation');

  const record = liveAdapter.buildCaseRecord({
    caseId: 'c2',
    report: { providerAttempts: [], counters: { unexpectedNetworkAttempts: 1 }, v2Present: false },
    runIdentityRecord: { runId: 'r', datasetVersion: '0.3.1' },
    outcome: blocked,
    attemptsUsed: 0,
    costUsd: 0,
  });
  assert.equal(record.parseStatus, 'not_reached');
});

test('transient and permanent 429 remain distinct terminals', () => {
  const transient = liveAdapter.classifyOutcome({
    providerAttempts: [{ httpStatus: 429, certifiedFailureKind: 'http_429_transient' }],
  });
  assert.equal(transient.status, 'provider_rate_limited');
  assert.equal(transient.retryable, true);

  const permanent = liveAdapter.classifyOutcome({
    providerAttempts: [{ httpStatus: 429, certifiedFailureKind: 'http_429_quota' }],
  });
  assert.equal(permanent.status, 'provider_quota_exhausted');
  assert.equal(permanent.retryable, false);

  assert.notEqual(transient.status, permanent.status);
  assert.equal(taxonomy.CATEGORIES.provider_rate_limited.billable, true);
  assert.equal(taxonomy.CATEGORIES.provider_quota_exhausted.billable, false);
});

// ── The projection ──────────────────────────────────────────────────────────

test('the projection supplies exactly the keys the scorer reads', () => {
  const projected = scoringProjection.projectV2ForScoring(validated(v2Result()));
  for (const key of scoringProjection.SCORER_INPUT_KEYS) {
    assert.equal(key in projected, true, `the scorer reads ${key}`);
  }
  assert.equal(projected.category, 'footwear');
  assert.equal(projected.subtype, 'low_top_sneaker');
  assert.equal(projected.primaryColor, 'red');
  assert.deepEqual(projected.secondaryColors, ['white']);
  assert.equal(projected.material, 'canvas');
  assert.equal(projected.pattern, 'solid');
  assert.equal(projected.brand, null);
  assert.equal(projected.status, 'completed');
  assert.equal(projected.resolutionLevel, 'subtype');
});

test('the projection carries no clothingType, because the V2 contract has no third level', () => {
  const projected = scoringProjection.projectV2ForScoring(validated(v2Result()));
  assert.equal('clothingType' in projected, false);

  // And the frozen scorer treats the absence exactly as it always has: as an
  // abstention against a concrete label, with no new disposition invented.
  const scored = scoreFields.scoreField('clothingType', 'sneaker', projected.clothingType);
  assert.equal(scored.disposition, scoreFields.DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS);
  assert.notEqual(scored.disposition, scoreFields.DISPOSITIONS.NOT_MEASURED);
});

test('the projection reduces V2 lists without discarding them', () => {
  const projected = scoringProjection.projectV2ForScoring(
    validated(v2Result({ item: { material: ['denim', 'cotton'], pattern: [] } }))
  );
  assert.equal(projected.material, 'denim', 'the provider assertion comes first in the certified list');
  assert.deepEqual(projected.materialAll, ['denim', 'cotton']);
  assert.equal(projected.pattern, null, 'an empty list is an absence, not an empty string');
  assert.deepEqual(projected.patternAll, []);
});

test('the projection rewrites no value: uncertainty tokens and placeholders pass through', () => {
  const projected = scoringProjection.projectV2ForScoring(
    validated(v2Result({ item: { category: 'unknown', subtype: null, brand: { value: 'unbranded', confidence: null, provenance: 'unknown', evidence: [] } } }))
  );
  assert.equal(projected.category, 'unknown', 'an uncertainty token is not rewritten');
  assert.equal(projected.brand, 'unbranded', 'a placeholder is not silently converted into an abstention');
});

test('a non-identity result projects with no identity at all', () => {
  const projected = scoringProjection.projectV2ForScoring(validated(v2Result({
    status: 'insufficient_visual_evidence',
    resolutionLevel: 'unknown',
    item: {
      category: null,
      subtype: null,
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: null, secondary: [] },
      material: [],
      pattern: [],
    },
    confidence: { category: null, subtype: null, brand: null, modelFamily: null, exactProduct: null },
  })));
  assert.equal(projected.category, null);
  assert.equal(projected.brand, null);
  assert.equal(projected.material, null);
  assert.equal(projected.status, 'insufficient_visual_evidence');
});

// ── Scoring semantics are unchanged ─────────────────────────────────────────

const LABEL = Object.freeze({
  caseId: 'proj-1',
  datasetVersion: '0.3.1',
  category: 'footwear',
  clothingType: 'sneaker',
  subtype: 'low_top_sneaker',
  primaryColor: 'red',
  secondaryColors: ['white'],
  material: 'canvas',
  pattern: 'solid',
  brand: 'not_visible',
  exactProduct: 'unknown',
  expectedResultType: 'identified_style',
  expectedAbstention: false,
  nonFashion: false,
});

test('the projection changes no denominator and no contract version', () => {
  const viaProjection = scoreFields.scoreCase(LABEL, scoringProjection.projectV2ForScoring(validated(v2Result())));
  const viaFlat = scoreFields.scoreCase(LABEL, {});

  assert.equal(viaProjection.fields.length, viaFlat.fields.length, 'the same field list is scored either way');
  assert.deepEqual(
    viaProjection.fields.map((f) => f.field),
    viaFlat.fields.map((f) => f.field)
  );
  assert.equal(viaProjection.scoringContractVersion, '0.3.0');
  assert.equal(viaProjection.scoringContractVersion, viaFlat.scoringContractVersion);
  assert.equal(scoreFields.SCORING_CONTRACT_VERSION, '0.3.0');

  const agg = scoreFields.aggregateScores([viaProjection]);
  assert.equal(agg.caseCount, 1);
  assert.equal(agg.scoringContractVersion, '0.3.0');
});

test('the projection is what makes a correct answer score correct', () => {
  // Before the projection existed, the raw V2 object was handed to the scorer
  // and every flat field read undefined, so a perfectly correct scanner result
  // scored as a total abstention. This is the regression test for that.
  const raw = validated(v2Result());
  const rawScored = scoreFields.scoreCase(LABEL, raw);
  const projected = scoreFields.scoreCase(LABEL, scoringProjection.projectV2ForScoring(raw));

  const dispositionOf = (score, field) => score.fields.find((f) => f.field === field).disposition;
  assert.equal(dispositionOf(rawScored, 'category'), scoreFields.DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS);
  assert.equal(dispositionOf(projected, 'category'), scoreFields.DISPOSITIONS.CORRECT);
  assert.equal(dispositionOf(projected, 'subtype'), scoreFields.DISPOSITIONS.CORRECT);
  assert.equal(dispositionOf(projected, 'primaryColor'), scoreFields.DISPOSITIONS.CORRECT);
  assert.equal(dispositionOf(projected, 'material'), scoreFields.DISPOSITIONS.CORRECT);
  assert.ok(projected.totalPenalty < rawScored.totalPenalty);
});

test('abstention, incorrect and not_measured stay three different things', () => {
  const abstained = scoreFields.scoreField('material', 'not_visible', null);
  assert.equal(abstained.disposition, scoreFields.DISPOSITIONS.CORRECT);

  const overclaimed = scoreFields.scoreField('material', 'not_visible', 'leather');
  assert.equal(overclaimed.disposition, scoreFields.DISPOSITIONS.UNSUPPORTED_CERTAINTY);

  const wrong = scoreFields.scoreField('material', 'canvas', 'leather');
  assert.equal(wrong.disposition, scoreFields.DISPOSITIONS.INCORRECT);

  const notMeasured = scoreFields.scoreExactProduct('unknown', null, 'identified_style');
  assert.equal(notMeasured.disposition, scoreFields.DISPOSITIONS.NOT_MEASURED);
  assert.equal(notMeasured.penalty, scoreFields.penaltyFor('exactProduct', scoreFields.DISPOSITIONS.NOT_MEASURED));

  for (const [a, b] of [[abstained, wrong], [abstained, notMeasured], [wrong, notMeasured]]) {
    assert.notEqual(a.disposition, b.disposition);
  }
});

test('unsupported certainty remains measurable, and abstention is never credited as correct identification', () => {
  const label = { ...LABEL, material: 'not_visible' };
  const claimed = scoreFields.scoreCase(label, scoringProjection.projectV2ForScoring(validated(v2Result())));
  const material = claimed.fields.find((f) => f.field === 'material');
  assert.equal(material.disposition, scoreFields.DISPOSITIONS.UNSUPPORTED_CERTAINTY);
  // An ungradeable label cannot contribute to identification accuracy.
  assert.equal(material.gradeable, false);

  const agg = scoreFields.aggregateScores([claimed]);
  assert.equal(agg.identification.material.gradeableN, 0);
  assert.equal(agg.identification.material.correctRate, 'not_measured', 'never 0');
});

test('an empty brand can never become a concrete prediction', () => {
  // The schema boundary refuses the empty string outright.
  const empty = normalizedResultValidation.validateNormalizedResult(
    v2Result({ item: { brand: { value: '', confidence: null, provenance: 'unknown', evidence: [] } } })
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.errors.some((e) => e.path === 'item.brand.value'), true);

  // And even if one reached it, the scorer would not count it as concrete.
  for (const value of ['', '   ', null, undefined, []]) {
    const scored = scoreFields.scoreBrand('not_visible', value);
    assert.equal(scored.brandConcretePrediction, false, `${JSON.stringify(value)} is not a brand claim`);
    assert.equal(scored.brandFalsePositive, false);
  }
});

test('the five contradictory brand cases stay not_measured and out of both cohorts', () => {
  const scored = scoreFields.scoreBrand('not_visible', 'Levi’s', {
    brandEvidenceState: 'product_level_evidence',
  });
  assert.equal(scored.disposition, scoreFields.DISPOSITIONS.NOT_MEASURED);
  assert.equal(scored.brandNotMeasured, true);
  assert.equal(scored.brandFalsePositive, false);

  const agg = scoreFields.aggregateScores([
    scoreFields.scoreCase(
      { ...LABEL, brand: 'not_visible', brandEvidenceState: 'product_level_evidence' },
      scoringProjection.projectV2ForScoring(
        validated(v2Result({ item: { brand: { value: 'Levi’s', confidence: 0.8, provenance: 'visible_text', evidence: [{ type: 'visible_brand_text' }] } } }))
      )
    ),
  ]);
  assert.equal(agg.brandPrecisionSignals.notMeasuredCases, 1);
  assert.equal(agg.brandPrecisionSignals.falsePositiveCohortN, 0);
  assert.equal(agg.brandPrecisionSignals.falsePositives, 0);
});

// ── Candidate post-validation is candidate-scoped and report-only ───────────

test('the control receives no candidate rule at all', () => {
  const contradictory = validated(v2Result({ item: { category: 'dress', subtype: 'low_top_sneaker' } }));
  const result = candidateValidation.findCandidateViolations(contradictory, { candidateVersion: CONTROL });
  assert.equal(result.applicable, false);
  assert.equal(result.policy, 'certified_only');
  assert.deepEqual(result.findings, []);
});

test('an unknown candidate cannot run post-validation', () => {
  assert.throws(
    () => candidateValidation.findCandidateViolations(validated(v2Result()), { candidateVersion: 'phase2a-v0.0.1' }),
    candidateRegistry.UnknownCandidateVersion
  );
});

test('a clean candidate result produces no findings', () => {
  const result = candidateValidation.findCandidateViolations(validated(v2Result()), { candidateVersion: CANDIDATE });
  assert.equal(result.applicable, true);
  assert.deepEqual(result.findings, []);
});

test('a category/subtype contradiction is detected, and a consistent pair is not', () => {
  const contradictory = candidateValidation.findCandidateViolations(
    validated(v2Result({ item: { category: 'dress', subtype: 'low_top_sneaker' } })),
    { candidateVersion: CANDIDATE }
  );
  assert.equal(contradictory.findings.some((f) => f.code === 'taxonomy_contradiction'), true);

  // Exact, one level, and two levels are all consistent; a peer is not.
  assert.equal(candidateValidation.taxonomyPairConsistency('sneaker', 'low_top_sneaker').consistent, true);
  assert.equal(candidateValidation.taxonomyPairConsistency('footwear', 'low_top_sneaker').consistent, true);
  assert.equal(candidateValidation.taxonomyPairConsistency('dress', 'low_top_sneaker').consistent, false);

  // Undecidable rather than contradictory when a side is absent or uncertain.
  assert.equal(candidateValidation.taxonomyPairConsistency('footwear', null).decidable, false);
  assert.equal(candidateValidation.taxonomyPairConsistency('footwear', 'unknown').decidable, false);
});

test('an out-of-ontology prediction is reported as unmapped, not as a contradiction', () => {
  const result = candidateValidation.findCandidateViolations(
    validated(v2Result({ item: { category: 'footwear', subtype: 'quantum_slipper' } })),
    { candidateVersion: CANDIDATE }
  );
  assert.equal(result.findings.some((f) => f.code === 'unmapped_taxonomy_prediction'), true);
  assert.equal(result.findings.some((f) => f.code === 'taxonomy_contradiction'), false);
});

test('a brand asserted with no recorded evidence is reported', () => {
  const withoutEvidence = candidateValidation.findCandidateViolations(
    validated(v2Result({ item: { brand: { value: 'Acme', confidence: null, provenance: 'unknown', evidence: [] } } })),
    { candidateVersion: CANDIDATE }
  );
  assert.equal(withoutEvidence.findings.some((f) => f.code === 'brand_without_recorded_evidence'), true);

  // A brand the model DID support is not reported. Phase 2A must not discourage
  // naming a brand that is actually visible.
  const withEvidence = candidateValidation.findCandidateViolations(
    validated(v2Result({
      item: {
        brand: {
          value: 'Acme',
          confidence: 0.8,
          provenance: 'visible_text',
          evidence: [{ type: 'visible_brand_text', observation: 'ACME' }],
        },
      },
    })),
    { candidateVersion: CANDIDATE }
  );
  assert.equal(withEvidence.findings.length, 0);
});

test('placeholders and attribute claims without a classification are reported', () => {
  const placeholder = candidateValidation.findCandidateViolations(
    validated(v2Result({ item: { brand: { value: 'N/A', confidence: null, provenance: 'unknown', evidence: [] } } })),
    { candidateVersion: CANDIDATE }
  );
  assert.equal(placeholder.findings.some((f) => f.code === 'placeholder_value'), true);
  for (const token of candidateValidation.PLACEHOLDER_TOKENS) {
    assert.equal(candidateValidation.isPlaceholder(token.toUpperCase()), true);
  }
  assert.equal(candidateValidation.isPlaceholder('canvas'), false);

  const unclassified = candidateValidation.findCandidateViolations(
    validated(v2Result({
      status: 'partial',
      resolutionLevel: 'unknown',
      item: { category: null, subtype: null, material: ['leather'] },
      confidence: { category: null, subtype: null, brand: null, modelFamily: null, exactProduct: null },
    })),
    { candidateVersion: CANDIDATE }
  );
  assert.equal(unclassified.findings.some((f) => f.code === 'attribute_claim_without_classification'), true);
});

test('high confidence with an unknown resolution level is reported', () => {
  const result = candidateValidation.findCandidateViolations(
    validated(v2Result({
      status: 'insufficient_visual_evidence',
      resolutionLevel: 'unknown',
      item: {
        category: null,
        subtype: null,
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: null, secondary: [] },
        material: [],
        pattern: [],
      },
      confidence: { category: null, subtype: null, brand: null, modelFamily: null, exactProduct: null },
      compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.95 },
    })),
    { candidateVersion: CANDIDATE }
  );
  assert.equal(result.findings.some((f) => f.code === 'confidence_exceeds_resolution'), true);
});

test('candidate post-validation mutates nothing and changes no score', () => {
  const offending = validated(v2Result({
    item: {
      category: 'dress',
      subtype: 'low_top_sneaker',
      brand: { value: 'unbranded', confidence: null, provenance: 'unknown', evidence: [] },
    },
  }));
  const before = JSON.stringify(offending);
  const scoredBefore = scoreFields.scoreCase(LABEL, scoringProjection.projectV2ForScoring(offending));

  const result = candidateValidation.findCandidateViolations(offending, { candidateVersion: CANDIDATE });
  assert.ok(result.findings.length >= 2, 'this fixture must actually trip the guards');

  assert.equal(JSON.stringify(offending), before, 'the observed result is never mutated');

  const scoredAfter = scoreFields.scoreCase(LABEL, scoringProjection.projectV2ForScoring(offending));
  assert.deepEqual(
    scoredAfter.fields.map((f) => [f.field, f.disposition, f.penalty]),
    scoredBefore.fields.map((f) => [f.field, f.disposition, f.penalty]),
    'findings must not change a single disposition or penalty'
  );
  assert.equal(scoredAfter.totalPenalty, scoredBefore.totalPenalty);

  // Specifically: the placeholder brand is still scored as the unsupported claim
  // it is, and is NOT laundered into a correct abstention.
  const brand = scoredAfter.fields.find((f) => f.field === 'brand');
  assert.equal(brand.disposition, scoreFields.DISPOSITIONS.UNSUPPORTED_CERTAINTY);
  assert.equal(brand.brandFalsePositive, true);
});

test('every declared finding code is reachable and the set is closed', () => {
  const observed = new Set();
  const fixtures = [
    v2Result({ item: { category: 'dress', subtype: 'low_top_sneaker' } }),
    v2Result({ item: { subtype: 'quantum_slipper' } }),
    v2Result({ item: { brand: { value: 'N/A', confidence: null, provenance: 'unknown', evidence: [] } } }),
    v2Result({ item: { brand: { value: 'Acme', confidence: null, provenance: 'unknown', evidence: [] } } }),
    v2Result({
      status: 'partial',
      resolutionLevel: 'unknown',
      item: { category: null, subtype: null, material: ['leather'] },
      confidence: { category: null, subtype: null, brand: null, modelFamily: null, exactProduct: null },
      compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.9 },
    }),
  ];
  for (const fixture of fixtures) {
    for (const found of candidateValidation.findCandidateViolations(validated(fixture), { candidateVersion: CANDIDATE }).findings) {
      assert.equal(candidateValidation.FINDING_CODES.includes(found.code), true, `${found.code} is undeclared`);
      observed.add(found.code);
    }
  }
  assert.deepEqual([...observed].sort(), [...candidateValidation.FINDING_CODES].sort());
});

// ── No contract drift ───────────────────────────────────────────────────────

test('the taxonomy hash and every governing version are unchanged', () => {
  assert.equal(taxonomy.TAXONOMY_VERSION, '1.0.0');
  assert.equal(
    taxonomy.taxonomyHash(),
    '3c93e35a66b34c42a8563d080794bafbaf640377c121622f3a10a3b2fb7a051a'
  );
  assert.deepEqual(taxonomy.unmappedCertifiedKinds(), []);
  assert.equal(scoreFields.SCORING_CONTRACT_VERSION, '0.3.0');
  assert.equal(normalizedResultValidation.CONTRACT_VERSION, 'fashion-identification-v2');
});
