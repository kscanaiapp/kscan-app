'use strict';

/**
 * Independent holdout review — locking, agreement and integrity.
 *
 * The properties pinned here are the ones that make the holdout worth having: a
 * label set cannot be edited after locking without detection, disagreement classes
 * are distinguished rather than merged, and the agreement figure cannot be reported
 * without the caveat that it comes from two same-model sessions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const holdoutReview = require('../lib/holdoutReview');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function submission(role, overrides = {}) {
  return {
    reviewerRole: role,
    integrityDeclaration: {
      labeledOnlyFromImages: true,
      readAnyExistingLabels: false,
      sawOtherReviewerWork: false,
      sawAnyModelOutput: false,
      attemptedProvenanceLookup: false,
      notes: '',
    },
    labels: [
      {
        blindId: 'hv-01',
        category: 'footwear',
        clothingType: 'sneaker',
        subtype: 'low_top',
        primaryColor: 'white',
        secondaryColors: 'not_visible',
        material: 'leather',
        pattern: 'solid',
        brand: 'not_visible',
        brandEvidence: 'none',
        exactProduct: 'unknown',
        expectedResultType: 'identified_style',
        nonFashion: false,
        confidence: 'high',
        evidenceBasis: 'clear side view of a low-top sneaker',
      },
    ],
    sameItemGroups: [],
    notes: '',
    ...overrides,
  };
}

// ── Locking ─────────────────────────────────────────────────────────────────

test('a label set locks to a stable hash', () => {
  const a = holdoutReview.lockLabelSet(submission('A'));
  const b = holdoutReview.lockLabelSet(submission('A'));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('re-wording a rationale does not break a lock, but changing a label does', () => {
  const baseline = holdoutReview.lockLabelSet(submission('A'));

  const reworded = submission('A');
  reworded.labels[0].evidenceBasis = 'completely different wording';
  reworded.notes = 'added a note afterwards';
  reworded.labels[0].confidence = 'low';
  assert.equal(holdoutReview.lockLabelSet(reworded), baseline,
    'free-text and confidence must not invalidate a lock');

  // Any reviewed FIELD changing must invalidate it — that is the whole point.
  for (const field of holdoutReview.REVIEWED_FIELDS) {
    const edited = submission('A');
    edited.labels[0][field] = field === 'nonFashion' ? true : 'edited_after_the_fact';
    assert.notEqual(holdoutReview.lockLabelSet(edited), baseline,
      `editing ${field} after locking must be detectable`);
  }
});

test('label order does not affect the lock, so submission order cannot mask an edit', () => {
  const twoLabels = submission('A');
  twoLabels.labels.push({ ...twoLabels.labels[0], blindId: 'hv-02', category: 'bag' });
  const forward = holdoutReview.lockLabelSet(twoLabels);
  const reversed = holdoutReview.lockLabelSet({ ...twoLabels, labels: twoLabels.labels.slice().reverse() });
  assert.equal(forward, reversed);
});

test('a changed same-item grouping invalidates the lock', () => {
  const baseline = holdoutReview.lockLabelSet(submission('A'));
  const grouped = submission('A', {
    sameItemGroups: [{ blindIds: ['hv-01', 'hv-02'], sameItemConfidence: 'high', basis: 'same shoe' }],
  });
  assert.notEqual(holdoutReview.lockLabelSet(grouped), baseline);
});

test('the two reviewer roles produce different locks for identical labels', () => {
  // The role is part of the locked identity, so one reviewer's set can never be
  // presented as the other's.
  assert.notEqual(holdoutReview.lockLabelSet(submission('A')), holdoutReview.lockLabelSet(submission('B')));
});

// ── Agreement and disagreement classification ───────────────────────────────

test('identical reviews agree on every field with zero disagreements', () => {
  const comparison = holdoutReview.compareReviews(submission('A'), submission('B'));
  assert.equal(comparison.disagreementCount, 0);
  assert.equal(comparison.overall.rate, 1);
  assert.equal(comparison.sameItem.agreed, true);
  for (const field of holdoutReview.REVIEWED_FIELDS) {
    assert.equal(comparison.agreementByField[field].rate, 1);
  }
});

test('an uncertainty-token disagreement is classified separately from a value disagreement', () => {
  // not_visible vs unknown is a rule misunderstanding, not a perception difference,
  // and it changes how the model's later behaviour is scored.
  const a = submission('A');
  const b = submission('B');
  b.labels[0].material = 'unknown';
  a.labels[0].material = 'not_visible';
  const tokenCase = holdoutReview.compareReviews(a, b);
  const tokenFinding = tokenCase.disagreements.find((d) => d.field === 'material');
  assert.equal(tokenFinding.kind, 'uncertainty_token');

  const c = submission('A');
  const d = submission('B');
  d.labels[0].category = 'bag';
  const valueCase = holdoutReview.compareReviews(c, d);
  assert.equal(valueCase.disagreements.find((x) => x.field === 'category').kind, 'value');
});

test('brand and exactProduct disagreements are flagged as near-mechanical', () => {
  const a = submission('A');
  const b = submission('B');
  b.labels[0].brand = 'Nike';
  b.labels[0].brandEvidence = 'swoosh on the side';
  const comparison = holdoutReview.compareReviews(a, b);
  const finding = comparison.disagreements.find((x) => x.field === 'brand');
  assert.equal(finding.nearMechanical, true);
  // The evidence each reviewer cited travels with the disagreement so the
  // adjudicator can rule on evidence rather than on a vote.
  assert.equal(finding.reviewerB, 'Nike');
  assert.match(finding.reviewerBEvidence, /swoosh/);
});

test('a missing label is a disagreement, not a silent skip', () => {
  const a = submission('A');
  const b = submission('B', { labels: [] });
  const comparison = holdoutReview.compareReviews(a, b);
  const finding = comparison.disagreements.find((d) => d.kind === 'missing_label');
  assert.ok(finding);
  assert.equal(finding.reviewerB, 'absent');
});

test('a same-item identity disagreement is reported as its own class', () => {
  const a = submission('A', {
    sameItemGroups: [{ blindIds: ['hv-01', 'hv-02'], sameItemConfidence: 'high', basis: 'x' }],
  });
  const b = submission('B', { sameItemGroups: [] });
  const comparison = holdoutReview.compareReviews(a, b);
  assert.equal(comparison.sameItem.agreed, false);
  const finding = comparison.disagreements.find((d) => d.kind === 'same_item_identity');
  assert.ok(finding, 'unconfirmed same-item identity must surface, since it makes a set unscorable');
});

test('comparison is case- and whitespace-insensitive but not value-collapsing', () => {
  const a = submission('A');
  const b = submission('B');
  b.labels[0].category = '  FOOTWEAR  ';
  assert.equal(holdoutReview.compareReviews(a, b).disagreementCount, 0, 'formatting is not disagreement');

  const c = submission('B');
  c.labels[0].primaryColor = 'off-white';
  assert.ok(
    holdoutReview.compareReviews(a, c).disagreementCount > 0,
    'a genuinely different shade must remain a disagreement'
  );
});

// ── Integrity declaration ───────────────────────────────────────────────────

test('a missing integrity declaration fails closed', () => {
  const result = holdoutReview.verifyIntegrityDeclaration({ labels: [] });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.check === 'declaration_present'));
});

test('any admitted isolation breach invalidates the review', () => {
  for (const field of [
    'readAnyExistingLabels',
    'sawOtherReviewerWork',
    'sawAnyModelOutput',
    'attemptedProvenanceLookup',
  ]) {
    const breached = submission('A');
    breached.integrityDeclaration[field] = true;
    const result = holdoutReview.verifyIntegrityDeclaration(breached);
    assert.equal(result.ok, false, `${field} = true must invalidate`);
    assert.ok(result.failures.some((f) => f.check === field));
  }
});

test('failing to confirm image-only labeling invalidates the review', () => {
  const unconfirmed = submission('A');
  unconfirmed.integrityDeclaration.labeledOnlyFromImages = false;
  assert.equal(holdoutReview.verifyIntegrityDeclaration(unconfirmed).ok, false);
});

test('a clean declaration passes', () => {
  assert.equal(holdoutReview.verifyIntegrityDeclaration(submission('A')).ok, true);
});

// ── The caveat that must travel with the number ─────────────────────────────

test('the agreement interpretation refuses to be mistaken for human agreement', () => {
  const interpretation = holdoutReview.agreementInterpretation();
  assert.match(interpretation.measures, /isolated same-model labeling sessions/);
  assert.match(interpretation.doesNotMeasure, /human inter-reviewer agreement/);
  assert.match(interpretation.whyOptimistic, /errors are correlated/);
  assert.match(interpretation.comparabilityRule, /never be compared against/);
  assert.ok(interpretation.isolationBasis.length > 0);
});

// ── Blinding, which is what makes the review independent at all ─────────────

test('every holdout case id leaks ground truth, so blinding is mandatory', () => {
  // This is why reviewers receive opaque blind ids rather than case ids. If this
  // assertion ever fails because ids were renamed, blinding can be revisited —
  // until then it must not be skipped.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json'), 'utf8')
  );
  const holdoutIds = manifest.split.holdout;
  const categoryTokens = ['footwear', 'top', 'dress', 'pants', 'skirt', 'bag', 'accessory', 'outerwear', 'non_fashion'];
  const clothingTypeTokens = ['jeans', 'jacket', 'sneaker', 'boot', 'gown'];

  const leaksCategory = holdoutIds.filter((id) => categoryTokens.some((t) => id.toLowerCase().includes(t)));
  assert.equal(leaksCategory.length, 7, '7 of the 8 holdout ids embed their level-1 category');

  // The eighth leaks a level-2 clothing type AND a brand model designation, for a
  // case whose brand ground truth is not_visible — the worst single leak of the set.
  const remainder = holdoutIds.filter((id) => !leaksCategory.includes(id));
  assert.deepEqual(remainder, ['set-501xx-jeans']);
  assert.ok(clothingTypeTokens.some((t) => remainder[0].includes(t)),
    'the remaining id still leaks a clothing type');
  const leakedCase = manifest.cases.find((c) => c.caseId === remainder[0]);
  assert.equal(leakedCase.brand, 'not_visible',
    "the case id names a Levi's model designation while its brand ground truth is not_visible");

  // Net effect: all 8 leak label information, so no case id may reach a reviewer.
  const leaksAnything = holdoutIds.filter((id) =>
    [...categoryTokens, ...clothingTypeTokens].some((t) => id.toLowerCase().includes(t)));
  assert.equal(leaksAnything.length, holdoutIds.length,
    'no holdout case id may ever be shown to a reviewer');
});
