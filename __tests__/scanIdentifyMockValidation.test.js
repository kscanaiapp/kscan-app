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
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const adapter = loadTsModule('services/scanIdentification.ts', {
  './supabaseClient': { supabase: {} },
  '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
});
const scanResultObject = loadTsModule('services/scanResultObject.ts');
const scanTitleBuilder = loadTsModule('services/scanTitleBuilder.ts');
const { buildOutfitConfirmationCandidates } = loadTsModule(
  'services/outfitConfirmation/outfitDetectionBridge.ts',
);
const mapper = loadTsModule('services/scanIdentificationMapper.ts', {
  './scanResultObject': scanResultObject,
  './scanTitleBuilder': scanTitleBuilder,
  // IMG-008: the mapper now also builds the durable identification snapshot.
  './identificationSnapshot': loadTsModule('services/identificationSnapshot.ts'),
  './outfitConfirmation/outfitDetectionBridge': { buildOutfitConfirmationCandidates },
  '../constants/build': { SCAN_IDENTITY_DEBUG: false },
});

// ── Mock case 1: Black double-breasted blazer ─────────────────────────────────

test('mock: black double-breasted blazer → rich identification', () => {
  const raw = {
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'Black double-breasted blazer with structured shoulders, peak lapels, and gold buttons.',
    attributes: {
      category: 'blazer',
      itemType: 'double-breasted blazer',
      silhouette: 'structured',
      colorPalette: ['black'],
      materialEstimate: 'wool blend',
      pattern: 'solid',
      styleTags: ['tailored', 'minimalist', 'polished'],
      occasion: 'workwear',
      confidenceScore: 0.92,
    },
    identification: {
      visual_observation: 'Black double-breasted blazer with structured shoulders, peak lapels, and gold buttons.',
      item_type: 'blazer',
      subtype: 'double-breasted blazer',
      primary_color: 'black',
      secondary_colors: [],
      pattern: 'solid',
      material_estimate: 'wool blend',
      silhouette: 'structured',
      fit: 'tailored',
      length: 'hip length',
      sleeve_length: 'long sleeve',
      neckline_or_lapel: 'peak lapel',
      closure: 'front buttons',
      distinctive_features: ['gold buttons', 'structured shoulders'],
      style_tags: ['tailored', 'minimalist', 'polished'],
      occasion_tags: ['workwear', 'evening', 'smart casual'],
      visible_brand_text: null,
      logo_detected: false,
      brand_guess: null,
      confidence_score: 0.92,
      search_queries: [
        'black double breasted blazer gold buttons',
        'tailored black blazer structured shoulders',
        'minimalist black blazer peak lapel',
      ],
      non_fashion: false,
    },
  };

  const normalized = adapter.normalizeScanIdentifyResponse(raw);
  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.identification.item_type, 'blazer');
  assert.equal(normalized.identification.confidence_score, 0.92);

  const mapped = mapper.mapScanIdentifyToAnalysis(normalized);
  assert.equal(mapped.type, 'fashion');
  assert.equal(mapped.result, 'Black double-breasted blazer with structured shoulders, peak lapels, and gold buttons.');
  assert.equal(mapped.metadata.category, 'blazer');
  assert.equal(mapped.metadata.itemType, 'double-breasted blazer');
  assert.equal(mapped.metadata.color, 'black');
  assert.equal(mapped.metadata.silhouette, 'structured');
  assert.equal(mapped.metadata.materialEstimate, 'wool blend');
  assert.equal(mapped.metadata.pattern, 'solid');
  assert.equal(mapped.metadata.occasion, 'workwear');
  assert.deepStrictEqual(mapped.metadata.styleTags, ['tailored', 'minimalist', 'polished']);
  assert.equal(mapped.metadata.confidenceScore, 0.92);
});

// ── Mock case 2: Floral midi dress ────────────────────────────────────────────

