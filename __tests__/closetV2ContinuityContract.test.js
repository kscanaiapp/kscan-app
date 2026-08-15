// BUILD 29 CLOSET V2 — PERMANENT CONTINUITY CONTRACT
//
// WHAT THIS GOVERNS
// -----------------
// The historical failure class this repository keeps hitting is NOT "the
// Scanner returned bad data". It is "Recent Scans and Closet look healthy while
// metadata or commerce fields were already lost at a persistence boundary".
//
// A test that asserts against the Scanner response object cannot catch that,
// because the response is fine. The loss happens later, in the serializer, in
// the jsonb round-trip, in hydration, or in the Closet adapter.
//
// So this test drives the REAL adapters end to end:
//
//   ScanIdentifyResponse (rich)
//     -> buildIdentificationSnapshot        services/identificationSnapshot.ts
//     -> SavedScanModel
//     -> mapSavedScanToRow                  services/savedScansCloud.ts   [SERIALIZE]
//     -> JSON.parse(JSON.stringify(row))    simulates the jsonb column
//     -> mapSavedScanRowToModel             services/savedScansCloud.ts   [HYDRATE]
//     -> normalizeSavedScanRow              services/ownedClosetItems.ts  [CLOSET]
//
// The JSON round-trip in the middle is load-bearing. A field that only exists
// as a live object reference — a Map, a class instance, an undefined — vanishes
// there exactly as it would vanish through Postgres, and that is precisely the
// bug shape we are guarding against.
//
// FAILURE MEANING: if this test fails, a field that the product contract
// promises to persist is being dropped somewhere between the Scanner and the
// Closet. Do not adjust the expectation to match the new behaviour without
// establishing that the contract itself changed.

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
    // URL/URLSearchParams are Node/web globals, not ECMAScript intrinsics, so a
    // bare VM context does not have them. The commerce URL normalizer builds a
    // `new URL(...)` inside a try/catch, so without these it would swallow a
    // ReferenceError and silently return null for every link — a harness
    // artifact that looks exactly like a real commerce-drop regression.
    URL,
    URLSearchParams,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

// ── Real modules under test ──────────────────────────────────────────────────
const identificationSnapshot = loadTsModule('services/identificationSnapshot.ts');
const canonicalFashionMetadata = loadTsModule('services/canonicalFashionMetadata.ts');
const dressingRoomCommerce = loadTsModule('services/dressingRoomCommerce.ts');
const ownedTypes = loadTsModule('types/ownedClosetItem.ts');

const cloud = loadTsModule('services/savedScansCloud.ts', {
  './supabaseClient': { supabase: {} },
  '../constants/featureFlags': { CLOUD_SAVED_SCANS_ENABLED: true },
  './dressingRoomCommerce': dressingRoomCommerce,
  './identificationSnapshot': identificationSnapshot,
});

const owned = loadTsModule('services/ownedClosetItems.ts', {
  './supabaseClient': { supabase: {} },
  './savedScansCloud': cloud,
  '../types/ownedClosetItem': ownedTypes,
  './canonicalFashionMetadata': canonicalFashionMetadata,
  './identificationSnapshot': identificationSnapshot,
});

const REMOTE_UUID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * A rich Scanner response — the shape scan-identify returns when identification
 * actually succeeds, carrying every field the canonical contract claims.
 */
function richScanResponse() {
  return {
    scanId: 'scan-abc',
    status: 'completed',
    attributes: {
      category: 'Outerwear',
      silhouette: 'Structured',
      colorPalette: ['Charcoal', 'Slate'],
      materialEstimate: 'Wool',
      pattern: 'Herringbone',
      styleTags: ['tailored', 'work'],
      confidenceScore: 0.82,
    },
    identification: {
      item_type: 'Blazer',
      subtype: 'double-breasted blazer',
      primary_color: 'Charcoal',
      secondary_colors: ['Slate'],
      pattern: 'Herringbone',
      material_estimate: 'Wool',
      silhouette: 'Structured',
      fit: 'Tailored',
      length: 'Hip',
      sleeve_length: 'Long',
      neckline_or_lapel: 'Peak lapel',
      closure: 'Button',
      distinctive_features: ['functional cuff buttons'],
      style_tags: ['tailored', 'work'],
      occasion_tags: ['office'],
      visible_brand_text: 'ACME',
      logo_detected: true,
      brand_guess: 'Acme Tailoring',
      confidence_score: 0.82,
    },
    recommendedProducts: [],
  };
}

