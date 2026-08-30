// Regression: Scanner brand-aware identification (build29 repair pass 2).
//
// THE DEFECT THIS PINS
//
// A Prada polo with a visible Prada wordmark displayed as "Yellow Top" while
// the free-text analysis still recognized brand-like evidence and a polo
// silhouette. Two precedence inversions, both "weak evidence beats strong
// evidence", caused this class of failure:
//
//   1. buildScanTitle's category resolution preferred the broad upstream
//      item_type field ("top") over the more fashion-specific subtype
//      ("polo shirt"), so a reliable specific category never reached the
//      title even when it was right there in the same response.
//   2. scanIdentificationMapper's brand resolution preferred brand_guess (a
//      model hypothesis, e.g. inferred from silhouette/style resemblance)
//      over visible_brand_text (literally read off the garment), so a
//      directly-read wordmark could be silently overridden by a conflicting
//      guess — or diluted into a 'medium'-confidence result that the title
//      builder correctly, but unhelpfully, omits.
//
// This suite exercises the REAL mapper + title-builder path end to end
// (mapper.mapScanIdentifyToAnalysis, not a re-implementation of its logic),
// so a future refactor that reintroduces either bug is caught here rather
// than by a source-text regex.
//
// THE GOVERNING RULE (do not weaken this)
//
// Strong/direct evidence (a legible wordmark, or a detected logo with a
// named guess) may confidently brand the title. A brand_guess with no
// legible text and no detected logo must NOT reach 'high' confidence and
// must NOT appear in the title — see CASE B. Loosening that gate to "fix"
// this regression would trade a display bug for hallucinated brands, which
// is the worse defect.

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

const scanResultObjectModule = loadTsModule('services/scanResultObject.ts');
const scanTitleBuilderModule = loadTsModule('services/scanTitleBuilder.ts');
// iOS-only dependency (Android's mapper does not import this): stub for real,
// matching the harness in scanIdentification.test.js.
const outfitDetectionBridgeModule = loadTsModule('services/outfitConfirmation/outfitDetectionBridge.ts');
const mapper = loadTsModule('services/scanIdentificationMapper.ts', {
  './scanResultObject': scanResultObjectModule,
  './scanTitleBuilder': scanTitleBuilderModule,
  './identificationSnapshot': loadTsModule('services/identificationSnapshot.ts'),
  './scannerV2Display': loadTsModule('services/scannerV2Display.ts'),
  './outfitConfirmation/outfitDetectionBridge': outfitDetectionBridgeModule,
  '../constants/build': { SCAN_IDENTITY_DEBUG: false },
});

// -- CASE A: strong / direct visible brand evidence --------------------------

test('CASE A (strong): a visible Prada wordmark survives to a brand-bearing, polo-specific title', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    identification: {
      // Deliberately generic upstream category, mirroring a real response
      // where item_type is broad and subtype carries the real specificity.
      item_type: 'top',
      subtype: 'polo shirt',
      primary_color: 'yellow',
      visible_brand_text: 'Prada',
      brand_guess: 'Prada',
      logo_detected: true,
      confidence_score: 0.9,
    },
  });

  assert.equal(out.metadata.brand, 'Prada', 'INTERNAL_BRAND must be Prada');
  assert.equal(out.metadata.brandConfidence, 'high', 'direct evidence must grade high');
  assert.equal(out.title, 'Prada Yellow Polo Shirt', 'DISPLAY_BRAND: brand-bearing, fashion-specific title');
  assert.ok(out.commerceEvidence === undefined, 'commerceDeferred was not set on this fixture');
});

test('CASE A (strong, commerce evidence): brand and specific category reach commerceEvidence unchanged', () => {
  // v127 deferred-commerce path: commerceEvidence carries the raw
  // identification through to a MODE B follow-up request. It must not be
  // stripped, reordered, or otherwise corrupted en route.
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    commerceDeferred: true,
    identification: {
      item_type: 'top',
      subtype: 'polo shirt',
      primary_color: 'yellow',
      visible_brand_text: 'Prada',
      brand_guess: 'Prada',
      logo_detected: true,
      confidence_score: 0.9,
    },
  });

  assert.equal(out.commerceDeferred, true);
  assert.ok(out.commerceEvidence, 'COMMERCE_EVIDENCE_BRAND: commerceEvidence must be present');
  assert.equal(out.commerceEvidence.identification.visible_brand_text, 'Prada');
  assert.equal(out.commerceEvidence.identification.brand_guess, 'Prada');
  assert.equal(out.commerceEvidence.identification.subtype, 'polo shirt');
});

