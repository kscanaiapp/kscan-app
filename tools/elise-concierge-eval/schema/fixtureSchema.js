'use strict';

/**
 * Fixture schemas + validators. Hand-rolled (no ajv dependency) to keep the
 * lane dependency-free, consistent with this repo's existing scripts/*.js
 * convention of plain Node built-ins only.
 *
 * Every validator returns { valid: boolean, errors: string[] } and NEVER
 * throws on malformed input — malformed fixtures are exactly what the
 * independent validator (baseline/validateReport.js counterpart, see
 * runner "VALIDATE" mode) must be able to catch, per spec section 54.
 */

const FIXTURE_SCHEMA_VERSION = 'FIXTURE_SCHEMA_V1';

function err(errors, message) {
  errors.push(message);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

const CLOSET_ITEM_REQUIRED_FIELDS = ['id', 'category', 'colors', 'colorFamilies', 'title'];

function validateClosetItem(item, index, errors) {
  if (typeof item !== 'object' || item === null) {
    err(errors, `closet item[${index}] is not an object`);
    return;
  }
  for (const field of CLOSET_ITEM_REQUIRED_FIELDS) {
    if (!(field in item)) err(errors, `closet item[${index}] missing required field "${field}"`);
  }
  if ('id' in item && !isNonEmptyString(item.id)) err(errors, `closet item[${index}].id must be a non-empty string`);
  if ('colors' in item && !isStringArray(item.colors)) err(errors, `closet item[${index}].colors must be a string array`);
  if ('colorFamilies' in item && !isStringArray(item.colorFamilies)) err(errors, `closet item[${index}].colorFamilies must be a string array`);
}

function validateCloset(fixture) {
  const errors = [];
  if (typeof fixture !== 'object' || fixture === null) {
    return { valid: false, errors: ['closet fixture is not an object'] };
  }
  if (!isNonEmptyString(fixture.id)) err(errors, 'closet.id required');
  if (!isNonEmptyString(fixture.kind)) err(errors, 'closet.kind required');
  if (typeof fixture.kPlusActive !== 'boolean') err(errors, 'closet.kPlusActive must be boolean');
  if (!Array.isArray(fixture.items)) {
    err(errors, 'closet.items must be an array');
  } else {
    fixture.items.forEach((item, i) => validateClosetItem(item, i, errors));
    const ids = fixture.items.map((i) => i && i.id).filter(Boolean);
    const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupIds.length) err(errors, `closet.items has duplicate item ids: ${[...new Set(dupIds)].join(', ')}`);
  }
  if (!Array.isArray(fixture.doesNotOwn)) {
    err(errors, 'closet.doesNotOwn must be an array (explicit ground-truth absence list, may be empty)');
  }
  return { valid: errors.length === 0, errors };
}

function validateSignatureStyle(fixture) {
  const errors = [];
  if (typeof fixture !== 'object' || fixture === null) {
    return { valid: false, errors: ['signatureStyle fixture is not an object'] };
  }
  if (!isNonEmptyString(fixture.id)) err(errors, 'signatureStyle.id required');
  if (!isNonEmptyString(fixture.kind)) err(errors, 'signatureStyle.kind required');
  if (typeof fixture.empty !== 'boolean') err(errors, 'signatureStyle.empty must be boolean');
  if (!fixture.empty) {
    if (!isStringArray(fixture.preferences || [])) err(errors, 'signatureStyle.preferences must be a string array');
    if (!isStringArray(fixture.dislikes || [])) err(errors, 'signatureStyle.dislikes must be a string array');
  }
  if (!['low', 'medium', 'none'].includes(fixture.confidence)) {
    err(errors, 'signatureStyle.confidence must be one of low|medium|none');
  }
  return { valid: errors.length === 0, errors };
}

