// Phase 7 pre-staging integration — local client-side funnel harness (Node).
//
// Companion to supabase/functions/scan-identify/phase7PipelineSurvivability.test.ts
// (Deno), which covers the backend stages. This file covers the two stages
// that only run on the client: the V2 response validator, and the active
// scanner display/result state the app actually reads. Uses the REAL
// exported functions, transpiled in place — the same convention every other
// file under __tests__/ already uses for TypeScript services (see
// __tests__/scanIdentification.test.js, __tests__/helpers/loadScanJourneyModule.js).
//
// No network, no provider, no Supabase, no staging, no production. Every
// fixture is synthetic and inline.

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
    console,
    exports: mod.exports,
    module: mod,
    Set,
    Map,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    RegExp,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

// fashionIdentificationV2Core.ts imports isValidEvidenceId from the evidence
// gateway, which in turn imports expo-crypto — a native module unavailable
// under `node --test`. Stubbed here because neither function under test
// (validateFashionV2Response, extractFashionV2Candidates) calls it; only the
// module's own top-level `require` needs a binding to resolve.
const core = loadTsModule('services/fashionIdentificationV2Core.ts', {
  '../types/fashionIdentificationV2': loadTsModule('types/fashionIdentificationV2.ts'),
  './fashionEvidenceGateway': { isValidEvidenceId: () => true },
});

const display = loadTsModule('services/scannerV2Display.ts');

/** Mandated fixture: pants -> jeans -> wide_leg_jeans, three distinct tiers. */
function buildV2Response(overrides = {}) {
  return {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req_client_harness',
    status: 'completed',
    resolutionLevel: 'subtype',
    item: {
      category: 'pants',
      clothingType: 'jeans',
      subtype: 'wide_leg_jeans',
      brand: { value: 'Levi\'s', confidence: 0.7, provenance: 'inferred', evidence: [] },
      colors: { primary: 'dark blue', secondary: [] },
      material: ['denim'],
      silhouette: [],
      pattern: [],
      attributes: { pockets: [], visible: [], distinctive: [] },
    },
    confidence: { category: 0.9, subtype: 0.8, brand: 0.7, modelFamily: null, exactProduct: null },
    exactProduct: null,
    evidence: [{ evidenceId: 'ev-00000001', observations: [] }],
    candidates: [
      { candidateId: 'c1', evidenceId: 'ev-00000001', category: 'pants', clothingType: 'jeans', subtype: 'wide_leg_jeans' },
      { candidateId: 'c2', evidenceId: 'ev-00000001', category: 'footwear', subtype: 'chelsea_boot' },
    ],
    conflicts: [],
    unknownReason: null,
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.8 },
    ...overrides,
  };
}

// ── Stage 7: client parser retains clothingType ─────────────────────────────

test('stage 7 — client parser: validateFashionV2Response retains item.clothingType', () => {
  const validation = core.validateFashionV2Response(buildV2Response());
  assert.equal(validation.kind, 'ok', validation.kind === 'invalid' ? validation.category : '');
  assert.equal(validation.result.item.clothingType, 'jeans');
  assert.notEqual(validation.result.item.clothingType, validation.result.item.category);
  assert.notEqual(validation.result.item.clothingType, validation.result.item.subtype);
});

test('stage 7 — client parser: an absent clothingType (V1-shaped extra tolerance) does not reject the response', () => {
  const withoutTier = buildV2Response();
  delete withoutTier.item.clothingType;
  const validation = core.validateFashionV2Response(withoutTier);
  assert.equal(validation.kind, 'ok', validation.kind === 'invalid' ? validation.category : '');
});

test('stage 7 — candidate correlation: extractFashionV2Candidates retains clothingType per candidate', () => {
  const validation = core.validateFashionV2Response(buildV2Response());
  assert.equal(validation.kind, 'ok');
  const candidates = core.extractFashionV2Candidates(validation.result, 'ev-00000001');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].clothingType, 'jeans');
  assert.equal(candidates[1].clothingType, undefined, 'a candidate with no supplied tier stays absent');
});

// ── Stage 8: active scanner result state retains clothingType ──────────────

test('stage 8 — active result state: buildScannerV2Display carries clothingType through', () => {
  const validation = core.validateFashionV2Response(buildV2Response());
  assert.equal(validation.kind, 'ok');
  const projected = display.buildScannerV2Display(validation.result);
  assert.equal(projected.clothingType, 'jeans');
  assert.equal(projected.category, 'pants');
  assert.equal(projected.subtype, 'wide_leg_jeans');
});

test('stage 8 — active result state: an absent clothingType degrades to empty string, not a crash', () => {
  const withoutTier = buildV2Response();
  withoutTier.item.clothingType = null;
  const validation = core.validateFashionV2Response(withoutTier);
  assert.equal(validation.kind, 'ok');
  const projected = display.buildScannerV2Display(validation.result);
  assert.equal(projected.clothingType, '');
});

test('stage 8 — active result state: a malformed/null result never throws', () => {
  assert.doesNotThrow(() => display.buildScannerV2Display(null));
  assert.equal(display.buildScannerV2Display(null).clothingType, '');
});

// ── 10 (client half): no stage replaces it with category or subtype ────────

test('stage 10 — the three tiers stay distinct through the client parser and display projection', () => {
  const validation = core.validateFashionV2Response(buildV2Response());
  const projected = display.buildScannerV2Display(validation.result);
  const values = new Set([projected.category, projected.clothingType, projected.subtype]);
  assert.equal(values.size, 3, `expected 3 distinct values, got ${JSON.stringify([...values])}`);
});
