'use strict';

/**
 * Independent holdout review: locking, agreement, and adjudication (Phase 1 §5).
 *
 * WHY LOCKING COMES FIRST
 * A review is only independent if it can be proven not to have changed after the
 * other reviewer's answers, or any model output, became visible. So each reviewer's
 * label set is hashed the moment it is received, BEFORE any comparison runs, and
 * that hash is what the review artifact and the holdout seal reference. A label set
 * that is edited after locking produces a different hash and invalidates the run
 * rather than quietly becoming the new ground truth.
 *
 * WHAT AGREEMENT HERE DOES AND DOES NOT MEAN
 * Two isolated agent sessions labeling the same images independently are genuinely
 * two labeling runs with no shared state — which is strictly more than one session
 * labeling twice. They are NOT two humans. They share a model, so their errors are
 * correlated, and the agreement rate is therefore an OPTIMISTIC bound on how
 * unambiguous the labeling rules are. It must never be reported as, or compared
 * against, human inter-reviewer agreement. `agreementInterpretation()` returns that
 * caveat as data so a report cannot omit it.
 */

const crypto = require('crypto');

/**
 * Fields both reviewers label and which are therefore comparable.
 *
 * `visiblePerson` was originally omitted, and the adjudicator caught the
 * consequence: the two reviewers answered it OPPOSITELY on one image, the
 * divergence appeared in neither the agreement table nor the disagreement list,
 * and it would have entered the dataset with whichever reviewer's value a merge
 * happened to take. A divergent field that nobody adjudicates is worse than a
 * known disagreement, so any field a reviewer is asked to supply must be compared.
 */
const REVIEWED_FIELDS = Object.freeze([
  'category',
  'clothingType',
  'subtype',
  'primaryColor',
  'secondaryColors',
  'material',
  'pattern',
  'brand',
  'exactProduct',
  'expectedResultType',
  'nonFashion',
  'visiblePerson',
]);

/**
 * Fields whose admissible-evidence rule is close to mechanical, so disagreement
 * indicates a reviewer who has not internalised the rule rather than a hard case.
 */
const NEAR_MECHANICAL_FIELDS = Object.freeze(['brand', 'exactProduct']);

const UNCERTAINTY_TOKENS = Object.freeze(['not_visible', 'unknown', 'not_applicable']);

/**
 * Hash one reviewer's label set.
 *
 * Only the labels and the reviewer role are hashed. Free-text `evidenceBasis`,
 * `notes` and confidence are excluded: re-wording a rationale must not invalidate a
 * lock, but changing a label must.
 */