/** Commerce results as the Scanner/commerce path produces them. */
function commerceOptions() {
  return [
    {
      title: 'Charcoal Wool Blazer',
      retailer: 'Nordstrom',
      price: '395.00',
      currency: 'USD',
      productUrl: 'https://example.com/p/charcoal-blazer',
      imageUrl: 'https://cdn.example.com/blazer.jpg',
      availability: 'in_stock',
      matchScore: 0.91,
      provider: 'serpapi',
      productId: 'sku-4417',
    },
  ];
}

function makeModel(overrides = {}) {
  const response = richScanResponse();
  return {
    id: 'scan-local-1',
    cloudId: REMOTE_UUID,
    createdAt: '2026-08-14T00:00:00Z',
    savedAt: '2026-08-14T00:00:00Z',
    thumbnailUri: 'file:///scans/1-thumb.jpg',
    imageUri: 'file:///scans/1.jpg',
    attributes: {
      category: response.attributes.category,
      silhouette: response.attributes.silhouette,
      color_palette: response.attributes.colorPalette[0],
      material_estimate: response.attributes.materialEstimate,
      style_tags: response.attributes.styleTags,
      confidence_score: response.attributes.confidenceScore,
    },
    identificationSnapshot: identificationSnapshot.buildIdentificationSnapshot(response, {
      entryPath: 'camera',
    }),
    result: 'A structured charcoal wool blazer.',
    products: [],
    purchaseOptions: commerceOptions(),
    source: 'camera',
    metadata: {},
    ...overrides,
  };
}

/**
 * Serialize -> persist -> hydrate.
 *
 * The JSON round-trip stands in for the jsonb column. Anything that cannot
 * survive JSON cannot survive Postgres either.
 */
function persistAndReload(model) {
  const row = cloud.mapSavedScanToRow(model, USER_ID);
  const persisted = JSON.parse(JSON.stringify(row));
  return {
    persisted,
    reloaded: cloud.mapSavedScanRowToModel({
      ...persisted,
      id: persisted.id || REMOTE_UUID,
      created_at: '2026-08-14T00:00:00Z',
      updated_at: '2026-08-14T00:00:00Z',
    }),
  };
}

// ── S2: fashion metadata continuity ──────────────────────────────────────────

test('S2: the identification snapshot survives serialization into saved_scans', () => {
  const { persisted } = persistAndReload(makeModel());
  const stored = persisted.analysis_result.identificationSnapshot;

  assert.ok(stored, 'analysis_result must carry the identification snapshot');
  assert.equal(stored.subtype, 'double-breasted blazer');
  assert.equal(stored.colors.primary, 'Charcoal');
  assert.deepEqual(Array.from(stored.pattern), ['Herringbone']);
  assert.equal(stored.attributes.fit, 'Tailored');
});

test('S2: the snapshot survives hydration back out of the persisted row', () => {
  const { reloaded } = persistAndReload(makeModel());
  const snapshot = reloaded.identificationSnapshot;

  assert.ok(snapshot, 'hydration must return the snapshot, not drop it');
  assert.equal(snapshot.subtype, 'double-breasted blazer');
  assert.equal(snapshot.attributes.fit, 'Tailored');
  assert.deepEqual(Array.from(snapshot.pattern), ['Herringbone']);
});

test('S2: every canonical field reaches the Closet adapter after a full round trip', () => {
  const { persisted } = persistAndReload(makeModel());
  const item = owned.normalizeSavedScanRow({
    ...persisted,
    id: REMOTE_UUID,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  });

  // These six are the regression. Before the canonical adapter, subcategory,
  // pattern, fit and brand were null here on every row ever written, because
  // the reader looked for keys the writer never emitted.
  assert.equal(item.category, 'Blazer', 'category must survive');
  assert.equal(item.subcategory, 'double-breasted blazer', 'subtype/subcategory must survive');
  assert.equal(item.color, 'Charcoal', 'primary colour must survive');
  assert.equal(item.material, 'Wool', 'material must survive');
  assert.equal(item.pattern, 'Herringbone', 'pattern must survive');
  assert.equal(item.silhouette, 'Structured', 'silhouette must survive');
  assert.equal(item.fit, 'Tailored', 'fit must survive');
  assert.equal(item.brand, 'ACME', 'observed brand text must survive without promoting a guess');
});

