'use strict';

/**
 * Fail-closed validator for the certified FashionIdentificationResultV2
 * boundary. The vocabulary and required shape are mirrored from certified v140
 * fashionIdentificationV2.ts; this module does not add production fields.
 */

const CONTRACT_VERSION = 'fashion-identification-v2';
const STATUSES = Object.freeze([
  'completed',
  'partial',
  'insufficient_visual_evidence',
  'non_fashion',
  'multiple_items_need_selection',
  'technical_failure',
]);
const RESOLUTION_LEVELS = Object.freeze([
  'exact_product',
  'model_family',
  'brand_and_subtype',
  'subtype',
  'category',
  'unknown',
]);
const BRAND_PROVENANCES = Object.freeze([
  'visual',
  'visible_text',
  'logo_shape',
  'catalog_corroboration',
  'commerce_corroboration',
  'unknown',
]);
const NON_IDENTITY_STATUSES = new Set([
  'insufficient_visual_evidence',
  'non_fashion',
  'technical_failure',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function error(errors, path, message) {
  errors.push({ path, message });
}

function nullableString(errors, path, value) {
  if (value !== null && (typeof value !== 'string' || value.length === 0)) {
    error(errors, path, 'must be null or a non-empty string');
  }
}

function nullableConfidence(errors, path, value) {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
    error(errors, path, 'must be null or a finite number from 0 through 1');
  }
}

function stringArray(errors, path, value) {
  if (!Array.isArray(value)) {
    error(errors, path, 'must be an array');
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length === 0) error(errors, `${path}[${index}]`, 'must be a non-empty string');
  });
}

function requireObject(errors, path, value) {
  if (!isObject(value)) {
    error(errors, path, 'required object');
    return false;
  }
  return true;
}

function parseCandidate(candidate) {
  if (typeof candidate !== 'string') return { ok: true, value: candidate };
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (parseError) {
    return {
      ok: false,
      errors: [{ path: '', message: `provider response is not parseable JSON: ${parseError.message}` }],
    };
  }
}

