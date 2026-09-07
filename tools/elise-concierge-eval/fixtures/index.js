'use strict';

/**
 * Fixture loader: reads the JSON fixture sets + the generated commerce
 * catalog, validates every one against schema/fixtureSchema.js and
 * schema/privacyGuard.js, and exposes lookups by id. Throws on any invalid
 * or unsafe fixture — malformed/unsafe fixtures must fail loudly, never be
 * silently dropped or redacted (spec sections 54/55).
 */

const path = require('node:path');
const fs = require('node:fs');
const {
  validateCloset,
  validateSignatureStyle,
  validateScenario,
  validateMultiTurnTrace,
  validateCommerceCatalog,
} = require('../schema/fixtureSchema');
const { checkPrivacy } = require('../schema/privacyGuard');
const { buildCommerceCatalog } = require('./commerceCatalog');

function readJson(relPath) {
  const full = path.join(__dirname, relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function assertNoDuplicateIds(items, label) {
  const seen = new Map();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`Duplicate fixture id in ${label}: "${item.id}"`);
    }
    seen.set(item.id, true);
  }
}

function validateAndCollect(items, validateFn, label) {
  const errors = [];
  items.forEach((item, i) => {
    const result = validateFn(item);
    if (!result.valid) {
      errors.push(`${label}[${i}] (id=${item && item.id}): ${result.errors.join('; ')}`);
    }
    const privacy = checkPrivacy(item);
    if (!privacy.safe) {
      errors.push(
        `${label}[${i}] (id=${item && item.id}) FAILED PRIVACY GUARD: ${privacy.violations
          .map((v) => `${v.path}:${v.patternId || v.reason}`)
          .join(', ')}`,
      );
    }
  });
  if (errors.length) {
    throw new Error(`Fixture validation failed for ${label}:\n${errors.join('\n')}`);
  }
  assertNoDuplicateIds(items, label);
  return items;
}

function loadFixtures() {
  const closetsRaw = readJson('closets/closets.json');
  const signatureStylesRaw = readJson('signatureStyles/signatureStyles.json');
  const scenariosRaw = readJson('scenarios/scenarios.json');
  const multiTurnRaw = readJson('multiTurnTraces/multiTurnTraces.json');
  const commerceCatalog = buildCommerceCatalog();

  const closets = validateAndCollect(closetsRaw.closets, validateCloset, 'closets');
  const signatureStyles = validateAndCollect(
    signatureStylesRaw.signatureStyles,
    validateSignatureStyle,
    'signatureStyles',
  );
  const scenarios = validateAndCollect(scenariosRaw.scenarios, validateScenario, 'scenarios');
  const multiTurnTraces = validateAndCollect(
    multiTurnRaw.multiTurnTraces,
    validateMultiTurnTrace,
    'multiTurnTraces',
  );

  const catalogValidation = validateCommerceCatalog(commerceCatalog);
  if (!catalogValidation.valid) {
    throw new Error(`Commerce catalog invalid: ${catalogValidation.errors.join('; ')}`);
  }
  const catalogPrivacy = checkPrivacy(commerceCatalog);
  if (!catalogPrivacy.safe) {
    throw new Error(
      `Commerce catalog failed privacy guard: ${catalogPrivacy.violations
        .map((v) => `${v.path}:${v.patternId || v.reason}`)
        .join(', ')}`,
    );
  }

  // Cross-reference integrity: every scenario must point at a real closet /
  // signature style id, and every multi-turn trace at a real closet id.
  const closetIds = new Set(closets.map((c) => c.id));
  const styleIds = new Set(signatureStyles.map((s) => s.id));
  const crossRefErrors = [];
  for (const scenario of scenarios) {
    if (!closetIds.has(scenario.closetId)) {
      crossRefErrors.push(`scenario ${scenario.id} references unknown closetId ${scenario.closetId}`);
    }
    if (!styleIds.has(scenario.signatureStyleId)) {
      crossRefErrors.push(
        `scenario ${scenario.id} references unknown signatureStyleId ${scenario.signatureStyleId}`,
      );
    }
  }
  for (const trace of multiTurnTraces) {
    if (!closetIds.has(trace.closetId)) {
      crossRefErrors.push(`multiTurnTrace ${trace.id} references unknown closetId ${trace.closetId}`);
    }
    if (!styleIds.has(trace.signatureStyleId)) {
      crossRefErrors.push(
        `multiTurnTrace ${trace.id} references unknown signatureStyleId ${trace.signatureStyleId}`,
      );
    }
  }
  if (crossRefErrors.length) {
    throw new Error(`Fixture cross-reference integrity failed:\n${crossRefErrors.join('\n')}`);
  }

  const closetsById = Object.fromEntries(closets.map((c) => [c.id, c]));
  const signatureStylesById = Object.fromEntries(signatureStyles.map((s) => [s.id, s]));
  const scenariosById = Object.fromEntries(scenarios.map((s) => [s.id, s]));
  const multiTurnTracesById = Object.fromEntries(multiTurnTraces.map((t) => [t.id, t]));
  const commerceProductsById = Object.fromEntries(commerceCatalog.products.map((p) => [p.id, p]));

  return {
    closets,
    signatureStyles,
    scenarios,
    multiTurnTraces,
    commerceCatalog,
    closetsById,
    signatureStylesById,
    scenariosById,
    multiTurnTracesById,
    commerceProductsById,
  };
}

let cached = null;
function getFixtures() {
  if (!cached) cached = loadFixtures();
  return cached;
}

module.exports = { loadFixtures, getFixtures };
