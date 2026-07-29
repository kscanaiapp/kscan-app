'use strict';

/**
 * Development / holdout split (Phase 0B sections 7 and 8).
 *
 * RULES ENFORCED HERE, NOT LEFT TO DISCIPLINE:
 *   - membership is disjoint;
 *   - synthetic imagery never enters the holdout;
 *   - the holdout carries representation from each required stratum;
 *   - membership is deterministic, so the same dataset always splits the same
 *     way and a "re-split" cannot quietly move a case that scored badly.
 *
 * The split is frozen with the dataset version. After the freeze, membership is
 * immutable: holdout results must never be used to tune prompts, thresholds,
 * ontology rules or reranking candidates.
 */

const crypto = require('crypto');

const SYNTHETIC_SOURCE_CLASSES = new Set(['synthetic_image', 'synthetic_text_proxy']);

/** Strata the holdout must represent (section 7). */
const REQUIRED_HOLDOUT_STRATA = Object.freeze([
  'majorCategory',
  'brandVisible',
  'brandNotVisible',
  'exactProductKnowable',
  'exactProductNotKnowable',
  'insufficientEvidence',
  'nonFashion',
  'multiImage',
  'difficultLightingOrOcclusion',
]);

function isSynthetic(caseRecord) {
  return SYNTHETIC_SOURCE_CLASSES.has(caseRecord.sourceClass);
}

function strataOf(caseRecord) {
  const tags = new Set();
  if (caseRecord.category && caseRecord.category !== 'not_applicable') tags.add('majorCategory');
  if (caseRecord.brandVisible === true) tags.add('brandVisible');
  if (caseRecord.brandVisible === false) tags.add('brandNotVisible');
  if (caseRecord.exactProductKnowable === true) tags.add('exactProductKnowable');
  if (caseRecord.exactProductKnowable === false) tags.add('exactProductNotKnowable');
  if (caseRecord.expectedResultType === 'insufficient_evidence') tags.add('insufficientEvidence');
  if (caseRecord.category === 'not_applicable' || caseRecord.nonFashion === true) tags.add('nonFashion');
  if ((caseRecord.imageCount || 1) > 1) tags.add('multiImage');
  const difficulty = Array.isArray(caseRecord.difficultyTags) ? caseRecord.difficultyTags : [];
  if (difficulty.some((t) => /low_light|blur|occlusion/.test(t))) tags.add('difficultLightingOrOcclusion');
  return tags;
}

/** Deterministic ordering key. Depends only on caseId, never on a clock. */
function orderKey(caseId) {
  return crypto.createHash('sha256').update(String(caseId)).digest('hex');
}

/**
 * Produce a stratified, deterministic split.
 *
 * @param {Array<object>} cases
 * @param {{ holdoutCount: number }} options
 */
function splitDataset(cases, options = {}) {
  const holdoutCount = options.holdoutCount == null ? 15 : options.holdoutCount;
  const eligible = cases.filter((c) => !isSynthetic(c));
  const syntheticIds = cases.filter(isSynthetic).map((c) => c.caseId);

  const ordered = eligible
    .map((c) => ({ caseRecord: c, key: orderKey(c.caseId) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.caseRecord);

  const holdout = [];
  const covered = new Set();

  // Pass 1: take the first case that adds an uncovered stratum.
  for (const stratum of REQUIRED_HOLDOUT_STRATA) {
    if (holdout.length >= holdoutCount) break;
    const pick = ordered.find(
      (c) => !holdout.includes(c) && strataOf(c).has(stratum)
    );
    if (pick) {
      holdout.push(pick);
      for (const tag of strataOf(pick)) covered.add(tag);
    }
  }

  // Pass 2: fill deterministically.
  for (const caseRecord of ordered) {
    if (holdout.length >= holdoutCount) break;
    if (!holdout.includes(caseRecord)) holdout.push(caseRecord);
  }

  const holdoutIds = holdout.map((c) => c.caseId);
  const development = cases
    .filter((c) => !holdoutIds.includes(c.caseId))
    .map((c) => c.caseId);

  return {
    holdout: holdoutIds,
    development,
    syntheticExcludedFromHoldout: syntheticIds,
    coveredStrata: [...covered].sort(),
    missingStrata: REQUIRED_HOLDOUT_STRATA.filter((s) => !covered.has(s)),
    deterministic: true,
  };
}

/**
 * Validate a frozen split.
 *
 * @param {Array<object>} cases
 * @param {{ development: string[], holdout: string[] }} split
 */
function validateSplit(cases, split) {
  const errors = [];
  const byId = new Map(cases.map((c) => [c.caseId, c]));
  const dev = new Set(split.development || []);
  const hold = new Set(split.holdout || []);

  for (const id of hold) {
    if (dev.has(id)) errors.push({ path: id, message: `case ${id} is in both development and holdout` });
  }

  for (const id of [...dev, ...hold]) {
    if (!byId.has(id)) errors.push({ path: id, message: `split references unknown case ${id}` });
  }

  for (const caseRecord of cases) {
    const inDev = dev.has(caseRecord.caseId);
    const inHold = hold.has(caseRecord.caseId);
    if (!inDev && !inHold) {
      errors.push({ path: caseRecord.caseId, message: `case ${caseRecord.caseId} is in neither split` });
    }
    if (inHold && isSynthetic(caseRecord)) {
      errors.push({
        path: caseRecord.caseId,
        message: `synthetic case ${caseRecord.caseId} may not enter the holdout`,
      });
    }
  }

  const holdoutCases = [...hold].map((id) => byId.get(id)).filter(Boolean);
  const covered = new Set();
  for (const caseRecord of holdoutCases) {
    for (const tag of strataOf(caseRecord)) covered.add(tag);
  }
  const missing = REQUIRED_HOLDOUT_STRATA.filter((s) => !covered.has(s));

  // Synthetic share of the DEVELOPMENT set is capped at 20% (section 8).
  const devCases = [...dev].map((id) => byId.get(id)).filter(Boolean);
  const syntheticDev = devCases.filter(isSynthetic).length;
  const syntheticShare = devCases.length ? syntheticDev / devCases.length : 0;
  if (syntheticShare > 0.2) {
    errors.push({
      path: 'development',
      message: `synthetic imagery is ${(syntheticShare * 100).toFixed(1)}% of development, exceeding the 20% cap`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings: missing.map((s) => ({ path: 'holdout', message: `holdout lacks representation for stratum: ${s}` })),
    coveredStrata: [...covered].sort(),
    missingStrata: missing,
    syntheticDevelopmentShare: syntheticShare,
  };
}

module.exports = {
  SYNTHETIC_SOURCE_CLASSES,
  REQUIRED_HOLDOUT_STRATA,
  isSynthetic,
  strataOf,
  splitDataset,
  validateSplit,
};
