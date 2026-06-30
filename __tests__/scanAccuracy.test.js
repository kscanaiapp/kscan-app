'use strict';

/**
 * Golden accuracy tests (identification-accuracy sprint v1).
 *
 * Verifies the deterministic accuracy levers that drive catalog retrieval and
 * the displayed result:
 *   - category normalization (incl. plural/synonym coverage and dominant-item)
 *   - confidence label calibration (0.80 / 0.60 thresholds + downgrades)
 *   - JSON parse / repair (fences, trailing commas, surrounding prose)
 *
 * These are text proxies — real visual accuracy must be confirmed by a human
 * running equivalent image scans on-device.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const {
  CATEGORY_CASES,
  DOMINANT_CASES,
  CONFIDENCE_CASES,
  PARSE_CASES,
} = require('./fixtures/scanAccuracyCases');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    crypto: require('crypto'),
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const helpers = loadTsModule('supabase/functions/_shared/scanHelpers.ts');

// Catalog canonical categories that exist on App Staging today.
const CATALOG_CATEGORIES = new Set(['outerwear', 'blazer', 'dress', 'footwear', 'bag', 'accessory']);

// ── Category normalization ────────────────────────────────────────────────────

for (const { itemType, expected } of CATEGORY_CASES) {
  test(`category: "${itemType}" → ${expected}`, () => {
    assert.equal(helpers.normalizeCategory(itemType), expected);
  });
}

test('category: every footwear/outerwear/dress/bag/accessory/blazer case is a real catalog category', () => {
  for (const { itemType, expected } of CATEGORY_CASES) {
    if (['outerwear', 'blazer', 'dress', 'footwear', 'bag', 'accessory'].includes(expected)) {
      assert.equal(CATALOG_CATEGORIES.has(helpers.normalizeCategory(itemType)), true,
        `${itemType} should map to a catalog category`);
    }
  }
});

// ── Dominant item wins over co-present bag/accessory ───────────────────────────

for (const { phrase, expected } of DOMINANT_CASES) {
  test(`dominant: "${phrase}" → ${expected}`, () => {
    assert.equal(helpers.normalizeCategory(phrase), expected);
  });
}

// ── Misclassification guard expectations (structural) ──────────────────────────

test('guard: outerwear never normalizes to bag/accessory', () => {
  for (const it of ['puffer jacket', 'wool coat', 'bomber jacket', 'raincoat']) {
    const cat = helpers.normalizeCategory(it);
    assert.equal(cat, 'outerwear');
    assert.notEqual(cat, 'bag');
    assert.notEqual(cat, 'accessory');
  }
});

test('guard: footwear never normalizes to bag/accessory', () => {
  for (const it of ['sneakers', 'boots', 'loafers', 'heels']) {
    const cat = helpers.normalizeCategory(it);
    assert.equal(cat, 'footwear');
    assert.notEqual(cat, 'bag');
    assert.notEqual(cat, 'accessory');
  }
});

// ── Confidence calibration ─────────────────────────────────────────────────────

for (const { score, opts, expected } of CONFIDENCE_CASES) {
  const label = opts ? ` (${JSON.stringify(opts)})` : '';
  test(`confidence: ${score}${label} → ${expected}`, () => {
    assert.equal(helpers.deriveConfidenceLabel(score, opts), expected);
  });
}

// ── JSON parse / repair ─────────────────────────────────────────────────────────

for (const { name, raw, expectKey, expectValue } of PARSE_CASES) {
  test(`parse: ${name}`, () => {
    const parsed = helpers.safeParseAiJson(raw);
    assert.equal(typeof parsed, 'object');
    assert.equal(parsed[expectKey], expectValue);
  });
}

test('parse: unrecoverable input throws ai_json_parse_failed', () => {
  assert.throws(() => helpers.safeParseAiJson('not json at all'), /ai_json_parse_failed/);
});
