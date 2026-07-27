// Versioned identification snapshot — save/reopen fidelity (IMG-008).
//
// Phase 2A recorded the defect: library.saveScan() reduced a full normalized
// identification to six fields, three of which were hardcoded blanks
// (material_estimate: null, style_tags: [], confidence_score: null). The cloud
// row's analysis_result then persisted that same subset. Subtype, brand and its
// evidence, secondary colours, pattern, construction details, visible and
// distinctive attributes, and confidence could not be reconstructed after a
// scan was reopened — on Scanner and Elise, on both platforms.
//
// These tests cover the durable snapshot that closes it: local round trip,
// cloud round trip, partial results, legacy rows, malformed and unknown-version
// payloads, actor safety, and the separation of commerce from identification.
//
// Pure Node with deterministic fixtures. No network, no Supabase, no migration.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(relativePath, requireMap, extraGlobals = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    process,
    URL,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require in ${relativePath}: ${id}`);
    },
    ...extraGlobals,
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

const snapshotModule = transpile('services/identificationSnapshot.ts', {
  '../types/scanIdentification': {},
});

const {
  IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION,
  buildIdentificationSnapshot,
  hydrateIdentificationSnapshot,
  sanitizeIdentificationSnapshot,
  snapshotFromLegacyAttributes,
} = snapshotModule;

// ── Deterministic backend fixture ────────────────────────────────────────────

function richResponse(overrides = {}) {
  return {
    status: 'completed',
    userMessage: 'A tan cotton chore jacket.',
    identification: {
      visual_observation: 'A tan cotton chore jacket with patch pockets.',
      item_type: 'Jacket',
      subtype: 'Chore Jacket',
      primary_color: 'Tan',
      secondary_colors: ['Cream'],
      pattern: 'Solid',
      material_estimate: 'Cotton canvas',
      silhouette: 'Boxy',
      fit: 'Relaxed',
      length: 'Hip',
      sleeve_length: 'Long',
      neckline_or_lapel: 'Point collar',
      closure: 'Button front',
      distinctive_features: ['Triple-stitched seams', 'Patch pockets'],
      style_tags: ['workwear', 'casual'],
      occasion_tags: ['weekend'],
      visible_brand_text: 'Carhartt',
      logo_detected: true,
      brand_guess: 'Carhartt',
      confidence_score: 0.86,
      ...(overrides.identification ?? {}),
    },
    attributes: { category: 'Outerwear' },
    recommendedProducts: [],
    similarityMatches: [],
    ...overrides.top,
  };
}

/** Every rich field the snapshot is supposed to carry. */
function assertFullyPreserved(snapshot) {
  assert.equal(snapshot.contractVersion, IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.category, 'Jacket');
  assert.equal(snapshot.subtype, 'Chore Jacket');
  assert.equal(snapshot.brand.value, 'Carhartt');
  assert.equal(snapshot.confidence.overall, 0.86);
  assert.equal(snapshot.colors.primary, 'Tan');
  assert.deepEqual(Array.from(snapshot.colors.secondary), ['Cream']);
  assert.deepEqual(Array.from(snapshot.material), ['Cotton canvas']);
  assert.deepEqual(Array.from(snapshot.silhouette), ['Boxy']);
  assert.deepEqual(Array.from(snapshot.pattern), ['Solid']);
  assert.equal(snapshot.attributes.fit, 'Relaxed');
  assert.equal(snapshot.attributes.length, 'Hip');
  assert.equal(snapshot.attributes.sleeve, 'Long');
  assert.equal(snapshot.attributes.neckline, 'Point collar');
  assert.equal(snapshot.attributes.closure, 'Button front');
  assert.deepEqual(Array.from(snapshot.attributes.distinctive), [
    'Triple-stitched seams',
    'Patch pockets',
  ]);
  assert.ok(Array.from(snapshot.attributes.visible).includes('workwear'));

  const evidenceTypes = Array.from(snapshot.brand.evidence).map((entry) => entry.type);
  assert.ok(evidenceTypes.includes('visible_brand_text'));
  assert.ok(evidenceTypes.includes('logo_detected'));
  assert.ok(evidenceTypes.includes('brand_guess'));
}

// ── Build ────────────────────────────────────────────────────────────────────

test('IMG-008: the snapshot preserves every field the legacy shape dropped', () => {
  assertFullyPreserved(buildIdentificationSnapshot(richResponse()));
});

test('IMG-008: the snapshot carries no image bytes, paths, prompts or commerce', () => {
  const serialized = JSON.stringify(
    buildIdentificationSnapshot(richResponse({ top: { recommendedProducts: [{ url: 'x' }] } })),
  );
  for (const forbidden of ['base64', 'file://', 'content://', 'imageUri', 'prompt', 'recommendedProducts', 'purchase']) {
    assert.ok(!serialized.includes(forbidden), `snapshot must not contain ${forbidden}`);
  }
});

test('IMG-008: entryPath is recorded and never invented', () => {
  assert.equal(buildIdentificationSnapshot(richResponse()).source.entryPath, 'unknown');
  assert.equal(
    buildIdentificationSnapshot(richResponse(), { entryPath: 'elise_gallery' }).source.entryPath,
    'elise_gallery',
  );
});

test('IMG-008: a partial result still produces a usable snapshot', () => {
  const snapshot = buildIdentificationSnapshot(
    richResponse({
      identification: {
        subtype: null,
        brand_guess: null,
        visible_brand_text: null,
        logo_detected: false,
        distinctive_features: [],
        material_estimate: null,
      },
    }),
  );

  assert.equal(snapshot.category, 'Jacket', 'category must survive a brandless result');
  assert.equal(snapshot.brand.value, null);
  assert.equal(snapshot.brand.confidence, null, 'no brand means no brand confidence');
  assert.deepEqual(Array.from(snapshot.brand.evidence), []);
  assert.deepEqual(Array.from(snapshot.material), []);
  assert.equal(snapshot.colors.primary, 'Tan');
});

test('IMG-008: non-fashion and failed stay distinct from completed', () => {
  assert.equal(
    buildIdentificationSnapshot({ status: 'non_fashion', userMessage: 'Not clothing.' }).status,
    'non_fashion',
  );
  assert.equal(
    buildIdentificationSnapshot({ status: 'failed', userMessage: 'Try again.' }).status,
    'failed',
  );
  assert.equal(buildIdentificationSnapshot({ status: 'weird' }).status, 'unknown');
  assert.equal(buildIdentificationSnapshot(null), null);
});

test('IMG-008: an unknown reason is recorded for a non-completed result', () => {
  const snapshot = buildIdentificationSnapshot({ status: 'failed', userMessage: 'Try again.' });
  assert.equal(snapshot.unknownReason, 'Try again.');
  assert.equal(buildIdentificationSnapshot(richResponse()).unknownReason, null);
});

// ── Serialize / hydrate ──────────────────────────────────────────────────────

test('IMG-008: the snapshot survives a JSON round trip intact', () => {
  const original = buildIdentificationSnapshot(richResponse(), { entryPath: 'scanner_camera' });
  const rehydrated = sanitizeIdentificationSnapshot(JSON.parse(JSON.stringify(original)));
  assertFullyPreserved(rehydrated);
  assert.equal(rehydrated.source.entryPath, 'scanner_camera');
});

test('IMG-008: an unknown contract version is reported, not silently dropped', () => {
  const future = { ...buildIdentificationSnapshot(richResponse()), contractVersion: 'fashion-identification-v9' };
  const result = sanitizeIdentificationSnapshot(JSON.parse(JSON.stringify(future)));
  assert.equal(result.unsupported, true);
  assert.equal(result.contractVersion, 'fashion-identification-v9');
});

test('IMG-008: a malformed snapshot degrades instead of crashing hydration', () => {
  for (const malformed of [
    undefined,
    null,
    'string',
    42,
    [],
    {},
    { contractVersion: IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION },
    { contractVersion: IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION, brand: 'nope', colors: 7, attributes: [] },
  ]) {
    assert.doesNotThrow(() => sanitizeIdentificationSnapshot(malformed));
  }
  const salvaged = sanitizeIdentificationSnapshot({
    contractVersion: IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION,
    brand: 'nope',
    colors: 7,
    attributes: [],
  });
  assert.equal(salvaged.brand.value, null);
  assert.deepEqual(Array.from(salvaged.colors.secondary), []);
});

// ── Legacy compatibility ─────────────────────────────────────────────────────

test('IMG-008: a legacy flattened row remains readable', () => {
  const legacy = {
    attributes: {
      category: 'Footwear',
      silhouette: 'Low-top',
      color_palette: 'Grey, White',
      material_estimate: null,
      style_tags: [],
      confidence_score: null,
    },
    result: 'Grey Footwear',
  };
  const hydrated = hydrateIdentificationSnapshot(legacy);

  assert.ok(hydrated && !hydrated.unsupported);
  assert.equal(hydrated.category, 'Footwear');
  assert.equal(hydrated.colors.primary, 'Grey');
  assert.deepEqual(Array.from(hydrated.colors.secondary), ['White']);
  assert.equal(
    hydrated.status,
    'unknown',
    'a legacy row records no status; claiming completed would be an invention',
  );
  assert.equal(hydrated.subtype, null);
});

test('IMG-008: an empty legacy row yields no fabricated identification', () => {
  assert.equal(snapshotFromLegacyAttributes({}), null);
  assert.equal(
    snapshotFromLegacyAttributes({ category: '', color_palette: '', silhouette: '' }),
    null,
  );
});

test('IMG-008: a versioned snapshot wins over the legacy fields on the same record', () => {
  const hydrated = hydrateIdentificationSnapshot({
    identificationSnapshot: buildIdentificationSnapshot(richResponse()),
    attributes: { category: 'Stale', color_palette: 'Wrong', silhouette: '' },
  });
  assert.equal(hydrated.category, 'Jacket');
  assert.equal(hydrated.subtype, 'Chore Jacket');
});

test('IMG-008: an unknown-version row still falls back to legacy display', () => {
  const hydrated = hydrateIdentificationSnapshot({
    identificationSnapshot: { contractVersion: 'fashion-identification-v9', category: 'Future' },
    attributes: { category: 'Footwear', color_palette: 'Grey', silhouette: 'Low-top' },
  });
  // The record is not made unreadable: the unsupported version is surfaced and
  // the caller can still render the legacy fields it already had.
  assert.equal(hydrated.unsupported, true);
});

// ── Local persistence through library.saveScan ───────────────────────────────

function loadLibraryModule() {
  const purchaseOptions = transpile('services/purchaseOptions.ts', {});
  const actorContext = transpile('services/actorContext.js', {});
  const store = { json: null };

  const FileSystem = {
    documentDirectory: 'file:///doc/',
    EncodingType: { UTF8: 'utf8' },
    makeDirectoryAsync: async () => {},
    getInfoAsync: async () => ({ exists: Boolean(store.json) }),
    readAsStringAsync: async () => store.json || '[]',
    writeAsStringAsync: async (_p, contents) => { store.json = contents; },
    moveAsync: async () => {},
    deleteAsync: async () => {},
  };
  const ImageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => ({ uri: `${uri}-out.jpg` }),
  };
  const cloudCalls = [];

  const library = transpile('services/library.js', {
    'expo-file-system/legacy': FileSystem,
    'expo-image-manipulator': ImageManipulator,
    './savedScansCloud': {
      saveScanToCloud: async (...args) => { cloudCalls.push({ type: 'save', args }); return { ok: true }; },
      softDeleteCloudSavedScan: async () => ({ ok: true }),
    },
    './actorContext': actorContext,
    './purchaseOptions': purchaseOptions,
  });

  return { library, store, cloudCalls, actorContext };
}

function authAs(actorContext, ownerId) {
  if (actorContext.getActorContext().actorId !== ownerId) {
    actorContext.advanceActorEpoch(ownerId);
  }
  return actorContext.createActorRequest();
}

/** The analysis a mapped completed response produces, snapshot included. */
function mappedAnalysis() {
  return {
    type: 'fashion',
    result: 'A tan cotton chore jacket.',
    metadata: {
      category: 'Jacket',
      color: 'Tan, Cream',
      silhouette: 'Boxy',
      materialEstimate: 'Cotton canvas',
      styleTags: ['workwear', 'casual'],
      confidenceScore: 0.86,
    },
    products: [],
    purchaseOptions: [{ title: 'A jacket', url: 'https://example.invalid/a', retailer: 'Shop' }],
    identificationSnapshot: buildIdentificationSnapshot(richResponse()),
  };
}

test('IMG-008: a saved scan persists the versioned snapshot locally', async () => {
  const { library, actorContext } = loadLibraryModule();
  const saved = await library.saveScan({
    photoUri: 'file:///photo.jpg',
    analysis: mappedAnalysis(),
    source: 'upload',
    actorRequest: authAs(actorContext, 'user-1'),
  });

  assert.ok(saved, 'the save must succeed');
  assertFullyPreserved(saved.identificationSnapshot);
  assert.equal(saved.identificationSnapshot.source.entryPath, 'scanner_gallery');
});

test('IMG-008: an explicit entryPath overrides the source-derived default', async () => {
  const { library, actorContext } = loadLibraryModule();
  const saved = await library.saveScan({
    photoUri: 'file:///photo.jpg',
    analysis: mappedAnalysis(),
    source: 'upload',
    entryPath: 'elise_gallery',
    actorRequest: authAs(actorContext, 'user-1'),
  });
  assert.equal(saved.identificationSnapshot.source.entryPath, 'elise_gallery');
});

test('IMG-008: the snapshot survives close and reopen of the local library', async () => {
  const { library, actorContext } = loadLibraryModule();
  await library.saveScan({
    photoUri: 'file:///photo.jpg',
    analysis: mappedAnalysis(),
    source: 'camera',
    actorRequest: authAs(actorContext, 'user-1'),
  });

  const reopened = await library.loadLibrary('user-1');
  assert.equal(reopened.length, 1);
  assertFullyPreserved(reopened[0].identificationSnapshot);
  // Purchase options remain a separate, still-surviving snapshot.
  assert.equal(reopened[0].purchaseOptions.length, 1);
});

test('IMG-008: the legacy attribute block is no longer blanked out', async () => {
  const { library, actorContext } = loadLibraryModule();
  const saved = await library.saveScan({
    photoUri: 'file:///photo.jpg',
    analysis: mappedAnalysis(),
    source: 'camera',
    actorRequest: authAs(actorContext, 'user-1'),
  });

  assert.equal(saved.attributes.material_estimate, 'Cotton canvas');
  assert.deepEqual(Array.from(saved.attributes.style_tags), ['workwear', 'casual']);
  assert.equal(saved.attributes.confidence_score, 0.86);
});

test('IMG-008: a save with no identification writes no snapshot', async () => {
  const { library, actorContext } = loadLibraryModule();
  const saved = await library.saveScan({
    photoUri: 'file:///photo.jpg',
    analysis: { result: 'Photo — attached for Elise', metadata: { category: 'tops' } },
    source: 'upload',
    actorRequest: authAs(actorContext, 'user-1'),
  });

  assert.equal(saved.identificationSnapshot, undefined);
  // …and it still hydrates from the legacy fields rather than being unreadable.
  assert.equal(hydrateIdentificationSnapshot(saved).category, 'tops');
});

test('IMG-008: a stale actor cannot commit a snapshot under the wrong owner', async () => {
  const { library, actorContext } = loadLibraryModule();
  const staleRequest = authAs(actorContext, 'user-1');
  actorContext.advanceActorEpoch('user-2');

  const saved = await library.saveScan({
    photoUri: 'file:///photo.jpg',
    analysis: mappedAnalysis(),
    source: 'camera',
    actorRequest: staleRequest,
  });

  assert.equal(saved, null, 'a stale actor request must be rejected outright');
  assert.equal((await library.loadLibrary('user-2')).length, 0);
  assert.equal((await library.loadLibrary('user-1')).length, 0);
});

// ── Cloud round trip ─────────────────────────────────────────────────────────

function loadCloudModule() {
  return transpile('services/savedScansCloud.ts', {
    './supabaseClient': { supabase: {} },
    '@supabase/supabase-js': {},
    '../constants/featureFlags': { CLOUD_SAVED_SCANS_ENABLED: true },
    './purchaseOptions': transpile('services/purchaseOptions.ts', {}),
    './identificationSnapshot': snapshotModule,
  });
}

test('IMG-008: the cloud row carries the snapshot in the existing JSON column', () => {
  const cloud = loadCloudModule();
  const row = cloud.mapSavedScanToRow(
    {
      id: 'scan_1',
      createdAt: '2026-07-27T00:00:00.000Z',
      thumbnailUri: null,
      attributes: {
        category: 'Jacket',
        silhouette: 'Boxy',
        color_palette: 'Tan, Cream',
        material_estimate: 'Cotton canvas',
        style_tags: ['workwear'],
        confidence_score: 0.86,
      },
      identificationSnapshot: buildIdentificationSnapshot(richResponse()),
      result: 'A tan cotton chore jacket.',
      products: [],
      purchaseOptions: [],
      source: 'upload',
    },
    'user-1',
  );

  assert.equal(row.user_id, 'user-1');
  assertFullyPreserved(row.analysis_result.identificationSnapshot);
  // The privacy repair from Phase 2A must still hold.
  assert.equal(row.image_uri, null);
  assert.equal(row.thumbnail_uri, null);
  assert.ok(!JSON.stringify(row).includes('file://'));
});

test('IMG-008: a fresh client hydrates the full snapshot from the cloud row', () => {
  const cloud = loadCloudModule();
  const snapshot = buildIdentificationSnapshot(richResponse(), { entryPath: 'scanner_camera' });
  const model = cloud.mapSavedScanRowToModel({
    id: 'cloud-1',
    user_id: 'user-1',
    local_id: 'scan_1',
    title: 'Jacket',
    scan_type: 'upload',
    analysis_result: JSON.parse(
      JSON.stringify({
        result: 'A tan cotton chore jacket.',
        metadata: { category: 'Jacket', color: 'Tan, Cream' },
        identificationSnapshot: snapshot,
      }),
    ),
    products: [],
    purchase_options: [{ title: 'A jacket', url: 'https://example.invalid/a', retailer: 'Shop' }],
    image_uri: null,
    thumbnail_uri: null,
    source: 'mobile',
    saved_at: '2026-07-27T00:00:00.000Z',
    deleted_at: null,
    metadata: {},
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
  });

  assertFullyPreserved(model.identificationSnapshot);
  assert.equal(model.identificationSnapshot.source.entryPath, 'scanner_camera');
  assert.equal(model.ownerId, 'user-1', 'ownership comes from the row, never the payload');
  assert.equal(model.purchaseOptions.length, 1, 'purchase options remain separate and intact');
});

test('IMG-008: a legacy cloud row still hydrates without a snapshot', () => {
  const cloud = loadCloudModule();
  const model = cloud.mapSavedScanRowToModel({
    id: 'cloud-2',
    user_id: 'user-1',
    local_id: 'scan_2',
    title: 'Footwear',
    scan_type: 'camera',
    analysis_result: {
      result: 'Grey Footwear',
      metadata: { category: 'Footwear', color: 'Grey', silhouette: 'Low-top' },
    },
    products: [],
    purchase_options: [],
    image_uri: null,
    thumbnail_uri: null,
    source: 'mobile',
    saved_at: '2026-07-27T00:00:00.000Z',
    deleted_at: null,
    metadata: {},
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
  });

  assert.equal(model.identificationSnapshot, undefined);
  assert.equal(model.attributes.category, 'Footwear');
  assert.equal(model.result, 'Grey Footwear');
  assert.equal(hydrateIdentificationSnapshot(model).colors.primary, 'Grey');
});

test('IMG-008: a malformed or unknown-version cloud snapshot never reaches the model', () => {
  const cloud = loadCloudModule();
  const base = {
    id: 'cloud-3',
    user_id: 'user-1',
    local_id: 'scan_3',
    title: null,
    scan_type: 'camera',
    products: [],
    purchase_options: [],
    image_uri: null,
    thumbnail_uri: null,
    source: 'mobile',
    saved_at: '2026-07-27T00:00:00.000Z',
    deleted_at: null,
    metadata: {},
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
  };

  for (const payload of [
    { identificationSnapshot: 'garbage' },
    { identificationSnapshot: { contractVersion: 'fashion-identification-v9', category: 'Future' } },
    { identificationSnapshot: [] },
  ]) {
    const model = cloud.mapSavedScanRowToModel({
      ...base,
      analysis_result: { result: 'Something', metadata: { category: 'Tops' }, ...payload },
    });
    assert.equal(model.identificationSnapshot, undefined);
    assert.equal(model.attributes.category, 'Tops', 'legacy display must survive');
  }
});

test('IMG-008: commerce results never enter the identification snapshot', () => {
  const cloud = loadCloudModule();
  const row = cloud.mapSavedScanToRow(
    {
      id: 'scan_4',
      createdAt: '2026-07-27T00:00:00.000Z',
      thumbnailUri: null,
      attributes: {
        category: 'Jacket',
        silhouette: '',
        color_palette: '',
        material_estimate: null,
        style_tags: [],
        confidence_score: null,
      },
      identificationSnapshot: buildIdentificationSnapshot(richResponse()),
      result: 'A tan cotton chore jacket.',
      products: [],
      purchaseOptions: [{ title: 'A jacket', url: 'https://example.invalid/a', retailer: 'Shop' }],
      commerceSnapshotVersion: 1,
      source: 'upload',
    },
    'user-1',
  );

  assert.equal(row.purchase_options.length, 1, 'purchase options stay in their own column');
  assert.ok(
    !JSON.stringify(row.analysis_result.identificationSnapshot).includes('example.invalid'),
    'a retailer result must never be able to mutate the visual identification',
  );
});
