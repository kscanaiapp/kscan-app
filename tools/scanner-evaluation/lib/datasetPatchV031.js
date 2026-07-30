'use strict';

const crypto = require('crypto');

const { canonicalNonFashionLabels } = require('./labelingGuide');

const SOURCE_VERSION = '0.3.0';
const PATCH_VERSION = '0.3.1';
const DUPLICATE_CASE_IDS = Object.freeze([
  'tiera-non_fashion-635218364b',
  'tiera-non_fashion-323cd4e23c',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceIdentity(manifest) {
  const cases = (manifest.cases || [])
    .map((record) => ({
      caseId: record.caseId,
      imageHashes: (record.imageHashes || []).slice(),
      split: (manifest.split.development || []).includes(record.caseId) ? 'development' : 'holdout',
    }))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
  return sha256(JSON.stringify({ datasetVersion: manifest.datasetVersion, cases }));
}

function mergedCaseId(left, right) {
  const hashes = [...left.imageHashes, ...right.imageHashes].slice().sort();
  return `case-${sha256(`owner-confirmed-same-item|${hashes.join('|')}`).slice(0, 16)}`;
}

function buildMergedMugCase(left, right) {
  const caseId = mergedCaseId(left, right);
  const canonical = canonicalNonFashionLabels();
  return {
    ...deepClone(left),
    ...canonical,
    caseId,
    datasetVersion: PATCH_VERSION,
    imageReferences: [...deepClone(left.imageReferences), ...deepClone(right.imageReferences)],
    imageHashes: [...left.imageHashes, ...right.imageHashes],
    imageCount: 2,
    sameItemAcrossImages: true,
    sameItemSetId: `${caseId}-views`,
    provenance: deepClone(left.provenance),
    provenanceViews: [deepClone(left.provenance), deepClone(right.provenance)],
    reviewStatus: 'draft',
    reviewerCount: 0,
    labelConfidence: 'high',
    curation: {
      status: 'owner_confirmed_patch',
      decidedBy: 'project owner decision',
      subjectConfirmed: true,
      note: 'Two views of one physical Preston Guild mug; both source images are retained.',
    },
    patchMetadata: {
      patchVersion: PATCH_VERSION,
      originalCaseIds: DUPLICATE_CASE_IDS.slice(),
      originalSourceHashes: [...left.imageHashes, ...right.imageHashes],
      mergeEvidence:
        'Owner-confirmed same physical object. Independent isolated AI review passes and adjudication '
        + 'identified matching inscription strokes, lustre-band placement, inscription break point, '
        + 'foot-ring notch, and distinct camera height/white balance across the two views.',
      caseWeight: 1,
    },
    notes: 'Owner-confirmed two-view non-fashion control. One physical object and one case weight.',
  };
}

function buildCandidate(sourceManifest) {
  if (!sourceManifest || sourceManifest.datasetVersion !== SOURCE_VERSION) {
    throw new Error(`v0.3.1 must be built from immutable dataset ${SOURCE_VERSION}`);
  }
  const source = deepClone(sourceManifest);
  const originals = DUPLICATE_CASE_IDS.map((id) => source.cases.find((record) => record.caseId === id));
  if (originals.some((record) => !record)) throw new Error('both owner-identified duplicate mug cases are required');

  const merged = buildMergedMugCase(originals[0], originals[1]);
  const duplicateSet = new Set(DUPLICATE_CASE_IDS);
  const cases = source.cases
    .filter((record) => !duplicateSet.has(record.caseId))
    .map((record) => {
      const next = { ...deepClone(record), datasetVersion: PATCH_VERSION, reviewStatus: 'draft', reviewerCount: 0 };
      if (next.nonFashion === true) Object.assign(next, canonicalNonFashionLabels());
      return next;
    });

  const firstOriginalIndex = source.cases.findIndex((record) => duplicateSet.has(record.caseId));
  const insertionIndex = source.cases
    .slice(0, firstOriginalIndex)
    .filter((record) => !duplicateSet.has(record.caseId)).length;
  cases.splice(insertionIndex, 0, merged);

  const holdout = [];
  let inserted = false;
  for (const id of source.split.holdout) {
    if (!duplicateSet.has(id)) {
      holdout.push(id);
    } else if (!inserted) {
      holdout.push(merged.caseId);
      inserted = true;
    }
  }

  const manifest = {
    ...source,
    datasetVersion: PATCH_VERSION,
    generatedAt: '2026-07-30',
    caseCount: cases.length,
    sourceImageCount: cases.reduce((sum, record) => sum + record.imageCount, 0),
    patchState: 'review_candidate',
    sourceVersion: SOURCE_VERSION,
    sourceAggregateSha256: sourceIdentity(source),
    benchmarkLimitations: (source.benchmarkLimitations || []).map((item) =>
      item === 'no repeated views of the same physical garment'
        ? 'only one confirmed same-item multi-view object, and it is a non-fashion control'
        : item
    ),
    split: {
      ...deepClone(source.split),
      development: source.split.development.slice(),
      holdout,
    },
    cases,
  };

  const validation = validateCandidate(manifest);
  if (!validation.ok) {
    throw new Error(`invalid v0.3.1 candidate: ${validation.errors.join('; ')}`);
  }
  return manifest;
}

function validateCandidate(manifest) {
  const errors = [];
  const cases = Array.isArray(manifest && manifest.cases) ? manifest.cases : [];
  const ids = new Set(cases.map((record) => record.caseId));
  const images = cases.reduce((sum, record) => sum + (record.imageReferences || []).length, 0);
  if (manifest.datasetVersion !== PATCH_VERSION) errors.push('datasetVersion must be 0.3.1');
  if (cases.length !== 40 || manifest.caseCount !== 40) errors.push('case count must be 40');
  if (images !== 56 || manifest.sourceImageCount !== 56) errors.push('source image count must be 56');
  if ((manifest.split.development || []).length !== 33) errors.push('development count must be 33');
  if ((manifest.split.holdout || []).length !== 7) errors.push('holdout count must be 7');
  if ((manifest.split.development || []).some((id) => !ids.has(id))) errors.push('development split names a missing case');
  if ((manifest.split.holdout || []).some((id) => !ids.has(id))) errors.push('holdout split names a missing case');
  if (DUPLICATE_CASE_IDS.some((id) => ids.has(id))) errors.push('original duplicate case ids must not remain');
  const merged = cases.filter((record) => record.patchMetadata && record.patchMetadata.caseWeight === 1);
  if (merged.length !== 1) errors.push('exactly one merged same-item case is required');
  if (merged.length === 1) {
    if (merged[0].imageCount !== 2 || merged[0].sameItemAcrossImages !== true) {
      errors.push('merged mug must be a two-image same-item case');
    }
    if (!manifest.split.holdout.includes(merged[0].caseId)) errors.push('merged mug must remain holdout');
  }
  for (const record of cases.filter((item) => item.nonFashion === true)) {
    const canonical = canonicalNonFashionLabels();
    for (const field of Object.keys(canonical)) {
      if (record[field] !== canonical[field]) errors.push(`${record.caseId}.${field} is not canonical non-fashion encoding`);
    }
  }
  return { ok: errors.length === 0, errors, mergedCaseId: merged[0] ? merged[0].caseId : null };
}

module.exports = {
  SOURCE_VERSION,
  PATCH_VERSION,
  DUPLICATE_CASE_IDS,
  sha256,
  sourceIdentity,
  mergedCaseId,
  buildMergedMugCase,
  buildCandidate,
  validateCandidate,
};