function validateScenario(fixture) {
  const errors = [];
  if (typeof fixture !== 'object' || fixture === null) {
    return { valid: false, errors: ['scenario fixture is not an object'] };
  }
  if (!isNonEmptyString(fixture.id)) err(errors, 'scenario.id required');
  if (!isNonEmptyString(fixture.taskId)) err(errors, 'scenario.taskId required');
  if (!isNonEmptyString(fixture.message)) err(errors, 'scenario.message required');
  if (!isNonEmptyString(fixture.closetId)) err(errors, 'scenario.closetId required');
  if (!isNonEmptyString(fixture.signatureStyleId)) err(errors, 'scenario.signatureStyleId required');
  if (!Array.isArray(fixture.hardConstraints)) err(errors, 'scenario.hardConstraints must be an array');
  if (!Array.isArray(fixture.softConstraints)) err(errors, 'scenario.softConstraints must be an array');
  if (typeof fixture.conciergeV1 !== 'boolean') err(errors, 'scenario.conciergeV1 must be boolean');
  if (typeof fixture.kPlusActive !== 'boolean') err(errors, 'scenario.kPlusActive must be boolean');
  if (!['low', 'medium', 'high'].includes(fixture.difficulty)) {
    err(errors, 'scenario.difficulty must be one of low|medium|high');
  }
  return { valid: errors.length === 0, errors };
}

function validateMultiTurnTrace(fixture) {
  const errors = [];
  if (typeof fixture !== 'object' || fixture === null) {
    return { valid: false, errors: ['multiTurnTrace fixture is not an object'] };
  }
  if (!isNonEmptyString(fixture.id)) err(errors, 'multiTurnTrace.id required');
  if (!isNonEmptyString(fixture.closetId)) err(errors, 'multiTurnTrace.closetId required');
  if (!Array.isArray(fixture.turns) || fixture.turns.length < 2) {
    err(errors, 'multiTurnTrace.turns must be an array with at least 2 turns');
  } else {
    fixture.turns.forEach((turn, i) => {
      if (!['user', 'assistant'].includes(turn.role)) err(errors, `multiTurnTrace.turns[${i}].role invalid`);
      if (!isNonEmptyString(turn.content)) err(errors, `multiTurnTrace.turns[${i}].content required`);
    });
  }
  if (!isNonEmptyString(fixture.continuityCheck)) {
    err(errors, 'multiTurnTrace.continuityCheck required (what constraint/preference must persist)');
  }
  return { valid: errors.length === 0, errors };
}

function validateCommerceProduct(product, index, errors) {
  const required = ['id', 'category', 'brand', 'price', 'color', 'material', 'stock'];
  for (const field of required) {
    if (!(field in product)) err(errors, `commerceProduct[${index}] missing "${field}"`);
  }
  if ('price' in product && !(typeof product.price === 'number' && product.price >= 0)) {
    err(errors, `commerceProduct[${index}].price must be a non-negative number`);
  }
  if ('stock' in product && !(typeof product.stock === 'number' && product.stock >= 0)) {
    err(errors, `commerceProduct[${index}].stock must be a non-negative number`);
  }
}

function validateCommerceCatalog(fixture) {
  const errors = [];
  if (typeof fixture !== 'object' || fixture === null || !Array.isArray(fixture.products)) {
    return { valid: false, errors: ['commerceCatalog.products must be an array'] };
  }
  if (fixture.products.length > 100) err(errors, 'commerceCatalog.products exceeds the 100-item bound (spec section 21)');
  fixture.products.forEach((p, i) => validateCommerceProduct(p, i, errors));
  const ids = fixture.products.map((p) => p && p.id).filter(Boolean);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupIds.length) err(errors, `commerceCatalog has duplicate product ids: ${[...new Set(dupIds)].join(', ')}`);
  return { valid: errors.length === 0, errors };
}

module.exports = {
  FIXTURE_SCHEMA_VERSION,
  validateCloset,
  validateSignatureStyle,
  validateScenario,
  validateMultiTurnTrace,
  validateCommerceCatalog,
};
