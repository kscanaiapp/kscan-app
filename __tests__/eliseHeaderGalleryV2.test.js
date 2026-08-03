// Elise header gallery — Phase 2B.3 V2-branch fallback policy.
//
// The legacy-path coverage lives in eliseHeaderGalleryEvidence.test.js with the
// flag OFF. This file covers the V2 branch with the flag ON, and specifically
// the hostile-audit repair to its fallback policy:
//
//   * `technical_failure` from the V2 orchestrator FAILS the reference
//     retryably. It must never fall through to the legacy envelope — an
//     intentless legacy request is defaulted to identify_and_shop server-side,
//     which routes a style photo into the commerce path, and it bills a second
//     identification for a transient error.
//   * `legacy_fallback` (UNSUPPORTED_CONTRACT_VERSION — the deployment does not
//     serve V2) is the ONLY state that continues on the legacy path, and when
//     the orchestrator already performed its one permitted legacy retry, that
//     paid response is REUSED rather than purchased a third time.
//
// Backend responses are deterministic fixtures. No network, no Supabase.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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
    Date,
    JSON,
    Math,
    Number,
    Set,
    Array,
    Promise,
    exports: mod.exports,
    module: mod,
    require: (spec) => {
      if (spec in requireMap) return requireMap[spec];
      throw new Error(`Unexpected import in ${relativePath}: ${spec}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

/** A completed legacy scan-identify response, marked so reuse is observable. */
function paidLegacyResponse() {
  return {
    status: 'completed',
    auditMarker: 'paid-once',
    identification: {
      item_type: 'Jacket',
      subtype: 'Chore Jacket',
      primary_color: 'Tan',
      confidence_score: 0.86,
    },
    attributes: { category: 'Outerwear' },
    similarityMatches: [],
    recommendedProducts: [],
  };
}

/**
 * Loads the evidence module with the flag ON and a scripted V2 orchestrator.
 *
 * `v2Outcome` is what `identifyPreparedImageForStyle` resolves to. The legacy
 * transport records every call so the tests can prove exactly how many legacy
 * identifications were purchased.
 */
function loadV2EvidenceModule(v2Outcome) {
  const calls = { legacyIdentify: [], v2Identify: [], stage: [] };

  class PrivacyPrepareError extends Error {}

  const mod = loadTsModule('services/style-chat/eliseVisualContextEvidence.ts', {
    '../privacyImageUpload': {
      PrivacyPrepareError,
      compressSanitizedImageForAnalysis: async (uri) => ({
        base64: 'data:image/jpeg;base64,AAAA',
        uri: `${uri}.analysis`,
      }),
    },
    '../scanIdentification': {
      identifyScanImage: async (image, options) => {
        calls.legacyIdentify.push({ image, options });
        return paidLegacyResponse();
      },
    },
    '../scanIdentificationMapper': {
      mapScanIdentifyToAnalysis: (response) => ({
        type: 'fashion',
        result: 'A tan chore jacket.',
        metadata: { category: 'Outerwear', color: 'Tan' },
        auditMarker: response.auditMarker ?? null,
      }),
    },
    './eliseDirectImageAttachment': {
      stageSanitizedEliseDirectImage: async (sanitizedUri, source, previewUri) => ({
        previewUri: previewUri ?? sanitizedUri,
        preparedUri: sanitizedUri,
        source,
        operationId: 'header-v2-operation',
        candidateId: 'candidate-v2-1',
        candidateBatchId: 'batch-v2-1',
        candidateImageUri: 'file:///candidate-v2-1.jpg',
        candidateThumbnailUri: 'file:///candidate-v2-1-thumb.jpg',
      }),
      resolvePreparedDirectImageAttachment: async (prepared, options) => {
        calls.stage.push({ prepared, options });
        return {
          ok: true,
          summary: { title: options?.title ?? 'Photo', itemCount: 1 },
          prepared,
          closetState: 'not_saved',
        };
      },
      discardPreparedDirectImage: async () => {},
    },
    '../../types/eliseVisualContext': {},
    '../../types/fashionIdentificationV2': {},
    '../fashionEvidenceGateway': {
      prepareFashionEvidence: (input) => ({ ...input, imageBase64: 'AAAA' }),
    },
    './eliseIdentifyForStyle': {
      identifyPreparedImageForStyle: async (input) => {
        calls.v2Identify.push(input);
        return v2Outcome;
      },
    },
    './eliseIdentificationV2': {
      beginEliseV2Session: () => Object.freeze({ enabled: true }),
      createEvidenceId: () => 'evidence-v2-test',
    },
    './eliseDirectImageIdentification': {
      currentIdentificationPlatform: () => 'ios',
    },
    './eliseVisualContextV2Projection': {
      projectV2ToVisualContextFields: () => ({
        title: 'Tan Chore Jacket',
        summary: 'Tan chore jacket',
        category: 'Outerwear',
        colors: ['Tan'],
        materials: null,
        silhouette: null,
        styleAttributes: null,
        brand: null,
        confidence: 0.86,
      }),
    },
  });

  return { mod, calls };
}

test('V2 flag on: a technical failure fails retryably and NEVER falls to the legacy envelope', async () => {
  const { mod, calls } = loadV2EvidenceModule({
    state: 'technical_failure',
    identifications: [],
    candidates: [],
    fallbackUsed: false,
  });
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'identification_failed');
  assert.equal(calls.v2Identify.length, 1, 'exactly one V2 operation ran');
  assert.equal(
    calls.legacyIdentify.length,
    0,
    'a transient V2 failure must not issue an intentless legacy request (identify_and_shop by server default)',
  );
  assert.equal(calls.stage.length, 0, 'nothing is staged for a failed reference');
});

test('V2 flag on: legacy_fallback REUSES the paid legacy response instead of billing a third scan', async () => {
  const { mod, calls } = loadV2EvidenceModule({
    state: 'legacy_fallback',
    identifications: [],
    candidates: [],
    fallbackUsed: true,
    legacyResponse: paidLegacyResponse(),
  });
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });
  assert.equal(result.ok, true, 'the legacy contract remains a working route');
  assert.equal(calls.v2Identify.length, 1);
  assert.equal(
    calls.legacyIdentify.length,
    0,
    'the response the orchestrator already paid for must be reused, not re-purchased',
  );
});

test('V2 flag on: legacy_fallback with NO carried response purchases exactly one legacy identification', async () => {
  const { mod, calls } = loadV2EvidenceModule({
    state: 'legacy_fallback',
    identifications: [],
    candidates: [],
    fallbackUsed: false,
  });
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });
  assert.equal(result.ok, true);
  assert.equal(calls.legacyIdentify.length, 1, 'one legacy identification, not two');
});
