// Elise header visual-context gallery — image evidence tests (IMG-007).
//
// Phase 2A recorded the defect this file covers: selecting a photo from the
// Elise header gallery produced a local sanitized preview and a `ready` entry
// titled "Uploaded photo". `toServerSafeActiveContext()` strips local URIs by
// design, and the path created no remote media backing, so `stylechat-generate`
// received descriptive placeholder context and no image reference. Elise was
// presented as image-aware while the backend had seen nothing.
//
// These tests prove the repaired path: the sanitized derivative reaches
// scan-identify, the normalized structured result becomes the visual context,
// the image gains authorized actor-owned remote backing, and every failure mode
// stays honest rather than producing a `ready` entry.
//
// Backend responses are deterministic fixtures. No network, no Supabase, no
// live model call.

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

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// ── Deterministic backend fixtures ───────────────────────────────────────────

/** A normal completed scan-identify response with rich attributes. */
function completedResponse() {
  return {
    status: 'completed',
    userMessage: 'A tan cotton chore jacket.',
    identification: {
      item_type: 'Jacket',
      subtype: 'Chore Jacket',
      brand_guess: 'Carhartt',
      visible_brand_text: 'Carhartt',
      logo_detected: true,
      primary_color: 'Tan',
      secondary_colors: ['Cream'],
      silhouette: 'Boxy',
      material_estimate: 'Cotton canvas',
      pattern: 'Solid',
      style_tags: ['workwear', 'casual'],
      fit: 'Relaxed',
      confidence_score: 0.86,
      visual_observation: 'A tan cotton chore jacket with patch pockets.',
    },
    attributes: {
      category: 'Outerwear',
    },
    similarityMatches: [],
    recommendedProducts: [],
  };
}

/**
 * Builds the evidence module with every external dependency injected, and
 * records what each collaborator was called with.
 */
