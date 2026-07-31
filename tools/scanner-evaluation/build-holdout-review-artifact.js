'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const REPO = 'C:/Users/jsmit/KScan-scanner-accuracy-v2-evals';
const SP = 'C:/Users/jsmit/AppData/Local/Temp/claude/C--Users-jsmit-KScan-local-hold/bf919243-78ab-47f3-a071-992bc7860f75/scratchpad/holdout-review/private';
const hr = require(path.join(REPO, 'tools/scanner-evaluation/lib/holdoutReview'));

const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const A = rd(SP + '/reviewer-A-submission.json');
const B = rd(SP + '/reviewer-B-submission.json');
const ADJ = rd(SP + '/adjudication.json');
const map = rd(SP + '/blind-mapping.json').mapping;
const freeze = rd(path.join(REPO, 'evals/scanner-accuracy/tier-a-freeze.v0.3.0.json'));

const cmp = hr.compareReviews(A, B);
const b2c = new Map(map.map((m) => [m.blindId, m.caseId]));
const holdoutCases = [...new Set(map.map((m) => m.caseId))].sort();

const unresolved = {};
const add = (bid, field, note) => {
  const c = b2c.get(bid);
  (unresolved[c] = unresolved[c] || []).push({ blindId: bid, field, note });
};
for (const r of ADJ.rulings) {
  if (r.verdict === 'unresolvable_guide_gap') add(r.blindId, r.field, 'adjudicated unresolvable_guide_gap');
}
for (const d of cmp.disagreements) {
  if (d.field === 'visiblePerson') {
    add(d.blindId, 'visiblePerson',
      'divergent and NEVER ADJUDICATED - the field was missing from the compared set at adjudication time');
  }
}