function validateNormalizedResult(candidate) {
  const parsed = parseCandidate(candidate);
  if (!parsed.ok) return { ok: false, failureCode: 'provider_output_invalid', errors: parsed.errors };
  const result = parsed.value;
  const errors = [];
  if (!requireObject(errors, '', result)) {
    return { ok: false, failureCode: 'provider_output_invalid', errors };
  }

  if (result.contractVersion !== CONTRACT_VERSION) error(errors, 'contractVersion', `must equal ${CONTRACT_VERSION}`);
  if (typeof result.requestId !== 'string' || result.requestId.length === 0) error(errors, 'requestId', 'required non-empty string');
  if (!STATUSES.includes(result.status)) error(errors, 'status', 'unsupported status');
  if (!RESOLUTION_LEVELS.includes(result.resolutionLevel)) error(errors, 'resolutionLevel', 'unsupported resolution level');

  if (requireObject(errors, 'item', result.item)) {
    nullableString(errors, 'item.category', result.item.category);
    nullableString(errors, 'item.subtype', result.item.subtype);
    if (requireObject(errors, 'item.brand', result.item.brand)) {
      nullableString(errors, 'item.brand.value', result.item.brand.value);
      nullableConfidence(errors, 'item.brand.confidence', result.item.brand.confidence);
      if (!BRAND_PROVENANCES.includes(result.item.brand.provenance)) {
        error(errors, 'item.brand.provenance', 'unsupported brand provenance');
      }
      if (!Array.isArray(result.item.brand.evidence)) {
        error(errors, 'item.brand.evidence', 'must be an array');
      } else {
        result.item.brand.evidence.forEach((entry, index) => {
          if (!isObject(entry) || typeof entry.type !== 'string' || entry.type.length === 0) {
            error(errors, `item.brand.evidence[${index}]`, 'must be an object with a non-empty type');
            return;
          }
          if (entry.evidenceId !== undefined && (typeof entry.evidenceId !== 'string' || !entry.evidenceId)) {
            error(errors, `item.brand.evidence[${index}].evidenceId`, 'must be a non-empty string when present');
          }
          if (entry.observation !== undefined) nullableString(errors, `item.brand.evidence[${index}].observation`, entry.observation);
          if (entry.confidence !== undefined) nullableConfidence(errors, `item.brand.evidence[${index}].confidence`, entry.confidence);
        });
      }
    }
    if (requireObject(errors, 'item.colors', result.item.colors)) {
      nullableString(errors, 'item.colors.primary', result.item.colors.primary);
      stringArray(errors, 'item.colors.secondary', result.item.colors.secondary);
    }
    for (const field of ['material', 'silhouette', 'pattern']) stringArray(errors, `item.${field}`, result.item[field]);
    if (requireObject(errors, 'item.attributes', result.item.attributes)) {
      for (const field of ['fit', 'length', 'sleeve', 'neckline', 'collar', 'closure']) {
        if (result.item.attributes[field] !== undefined) nullableString(errors, `item.attributes.${field}`, result.item.attributes[field]);
      }
      for (const field of ['pockets', 'visible', 'distinctive']) {
        stringArray(errors, `item.attributes.${field}`, result.item.attributes[field]);
      }
    }
  }

  if (requireObject(errors, 'confidence', result.confidence)) {
    for (const field of ['category', 'subtype', 'brand', 'modelFamily', 'exactProduct']) {
      if (!(field in result.confidence)) error(errors, `confidence.${field}`, 'required field missing');
      else nullableConfidence(errors, `confidence.${field}`, result.confidence[field]);
    }
  }

  if (result.exactProduct !== null) {
    if (!requireObject(errors, 'exactProduct', result.exactProduct)) {
      // requireObject records the error.
    } else {
      for (const field of ['brand', 'model', 'sku']) nullableString(errors, `exactProduct.${field}`, result.exactProduct[field]);
      nullableConfidence(errors, 'exactProduct.confidence', result.exactProduct.confidence);
    }
  }

  if (!Array.isArray(result.evidence)) error(errors, 'evidence', 'must be an array');
  else result.evidence.forEach((entry, index) => {
    if (!isObject(entry) || typeof entry.evidenceId !== 'string' || !entry.evidenceId) {
      error(errors, `evidence[${index}]`, 'must contain a non-empty evidenceId');
      return;
    }
    stringArray(errors, `evidence[${index}].observations`, entry.observations);
  });

  if (!Array.isArray(result.conflicts)) error(errors, 'conflicts', 'must be an array');
  else result.conflicts.forEach((entry, index) => {
    if (!isObject(entry) || typeof entry.field !== 'string' || typeof entry.description !== 'string') {
      error(errors, `conflicts[${index}]`, 'must contain string field and description');
      return;
    }
    stringArray(errors, `conflicts[${index}].evidenceIds`, entry.evidenceIds);
  });

  if (result.unknownReason !== undefined) nullableString(errors, 'unknownReason', result.unknownReason);
  if (requireObject(errors, 'compatibility', result.compatibility)) {
    if (typeof result.compatibility.legacyProjectionAvailable !== 'boolean') {
      error(errors, 'compatibility.legacyProjectionAvailable', 'required boolean');
    }
    nullableConfidence(errors, 'compatibility.globalConfidence', result.compatibility.globalConfidence);
    if (result.compatibility.commerceSkippedReason !== undefined) {
      nullableString(errors, 'compatibility.commerceSkippedReason', result.compatibility.commerceSkippedReason);
    }
  }

  if (result.status === 'multiple_items_need_selection') {
    if (!Array.isArray(result.candidates) || result.candidates.length === 0) {
      error(errors, 'candidates', 'multi-item result requires a non-empty candidates array');
    }
  }
  if (result.candidates !== undefined) {
    if (!Array.isArray(result.candidates)) error(errors, 'candidates', 'must be an array when present');
    else result.candidates.forEach((entry, index) => {
      if (!isObject(entry)) {
        error(errors, `candidates[${index}]`, 'must be an object');
        return;
      }
      for (const field of ['candidateId', 'evidenceId']) {
        if (typeof entry[field] !== 'string' || !entry[field]) error(errors, `candidates[${index}].${field}`, 'required non-empty string');
      }
      nullableString(errors, `candidates[${index}].category`, entry.category);
      nullableString(errors, `candidates[${index}].subtype`, entry.subtype);
      if (entry.bounds !== undefined) {
        if (!isObject(entry.bounds)) error(errors, `candidates[${index}].bounds`, 'must be an object');
        else for (const field of ['x', 'y', 'width', 'height']) {
          if (!Number.isFinite(entry.bounds[field])) error(errors, `candidates[${index}].bounds.${field}`, 'must be finite number');
        }
      }
    });
  }

  if (NON_IDENTITY_STATUSES.has(result.status)) {
    if (result.resolutionLevel !== 'unknown') error(errors, 'resolutionLevel', 'non-identity result must use unknown');
    const carriesBrandIdentity = isObject(result.item && result.item.brand)
      && result.item.brand.value !== null;
    if (isObject(result.item)
      && (result.item.category !== null || result.item.subtype !== null || carriesBrandIdentity)) {
      error(errors, 'item', 'non-identity result must not carry category, subtype, or brand identity');
    }
  }

  return {
    ok: errors.length === 0,
    failureCode: errors.length ? 'provider_output_invalid' : null,
    errors,
    value: errors.length ? null : result,
    envelope: result.status === 'multiple_items_need_selection'
      ? 'multi_item'
      : NON_IDENTITY_STATUSES.has(result.status) ? 'fallback_or_abstention' : 'single_item',
  };
}

module.exports = {
  CONTRACT_VERSION,
  STATUSES,
  RESOLUTION_LEVELS,
  BRAND_PROVENANCES,
  validateNormalizedResult,
};
