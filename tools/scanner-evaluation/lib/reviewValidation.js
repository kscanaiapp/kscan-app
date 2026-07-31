'use strict';

const taxonomy = require('../ontology/fashion-taxonomy.v1.json');
const colors = require('../ontology/color-families.v1.json');
const materials = require('../ontology/material-families.v1.json');
const guide = require('./labelingGuide');
const { REVIEWED_FIELDS, verifyIntegrityDeclaration } = require('./holdoutReview');

const UNCERTAINTY = new Set(Object.values(guide.UNAVAILABLE));
const CATEGORIES = new Set(Object.keys(taxonomy.hierarchy).filter((value) => value !== 'NON_FASHION'));
const CLOTHING_TYPES = new Set();
const SUBTYPES = new Set();
for (const node of Object.values(taxonomy.hierarchy)) {
  for (const [clothingType, values] of Object.entries(node.clothingTypes || {})) {
    CLOTHING_TYPES.add(clothingType);
    values.forEach((value) => SUBTYPES.add(value));
  }
}
const COLORS = new Set([
  ...colors.baseFamilies,
  ...Object.keys(colors.importedFamilyMap),
  'teal',
  'olive',
]);
const MATERIALS = new Set(materials.importedSupportedMaterials);
const EXPECTED_RESULTS = new Set([
  'likely_exact_match', 'closest_matches', 'identified_style', 'insufficient_evidence',
]);
const SAME_ITEM = new Set([true, false, 'unknown', 'not_applicable']);

function normalizeReviewSubmission(submission) {
  if (!submission || typeof submission !== 'object') return submission;
  const nestedCases = Array.isArray(submission.cases) ? submission.cases : [];
  const sourceLabels = Array.isArray(submission.labels)
    ? submission.labels
    : nestedCases.map((reviewCase) => ({
      blindId: reviewCase.blindId,
      ...(reviewCase.labels || {}),
      fieldEvidence: Object.fromEntries(
        Object.entries(reviewCase.fieldReviews || reviewCase.fieldEvidence || {})
          .map(([field, review]) => [field, review && typeof review === 'object' ? review.evidence : review])
      ),
      evidenceBasis: { blindImageIds: reviewCase.blindImageIds || [], basis: 'direct visual inspection' },
    }));
  const labels = sourceLabels.map((label) => ({
    ...label,
    fieldEvidence: Object.fromEntries(
      Object.entries(label.fieldEvidence || {}).map(([field, evidence]) => [
        field,
        evidence && typeof evidence === 'object' ? evidence.evidence : evidence,
      ])
    ),
  }));
  const memory = submission.memoryContextDeclaration || {};
  const declaredIntegrity = submission.integrityDeclaration || {};
  const integrityDeclaration = declaredIntegrity.labeledOnlyFromImages !== undefined
    ? declaredIntegrity
    : {
      labeledOnlyFromImages:
        (memory.usedOnlyReviewBriefNamedGuideOpaqueImagesAndGovernanceSummaries === true
          || memory.reviewedOnlyBriefNamedGuideOpaqueImagesAndGovernanceSummaries === true
          || (declaredIntegrity.noExternalResourcesUsed === true
            && Array.isArray(memory.allowedContextUsed)))
        && (declaredIntegrity.allOpaqueImagesInspected === true
          || declaredIntegrity.allNineOpaqueImagesInspectedWithViewImage === true
          || (declaredIntegrity.allSuppliedImagesInspectedWithViewImage === true
            && declaredIntegrity.noExternalResourcesUsed === true)),
      readAnyExistingLabels:
        memory.usedCuratorDraft === true
        || memory.curatorDraftUsed === true
        || memory.usedSourceProvenanceTitleOrCuratorDraft === true
        || memory.usedPriorOrInvalidatedReview === true
        || memory.priorOrInvalidatedReviewUsed === true,
      sawOtherReviewerWork:
        memory.usedConversationHistoryOrOtherAgentWork === true
        || memory.usedOtherAgentWork === true
        || memory.otherAgentWorkUsed === true
        || memory.usedPriorOrInvalidatedReview === true
        || memory.priorOrInvalidatedReviewUsed === true,
      sawAnyModelOutput:
        memory.usedScannerOrModelOutput === true || memory.scannerOrModelOutputUsed === true,
      attemptedProvenanceLookup:
        memory.usedRepositoryManifest === true
        || memory.repositoryManifestUsed === true
        || memory.usedPrivateCaseMap === true
        || memory.privateCaseMapUsed === true
        || memory.usedSourceProvenanceOrTitles === true
        || memory.sourceProvenanceOrTitleUsed === true,
    };
  return {
    ...submission,
    guideSha256:
      submission.guideSha256 || submission.reviewedGuideSha256 || submission.reviewedGuideHash,
    labels,
    integrityDeclaration,
  };
}