function lockLabelSet(reviewSubmission) {
  const canonical = {
    reviewerRole: reviewSubmission.reviewerRole,
    labels: (reviewSubmission.labels || [])
      .slice()
      .sort((a, b) => (a.blindId < b.blindId ? -1 : a.blindId > b.blindId ? 1 : 0))
      .map((label) => {
        const picked = { blindId: label.blindId };
        for (const field of REVIEWED_FIELDS) {
          picked[field] = label[field] === undefined ? null : label[field];
        }
        return picked;
      }),
    sameItemGroups: (reviewSubmission.sameItemGroups || [])
      .map((group) => group.blindIds.slice().sort())
      .sort((a, b) => (a.join() < b.join() ? -1 : 1)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Normalise for comparison without collapsing meaningfully distinct values. */
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  return text === '' ? null : text;
}

/**
 * Compare two locked label sets field by field.
 *
 * Uncertainty-token disagreements are surfaced as their own class, because
 * `not_visible` vs `unknown` vs `not_applicable` changes how the model's later
 * behaviour is scored and is a rule misunderstanding rather than a perception
 * difference.
 */
function compareReviews(reviewA, reviewB) {
  const byIdA = new Map((reviewA.labels || []).map((l) => [l.blindId, l]));
  const byIdB = new Map((reviewB.labels || []).map((l) => [l.blindId, l]));
  const blindIds = [...new Set([...byIdA.keys(), ...byIdB.keys()])].sort();

  const disagreements = [];
  const perField = {};
  for (const field of REVIEWED_FIELDS) perField[field] = { compared: 0, agreed: 0 };

  for (const blindId of blindIds) {
    const a = byIdA.get(blindId);
    const b = byIdB.get(blindId);
    if (!a || !b) {
      disagreements.push({
        blindId,
        field: '*',
        kind: 'missing_label',
        reviewerA: a ? 'present' : 'absent',
        reviewerB: b ? 'present' : 'absent',
      });
      continue;
    }
    for (const field of REVIEWED_FIELDS) {
      const left = normalizeValue(a[field]);
      const right = normalizeValue(b[field]);
      perField[field].compared += 1;
      if (left === right) {
        perField[field].agreed += 1;
        continue;
      }
      const bothTokens = UNCERTAINTY_TOKENS.includes(String(left))
        && UNCERTAINTY_TOKENS.includes(String(right));
      disagreements.push({
        blindId,
        field,
        kind: bothTokens ? 'uncertainty_token' : 'value',
        nearMechanical: NEAR_MECHANICAL_FIELDS.includes(field),
        reviewerA: a[field] === undefined ? null : a[field],
        reviewerB: b[field] === undefined ? null : b[field],
        reviewerAEvidence: a.brandEvidence && field === 'brand' ? a.brandEvidence : a.evidenceBasis || null,
        reviewerBEvidence: b.brandEvidence && field === 'brand' ? b.brandEvidence : b.evidenceBasis || null,
      });
    }
  }

  // Same-item identity is a set comparison, not a field comparison.
  const groupsA = (reviewA.sameItemGroups || []).map((g) => g.blindIds.slice().sort().join('+')).sort();
  const groupsB = (reviewB.sameItemGroups || []).map((g) => g.blindIds.slice().sort().join('+')).sort();
  const sameItemAgreed = JSON.stringify(groupsA) === JSON.stringify(groupsB);
  if (!sameItemAgreed) {
    disagreements.push({
      blindId: '*',
      field: 'sameItemAcrossImages',
      kind: 'same_item_identity',
      reviewerA: groupsA,
      reviewerB: groupsB,
    });
  }

  const agreement = {};
  for (const [field, counts] of Object.entries(perField)) {
    agreement[field] = {
      ...counts,
      rate: counts.compared === 0 ? null : counts.agreed / counts.compared,
    };
  }

  const totalCompared = Object.values(perField).reduce((sum, c) => sum + c.compared, 0);
  const totalAgreed = Object.values(perField).reduce((sum, c) => sum + c.agreed, 0);

  return {
    blindIds,
    disagreements,
    disagreementCount: disagreements.length,
    agreementByField: agreement,
    overall: {
      comparedFieldInstances: totalCompared,
      agreedFieldInstances: totalAgreed,
      rate: totalCompared === 0 ? null : totalAgreed / totalCompared,
    },
    sameItem: { agreed: sameItemAgreed, reviewerA: groupsA, reviewerB: groupsB },
  };
}

/**
 * The interpretation that must travel with any agreement number from this process.
 * Returned as data so a report cannot quietly drop it.
 */
function agreementInterpretation() {
  return {
    measures: 'agreement between two isolated same-model labeling sessions',
    doesNotMeasure: 'human inter-reviewer agreement',
    whyOptimistic:
      'Both reviewers share a model, so their errors are correlated. Agreement is an '
      + 'OPTIMISTIC bound on how unambiguous the labeling rules are, not an estimate of '
      + 'what two independent humans would produce.',
    comparabilityRule:
      'This figure must never be compared against, or presented as, a human '
      + 'inter-reviewer agreement rate.',
    isolationBasis:
      'Separate agent sessions with no shared context, blinded image ids decorrelated '
      + 'from case ids, identical briefs, no access to the curator draft, no access to '
      + 'each other, and no model or Scanner output in existence at review time.',
  };
}

/**
 * Validate a reviewer's self-declaration.
 * A false declaration invalidates the review; a missing one is treated as false.
 */
function verifyIntegrityDeclaration(submission) {
  const declaration = submission && submission.integrityDeclaration;
  const failures = [];
  if (!declaration) {
    return { ok: false, failures: [{ check: 'declaration_present', message: 'no integrity declaration supplied' }] };
  }
  if (declaration.labeledOnlyFromImages !== true) {
    failures.push({ check: 'labeled_only_from_images', message: 'reviewer did not confirm labeling from images alone' });
  }
  for (const [field, message] of Object.entries({
    readAnyExistingLabels: 'reviewer reports having seen existing labels',
    sawOtherReviewerWork: "reviewer reports having seen the other reviewer's work",
    sawAnyModelOutput: 'reviewer reports having seen model output',
    attemptedProvenanceLookup: 'reviewer reports attempting a provenance lookup',
  })) {
    if (declaration[field] === true) failures.push({ check: field, message });
  }
  return { ok: failures.length === 0, failures };
}

module.exports = {
  REVIEWED_FIELDS,
  NEAR_MECHANICAL_FIELDS,
  UNCERTAINTY_TOKENS,
  lockLabelSet,
  compareReviews,
  agreementInterpretation,
  verifyIntegrityDeclaration,
};