function loadEvidenceModule(overrides = {}) {
  const calls = {
    compress: [],
    identify: [],
    stage: [],
  };

  class PrivacyPrepareError extends Error {}

  const privacyImageUpload = {
    PrivacyPrepareError,
    compressSanitizedImageForAnalysis: async (uri) => {
      calls.compress.push(uri);
      if (overrides.compressThrows) throw new PrivacyPrepareError('compress failed');
      return { base64: 'data:image/jpeg;base64,AAAA', uri: `${uri}.analysis` };
    },
  };

  const scanIdentification = {
    identifyScanImage: async (image, options) => {
      calls.identify.push({ image, options });
      return overrides.response ?? completedResponse();
    },
  };

  // The real shared Scanner mapper — not a stand-in. Its output is the contract
  // this repair depends on, so stubbing it would prove nothing.
  const scanIdentificationMapper = loadTsModule('services/scanIdentificationMapper.ts', {
    // Phase 2B.2: the null-safe V2 display projection, loaded for real so the
    // mapper's V2 branch is exercised rather than simulated.
    './scannerV2Display': loadTsModule('services/scannerV2Display.ts', {}),
    './scanTitleBuilder': loadTsModule('services/scanTitleBuilder.ts', {}),
    // IMG-008: the mapper now also builds the durable identification snapshot.
    './identificationSnapshot': loadTsModule('services/identificationSnapshot.ts', {
      '../types/scanIdentification': {},
    }),
    './scanResultObject': loadTsModule('services/scanResultObject.ts', {
      '../types/scanIdentification': {},
      '../types/scanResultObject': {},
      '../constants/build': { IS_PRODUCTION_BUILD: true },
    }),
    './outfitConfirmation/outfitDetectionBridge': loadTsModule(
      'services/outfitConfirmation/outfitDetectionBridge.ts',
      { '../../types/scanIdentification': {} },
    ),
    '../constants/build': { IS_PRODUCTION_BUILD: true },
    '../types/scanIdentification': {},
    '../types/scanResultObject': {},
  });

  const eliseDirectImageAttachment = {
    resolvePreparedDirectImageAttachment: async (prepared, options) => {
      calls.stage.push({ prepared, options });
      if (overrides.stagingFails) {
        return { ok: false, errorCode: 'UPLOAD_FAILED', message: 'nope' };
      }
      return {
        ok: true,
        resolved: {
          attachmentType: 'owned_item',
          sourceType: 'saved_scan',
          sourceId: 'saved-scan-uuid-1',
          contractVersion: 'v2',
        },
        summary: { title: options?.title ?? 'Photo', itemCount: 1 },
        prepared,
      };
    },
  };

  const mod = loadTsModule('services/style-chat/eliseVisualContextEvidence.ts', {
    '../privacyImageUpload': privacyImageUpload,
    '../scanIdentification': scanIdentification,
    '../scanIdentificationMapper': scanIdentificationMapper,
    './eliseDirectImageAttachment': eliseDirectImageAttachment,
    '../../types/eliseVisualContext': {},
    '../../types/fashionIdentificationV2': {},
    // Phase 2B.3 added a V2 branch ahead of the legacy one. These tests cover the
    // LEGACY path, so the flag resolves OFF and the V2 branch is never entered —
    // which is exactly the "flag-off preserves current behaviour" property. The
    // V2 branch has its own coverage in eliseHeaderGalleryV2.test.js.
    '../fashionEvidenceGateway': {
      prepareFashionEvidence: () => {
        throw new Error('flag-off header gallery must not build V2 evidence');
      },
    },
    './eliseIdentifyForStyle': {
      identifyPreparedImageForStyle: () => {
        throw new Error('flag-off header gallery must not call identify_for_style');
      },
    },
    './eliseIdentificationV2': {
      beginEliseV2Session: () => ({ enabled: false }),
      createEvidenceId: () => 'evidence-should-not-be-used',
    },
    './eliseDirectImageIdentification': {
      currentIdentificationPlatform: () => 'ios',
    },
    './eliseVisualContextV2Projection': {
      projectV2ToVisualContextFields: () => {
        throw new Error('flag-off header gallery must not project a V2 identity');
      },
    },
  });

  return { mod, calls };
}

// ── 1–5. Evidence actually reaches the backend and comes back structured ─────

test('IMG-007: the sanitized derivative is sent to scan-identify', async () => {
  const { mod, calls } = loadEvidenceModule();
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.compress, ['file:///s.jpg']);
  assert.equal(calls.identify.length, 1, 'scan-identify must be invoked exactly once');
  assert.match(calls.identify[0].image, /^data:image\/jpeg;base64,/);
  assert.equal(calls.identify[0].options.source, 'upload');
});

test('IMG-007: privacy attestation stays truthful on the identification call', async () => {
  const { mod, calls } = loadEvidenceModule();
  await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });

  assert.equal(
    calls.identify[0].options.localPrivacyFiltered,
    false,
    'a metadata-stripping re-encode is not face or plate masking',
  );
});

test('IMG-007: the structured identification becomes the visual context', async () => {
  const { mod } = loadEvidenceModule();
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });

  assert.equal(result.ok, true);
  const { fields } = result;
  assert.equal(fields.category, 'Jacket', 'the mapper prefers identification.item_type over the attributes category');
  assert.equal(fields.brand, 'Carhartt');
  // Arrays cross the VM realm boundary, so compare contents rather than
  // identity — deepStrictEqual would fail on the foreign Array prototype.
  // Primary + secondary colours survive as a real list, not one joined string.
  assert.deepEqual(Array.from(fields.colors), ['Tan', 'Cream']);
  assert.deepEqual(Array.from(fields.materials), ['Cotton canvas']);
  assert.equal(fields.silhouette, 'Boxy');
  assert.equal(fields.confidence, 0.86);
  assert.ok(Array.isArray(fields.styleAttributes) && fields.styleAttributes.includes('workwear'));
  assert.ok(fields.summary && fields.summary.length > 0);
  // The placeholder title the defect produced must be gone.
  assert.notEqual(fields.title, 'Uploaded photo');
});