test('S2: brand evidence stays separable and is never collapsed into the brand string', () => {
  const { persisted } = persistAndReload(makeModel());
  const item = owned.normalizeSavedScanRow({
    ...persisted,
    id: REMOTE_UUID,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  });

  const kinds = Array.from(item.brandEvidence).map((e) => e.type).sort();
  assert.deepEqual(
    kinds,
    ['brand_guess', 'logo_detected', 'visible_brand_text'],
    'all three brand-evidence signals must survive persistence',
  );

  const visible = Array.from(item.brandEvidence).find((e) => e.type === 'visible_brand_text');
  assert.equal(visible.value, 'ACME', 'the observed brand text must keep its value');

  // A guess and an observation are different claims. Only the visible text is
  // authoritative enough for the scalar; the guess remains typed evidence.
  assert.equal(item.brand, 'ACME');
  assert.ok(
    Array.from(item.brandEvidence).some((e) => e.type === 'brand_guess'),
    'brand_guess must remain visible as a guess and never become the scalar brand',
  );
});

test('S2: a guess without observed brand evidence never becomes the scalar brand', () => {
  const response = richScanResponse();
  response.identification.visible_brand_text = null;
  response.identification.logo_detected = false;
  const model = makeModel({
    identificationSnapshot: identificationSnapshot.buildIdentificationSnapshot(response, {
      entryPath: 'camera',
    }),
  });
  const { persisted } = persistAndReload(model);
  const item = owned.normalizeSavedScanRow({
    ...persisted,
    id: REMOTE_UUID,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  });
  assert.equal(item.brand, null);
  assert.equal(item.metadataProvenance.brand, 'absent');
  assert.equal(item.brandEvidence[0].type, 'brand_guess');
  assert.equal(item.brandEvidence[0].value, 'Acme Tailoring');
});

test('S2: a V2 snapshot outranks V1 and carries the complete canonical garment', () => {
  const v2 = {
    snapshotVersion: 2,
    contractVersion: 'fashion-identification-v2',
    source: 'camera',
    createdAt: '2026-08-14T00:00:00Z',
    updatedAt: '2026-08-14T00:00:00Z',
    purchaseOptions: [],
    identification: {
      contractVersion: 'fashion-identification-v2',
      requestId: 'request-v2',
      status: 'completed',
      resolutionLevel: 'brand_and_subtype',
      item: {
        category: 'Outerwear V2',
        clothingType: 'blazer',
        subtype: 'cropped blazer',
        brand: {
          value: 'Maison V2',
          confidence: 0.93,
          provenance: 'visible_text',
          evidence: [{ type: 'evidence_wordmark', observation: 'MAISON V2', confidence: 0.93 }],
        },
        colors: { primary: 'Ink', secondary: ['Silver'] },
        material: ['Wool blend'],
        silhouette: ['Cropped'],
        pattern: ['Pinstripe'],
        attributes: { fit: 'Tailored', pockets: [], visible: ['sharp lapel'], distinctive: [] },
      },
      confidence: { category: 0.96, subtype: 0.9, brand: 0.93, modelFamily: null, exactProduct: null },
      exactProduct: null,
      evidence: [],
      conflicts: [],
      compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.91 },
    },
  };
  const { persisted } = persistAndReload(makeModel({ identificationSnapshotV2: v2 }));
  const item = owned.normalizeSavedScanRow({
    ...persisted,
    id: REMOTE_UUID,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  });
  assert.equal(item.category, 'Outerwear V2');
  assert.equal(item.subcategory, 'cropped blazer');
  assert.equal(item.pattern, 'Pinstripe');
  assert.equal(item.fit, 'Tailored');
  assert.equal(item.brand, 'Maison V2');
  assert.equal(item.metadataProvenance.brand, 'identification_snapshot_v2');
  assert.equal(item.brandEvidence[0].type, 'evidence_wordmark');

  // V2's generic `visual` provenance is produced by brand_guess. It must stay
  // evidence-only just like the V1 guess path.
  v2.identification.item.brand = {
    value: 'Guess House',
    confidence: 0.61,
    provenance: 'visual',
    evidence: [{ type: 'brand_guess', observation: 'Guess House', confidence: 0.61 }],
  };
  const { persisted: guessPersisted } = persistAndReload(
    makeModel({ identificationSnapshotV2: v2 }),
  );
  const guessItem = owned.normalizeSavedScanRow({
    ...guessPersisted,
    id: REMOTE_UUID,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  });
  assert.equal(guessItem.brand, null);
  assert.equal(guessItem.metadataProvenance.brand, 'absent');
  assert.equal(guessItem.brandEvidence[0].type, 'brand_guess');
});

