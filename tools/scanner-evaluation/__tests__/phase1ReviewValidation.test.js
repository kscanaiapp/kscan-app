'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const guide = require('../lib/labelingGuide');
const { REVIEWED_FIELDS } = require('../lib/holdoutReview');
const { validateReviewSubmission } = require('../lib/reviewValidation');

function fixture() {
  const label = {
    blindId: 'rv-001', category: 'footwear', clothingType: 'sneaker', subtype: 'running_sneaker',
    primaryColor: 'red', secondaryColors: ['white'], material: 'canvas', pattern: 'solid',
    brand: 'not_visible', exactProduct: 'not_visible', expectedResultType: 'identified_style',
    nonFashion: false, visiblePerson: false, brandEvidenceState: 'no_reliable_evidence',
    expectedBrandAssertionBehavior: guide.EXPECTED_BRAND_OUTCOMES.NONE,
    expectedAbstention: false, subjectDesignation: 'unambiguously_dominant',
    sameItemAcrossImages: 'not_applicable', privacyAndAuthorizationComplete: true,
    labelConfidence: 'high', fieldEvidence: {},
  };
  for (const field of [...REVIEWED_FIELDS, 'labelConfidence']) label.fieldEvidence[field] = 'visible evidence';
  const brief = {
    guideSha256: 'guide', opaqueCaseMapSha256: 'map', sourceImageAggregateSha256: 'source',
    cases: [{ blindId: 'rv-001', images: [{ blindImageId: 'img-001' }], governance: { complete: true } }],
  };
  const submission = {
    reviewerRole: 'A', reviewedGuideVersion: guide.GUIDE_VERSION, guideSha256: 'guide',
    opaqueCaseMapSha256: 'map', sourceImageAggregateSha256: 'source', memoryContextDeclaration: {},
    integrityDeclaration: { labeledOnlyFromImages: true, readAnyExistingLabels: false, sawOtherReviewerWork: false, sawAnyModelOutput: false, attemptedProvenanceLookup: false },
    labels: [label],
  };
  return { brief, submission, label };
}

test('controlled, complete review passes', () => {
  const { brief, submission } = fixture();
  assert.deepEqual(validateReviewSubmission(submission, brief, { expectedRole: 'A' }).errors, []);
});

test('free-text taxonomy and inconsistent brand behavior fail closed', () => {
  const { brief, submission, label } = fixture();
  label.subtype = 'chunky running shoes';
  label.expectedBrandAssertionBehavior = 'abstain';
  const result = validateReviewSubmission(submission, brief, { expectedRole: 'A' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path.endsWith('.subtype')));
  assert.ok(result.errors.some((error) => error.path.endsWith('.expectedBrandAssertionBehavior')));
});

test('non-fashion encoding and governance completeness are enforced', () => {
  const { brief, submission, label } = fixture();
  label.nonFashion = true;
  label.privacyAndAuthorizationComplete = false;
  const result = validateReviewSubmission(submission, brief, { expectedRole: 'A' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path.endsWith('.privacyAndAuthorizationComplete')));
  assert.ok(result.errors.some((error) => error.message.includes('canonically unavailable')));
});