test('IMG-007: the image receives authorized actor-owned remote backing', async () => {
  const { mod, calls } = loadEvidenceModule();
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });

  assert.equal(result.ok, true);
  assert.equal(result.savedScanId, 'saved-scan-uuid-1');
  assert.equal(calls.stage.length, 1, 'staging must run exactly once');
  // The real identification is persisted, not a placeholder.
  assert.equal(calls.stage[0].options.analysis.type, 'fashion');
  assert.equal(calls.stage[0].options.analysis.metadata.category, 'Jacket');
});

test('IMG-007: identification runs before any staging write', async () => {
  const { mod, calls } = loadEvidenceModule();
  await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });

  // Staging receives the mapped analysis, which cannot exist before
  // identification returned — so a single correct row is written, and a
  // classification failure leaves no orphaned row or uploaded media behind.
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.stage.length, 1);
  assert.ok(calls.stage[0].options.analysis, 'staging must carry the identification result');
});

// ── 9–10. Failures stay honest ───────────────────────────────────────────────

test('IMG-007: a failed identification does not pretend success', async () => {
  const { mod, calls } = loadEvidenceModule({
    response: { status: 'failed', userMessage: 'Something went wrong.' },
  });
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'identification_failed');
  assert.equal(calls.stage.length, 0, 'nothing may be staged for an unidentified image');
});

test('IMG-007: non-fashion stays distinct from a technical failure', async () => {
  const { mod } = loadEvidenceModule({
    response: { status: 'non_fashion', userMessage: 'That does not look like clothing.' },
  });
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'non_fashion');
  assert.notEqual(result.reason, 'identification_failed');
});

test('IMG-007: failed staging creates no visual context', async () => {
  const { mod } = loadEvidenceModule({ stagingFails: true });
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'staging_failed');
  assert.equal(result.fields, undefined, 'no descriptive fields may survive a staging failure');
});

test('IMG-007: a completed response with no usable category is not grounded context', async () => {
  const { mod, calls } = loadEvidenceModule({
    response: { status: 'completed', userMessage: 'Hmm.', identification: {}, attributes: {} },
  });
  const result = await mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///s.jpg' });

  assert.equal(result.ok, false);
  assert.equal(calls.stage.length, 0);
});

// ── 8. Cancellation ──────────────────────────────────────────────────────────