test('S2: provenance distinguishes a captured field from an absent one', () => {
  const { persisted } = persistAndReload(makeModel());
  const item = owned.normalizeSavedScanRow({
    ...persisted,
    id: REMOTE_UUID,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  });

  assert.equal(item.metadataProvenance.pattern, 'identification_snapshot_v1');
  assert.equal(item.metadataProvenance.fit, 'identification_snapshot_v1');
  assert.equal(item.metadataProvenance.subcategory, 'identification_snapshot_v1');
});

test('S2: a legacy row with no snapshot still resolves through the legacy fallback', () => {
  // Build 28 shape: analysis_result.metadata only, no identificationSnapshot.
  const legacyRow = {
    id: REMOTE_UUID,
    user_id: USER_ID,
    local_id: 'legacy-1',
    title: 'Wool blazer',
    scan_type: 'camera',
    analysis_result: {
      result: 'A structured wool blazer',
      metadata: {
        category: 'Blazer',
        color: 'Charcoal',
        silhouette: 'Structured',
        material_estimate: 'Wool',
        style_tags: ['classic'],
      },
    },
    products: [],
    purchase_options: [],
    image_uri: null,
    thumbnail_uri: null,
    source: 'mobile',
    saved_at: '2026-07-01T00:00:00Z',
    deleted_at: null,
    metadata: {},
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  };

  const item = owned.normalizeSavedScanRow(legacyRow);

  assert.equal(item.category, 'Blazer', 'legacy rows must keep resolving');
  assert.equal(item.color, 'Charcoal');
  assert.equal(item.material, 'Wool');
  assert.equal(item.metadataProvenance.category, 'legacy_metadata');

  // The legacy projection genuinely never carried these. They must read as
  // absent rather than being invented from a neighbouring field.
  assert.equal(item.pattern, null, 'a legacy row must not invent a pattern');
  assert.equal(item.fit, null, 'a legacy row must not invent a fit');
  assert.equal(item.metadataProvenance.pattern, 'absent');
  assert.equal(item.metadataProvenance.fit, 'absent');
});

test('S2: a malformed snapshot degrades to legacy instead of throwing or emptying', () => {
  const row = {
    id: REMOTE_UUID,
    user_id: USER_ID,
    local_id: 'broken-1',
    title: 'Wool blazer',
    scan_type: 'camera',
    analysis_result: {
      result: 'x',
      metadata: { category: 'Blazer', color: 'Charcoal' },
      identificationSnapshot: { contractVersion: 'fashion-identification-v99', junk: true },
    },
    products: [],
    purchase_options: [],
    image_uri: null,
    thumbnail_uri: null,
    source: 'mobile',
    saved_at: '2026-07-01T00:00:00Z',
    deleted_at: null,
    metadata: {},
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  };

  const item = owned.normalizeSavedScanRow(row);
  assert.equal(item.category, 'Blazer', 'a newer-contract snapshot must fall back, not blank out');
  assert.equal(item.metadataProvenance.category, 'legacy_metadata');
});

test('S2: a local scan carries its snapshot metadata into the Closet adapter', () => {
  const item = owned.normalizeLocalSavedScan(makeModel());

  // This path used to hard-code all four of these to null.
  assert.equal(item.subcategory, 'double-breasted blazer');
  assert.equal(item.pattern, 'Herringbone');
  assert.equal(item.fit, 'Tailored');
  assert.equal(item.brand, 'ACME');
});

// ── S3: commerce persistence continuity ──────────────────────────────────────

test('S3: persisted commerce provenance survives serialize -> reload', () => {
  const { persisted, reloaded } = persistAndReload(makeModel());

  assert.equal(persisted.purchase_options.length, 1, 'commerce must reach the row');
  const stored = persisted.purchase_options[0];
  assert.equal(stored.retailer, 'Nordstrom', 'retailer provenance must persist');
  assert.equal(stored.productUrl, 'https://example.com/p/charcoal-blazer', 'product URL must persist');
  assert.equal(stored.price, '395.00', 'price must persist');
  assert.equal(stored.currency, 'USD', 'currency must persist');
  assert.equal(stored.productId, 'sku-4417', 'product identity must persist');
  assert.equal(stored.provider, 'serpapi', 'provider provenance must persist');
  assert.equal(stored.matchScore, 0.91, 'match metadata must persist');

  const back = Array.from(reloaded.purchaseOptions);
  assert.equal(back.length, 1, 'commerce must survive hydration');
  assert.equal(back[0].retailer, 'Nordstrom');
  assert.equal(back[0].productUrl, 'https://example.com/p/charcoal-blazer');
  assert.equal(back[0].price, '395.00');
  assert.equal(back[0].currency, 'USD');
  assert.equal(back[0].productId, 'sku-4417');
});

