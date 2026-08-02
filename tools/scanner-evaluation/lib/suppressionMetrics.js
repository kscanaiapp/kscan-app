'use strict';

const scoreFields = require('./scoreFields');

const SUPPRESSION_CONTRACT_VERSION = '1.0.0';
const FIELDS = Object.freeze(['category', 'clothingType', 'subtype', 'primaryColor', 'material', 'pattern', 'brand']);
const UNCERTAINTY = new Set(['unknown', 'not_visible', 'not_applicable']);

function concrete(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== 'string' || (value.trim() !== '' && !UNCERTAINTY.has(value.trim().toLowerCase()));
}

function summarizeSuppression(records, labelsById, profile = scoreFields.DEFAULT_PROFILE) {
  const byField = Object.fromEntries(FIELDS.map((field) => [field, {
    field, totalN: 0, classifiableN: 0, answeredN: 0, answeredOnClassifiableN: 0,
    correctOnClassifiableN: 0, suppressedOnClassifiableN: 0, nullOrEmptyN: 0, uncertaintyTokenN: 0,
  }]));
  let invalidCaseCount = 0;
  for (const record of records) {
    const label = labelsById.get(record.caseId);
    if (!label) throw new Error(`missing governed label for ${record.caseId}`);
    const projection = record.projection || {};
    const scored = record.profiles && record.profiles[profile];
    if (!scored) invalidCaseCount += 1;
    const scoreByField = new Map((scored?.fields || []).map((field) => [field.field, field]));
    for (const field of FIELDS) {
      const bucket = byField[field];
      const prediction = projection[field];
      const isAnswered = concrete(prediction);
      const isClassifiable = concrete(label[field]);
      bucket.totalN += 1;
      if (isAnswered) bucket.answeredN += 1;
      else if (prediction == null || prediction === '' || (Array.isArray(prediction) && prediction.length === 0)) bucket.nullOrEmptyN += 1;
      else bucket.uncertaintyTokenN += 1;
      if (!isClassifiable) continue;
      bucket.classifiableN += 1;
      if (isAnswered) bucket.answeredOnClassifiableN += 1;
      else bucket.suppressedOnClassifiableN += 1;
      const fieldScore = scoreByField.get(field);
      if (isAnswered && fieldScore && [scoreFields.DISPOSITIONS.CORRECT, scoreFields.DISPOSITIONS.ACCEPTABLY_BROAD].includes(fieldScore.disposition)) {
        bucket.correctOnClassifiableN += 1;
      }
    }
  }
  const total = Object.values(byField).reduce((acc, bucket) => {
    for (const key of ['totalN', 'classifiableN', 'answeredN', 'answeredOnClassifiableN', 'correctOnClassifiableN', 'suppressedOnClassifiableN', 'nullOrEmptyN', 'uncertaintyTokenN']) acc[key] += bucket[key];
    return acc;
  }, { totalN: 0, classifiableN: 0, answeredN: 0, answeredOnClassifiableN: 0, correctOnClassifiableN: 0, suppressedOnClassifiableN: 0, nullOrEmptyN: 0, uncertaintyTokenN: 0 });
  return {
    suppressionContractVersion: SUPPRESSION_CONTRACT_VERSION,
    caseCount: records.length,
    invalidCaseCount,
    ...total,
    fieldCompletionRate: total.totalN ? total.answeredN / total.totalN : null,
    suppressionRateOnClassifiable: total.classifiableN ? total.suppressedOnClassifiableN / total.classifiableN : null,
    accuracyAmongAnsweredClassifiable: total.answeredOnClassifiableN ? total.correctOnClassifiableN / total.answeredOnClassifiableN : null,
    accuracyAcrossAllClassifiable: total.classifiableN ? total.correctOnClassifiableN / total.classifiableN : null,
    byField,
  };
}

module.exports = { SUPPRESSION_CONTRACT_VERSION, FIELDS, summarizeSuppression };