test('mock: floral puff-sleeve midi dress → rich identification', () => {
  const raw = {
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'Floral puff-sleeve midi dress with a fitted waist and soft flowing skirt.',
    attributes: {
      category: 'dress',
      itemType: 'puff-sleeve midi dress',
      silhouette: 'A-line',
      colorPalette: ['multi', 'green', 'pink'],
      materialEstimate: 'lightweight cotton or viscose',
      pattern: 'floral',
      styleTags: ['feminine', 'romantic', 'summer'],
      occasion: 'daytime',
      confidenceScore: 0.89,
    },
    identification: {
      visual_observation: 'Floral puff-sleeve midi dress with a fitted waist and soft flowing skirt.',
      item_type: 'dress',
      subtype: 'puff-sleeve midi dress',
      primary_color: 'multi',
      secondary_colors: ['green', 'pink'],
      pattern: 'floral',
      material_estimate: 'lightweight cotton or viscose',
      silhouette: 'A-line',
      fit: 'fitted waist',
      length: 'midi',
      sleeve_length: 'short sleeve',
      neckline_or_lapel: 'round neck',
      closure: 'side zipper',
      distinctive_features: ['puff sleeves', 'fitted waist', 'flowing skirt'],
      style_tags: ['feminine', 'romantic', 'summer'],
      occasion_tags: ['daytime', 'casual', 'brunch'],
      visible_brand_text: null,
      logo_detected: false,
      brand_guess: null,
      confidence_score: 0.89,
      search_queries: [
        'floral puff sleeve midi dress fitted waist',
        'A-line floral midi dress short sleeve',
        'romantic summer dress puff sleeves',
      ],
      non_fashion: false,
    },
  };

  const normalized = adapter.normalizeScanIdentifyResponse(raw);
  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.identification.item_type, 'dress');

  const mapped = mapper.mapScanIdentifyToAnalysis(normalized);
  assert.equal(mapped.type, 'fashion');
  assert.equal(mapped.result, 'Floral puff-sleeve midi dress with a fitted waist and soft flowing skirt.');
  assert.equal(mapped.metadata.category, 'dress');
  assert.equal(mapped.metadata.color, 'multi, green, pink');
  assert.equal(mapped.metadata.silhouette, 'A-line');
  assert.equal(mapped.metadata.itemType, 'puff-sleeve midi dress');
  assert.equal(mapped.metadata.materialEstimate, 'lightweight cotton or viscose');
  assert.equal(mapped.metadata.pattern, 'floral');
  assert.equal(mapped.metadata.occasion, 'daytime');
  assert.deepStrictEqual(mapped.metadata.styleTags, ['feminine', 'romantic', 'summer']);
  assert.equal(mapped.metadata.confidenceScore, 0.89);
});

// ── Mock case 3: Non-fashion coffee mug ─────────────────────────────────────

test('mock: non-fashion coffee mug → safe non_fashion response', () => {
  const raw = {
    status: 'non_fashion',
    recommendedProducts: [],
    userMessage: 'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.',
    identification: {
      visual_observation: 'This is a coffee mug, not a fashion item.',
      item_type: 'NON_FASHION',
      confidence_score: 0.95,
      non_fashion: true,
    },
  };

  const normalized = adapter.normalizeScanIdentifyResponse(raw);
  assert.equal(normalized.status, 'non_fashion');
  // identification is not surfaced on non_fashion in the adapter (message only)
  assert.equal(normalized.userMessage, 'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.');

  const mapped = mapper.mapScanIdentifyToAnalysis(normalized);
  assert.equal(mapped.type, 'non-fashion');
  assert.equal(mapped.message, 'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.');
});

// ── Backward compatibility: old attributes-only shape still works ─────────────

test('mock: legacy attributes-only shape → backward compatible', () => {
  const raw = {
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'A tan trench coat.',
    attributes: {
      category: 'Outerwear',
      itemType: 'Trench coat',
      silhouette: 'Relaxed straight fit',
      colorPalette: ['Tan', 'Camel'],
      confidenceScore: 0.86,
    },
  };

  const normalized = adapter.normalizeScanIdentifyResponse(raw);
  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.identification, undefined);

  const mapped = mapper.mapScanIdentifyToAnalysis(normalized);
  assert.equal(mapped.type, 'fashion');
  assert.equal(mapped.result, 'A tan trench coat.');
  assert.equal(mapped.metadata.category, 'Outerwear');
  assert.equal(mapped.metadata.itemType, 'Trench coat');
  assert.equal(mapped.metadata.color, 'Tan, Camel');
});