// -- CASE B: weak / unsupported brand guess -----------------------------------

test('CASE B (weak): an unsupported brand guess does not confidently brand the title', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    identification: {
      item_type: 'top',
      subtype: 'polo shirt',
      primary_color: 'yellow',
      brand_guess: 'Prada',
      visible_brand_text: null,
      logo_detected: false,
      confidence_score: 0.6,
    },
  });

  assert.notEqual(out.metadata.brandConfidence, 'high', 'a bare guess must never grade high');
  assert.doesNotMatch(out.title, /prada/i, 'a weak guess must not appear as a confident brand claim');
  assert.equal(out.title, 'Yellow Polo Shirt', 'falls back to the safe, fashion-specific unbranded title');
});

// -- CASE C: no brand evidence at all -----------------------------------------

test('CASE C (none): unbranded item gets a fashion-specific title, no fabricated brand', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    identification: {
      item_type: 'top',
      subtype: 'polo shirt',
      primary_color: 'yellow',
      brand_guess: null,
      visible_brand_text: null,
      logo_detected: false,
      confidence_score: 0.85,
    },
  });

  assert.equal(out.metadata.brand, null);
  assert.equal(out.title, 'Yellow Polo Shirt');
});

// -- CASE D: conflicting evidence ---------------------------------------------

test('CASE D (conflict): directly-read evidence governs over a conflicting model guess', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    identification: {
      item_type: 'top',
      subtype: 'polo shirt',
      primary_color: 'yellow',
      brand_guess: 'Gucci', // the model's hypothesis
      visible_brand_text: 'Prada', // what was actually legible on the garment
      logo_detected: true,
      confidence_score: 0.9,
    },
  });

  assert.equal(out.metadata.brand, 'Prada', 'direct evidence must govern, never silently merge the two brands');
  assert.doesNotMatch(out.title, /gucci/i, 'the losing, conflicting guess must never reach the display title');
  assert.equal(out.title, 'Prada Yellow Polo Shirt');
});

test('CASE D (conflict, commerce evidence): the raw conflicting fields still both reach commerceEvidence', () => {
  // commerceEvidence intentionally carries the RAW identification (both
  // fields) rather than the resolved display brand — the backend's own
  // query builder is expected to apply the same direct-evidence-governs
  // rule (see supabase/functions/scan-identify/commerceRelevanceQueries.ts).
  // This test only pins that the client does not lose either field before
  // that point.
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    commerceDeferred: true,
    identification: {
      item_type: 'top',
      subtype: 'polo shirt',
      primary_color: 'yellow',
      brand_guess: 'Gucci',
      visible_brand_text: 'Prada',
      logo_detected: true,
      confidence_score: 0.9,
    },
  });

  assert.equal(out.commerceEvidence.identification.visible_brand_text, 'Prada');
  assert.equal(out.commerceEvidence.identification.brand_guess, 'Gucci');
});

// -- Category specificity, isolated from brand --------------------------------

test('POLO CATEGORY: a specific subtype is preferred over a generic upstream item_type', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    identification: {
      item_type: 'top',
      subtype: 'polo shirt',
      primary_color: 'yellow',
      confidence_score: 0.85,
    },
  });

  assert.equal(out.title, 'Yellow Polo Shirt');
  assert.doesNotMatch(out.title, /\btop\b/i, 'the generic upstream category must not leak into the title');
});

test('POLO CATEGORY: no subtype falls back to item_type exactly as before (no regression)', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    identification: {
      item_type: 'blazer',
      primary_color: 'navy',
      confidence_score: 0.85,
    },
  });

  assert.equal(out.title, 'Navy Blazer');
});