test('S3: commerce is not dropped when the scan carries no identification', () => {
  // Commerce and identification are independent. A scan that failed to
  // identify must still keep any commerce result it obtained.
  const model = makeModel({ identificationSnapshot: null, result: '' });
  const { persisted } = persistAndReload(model);

  assert.equal(
    persisted.purchase_options.length,
    1,
    'an empty analysis_result must not take commerce down with it',
  );
  assert.equal(persisted.purchase_options[0].retailer, 'Nordstrom');
});

test('S3: absent commerce stays absent and is never invented', () => {
  const { persisted, reloaded } = persistAndReload(makeModel({ purchaseOptions: [] }));
  assert.deepEqual(Array.from(persisted.purchase_options), []);
  assert.deepEqual(Array.from(reloaded.purchaseOptions), []);
});

// ── S2: legacy-row enrichment ────────────────────────────────────────────────

/** Minimal saved_scans client: one row, lookup + update + insert. */
function mockClient(existingRow) {
  const calls = { updates: [], inserts: 0 };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: USER_ID } } }, error: null }),
    },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        is() { return this; },
        maybeSingle: async () => ({ data: existingRow, error: null }),
        update(payload) {
          calls.updates.push(payload);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
        insert: async () => {
          calls.inserts += 1;
          return { error: null };
        },
      };
    },
  };
  return { client, calls };
}

function legacyStoredRow() {
  return {
    id: REMOTE_UUID,
    deleted_at: null,
    // Build 28 shape: non-empty, but carries no identification snapshot.
    analysis_result: { result: 'A blazer', metadata: { category: 'Blazer' } },
    products: [],
    purchase_options: [],
  };
}

test('S2: a legacy row CAN acquire an identification snapshot on re-save', async () => {
  const { client, calls } = mockClient(legacyStoredRow());
  const result = await cloud.upsertSavedScanRowForAttachment(makeModel(), client);

  assert.equal(result.ok, true);
  assert.equal(calls.updates.length, 1, 'the existing row must be updated, not duplicated');

  const written = calls.updates[0].analysis_result;
  assert.ok(
    written,
    'a re-save carrying a snapshot must be allowed to write it onto a legacy row — ' +
      'otherwise subtype/pattern/fit/brand stay permanently absent for Build 28 users',
  );
  assert.equal(written.identificationSnapshot.subtype, 'double-breasted blazer');
  // Additive: what a previous build could read must still be there.
  assert.equal(typeof written.result, 'string');
  assert.ok(written.metadata, 'the legacy metadata projection must be preserved');
});

test('S2: enrichment never clobbers an existing snapshot', async () => {
  const stored = legacyStoredRow();
  stored.analysis_result.identificationSnapshot = {
    contractVersion: 'fashion-identification-v1',
    subtype: 'already-identified',
  };

  const { calls, client } = mockClient(stored);
  await cloud.upsertSavedScanRowForAttachment(makeModel(), client);

  assert.equal(
    calls.updates[0].analysis_result,
    undefined,
    'a row that already has a snapshot must not have it replaced by a re-save',
  );
});

test('S3: identification is immutable to commerce — a retailer result cannot rewrite the garment', () => {
  const model = makeModel({
    purchaseOptions: [
      {
        title: 'Navy Cotton Chinos',
        retailer: 'Retailer X',
        price: '80.00',
        currency: 'USD',
        productUrl: 'https://example.com/p/chinos',
        productId: 'sku-9999',
      },
    ],
  });
  const { persisted } = persistAndReload(model);
  const item = owned.normalizeSavedScanRow({
    ...persisted,
    id: REMOTE_UUID,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  });

  // The commerce match is for a completely different garment. Identification
  // must be unmoved by it.
  assert.equal(item.category, 'Blazer');
  assert.equal(item.subcategory, 'double-breasted blazer');
  assert.equal(item.color, 'Charcoal');
  assert.equal(item.brand, 'ACME');
});

