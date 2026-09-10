'use strict';

/**
 * Structural validation of __tests__/fixtures/commerce/manifest.json against
 * manifest.schema.json's vocabulary (spec section 42). Deliberately hand-rolled
 * rather than pulled in via a JSON-Schema library: the repo has no existing
 * ajv/zod dependency for this, and the checks needed are simple enough
 * (enum membership, uniqueness, pattern match, cross-reference) that adding
 * a new dependency for them would be disproportionate. The schema file
 * remains the single source of truth for the enums - this module reads the
 * enums OUT of manifest.schema.json rather than re-declaring them, so the
 * two can never silently drift apart.
 */

const fs = require('node:fs');
const path = require('node:path');

const { CORPUS_ROOT, MANIFEST_PATH, parsePointer } = require('./loadCorpus');

const SCHEMA_PATH = path.join(CORPUS_ROOT, 'manifest.schema.json');

function loadSchemaEnums() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const scenarioDef = schema.definitions.scenario;
  return {
    scenarioIdPattern: new RegExp(scenarioDef.properties.scenarioId.pattern),
    categories: new Set(scenarioDef.properties.category.enum),
    evidenceClasses: new Set(scenarioDef.properties.evidenceClass.enum),
    tags: new Set(scenarioDef.properties.tags.items.enum),
    requiredFields: scenarioDef.required,
  };
}

/**
 * Validates manifest structure and cross-references against the fixture
 * files on disk. Returns { valid, errors }. Never throws for an invalid
 * (but readable) manifest - only for I/O or JSON-parse failures, which are
 * caller bugs, not corpus-content problems.
 */
function validateManifest() {
  const errors = [];
  const enums = loadSchemaEnums();

  if (!fs.existsSync(MANIFEST_PATH)) {
    return { valid: false, errors: [`manifest not found at ${MANIFEST_PATH}`] };
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  if (typeof manifest.commerceCorpusVersion !== 'number' || manifest.commerceCorpusVersion < 1) {
    errors.push('manifest.commerceCorpusVersion must be a positive integer');
  }
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) {
    errors.push('manifest.scenarios must be a non-empty array');
    return { valid: false, errors };
  }

  const seenIds = new Set();

  for (const scenario of manifest.scenarios) {
    const label = scenario.scenarioId || '<missing scenarioId>';

    for (const field of enums.requiredFields) {
      if (scenario[field] === undefined) {
        errors.push(`scenario '${label}' is missing required field '${field}'`);
      }
    }

    if (typeof scenario.scenarioId === 'string') {
      if (!enums.scenarioIdPattern.test(scenario.scenarioId)) {
        errors.push(`scenario '${label}' has a scenarioId that is not kebab-case: '${scenario.scenarioId}'`);
      }
      if (seenIds.has(scenario.scenarioId)) {
        errors.push(`duplicate scenarioId: '${scenario.scenarioId}'`);
      }
      seenIds.add(scenario.scenarioId);
    }

    if (scenario.category !== undefined && !enums.categories.has(scenario.category)) {
      errors.push(`scenario '${label}' has an unrecognized category: '${scenario.category}'`);
    }

    if (scenario.evidenceClass !== undefined && !enums.evidenceClasses.has(scenario.evidenceClass)) {
      errors.push(
        `scenario '${label}' has an unrecognized evidenceClass: '${scenario.evidenceClass}' (must be one of OBSERVED-SHAPE, SOURCE-SHAPE, SYNTHETIC)`,
      );
    }
    if (scenario.evidenceClass === 'OBSERVED-SHAPE') {
      errors.push(
        `scenario '${label}' claims evidenceClass OBSERVED-SHAPE, but this corpus lane has no Staging/runtime access (STAGING_OBSERVED_SHAPE: UNAVAILABLE) - no scenario may claim OBSERVED-SHAPE`,
      );
    }

    if (Array.isArray(scenario.tags)) {
      for (const tag of scenario.tags) {
        if (!enums.tags.has(tag)) {
          errors.push(`scenario '${label}' has an unrecognized tag: '${tag}'`);
        }
      }
    }

    if (typeof scenario.inputFixture === 'string') {
      try {
        const { relPath, scenarioId: pointedId } = parsePointer(scenario.inputFixture);
        const absPath = path.join(CORPUS_ROOT, relPath);
        if (!fs.existsSync(absPath)) {
          errors.push(`scenario '${label}' points to a nonexistent fixture file: '${relPath}'`);
        } else {
          const fixtureFile = JSON.parse(fs.readFileSync(absPath, 'utf8'));
          const record = (fixtureFile.records || []).find((r) => r.scenarioId === pointedId);
          if (!record) {
            errors.push(`scenario '${label}' points to '${scenario.inputFixture}' but no matching record exists`);
          }
        }
      } catch (err) {
        errors.push(`scenario '${label}' has a malformed inputFixture pointer: ${err.message}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateManifest, loadSchemaEnums };
