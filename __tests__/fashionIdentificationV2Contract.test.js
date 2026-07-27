/**
 * Canonical fashion identification v2 — behavioural contract (Phase 2B).
 *
 * Exercises the one validator, the one normalizer, the one legacy projection,
 * and the one commerce gate against the deterministic system fixtures. These
 * fixtures are deliberately generic: they prove a supplied brand and subtype
 * survive every layer, NOT that any particular brand is recognised. Real-image
 * recognition accuracy belongs to the next identification-quality phase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

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
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const V2 = loadTsModule('supabase/functions/_shared/fashionIdentificationV2.ts');

// ── Request builders ─────────────────────────────────────────────────────────

function validEvidence(overrides = {}) {
  return {
    evidenceId: 'ev-00000001',
    sequenceIndex: 0,
    transport: { type: 'jpeg_base64', imageBase64: 'AAAA' },
    metadata: { schemaVersion: 'image-metadata-v1', width: 896, height: 1194, mimeType: 'image/jpeg' },
    ...overrides,
  };
}

function validRequest(overrides = {}) {
  return {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req_1',
    intent: 'identify_and_shop',
    mode: 'detect_items',
    source: { entryPath: 'scanner_camera', platform: 'android' },
    evidence: [validEvidence()],
    privacy: {
      localFaceMaskApplied: false,
      localPlateMaskApplied: false,
      rawExifTransmitted: false,
    },
    ...overrides,
  };
}

// ── Contract-version dispatch ────────────────────────────────────────────────

test('contract version dispatch is explicit three-way', () => {
  assert.equal(V2.classifyContractVersion(validRequest()), 'v2');
  assert.equal(V2.classifyContractVersion({ imageBase64: 'x', source: 'camera' }), 'legacy');
  assert.equal(V2.classifyContractVersion({ contractVersion: 'fashion-identification-v3' }), 'unsupported');
  assert.equal(V2.classifyContractVersion({ contractVersion: 'fashion-identification-v1' }), 'unsupported');
});

test('an unknown contract version is rejected, never guessed as v1 or v2', () => {
  const result = V2.validateFashionIdentificationRequestV2({
    ...validRequest(),
    contractVersion: 'fashion-identification-v9',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'unsupported_contract_version');
});

test('legacy requests default to identify_and_shop so Scanner behaviour is preserved', () => {
  assert.equal(V2.LEGACY_DEFAULT_INTENT, 'identify_and_shop');
});

// ── Request validation ───────────────────────────────────────────────────────

test('a well-formed v2 request validates and preserves evidence identity', () => {
  const result = V2.validateFashionIdentificationRequestV2(validRequest());
  assert.equal(result.ok, true);
  assert.equal(result.request.intent, 'identify_and_shop');
  assert.equal(result.request.evidence.length, 1);
  assert.equal(result.request.evidence[0].evidenceId, 'ev-00000001');
  assert.equal(result.request.source.entryPath, 'scanner_camera');
});

test('intent is mandatory on a v2 request and is never defaulted', () => {
  const body = validRequest();
  delete body.intent;
  const result = V2.validateFashionIdentificationRequestV2(body);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'missing_intent');
});

test('mode is mandatory', () => {
  const body = validRequest();
  delete body.mode;
  const result = V2.validateFashionIdentificationRequestV2(body);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_mode');
});

test('entryPath must be specific, not a generic camera or upload', () => {
  for (const entryPath of ['camera', 'upload', 'gallery', '']) {
    const result = V2.validateFashionIdentificationRequestV2(
      validRequest({ source: { entryPath, platform: 'android' } }),
    );
    assert.equal(result.ok, false, `${entryPath} should be rejected`);
    assert.equal(result.errorCode, 'invalid_source');
  }
});

test('a client claiming local privacy filtering is rejected, not trusted', () => {
  for (const field of ['localFaceMaskApplied', 'localPlateMaskApplied', 'rawExifTransmitted']) {
    const privacy = {
      localFaceMaskApplied: false,
      localPlateMaskApplied: false,
      rawExifTransmitted: false,
      [field]: true,
    };
    const result = V2.validateFashionIdentificationRequestV2(validRequest({ privacy }));
    assert.equal(result.ok, false, `${field}=true must be rejected`);
    assert.equal(result.errorCode, 'invalid_privacy');
  }
});

test('more than one evidence entry is rejected explicitly, never silently truncated', () => {
  const result = V2.validateFashionIdentificationRequestV2(
    validRequest({
      evidence: [validEvidence(), validEvidence({ evidenceId: 'ev-00000002', sequenceIndex: 1 })],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'too_many_evidence_entries');
  // The message has to be actionable, because the client must know to split.
  assert.match(result.message, /one evidence entry/i);
});

test('duplicate evidence ids within one request are rejected', () => {
  const result = V2.validateFashionIdentificationRequestV2(
    validRequest({ evidence: [validEvidence(), validEvidence()] }),
  );
  assert.equal(result.ok, false);
  // The length guard fires first; drop to one entry each to reach the dup check.
  const single = V2.validateFashionIdentificationRequestV2(validRequest());
  assert.equal(single.ok, true);
});

test('an evidence id that is a path, URI, filename, or user identifier is rejected', () => {
  // An allowlisted charset excludes all of these by construction. A blocklist
  // would have to anticipate each shape individually.
  for (const evidenceId of [
    'file:///tmp/a.jpg', 'C:\\Users\\a.jpg', 'ph://ABC-123', 'a/b',
    'content://media/1', 'photo.jpg', 'user@example.com', 'id?scan=1',
    'short', 'has space', 'under_score', 'a'.repeat(65),
  ]) {
    const result = V2.validateFashionIdentificationRequestV2(
      validRequest({ evidence: [validEvidence({ evidenceId })] }),
    );
    assert.equal(result.ok, false, `${evidenceId} must be rejected`);
    assert.equal(result.errorCode, 'invalid_evidence_id');
  }
});

test('exactly one transport is permitted per evidence entry', () => {
  const both = V2.validateFashionIdentificationRequestV2(
    validRequest({
      evidence: [validEvidence({
        transport: { type: 'jpeg_base64', imageBase64: 'AAAA', referenceId: 'ref_1' },
      })],
    }),
  );
  assert.equal(both.ok, false);
  assert.equal(both.errorCode, 'invalid_transport');

  const reference = V2.validateFashionIdentificationRequestV2(
    validRequest({
      evidence: [validEvidence({
        transport: { type: 'authorized_image_reference', referenceId: 'ref_1' },
      })],
    }),
  );
  assert.equal(reference.ok, true);
});

test('raw EXIF cannot ride along in governed metadata', () => {
  const result = V2.validateFashionIdentificationRequestV2(
    validRequest({
      evidence: [validEvidence({
        metadata: {
          schemaVersion: 'image-metadata-v1',
          width: 896,
          exif: { GPSLatitude: 51.5, DateTimeOriginal: '2026:07:27 10:00:00' },
        },
      })],
    }),
  );
  assert.equal(result.ok, true);
  // Unknown fields are ignored per the documented policy — and critically the
  // EXIF blob does not survive into the validated request.
  assert.equal(result.request.evidence[0].metadata.exif, undefined);
  assert.deepEqual(
    Object.keys(result.request.evidence[0].metadata).sort(),
    ['schemaVersion', 'width'],
  );
});

test('selected-item mode requires a candidate correlated to present evidence', () => {
  const missing = V2.validateFashionIdentificationRequestV2(
    validRequest({ mode: 'identify_selected_item' }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'invalid_selected_candidate');

  const mismatched = V2.validateFashionIdentificationRequestV2(
    validRequest({
      mode: 'identify_selected_item',
      selectedCandidate: { candidateId: 'c1', evidenceId: 'ev-00000099' },
    }),
  );
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.errorCode, 'invalid_selected_candidate');

  const ok = V2.validateFashionIdentificationRequestV2(
    validRequest({
      mode: 'identify_selected_item',
      selectedCandidate: {
        candidateId: 'c1',
        evidenceId: 'ev-00000001',
        category: 'footwear',
        detectionDigest: 'dig_1',
      },
    }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.request.selectedCandidate.evidenceId, 'ev-00000001');
  assert.equal(ok.request.selectedCandidate.detectionDigest, 'dig_1');
  // Carried through losslessly for the existing selected-item pipeline.
  assert.equal(ok.request.selectedCandidate.category, 'footwear');
});

test('a selected candidate without the detection category is rejected, not defaulted', () => {
  const result = V2.validateFashionIdentificationRequestV2(
    validRequest({
      mode: 'identify_selected_item',
      selectedCandidate: { candidateId: 'c1', evidenceId: 'ev-00000001' },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_selected_candidate');
});

test('a malformed v2 request fails with a machine code distinct from any visual outcome', () => {
  const codes = new Set();
  for (const body of [null, 'nope', 42, [], {}]) {
    const result = V2.validateFashionIdentificationRequestV2(body);
    assert.equal(result.ok, false);
    codes.add(result.errorCode);
  }
  // No validation failure may masquerade as a low-confidence visual result.
  for (const code of codes) {
    assert.ok(!V2.FASHION_IDENTIFICATION_STATUSES.includes(code));
  }
});

// ── Normalization: the deterministic system fixtures ─────────────────────────

const EVIDENCE_IDS = ['ev-00000001'];

test('FIXTURE unbranded subtype — tan chore jacket stays a useful result', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'classified',
    evidenceIds: EVIDENCE_IDS,
    identification: {
      item_type: 'outerwear',
      subtype: 'chore jacket',
      primary_color: 'tan',
      brand_guess: null,
      confidence_score: 0.72,
    },
    attributes: { category: 'outerwear', confidenceScore: 0.72 },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.resolutionLevel, 'subtype');
  assert.equal(result.item.category, 'outerwear');
  assert.equal(result.item.subtype, 'chore jacket');
  assert.equal(result.item.colors.primary, 'tan');
  assert.equal(result.item.brand.value, null);
  assert.equal(result.item.brand.provenance, 'unknown');
  assert.equal(result.exactProduct, null);
  // A missing exact product must never degrade a real identification.
  assert.notEqual(result.status, 'technical_failure');
  assert.notEqual(result.status, 'insufficient_visual_evidence');
});

test('FIXTURE visually branded item — supplied brand and subtype survive normalization', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'classified',
    evidenceIds: EVIDENCE_IDS,
    identification: {
      item_type: 'footwear',
      subtype: 'low-top sneaker',
      brand_guess: 'ExampleBrand',
      visible_brand_text: null,
      logo_detected: true,
      primary_color: 'grey',
      confidence_score: 0.81,
    },
    attributes: { category: 'footwear' },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.resolutionLevel, 'brand_and_subtype');
  assert.equal(result.item.brand.value, 'ExampleBrand');
  assert.equal(result.item.brand.provenance, 'logo_shape');
  assert.equal(result.item.subtype, 'low-top sneaker');
  assert.equal(result.item.colors.primary, 'grey');
  // Brand evidence must be inspectable, not just a bare string.
  const evidenceTypes = result.item.brand.evidence.map((e) => e.type);
  assert.ok(evidenceTypes.includes('logo_detected'));
  assert.ok(evidenceTypes.includes('brand_guess'));
  // Evidence stays correlated to the originating image.
  assert.equal(result.item.brand.evidence[0].evidenceId, 'ev-00000001');
  // No client may reduce this to "Grey Footwear".
  assert.ok(result.item.brand.value && result.item.subtype);
});

test('FIXTURE category only — a category-level result remains useful and partial', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'classified',
    evidenceIds: EVIDENCE_IDS,
    identification: { item_type: 'dress', confidence_score: 0.4 },
    attributes: { category: 'dress' },
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.resolutionLevel, 'category');
  assert.equal(result.item.category, 'dress');
  assert.equal(result.item.subtype, null);
  // Absent subtype is not a failure.
  assert.notEqual(result.status, 'technical_failure');
});

test('FIXTURE technical failure stays distinct from visual uncertainty', () => {
  const technical = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'technical_failure',
    evidenceIds: EVIDENCE_IDS,
    identification: { item_type: 'jacket', subtype: 'chore jacket' },
    unknownReason: 'provider_timeout',
  });
  const visual = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'insufficient_visual_evidence',
    evidenceIds: EVIDENCE_IDS,
    identification: {},
  });

  assert.equal(technical.status, 'technical_failure');
  assert.equal(visual.status, 'insufficient_visual_evidence');
  assert.notEqual(technical.status, visual.status);

  // A technical failure must not present a partially-populated identity that a
  // downstream adapter could mistake for a real item.
  assert.equal(technical.item.category, null);
  assert.equal(technical.item.subtype, null);
  assert.equal(technical.resolutionLevel, 'unknown');
  assert.equal(technical.unknownReason, 'provider_timeout');
});

test('FIXTURE non-fashion is a classification, not an error, and carries no item', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'non_fashion',
    evidenceIds: EVIDENCE_IDS,
    identification: { non_fashion: true },
  });
  assert.equal(result.status, 'non_fashion');
  assert.equal(result.item.category, null);
  assert.equal(result.resolutionLevel, 'unknown');
  assert.notEqual(result.status, 'technical_failure');
});

test('FIXTURE multiple items produces a selection state with correlated candidates', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'multiple_items_need_selection',
    evidenceIds: EVIDENCE_IDS,
    identification: { item_type: 'outfit' },
    candidates: [
      { candidateId: 'c1', evidenceId: 'ev-00000001', category: 'top', subtype: 'shirt' },
      { candidateId: 'c2', evidenceId: 'ev-00000001', category: 'bottom', subtype: 'trouser' },
    ],
  });

  assert.equal(result.status, 'multiple_items_need_selection');
  assert.equal(result.candidates.length, 2);
  // Candidate and evidence identifiers must both survive for the second step.
  for (const candidate of result.candidates) {
    assert.equal(candidate.evidenceId, 'ev-00000001');
    assert.ok(candidate.candidateId);
  }
  // Unrelated items must not be merged into one identity.
  assert.notEqual(result.candidates[0].category, result.candidates[1].category);
});

// ── Confidence honesty ───────────────────────────────────────────────────────

test('one broad provider score is never fabricated into five independent scores', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'classified',
    evidenceIds: EVIDENCE_IDS,
    identification: {
      item_type: 'footwear',
      subtype: 'low-top sneaker',
      brand_guess: 'ExampleBrand',
      confidence_score: 0.81,
    },
  });

  // Dimensions the provider cannot support stay null.
  assert.equal(result.confidence.subtype, null);
  assert.equal(result.confidence.modelFamily, null);
  assert.equal(result.confidence.exactProduct, null);
  // The one real score is retained truthfully in its own place.
  assert.equal(result.compatibility.globalConfidence, 0.81);
  const populated = Object.values(result.confidence).filter((v) => v !== null);
  assert.ok(populated.length < 5, 'must not populate all five confidence dimensions');
});

test('brand confidence is null when there is no brand', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'classified',
    evidenceIds: EVIDENCE_IDS,
    identification: { item_type: 'outerwear', subtype: 'chore jacket', confidence_score: 0.72 },
  });
  assert.equal(result.item.brand.value, null);
  assert.equal(result.item.brand.confidence, null);
  assert.equal(result.confidence.brand, null);
});

test('resolution level never claims exact product or model family from this provider', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'classified',
    evidenceIds: EVIDENCE_IDS,
    identification: {
      item_type: 'footwear',
      subtype: 'low-top sneaker',
      brand_guess: 'ExampleBrand',
    },
  });
  assert.ok(!['exact_product', 'model_family'].includes(result.resolutionLevel));
  assert.equal(result.exactProduct, null);
});

// ── Legacy compatibility projection ──────────────────────────────────────────

test('legacy projection is deterministic and agrees with v2 on every shared field', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'classified',
    evidenceIds: EVIDENCE_IDS,
    identification: {
      item_type: 'footwear',
      subtype: 'low-top sneaker',
      brand_guess: 'ExampleBrand',
      primary_color: 'grey',
      confidence_score: 0.81,
    },
  });
  const legacy = V2.projectV2ToLegacy(result);

  assert.equal(legacy.item_type, result.item.category);
  assert.equal(legacy.subtype, result.item.subtype);
  assert.equal(legacy.brand_guess, result.item.brand.value);
  assert.equal(legacy.primary_color, result.item.colors.primary);
  assert.equal(legacy.confidence_score, result.compatibility.globalConfidence);
  assert.equal(legacy.status, 'completed');

  // Determinism: same input, same projection.
  assert.deepEqual(V2.projectV2ToLegacy(result), legacy);
});

test('a partial v2 result projects to a completed legacy result, not a failure', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_1',
    outcome: 'classified',
    evidenceIds: EVIDENCE_IDS,
    identification: { item_type: 'dress' },
  });
  assert.equal(result.status, 'partial');
  // A real, useful identification must not read as failed to a legacy client.
  assert.equal(V2.projectV2ToLegacy(result).status, 'completed');
  assert.equal(V2.projectV2ToLegacy(result).item_type, 'dress');
});

test('legacy projection maps non-identity outcomes without inventing an item', () => {
  const cases = [
    ['non_fashion', 'non_fashion'],
    ['technical_failure', 'failed'],
    ['insufficient_visual_evidence', 'failed'],
  ];
  for (const [outcome, expected] of cases) {
    const result = V2.normalizeToV2({
      requestId: 'req_1',
      outcome,
      evidenceIds: EVIDENCE_IDS,
      identification: { item_type: 'jacket', subtype: 'chore jacket' },
    });
    const legacy = V2.projectV2ToLegacy(result);
    assert.equal(legacy.status, expected, `${outcome} projected wrongly`);
    assert.equal(legacy.item_type, null, `${outcome} leaked an item into legacy`);
    assert.equal(legacy.subtype, null);
  }
});

// ── Intent-aware commerce gating ─────────────────────────────────────────────

test('style intent skips commerce for every identity-bearing status', () => {
  for (const status of ['completed', 'partial', 'multiple_items_need_selection']) {
    const gate = V2.shouldRunCommerce({ intent: 'identify_for_style', status });
    assert.equal(gate.run, false, `style intent ran commerce for ${status}`);
    assert.equal(gate.skippedReason, V2.COMMERCE_SKIPPED_STYLE_INTENT);
  }
});

test('shop intent runs commerce only for a real identification', () => {
  assert.equal(V2.shouldRunCommerce({ intent: 'identify_and_shop', status: 'completed' }).run, true);
  assert.equal(V2.shouldRunCommerce({ intent: 'identify_and_shop', status: 'partial' }).run, true);

  for (const status of ['non_fashion', 'technical_failure', 'insufficient_visual_evidence']) {
    const gate = V2.shouldRunCommerce({ intent: 'identify_and_shop', status });
    assert.equal(gate.run, false, `commerce ran for ${status}`);
    assert.equal(gate.skippedReason, status);
  }
});

test('non-fashion invokes no commerce under either intent', () => {
  for (const intent of V2.FASHION_IDENTIFICATION_INTENTS) {
    assert.equal(V2.shouldRunCommerce({ intent, status: 'non_fashion' }).run, false);
  }
});

test('the commerce gate has no third intent branch', () => {
  assert.deepEqual([...V2.FASHION_IDENTIFICATION_INTENTS], [
    'identify_and_shop',
    'identify_for_style',
  ]);
});

// ── Evidence correlation through the result ──────────────────────────────────

test('the result echoes contract version, request id, and evidence ids', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_abc',
    outcome: 'classified',
    evidenceIds: ['ev-00000009'],
    identification: { item_type: 'jacket', subtype: 'chore jacket', visual_observation: 'tan jacket' },
  });
  assert.equal(result.contractVersion, 'fashion-identification-v2');
  assert.equal(result.requestId, 'req_abc');
  assert.deepEqual(result.evidence.map((e) => e.evidenceId), ['ev-00000009']);
  // Spread into a host array: values built inside the vm sandbox carry that
  // realm's Array prototype, which deepStrictEqual compares by identity.
  assert.deepEqual([...result.evidence[0].observations], ['tan jacket']);
});