// ── S5 §H: Recent Scan and Closet proven INDEPENDENTLY ───────────────────────
//
// These four are deliberately separate gates. The failure mode being guarded
// against is a suite where Recent Scan commerce "passes" only because a Closet
// copy happened to be present — which would hide a Recent Scan persistence
// regression completely. Each test below names exactly what it proves, and the
// first two never construct a Closet item at all.

test('RECENT_SCAN_RELOAD: a scan reopens after reload with identity and metadata intact', () => {
  const { reloaded } = persistAndReload(makeModel());

  // No Closet adapter is invoked anywhere in this test.
  assert.equal(reloaded.cloudId, REMOTE_UUID, 'identity must survive reload');
  assert.equal(reloaded.id, 'scan-local-1', 'local identity must survive reload');
  assert.equal(reloaded.identificationSnapshot.subtype, 'double-breasted blazer');
  assert.equal(reloaded.identificationSnapshot.attributes.fit, 'Tailored');
  assert.equal(reloaded.attributes.category, 'Outerwear');
  assert.equal(typeof reloaded.result, 'string');
});

test('RECENT_SCAN_COMMERCE: persisted commerce is recoverable WITHOUT Closet', () => {
  const { reloaded } = persistAndReload(makeModel());

  // Nothing in this test creates, saves to, or reads from Closet. If commerce
  // is present here, the Recent Scan path owns it independently.
  const options = Array.from(reloaded.purchaseOptions);
  assert.equal(options.length, 1, 'commerce must come back from the Recent Scan row itself');
  assert.equal(options[0].retailer, 'Nordstrom');
  assert.equal(options[0].productUrl, 'https://example.com/p/charcoal-blazer');
  assert.equal(options[0].price, '395.00');
  assert.equal(options[0].currency, 'USD');
  assert.equal(options[0].productId, 'sku-4417');
  assert.equal(options[0].provider, 'serpapi');

  // The CTA needs a usable link; a null here is the historical regression.
  assert.ok(options[0].productUrl, 'the commerce CTA must remain functional after reload');
});

test('RECENT_SCAN_TO_CLOSET: saving to Closet does not mutate or downgrade the scan', () => {
  const model = makeModel();
  const { persisted } = persistAndReload(model);
  const scanRow = {
    ...persisted,
    id: REMOTE_UUID,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  };

  // Snapshot the scan's commerce BEFORE the Closet conversion.
  const before = JSON.parse(JSON.stringify(scanRow.purchase_options));

  const item = owned.normalizeSavedScanRow(scanRow);
  assert.equal(item.subcategory, 'double-breasted blazer', 'Closet inherits the canonical metadata');

  // The Closet conversion is a projection. It must not write back.
  assert.deepEqual(
    JSON.parse(JSON.stringify(scanRow.purchase_options)),
    before,
    'converting to a Closet item must not mutate the originating scan commerce',
  );
  assert.equal(scanRow.analysis_result.identificationSnapshot.subtype, 'double-breasted blazer');
});

test('CLOSET_RELOAD: the Closet item survives its own reload independently', () => {
  const { persisted } = persistAndReload(makeModel());
  const scanRow = {
    ...persisted,
    id: REMOTE_UUID,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  };

  const first = owned.normalizeSavedScanRow(scanRow);
  // Reload = re-derive from the persisted row, as a fresh app launch would.
  const second = owned.normalizeSavedScanRow(JSON.parse(JSON.stringify(scanRow)));

  for (const field of ['category', 'subcategory', 'color', 'material', 'pattern', 'silhouette', 'fit', 'brand']) {
    assert.equal(second[field], first[field], `${field} must be stable across Closet reload`);
  }
  assert.equal(
    Array.from(second.brandEvidence).length,
    Array.from(first.brandEvidence).length,
    'brand evidence must be stable across Closet reload',
  );
});

test('INDEPENDENCE: a scan whose Closet projection is never built still keeps commerce', () => {
  // The explicit anti-pattern guard. Build ONLY the Recent Scan path and
  // assert commerce is whole — no Closet object is ever constructed.
  const { persisted, reloaded } = persistAndReload(makeModel());
  assert.equal(Array.from(reloaded.purchaseOptions).length, 1);
  assert.equal(persisted.purchase_options[0].productUrl, 'https://example.com/p/charcoal-blazer');
});