test('IMG-007: cancellation before work starts is a no-op', async () => {
  const { mod, calls } = loadEvidenceModule();
  const controller = new AbortController();
  controller.abort();

  const result = await mod.prepareVisualContextEvidence({
    sanitizedUri: 'file:///s.jpg',
    signal: controller.signal,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cancelled');
  assert.equal(calls.compress.length, 0);
  assert.equal(calls.identify.length, 0);
  assert.equal(calls.stage.length, 0);
});

// ── 2–3, 11–12. Hook wiring: preview stays local, ready requires evidence ────

const HOOK_SOURCE = read('hooks/useEliseVisualContext.ts');

test('IMG-007: the header gallery routes every selection through evidence preparation', () => {
  assert.match(
    HOOK_SOURCE,
    /prepareVisualContextEvidence/,
    'the upload path must call the evidence pipeline',
  );
});

test('IMG-007: no upload entry becomes ready without a savedScanId', () => {
  // The single `status: 'ready'` transition in the upload job must be the one
  // that also carries the staged reference and the identified fields.
  const readyTransitions = HOOK_SOURCE.match(/status:\s*'ready'/g) ?? [];
  assert.equal(readyTransitions.length, 1, 'exactly one ready transition should exist');
  const readyIndex = HOOK_SOURCE.indexOf("status: 'ready'");
  const window = HOOK_SOURCE.slice(readyIndex - 400, readyIndex + 400);
  assert.match(window, /savedScanId: evidence\.savedScanId/);
  assert.match(window, /\.\.\.evidence\.fields/);
});

test('IMG-007: the placeholder-only ready state is gone', () => {
  assert.ok(
    !/status:\s*'ready',\s*\n\s*title:\s*entry\.title \|\| 'Uploaded photo'/.test(HOOK_SOURCE),
    'the image-less "Uploaded photo" ready entry must no longer exist',
  );
});

test('IMG-007: a stale revision or actor cannot commit a completed entry', () => {
  // Every mutation in the preparation job goes through the revision-guarded
  // update, so a logout / account switch / removal invalidates late results.
  const jobBody = HOOK_SOURCE.slice(
    HOOK_SOURCE.indexOf('const processEntry'),
    HOOK_SOURCE.indexOf('processEntryRef.current = processEntry'),
  );
  assert.ok(jobBody.length > 0);
  assert.ok(
    !/\bupdateVisualContextEntry\(/.test(jobBody),
    'the job must never use an unguarded update',
  );
  const guarded = jobBody.match(/updateVisualContextEntryIfCurrent\(/g) ?? [];
  assert.ok(guarded.length >= 3, 'preview, failure and success updates must all be guarded');
});

test('IMG-007: duplicate work is suppressed by the preparation queue', () => {
  assert.match(HOOK_SOURCE, /pickerInFlightRef\.current/, 'duplicate picker taps are suppressed');
  assert.match(HOOK_SOURCE, /isVisualContextEntryRevisionCurrent/, 'stale jobs are dropped');
});

// ── 3. No local URI may cross the network ────────────────────────────────────

test('IMG-007: server-safe context still carries no local URI or storage reference', () => {
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');
  // Start after the signature: the return type is an Omit<…> that names the
  // very fields being excluded, so including it would match its own guard.
  const signatureIndex = provider.indexOf('export function toServerSafeActiveContext');
  const start = provider.indexOf('return {', signatureIndex);
  const end = provider.indexOf('function normalizeStatus', start);
  const body = provider.slice(start, end);

  assert.ok(signatureIndex >= 0 && start > signatureIndex && end > start);
  for (const forbidden of [
    'sanitizedPreviewUri',
    'rawImageUri',
    'imageUri',
    'savedScanId',
    'actorKey',
    'base64',
  ]) {
    assert.ok(!body.includes(forbidden), `server-safe context must not include ${forbidden}`);
  }
});

test('IMG-007: the visual-context type still forbids remote image references', () => {
  const types = read('types/eliseVisualContext.ts');
  const start = types.indexOf('export type EliseVisualContextInput');
  const body = types.slice(start, types.indexOf('};', start));
  for (const forbidden of ['Uri', 'url', 'base64', 'savedScanId']) {
    assert.ok(!body.includes(forbidden), `EliseVisualContextInput must not expose ${forbidden}`);
  }
});

// ── 13–14. Existing paths keep working ───────────────────────────────────────

test('IMG-007 regression: the direct composer attachment still stages a placeholder', () => {
  const source = read('services/style-chat/eliseDirectImageAttachment.ts');
  // The direct path deliberately skips scan-identify; the added `analysis`
  // option must be optional so that behaviour is unchanged.
  assert.match(source, /analysis\?:/, 'the analysis override must be optional');
  assert.match(
    source,
    /options\?\.analysis \?\? \{/,
    'the placeholder analysis must remain the default',
  );
  assert.ok(
    !source.includes('identifyScanImage'),
    'the direct attachment path must still not call scan-identify',
  );
});

test('IMG-007 regression: the Scanner handoff intent path is untouched', () => {
  assert.match(HOOK_SOURCE, /createVisualContextScanIntent/);
  assert.match(HOOK_SOURCE, /returnToSessionId=/);
  assert.match(HOOK_SOURCE, /visualContextIntentId=/);
});