function validateReviewSubmission(submission, brief, { expectedRole } = {}) {
  submission = normalizeReviewSubmission(submission);
  const errors = [];
  const push = (path, message) => errors.push({ path, message });
  if (!submission || typeof submission !== 'object') return { ok: false, errors: [{ path: '', message: 'submission must be an object' }] };
  if (expectedRole && submission.reviewerRole !== expectedRole) push('reviewerRole', `must equal ${expectedRole}`);
  if (submission.reviewedGuideVersion !== guide.GUIDE_VERSION) push('reviewedGuideVersion', `must equal ${guide.GUIDE_VERSION}`);
  for (const [field, expected] of [
    ['guideSha256', brief.guideSha256],
    ['opaqueCaseMapSha256', brief.opaqueCaseMapSha256],
    ['sourceImageAggregateSha256', brief.sourceImageAggregateSha256],
  ]) if (submission[field] !== expected) push(field, 'does not match blinded brief');

  const integrity = verifyIntegrityDeclaration(submission);
  for (const failure of integrity.failures) push(`integrityDeclaration.${failure.check}`, failure.message);
  if (!submission.memoryContextDeclaration || typeof submission.memoryContextDeclaration !== 'object') {
    push('memoryContextDeclaration', 'required');
  }

  const labels = Array.isArray(submission.labels) ? submission.labels : [];
  const expectedCases = new Map(brief.cases.map((record) => [record.blindId, record]));
  const actualIds = labels.map((label) => label.blindId);
  if (labels.length !== expectedCases.size) push('labels', `expected ${expectedCases.size} labels, found ${labels.length}`);
  if (new Set(actualIds).size !== actualIds.length) push('labels', 'duplicate blindId');
  for (const id of expectedCases.keys()) if (!actualIds.includes(id)) push('labels', `missing ${id}`);
  for (const id of actualIds) if (!expectedCases.has(id)) push('labels', `unexpected ${id}`);

  const scalarToken = (label, field, values) => {
    if (!values.has(label[field]) && !UNCERTAINTY.has(label[field])) push(`${label.blindId}.${field}`, 'not in controlled vocabulary');
  };

  for (const label of labels) {
    const reviewCase = expectedCases.get(label.blindId);
    if (!reviewCase) continue;
    for (const field of [...REVIEWED_FIELDS, 'labelConfidence']) {
      if (label[field] === undefined) push(`${label.blindId}.${field}`, 'required field missing');
      if (!label.fieldEvidence || typeof label.fieldEvidence[field] !== 'string' || !label.fieldEvidence[field].trim()) {
        push(`${label.blindId}.fieldEvidence.${field}`, 'required non-empty field evidence');
      }
    }
    scalarToken(label, 'category', CATEGORIES);
    scalarToken(label, 'clothingType', CLOTHING_TYPES);
    scalarToken(label, 'subtype', SUBTYPES);
    scalarToken(label, 'primaryColor', COLORS);
    scalarToken(label, 'material', MATERIALS);
    if (Array.isArray(label.secondaryColors)) {
      label.secondaryColors.forEach((value, index) => {
        if (!COLORS.has(value)) push(`${label.blindId}.secondaryColors[${index}]`, 'not in controlled color vocabulary');
      });
    } else if (!UNCERTAINTY.has(label.secondaryColors)) push(`${label.blindId}.secondaryColors`, 'must be a color array or uncertainty token');
    if (!EXPECTED_RESULTS.has(label.expectedResultType)) push(`${label.blindId}.expectedResultType`, 'unsupported result type');
    for (const field of ['nonFashion', 'visiblePerson', 'expectedAbstention', 'privacyAndAuthorizationComplete']) {
      if (typeof label[field] !== 'boolean') push(`${label.blindId}.${field}`, 'must be boolean');
    }
    if (!Object.values(guide.BRAND_EVIDENCE_STATES).includes(label.brandEvidenceState)) push(`${label.blindId}.brandEvidenceState`, 'unsupported brand evidence state');
    const expectedBrand = {
      [guide.BRAND_EVIDENCE_STATES.PRODUCT_LEVEL]: guide.EXPECTED_BRAND_OUTCOMES.PRODUCT_LEVEL,
      [guide.BRAND_EVIDENCE_STATES.CONTEXTUAL_ONLY]: guide.EXPECTED_BRAND_OUTCOMES.CONTEXTUAL_ONLY,
      [guide.BRAND_EVIDENCE_STATES.NONE]: guide.EXPECTED_BRAND_OUTCOMES.NONE,
    }[label.brandEvidenceState];
    if (label.expectedBrandAssertionBehavior !== expectedBrand) push(`${label.blindId}.expectedBrandAssertionBehavior`, 'does not match brand evidence state');
    if (!Object.values(guide.SUBJECT_DESIGNATIONS).includes(label.subjectDesignation)) push(`${label.blindId}.subjectDesignation`, 'unsupported subject designation');
    if (!SAME_ITEM.has(label.sameItemAcrossImages)) push(`${label.blindId}.sameItemAcrossImages`, 'unsupported same-item value');
    const imageCount = reviewCase.images.length;
    if (imageCount === 1 && label.sameItemAcrossImages !== 'not_applicable') push(`${label.blindId}.sameItemAcrossImages`, 'single-image case must be not_applicable');
    if (imageCount > 1 && label.sameItemAcrossImages === 'not_applicable') push(`${label.blindId}.sameItemAcrossImages`, 'multi-view case cannot be not_applicable');
    if (!['high', 'medium', 'low', 'unknown'].includes(label.labelConfidence)) push(`${label.blindId}.labelConfidence`, 'unsupported confidence');
    if (label.privacyAndAuthorizationComplete !== reviewCase.governance.complete) push(`${label.blindId}.privacyAndAuthorizationComplete`, 'does not match blinded governance summary');

    if (label.nonFashion === true) {
      const canonical = guide.canonicalNonFashionLabels();
      for (const field of guide.NON_FASHION_FIELDS) if (label[field] !== canonical[field]) push(`${label.blindId}.${field}`, 'non-fashion field is not canonically unavailable');
      if (label.expectedResultType !== canonical.expectedResultType || label.expectedAbstention !== true) push(`${label.blindId}.expectedResultType`, 'non-fashion case must use certified abstention state');
    }
    if (label.subjectDesignation === guide.SUBJECT_DESIGNATIONS.AMBIGUOUS_NO_DOMINANT) {
      if (label.expectedResultType !== 'insufficient_evidence' || label.expectedAbstention !== true) push(`${label.blindId}.subjectDesignation`, 'ambiguous case must abstain');
      for (const field of ['category', 'clothingType', 'subtype', 'primaryColor', 'material', 'pattern', 'brand', 'exactProduct']) {
        if (label[field] !== 'unknown') push(`${label.blindId}.${field}`, 'ambiguous case item field must be unknown');
      }
    }
  }
  return { ok: errors.length === 0, errors, labelCount: labels.length, normalized: submission };
}

module.exports = { normalizeReviewSubmission, validateReviewSubmission };
