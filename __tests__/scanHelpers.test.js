const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
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
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    crypto: require('crypto'),
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const helpers = loadTsModule('supabase/functions/_shared/scanHelpers.ts');

// VM-created arrays fail deepStrictEqual on prototype identity. Use JSON serialization.
function assertArraysEqual(actual, expected, message) {
  assert.equal(Array.isArray(actual), true, message || 'expected an array');
  assert.equal(actual.length, expected.length, message || `expected length ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i], expected[i], message || `item ${i} mismatch`);
  }
}

// ── Normalizer ──────────────────────────────────────────────────────────────────

test('normalizer: suit jacket → blazer', () => {
  assert.equal(helpers.normalizeCategory('suit jacket'), 'blazer');
});

test('normalizer: charcoal → gray/charcoal', () => {
  assert.equal(helpers.normalizeColor('charcoal'), 'gray/charcoal');
});

test('normalizer: faux leather → faux leather', () => {
  assert.equal(helpers.normalizeMaterial('faux leather'), 'faux leather');
});

test('normalizer: structured → tailored/structured', () => {
  assert.equal(helpers.normalizeSilhouette('structured'), 'tailored/structured');
});

test('normalizer: missing input returns empty string', () => {
  assert.equal(helpers.normalizeCategory(null), '');
  assert.equal(helpers.normalizeColor(undefined), '');
  assert.equal(helpers.normalizeMaterial(''), '');
  assert.equal(helpers.normalizeSilhouette(), '');
});

test('normalizer: normalizeStringArray tolerates non-array', () => {
  assertArraysEqual(helpers.normalizeStringArray(null), []);
  assertArraysEqual(helpers.normalizeStringArray('foo'), []);
  assertArraysEqual(helpers.normalizeStringArray(['  a  ', ' b ', '', null, 123]), ['a', 'b']);
});

test('normalizer: normalizeIdentification tolerates missing identification', () => {
  assert.equal(helpers.normalizeIdentification(null), null);
  assert.equal(helpers.normalizeIdentification(undefined), null);
  const out = helpers.normalizeIdentification({ item_type: 'blazer', primary_color: 'black' });
  assert.ok(out);
  assert.equal(out.canonicalCategory, 'blazer');
  assert.equal(out.canonicalColor, 'black');
  assert.equal(out.confidence_score, 0);
  assert.equal(out.logo_detected, false);
  assert.equal(out.non_fashion, false);
  assertArraysEqual(out.normalizedFeatures, []);
  assertArraysEqual(out.normalizedStyleTags, []);
  assertArraysEqual(out.normalizedSearchQueries, []);
});

test('normalizer: normalizeIdentification preserves arrays and booleans', () => {
  const out = helpers.normalizeIdentification({
    item_type: 'dress',
    confidence_score: 0.85,
    logo_detected: true,
    non_fashion: false,
    style_tags: ['feminine', 'romantic'],
    distinctive_features: ['ruffles'],
    search_queries: ['floral dress'],
  });
  assert.ok(out);
  assert.equal(out.confidence_score, 0.85);
  assert.equal(out.logo_detected, true);
  assert.equal(out.non_fashion, false);
  assertArraysEqual(out.normalizedStyleTags, ['feminine', 'romantic']);
  assertArraysEqual(out.normalizedFeatures, ['ruffles']);
  assertArraysEqual(out.normalizedSearchQueries, ['floral dress']);
});

// ── Ranking ─────────────────────────────────────────────────────────────────────

test('ranker: blazer candidate scores higher than unrelated dress for blazer identification', () => {
  const id = helpers.normalizeIdentification({
    item_type: 'blazer',
    primary_color: 'black',
    distinctive_features: ['gold buttons'],
    style_tags: ['tailored'],
  });
  const products = [
    { id: 'p1', name: 'Black blazer', category: 'blazer', color: 'black', silhouette: 'tailored', tags: ['tailored'] },
    { id: 'p2', name: 'Red floral dress', category: 'dress', color: 'red', tags: ['feminine'] },
  ];
  const ranked = helpers.rankRecommendedProducts(products, id);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 'p1');
  assert.ok((ranked[0].matchScore ?? 0) > (ranked[1].matchScore ?? 0));
});

test('ranker: weak match returns discovery_fallback', () => {
  const id = helpers.normalizeIdentification({
    item_type: 'blazer',
    primary_color: 'black',
  });
  const products = [
    { id: 'p1', name: 'Unrelated garden hose', category: 'garden' },
  ];
  const ranked = helpers.rankRecommendedProducts(products, id);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].confidenceTier, 'discovery_fallback');
});

test('ranker: silhouette match works for product value tailored against canonical tailored/structured', () => {
  const id = helpers.normalizeIdentification({
    item_type: 'blazer',
    silhouette: 'structured',
  });
  const products = [
    { id: 'p1', name: 'Tailored blazer', silhouette: 'tailored' },
  ];
  const ranked = helpers.rankRecommendedProducts(products, id);
  assert.equal(ranked.length, 1);
  assert.ok((ranked[0].matchScore ?? 0) >= 0.10);
  const reasons = ranked[0].matchReasons ?? {};
  assert.equal(reasons.silhouette_match, true);
});

test('ranker: exact candidate requires brand/logo evidence', () => {
  const id = helpers.normalizeIdentification({
    item_type: 'blazer',
    primary_color: 'black',
    distinctive_features: ['gold buttons'],
    style_tags: ['tailored'],
    confidence_score: 0.95,
  });
  const products = [
    { id: 'p1', name: 'Perfect blazer with gold buttons', category: 'blazer', color: 'black', silhouette: 'tailored', tags: ['tailored'], imageUrl: 'https://example.com/img.jpg', purchaseUrl: 'https://example.com/buy', availability: 'in stock' },
  ];
  const rankedNoBrand = helpers.rankRecommendedProducts(products, id);
  // Without brand/logo evidence, score >= 0.90 should still be closest_match, not exact_candidate
  assert.equal(rankedNoBrand[0].confidenceTier, 'closest_match');

  const idWithBrand = helpers.normalizeIdentification({
    item_type: 'blazer',
    primary_color: 'black',
    distinctive_features: ['gold buttons'],
    style_tags: ['tailored'],
    silhouette: 'structured',
    confidence_score: 0.95,
    visible_brand_text: 'Gucci',
  });
  const productsWithMaterial = [
    { id: 'p1', name: 'Perfect blazer with gold buttons', category: 'blazer', color: 'black', silhouette: 'structured', tags: ['tailored'], imageUrl: 'https://example.com/img.jpg', purchaseUrl: 'https://example.com/buy', availability: 'in stock' },
  ];
  const rankedWithBrand = helpers.rankRecommendedProducts(productsWithMaterial, idWithBrand);
  assert.equal(rankedWithBrand[0].confidenceTier, 'exact_candidate');
});

test('ranker: empty products returns empty array', () => {
  const id = helpers.normalizeIdentification({ item_type: 'blazer' });
  assertArraysEqual(helpers.rankRecommendedProducts([], id), []);
  assertArraysEqual(helpers.rankRecommendedProducts(null, id), []);
  assertArraysEqual(helpers.rankRecommendedProducts([{}], null), []);
});

// ── Legacy Attributes Derivation ────────────────────────────────────────────────

test('legacy: deriveLegacyAttributesFromIdentification derives safe attributes', () => {
  const id = helpers.normalizeIdentification({
    item_type: 'blazer',
    subtype: 'double-breasted blazer',
    silhouette: 'structured',
    primary_color: 'black',
    secondary_colors: ['gold'],
    material_estimate: 'wool blend',
    pattern: 'solid',
    style_tags: ['tailored'],
    occasion_tags: ['workwear'],
    confidence_score: 0.92,
  });
  const attrs = helpers.deriveLegacyAttributesFromIdentification(id);
  assert.ok(attrs);
  assert.equal(attrs.category, 'blazer');
  assert.equal(attrs.itemType, 'double-breasted blazer');
  assert.equal(attrs.silhouette, 'structured');
  assertArraysEqual(attrs.colorPalette, ['black', 'gold']);
  assert.equal(attrs.materialEstimate, 'wool blend');
  assert.equal(attrs.pattern, 'solid');
  assert.equal(attrs.texture, 'wool blend');
  assertArraysEqual(attrs.styleTags, ['tailored']);
  assert.equal(attrs.occasion, 'workwear');
  assert.equal(attrs.confidenceScore, 0.92);
});

test('legacy: deriveLegacyAttributesFromIdentification tolerates null', () => {
  assert.equal(helpers.deriveLegacyAttributesFromIdentification(null), undefined);
  assert.equal(helpers.deriveLegacyAttributesFromIdentification(undefined), undefined);
});

test('legacy: ensureLegacyAttributes derives attributes when missing', () => {
  const response = {
    status: 'completed',
    identification: {
      item_type: 'dress',
      primary_color: 'red',
      silhouette: 'A-line',
      confidence_score: 0.88,
    },
  };
  const ensured = helpers.ensureLegacyAttributes(response);
  assert.ok(ensured.attributes);
  assert.equal(ensured.attributes.category, 'dress');
  assert.equal(ensured.attributes.itemType, 'dress');
  assertArraysEqual(ensured.attributes.colorPalette, ['red']);
  assert.equal(ensured.attributes.confidenceScore, 0.88);
});

test('legacy: missing identification does not throw', () => {
  const response = { status: 'completed' };
  const ensured = helpers.ensureLegacyAttributes(response);
  assert.ok(ensured.attributes);
  assert.equal(ensured.attributes.category, 'unknown');
  assert.equal(ensured.attributes.itemType, 'NON_FASHION');
});

test('legacy: response with identification but missing attributes derives safe attributes', () => {
  const response = {
    status: 'completed',
    identification: {
      item_type: 'blazer',
      confidence_score: 0.90,
    },
  };
  const ensured = helpers.ensureLegacyAttributes(response);
  assert.ok(ensured.attributes);
  assert.equal(ensured.attributes.category, 'blazer');
  assert.equal(ensured.attributes.confidenceScore, 0.90);
});

test('legacy: attributes-only response still maps without identification', () => {
  const response = {
    status: 'completed',
    attributes: { category: 'Outerwear', itemType: 'Trench coat', confidenceScore: 0.86 },
  };
  const ensured = helpers.ensureLegacyAttributes(response);
  assert.equal(ensured.attributes.category, 'Outerwear');
  assert.equal(ensured.attributes.itemType, 'Trench coat');
});

// ── Non-Fashion ─────────────────────────────────────────────────────────────────

test('non-fashion: response returns safe attributes not empty object', () => {
  const response = { status: 'non_fashion' };
  const ensured = helpers.ensureLegacyAttributes(response);
  assert.ok(ensured.attributes);
  assert.equal(ensured.attributes.category, 'unknown');
  assert.equal(ensured.attributes.itemType, 'NON_FASHION');
  assertArraysEqual(ensured.attributes.colorPalette, []);
  assert.equal(ensured.attributes.confidenceScore, 0.95);
  assert.notEqual(Object.keys(ensured.attributes).length, 0);
});

// ── Logger ──────────────────────────────────────────────────────────────────────

test('logger: does not throw with typical audit payload', () => {
  const event = helpers.buildAuditEvent(
    { status: 'completed' },
    helpers.normalizeIdentification({ item_type: 'blazer', primary_color: 'black' }),
    [],
    1234,
    'scan-123',
  );
  assert.equal(event.event, 'scan_identification_audit');
  assert.equal(event.scan_id, 'scan-123');
  assert.equal(event.status, 'completed');
  assert.equal(event.latency_ms, 1234);
  assert.equal(event.is_non_fashion, false);
  assert.ok(event.normalized_attributes);
  assert.equal(event.normalized_attributes.canonicalCategory, 'blazer');
  assert.equal(event.normalized_attributes.canonicalColor, 'black');
  assertArraysEqual(event.generated_queries, []);

  // Must not throw
  assert.doesNotThrow(() => helpers.logScanIdentificationAudit(event));
});

test('logger: does not throw with null normalized identification', () => {
  const event = helpers.buildAuditEvent(
    { status: 'failed' },
    null,
    [],
    500,
  );
  assert.equal(event.normalized_attributes, null);
  assert.doesNotThrow(() => helpers.logScanIdentificationAudit(event));
});

test('logger: buildAuditEvent generates scan_id when none provided', () => {
  const event = helpers.buildAuditEvent({ status: 'completed' }, null, [], 100);
  assert.equal(typeof event.scan_id, 'string');
  assert.ok(event.scan_id.length > 0);
});

test('logger: does not accept or pass through raw image/base64 fields', () => {
  const event = helpers.buildAuditEvent(
    { status: 'completed', imageBase64: 'data:image/jpeg;base64,ABC123', rawImage: '...' },
    helpers.normalizeIdentification({ item_type: 'blazer' }),
    [],
    100,
  );
  // The buildAuditEvent does not include imageBase64 or rawImage in the output
  const keys = Object.keys(event);
  assert.equal(keys.includes('imageBase64'), false);
  assert.equal(keys.includes('rawImage'), false);
});

// ── JSON Parsing ────────────────────────────────────────────────────────────────

test('parser: cleanAiJsonText strips markdown fences', () => {
  assert.equal(helpers.cleanAiJsonText('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(helpers.cleanAiJsonText('```JSON\n{"a":1}\n```'), '{"a":1}');
  assert.equal(helpers.cleanAiJsonText('```\n{"a":1}\n```'), '{"a":1}');
});

test('parser: safeParseAiJson parses valid JSON', () => {
  const result = helpers.safeParseAiJson('{"a":1}');
  assert.equal(result.a, 1);
});

test('parser: safeParseAiJson extracts JSON from surrounding text', () => {
  const raw = 'Some text before\n{"a":1}\nSome text after';
  const result = helpers.safeParseAiJson(raw);
  assert.equal(result.a, 1);
});

test('parser: safeParseAiJson throws on unparseable text', () => {
  assert.throws(() => helpers.safeParseAiJson('not json at all'), /ai_json_parse_failed/);
});