const artifact = {
  reviewArtifactVersion: '1.0.0',
  artifactKind: 'INDEPENDENT HOLDOUT REVIEW RECORD',
  immutable: true,
  createdAt: new Date().toISOString(),
  boundTo: {
    datasetVersion: '0.3.0',
    datasetAggregateSha256: freeze.aggregateSha256,
    split: 'holdout',
    holdoutCaseIds: holdoutCases,
    holdoutCaseCount: holdoutCases.length,
    holdoutViewCount: map.length,
  },
  whyThisIsNotADatasetChange:
    'Clarification 3: approvals, reviewer identities, timestamps, locks, disagreements and adjudication live in an '
    + 'immutable review artifact tied to v0.3.0. Frozen dataset v0.3.0 was NOT modified and no reviewStatus was rewritten in it.',
  reviewerSeats: {
    curatorExcluded: true,
    curatorExclusionBasis:
      'The Phase 0H curation records carry decidedBy "build-lead visual review". That agent authored the draft labels '
      + 'and therefore held NO review seat and NO adjudication seat.',
    seats: [
      { role: 'A', kind: 'isolated agent session' },
      { role: 'B', kind: 'isolated agent session' },
      { role: 'adjudicator', kind: 'isolated agent session, separate from both reviewers' },
    ],
  },
  blindingMethod: {
    why:
      'All 8 holdout case ids leak ground truth: 7 embed their level-1 category (tiera-footwear-*, tiera-non_fashion-*, '
      + 'tiera-dress-*, tiera-top-*) and set-501xx-jeans additionally leaks a clothing type and a brand model '
      + 'designation for a case whose brand ground truth is not_visible.',
    method:
      'Each holdout view was copied to an opaque id hv-01..hv-09 outside every Git worktree, ordered deterministically '
      + 'by sha256 of the governed ref so presentation order carries no information about manifest order or grouping.',
    multiImageGroupingHidden: true,
    multiImageGroupingNote:
      'The one manifest multi-image case landed at non-adjacent blind ids, so same-item identity had to be decided by '
      + 'the reviewers rather than inferred from adjacency.',
    reviewersReceived: ['the 9 blinded images', 'one identical brief'],
    reviewersDidNotReceive: [
      'case ids',
      'the curator draft labels',
      'the manifest',
      'the other reviewer decisions',
      'any model or Scanner output',
    ],
  },
  isolationOutcome: {
    integrityA: hr.verifyIntegrityDeclaration(A),
    integrityB: hr.verifyIntegrityDeclaration(B),
    allDeclarationsPass: true,
    knownImperfection: {
      finding:
        'All three sessions independently disclosed that this project persistent auto-memory index was present in '
        + 'their context, referencing Build 4 dataset design in general terms (41 cases / 56 images, three-tier brand '
        + 'evidence, exact product not_measured).',
      containedPerImageLabels: false,
      namedAnyReviewedImage: false,
      assessment:
        'Isolation was imperfect BY CONSTRUCTION, not by reviewer error. The exposure is dataset-wide policy rather '
        + 'than labels, and the brief itself already stated exact product would usually be unknown, so the marginal '
        + 'information is small. Recorded rather than dismissed; any future review must use memory-free sessions.',
      severity: 'P2',
    },
    adjudicatorProtocolDeviation: {
      disclosed: true,
      deviation: 'Instructed to write no files; wrote three temporary magnified image crops to scratchpad to zoom pixels.',
      containedLabelsOrFindings: false,
      assessment: 'Honestly disclosed, no label or finding written, no effect on independence. Recorded for completeness.',
      severity: 'P3',
    },
  },
  locks: {
    reviewerALockSha256: hr.lockLabelSet(A),
    reviewerBLockSha256: hr.lockLabelSet(B),
    lockedBeforeComparison: true,
    lockCoverage:
      'the reviewed label fields and the same-item groupings; deliberately excludes free-text rationale and confidence '
      + 'so re-wording cannot invalidate a lock while any label change does',
    reviewedFields: hr.REVIEWED_FIELDS,
    lockGenerations: {
      note:
        'TWO lock generations exist and both are recorded, because the lock DEFINITION changed after locking while the '
        + 'label sets did not. The submissions are byte-identical to what each reviewer returned; no label was edited.',
      generation1: {
        reviewedFieldCount: 11,
        reviewerALockSha256: '967a0b3fd192add6ca47c68b3638c0ca46e120a23e43c086de4720967cc1b9a3',
        reviewerBLockSha256: '3949952f3556c149d728d1e44c4f5c1d925bcf93a46dd4f9110d0e736feec153',
        takenAt: 'immediately on receipt of each submission, before any comparison ran',
      },
      generation2: {
        reviewedFieldCount: 12,
        reviewerALockSha256: hr.lockLabelSet(A),
        reviewerBLockSha256: hr.lockLabelSet(B),
        reason:
          'The adjudicator identified that visiblePerson was absent from the compared field set, so a genuine '
          + 'divergence (hv-01: A true, B false) appeared in neither the agreement table nor the disagreement list and '
          + 'would have entered the dataset with whichever value a merge happened to take. visiblePerson was added to '
          + 'the reviewed set and the locks recomputed over the SAME unmodified submissions.',
        consequence:
          'Agreement denominator moved from 99 to 108 field instances and one further divergence surfaced. That '
          + 'divergence is recorded as unresolved because it was never adjudicated.',
      },
    },
  },
  agreement: {
    overall: cmp.overall,
    byField: cmp.agreementByField,
    sameItem: cmp.sameItem,
    interpretation: hr.agreementInterpretation(),
    headlineCaveat:
      'The raw rate is exact-string agreement and materially UNDERSTATES substantive agreement. The adjudicator '
      + 'classified the disagreements as 9 phrasing, 6 granularity, 14 traceable to missing or self-contradictory '
      + 'rules, and exactly 1 genuine perception difference. No adjusted percentage is published, because inventing '
      + 'one after seeing the results would be tuning the metric.',
  },
  adjudication: {
    summary: ADJ.summary,
    standardApplied:
      'Ruled on evidence, never by vote. unresolvable_guide_gap is a first-class verdict where a disagreement traces '
      + 'to a missing or contradictory rule; forcing a resolution would convert a rule problem into a silently '
      + 'unreliable label.',
    rulings: ADJ.rulings,
    sameItemAssessment: ADJ.sameItemAssessment,
  },
  unresolved: {
    caseCount: Object.keys(unresolved).length,
    requirementForPaidExecution: 0,
    cases: unresolved,
    fullyResolvedCaseIds: holdoutCases.filter((c) => !unresolved[c]),
  },
  guideGapsRequiringOwnerDecision: ADJ.guideGapsRequiringOwnerDecision,
  datasetConcerns: ADJ.datasetConcerns,
  holdoutSeal: {
    issued: false,
    refusalReason:
      'A holdout seal asserts that frozen, adjudicated ground truth exists for every holdout case. It does not: 5 of 8 '
      + 'cases carry at least one field the adjudicator ruled unresolvable pending an owner decision, plus one '
      + 'divergent field that was never adjudicated. Sealing now would freeze incomplete ground truth and present '
      + 'unresolved fields as settled.',
    requirementsMet: [
      'reviewer A completion',
      'reviewer B completion',
      'adjudication completion',
      'locked-label hashes',
      'dataset aggregate binding',
    ],
    requirementsNotMet: ['unresolved cases = 0'],
    canBeIssuedWhen: 'the owner rules on G-1 through G-8 and the affected fields are re-adjudicated under the new rules',
  },
  datasetPatchAssessment: {
    v031Created: false,
    whyNot:
      'Adjudicated labels differ from the v0.3.0 draft in several places AND 13 fields remain unresolved. Freezing a '
      + 'patch now would bake in incomplete ground truth. Clarification 3 requires a patch once review has SETTLED a '
      + 'label; it has not.',
    confirmedDraftDefects: [
      {
        caseId: 'tiera-footwear-537f81fab6',
        field: 'expectedResultType',
        draft: 'identified_style',
        bothReviewersIndependently: 'closest_matches',
        basis: 'brand is established from an on-item wordmark and no SKU is determinable, which is the guide table definition of closest_matches',
        severity: 'P1',
      },
      {
        caseId: 'set-501xx-jeans',
        field: 'primaryColor',
        draft: 'blue',
        adjudicated: 'dark indigo',
        basis: 'the guide requires the shade you can see, not the family; the draft used the family',
        severity: 'P2',
      },
      {
        caseId: 'tiera-top-1144bf2cff',
        field: 'primaryColor',
        draft: 'white',
        bothReviewersIndependently: 'unknown',
        basis: 'multi-item stall with no designated subject; the draft picked one shirt arbitrarily',
        severity: 'P2',
      },
      {
        caseId: 'the three NON_FASHION cases',
        field: 'brand / primaryColor',
        draft: 'inconsistent: one has brand not_applicable, two have brand not_visible; two carry primaryColor white on a non-fashion item',
        basis: 'internal inconsistency in the draft, caught by the review',
        severity: 'P2',
      },
    ],
    sameItemDuplication: {
      finding:
        'tiera-non_fashion-635218364b and tiera-non_fashion-323cd4e23c are TWO VIEWS OF ONE PHYSICAL MUG, confirmed '
        + 'independently by reviewer A, reviewer B and the adjudicator at high confidence on forensic detail '
        + '(letterform strokes, lustre band positions, inscription break point, foot-ring notch, and differing camera '
        + 'height and white balance proving two exposures rather than one crop).',
      manifestTreatment: 'two independent single-image holdout cases',
      violates: 'the project rule that a same-item set is ONE case with N images',
      consequence:
        'the holdout is 7 distinct physical objects across 8 declared cases; the non-fashion stratum tests 2 distinct '
        + 'objects, one of them twice; that object is double-weighted in every holdout aggregate',
      severity: 'P0',
      requiresOwnerDecision: true,
    },
    measurementCapacityFinding: {
      declaredHoldout: '8 cases / 9 images',
      actualDistinctObjects: 7,
      nonFashionCeramicsFromOneMuseumCase: 3,
      multiItemFramesYieldingNoItemLevelTruth: 2,
      distinctSingleSubjectFashionObjects: 3,
      admissiblePositiveBrandCases: 1,
      conclusion:
        'No per-field accuracy figure computed over this holdout can support a release claim. This is a capacity '
        + 'finding about the corpus, not a Scanner result.',
      severity: 'P1',
    },
  },
  reviewerRaisedGuideFeedback: { reviewerA: A.notes, reviewerB: B.notes },
  privacyCompliance: {
    reviewerIdentitiesStoredInCaseRecords: false,
    note: 'Roles only, per the identity policy. No reviewer name, email or id appears anywhere in this artifact.',
  },
};

artifact.artifactSha256 = crypto.createHash('sha256').update(JSON.stringify({
  boundTo: artifact.boundTo,
  locks: artifact.locks,
  rulings: artifact.adjudication.rulings,
  unresolved: artifact.unresolved,
})).digest('hex');

const out = path.join(REPO, 'evals/scanner-accuracy/review/holdout-review.v0.3.0.json');
fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
console.log('artifact:', out);
console.log('artifactSha256:', artifact.artifactSha256);
console.log('lockA:', artifact.locks.reviewerALockSha256);
console.log('lockB:', artifact.locks.reviewerBLockSha256);
console.log('reviewedFields:', hr.REVIEWED_FIELDS.length);
console.log('agreement:', cmp.overall.agreedFieldInstances + '/' + cmp.overall.comparedFieldInstances);
console.log('unresolved cases:', artifact.unresolved.caseCount, 'of', holdoutCases.length);
console.log('fullyResolved:', artifact.unresolved.fullyResolvedCaseIds.join(', '));
console.log('seal issued:', artifact.holdoutSeal.issued);
console.log('v0.3.1 created:', artifact.datasetPatchAssessment.v031Created);
console.log('contains reviewer name/email?', /@|reviewerName/.test(JSON.stringify(artifact)));
