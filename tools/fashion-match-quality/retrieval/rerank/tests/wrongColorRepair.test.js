'use strict';

/**
 * Spec section 11: resolve the wrongColor = 1.0 defect, verify the repair
 * against known cases, and do not tune the evaluator to flatter FashionCLIP.
 */

const test = require('node:test');
const assert = require('node:assert');

const { scoreFashionComponents } = require('../../../evaluator/substituteAxis');
const { resolveCandidateField, CANDIDATE_FIELD_ALIASES, COMPONENT_FIELD_RESOLUTION_VERSION, FASHION_COMPONENTS } = require('../../../evaluator/rubric');
const { loadFullCorpus } = require('../../../corpus/corpusLoader');

test('WRONGCOLOR REPAIR: the defect is a field-name mismatch, and only color_family was affected', () => {
  // The audit that justified the repair, kept executable so it cannot rot: of
  // all 13 rubric components, color_family is the ONLY one whose name never
  // appears on a candidate product. Anything else appearing here would mean
  // the alias table is now incomplete.
  const fixtures = loadFullCorpus();
  const candidateKeys = new Set();
  for (const f of fixtures) for (const c of f.candidateProducts) Object.keys(c).forEach((k) => candidateKeys.add(k));

  const missing = Object.keys(FASHION_COMPONENTS).filter((name) => !candidateKeys.has(name));
  assert.deepStrictEqual(missing, ['color_family'], 'only color_family should need a candidate-side alias');
});

test('WRONGCOLOR REPAIR: a correct colour now scores 1 where it previously scored 0', () => {
  const groundTruth = { color_family: 'navy' };
  // Candidate carries the colour under the key retailer-shaped products use.
  const candidate = { color_normalized: 'navy', color: 'navy' };

  assert.strictEqual(candidate.color_family, undefined, 'the candidate genuinely has no color_family key - that was the defect');
  assert.strictEqual(resolveCandidateField(candidate, 'color_family'), 'navy', 'the alias must find the colour that is actually there');
  assert.strictEqual(scoreFashionComponents(candidate, groundTruth).components.color_family, 1);
});

test('WRONGCOLOR REPAIR: a WRONG colour still scores 0 - the repair is not a blanket pass', () => {
  const groundTruth = { color_family: 'navy' };
  assert.strictEqual(scoreFashionComponents({ color_normalized: 'gray' }, groundTruth).components.color_family, 0);
  assert.strictEqual(scoreFashionComponents({ color_normalized: 'brown/tan' }, groundTruth).components.color_family, 0);
});

test('WRONGCOLOR REPAIR: a candidate with no colour at all still scores 0, not null', () => {
  assert.strictEqual(scoreFashionComponents({}, { color_family: 'navy' }).components.color_family, 0);
});

test('WRONGCOLOR REPAIR: absent ground truth is still unscoreable (null), never defaulted to 0', () => {
  assert.strictEqual(scoreFashionComponents({ color_normalized: 'navy' }, {}).components.color_family, null);
});

test('WRONGCOLOR REPAIR: resolution order prefers the canonical key when both are present', () => {
  assert.strictEqual(resolveCandidateField({ color_family: 'navy', color_normalized: 'black' }, 'color_family'), 'navy');
  assert.deepStrictEqual([...CANDIDATE_FIELD_ALIASES.color_family], ['color_family', 'color_normalized', 'color']);
});

test('WRONGCOLOR REPAIR: verified end to end against the real corpus - exact matches score 1, distractors 0', () => {
  const fixture = loadFullCorpus().find((f) => f.fixtureId === 'synthetic-dress-00');
  const bySuffix = (suffix) => fixture.candidateProducts.find((c) => c.id.endsWith(suffix));

  const exact = scoreFashionComponents(bySuffix('::exact'), fixture.groundTruth).components.color_family;
  const distractor = scoreFashionComponents(bySuffix('::distractor'), fixture.groundTruth).components.color_family;

  assert.strictEqual(exact, 1, 'the exact-SKU match shares ground truth colour and must score 1');
  assert.strictEqual(distractor, 0, 'a differently-coloured distractor must still score 0');
  assert.notStrictEqual(exact, distractor, 'the colour metric must be able to tell two rankings apart - that is the point of the repair');
});

test('WRONGCOLOR REPAIR: the field-resolution change is versioned so pre-repair artifacts are not silently compared', () => {
  assert.strictEqual(typeof COMPONENT_FIELD_RESOLUTION_VERSION, 'string');
  assert.match(COMPONENT_FIELD_RESOLUTION_VERSION, /color-family-repair/);
});

test('WRONGCOLOR REPAIR: scoring is symmetric across arms - it depends only on the candidate, never on who ranked it', () => {
  // Guards against the specific failure spec section 11 forbids: an evaluator
  // that scores the challenger's candidates differently from the control's.
  const groundTruth = { color_family: 'navy' };
  const candidate = { color_normalized: 'navy' };
  const asControl = scoreFashionComponents(candidate, groundTruth);
  const asChallenger = scoreFashionComponents({ ...candidate }, groundTruth);
  assert.deepStrictEqual(asControl.components, asChallenger.components);
});
