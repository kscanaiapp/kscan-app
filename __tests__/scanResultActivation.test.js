// Part 2 activation tests: Dressing Room save bridge, result-card view model,
// text-only share message, and compare adapter. Uses the same VM-sandbox harness
// as scanIdentification.test.js so RN/supabase runtime deps stay out.

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
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    Set,
    RegExp,
    String,
    Boolean,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

// Pure modules → load directly (type-only / no runtime imports).
const sro = loadTsModule('services/scanResultObject.ts');
const productSnapshot = loadTsModule('src/utils/productSnapshot.ts');

// The bridge has runtime imports: productSnapshot (pure), scanResultObject
// (pure), and styleObjects (stubbed so we never touch supabase / RN).
function loadBridge(addProductStub, extraStyleObjects = {}) {
  return loadTsModule('services/scanResultDressingRoom.ts', {
    '../src/utils/productSnapshot': productSnapshot,
    './scanResultObject': sro,
    './styleObjects': { addProductToDressingRoom: addProductStub, ...extraStyleObjects },
  });
}

function scanWithMatch(extraProductFields = {}) {
  return sro.createScanResultObject({
    status: 'completed',
    identification: {
      item_type: 'jacket',
      primary_color: 'Black',
      material_estimate: 'Leather',
      style_tags: ['edgy', 'minimalist'],
      confidence_score: 0.9,
      brand_guess: 'AllSaints',
    },
    recommendedProducts: [
      {
        id: 'p1',
        name: 'Leather Biker Jacket',
        retailer: 'Test Retailer',
        imageUrl: 'https://cdn.example.com/p1.jpg',
        productUrl: 'https://shop.example.com/p1',
        price: 129.99,
        matchScore: 0.92,
        ...extraProductFields,
      },
      { id: 'p2', name: 'Moto Jacket', image_url: 'https://cdn.example.com/p2.jpg' },
    ],
  });
}

// ── 6. Save adapter chooses primary recommended product ───────────────────────

test('save bridge selects the primary (first) recommended product', () => {
  const obj = scanWithMatch();
  const primary = sro && obj.matches[0];
  const bridge = loadBridge(async () => ({ id: 'item-1' }));
  assert.equal(bridge.selectPrimaryMatch(obj).id, 'p1');
  const source = bridge.buildDressingRoomSaveSource(obj);
  assert.equal(source.id, 'p1');
  assert.equal(source.title, 'Leather Biker Jacket');
  assert.equal(primary.id, 'p1');
});

// DR-1 regression: the save bridge must tag its source object with the
// Scanner scan's own id (ScanResultObject.id — distinct from the matched
// product's id) and kind: 'scanner_single', so the canonical DR-1 contract
// (services/styleObjects.ts::buildProductMatchSnapshot) can record truthful
// Scanner provenance instead of always labeling the item 'catalog_product'.
test('save bridge tags the source with the scan\'s own id and kind: scanner_single', () => {
  const obj = scanWithMatch();
  const bridge = loadBridge(async () => ({ id: 'item-1' }));
  const source = bridge.buildDressingRoomSaveSource(obj);
  assert.equal(source.scanId, obj.id);
  assert.ok(source.scanId, 'scanId must be non-empty when the scan has an id');
  assert.notEqual(source.scanId, source.id, 'scanId must be the scan id, not the matched product id');
  assert.equal(source.kind, 'scanner_single');
});

// ── 7. Save adapter rejects raw/local/captured image fields ───────────────────

test('save bridge never uses raw/local/captured image as the saved image', () => {
  const bridge = loadBridge(async () => ({ id: 'item-1' }));
  // A match whose ONLY image-ish fields are raw/local/captured → no safe image.
  const obj = sro.createScanResultObject({
    status: 'completed',
    identification: { item_type: 'jacket', confidence_score: 0.8 },
    recommendedProducts: [
      {
        id: 'leaky',
        name: 'Leaky',
        localImageUri: 'file:///raw.jpg',
        capturedImageUri: 'file:///captured.jpg',
        rawImageUri: 'file:///raw2.jpg',
      },
    ],
  });
  const source = bridge.buildDressingRoomSaveSource(obj);
  assert.equal(source, null);
});

test('save bridge ignores file:// in imageUrl and keeps only https catalog image', () => {
  const bridge = loadBridge(async () => ({ id: 'item-1' }));
  const obj = sro.createScanResultObject({
    status: 'completed',
    identification: { item_type: 'jacket', confidence_score: 0.8 },
    recommendedProducts: [
      { id: 'mixed', name: 'Mixed', imageUrl: 'https://cdn.example.com/safe.jpg', localImageUri: 'file:///raw.jpg' },
    ],
  });
  const source = bridge.buildDressingRoomSaveSource(obj);
  assert.equal(source.imageUrl, 'https://cdn.example.com/safe.jpg');
});

// ── 8. NO_SAFE_PRODUCT_MATCH_TO_SAVE when no product match ────────────────────

test('save bridge throws NO_SAFE_PRODUCT_MATCH_TO_SAVE when no matches', async () => {
  const bridge = loadBridge(async () => ({ id: 'item-1' }));
  const obj = sro.createScanResultObject({
    status: 'completed',
    identification: { item_type: 'jacket', confidence_score: 0.8 },
    recommendedProducts: [],
  });
  assert.equal(bridge.buildDressingRoomSaveSource(obj), null);
  await assert.rejects(
    () => bridge.saveScanResultToDressingRoom({ dressingRoomId: 'r1', scanResultObject: obj }),
    (err) => {
      assert.equal(err.message, bridge.NO_SAFE_PRODUCT_MATCH_TO_SAVE);
      assert.equal(err.message, 'NO_SAFE_PRODUCT_MATCH_TO_SAVE');
      return true;
    },
  );
});

// ── 9. Save adapter does not call any raw scan-image persistence path ─────────

test('save bridge calls addProductToDressingRoom only (no scan-image path)', async () => {
  let productCalls = 0;
  let scanImageCalled = false;
  const bridge = loadBridge(
    async (roomId, source) => {
      productCalls += 1;
      assert.equal(roomId, 'r1');
      assert.ok(source.imageUrl.startsWith('https://'));
      return { id: 'item-9' };
    },
    {
      // If the bridge ever wired this up, the stub would flip the flag.
      addScanImageToDressingRoom: async () => {
        scanImageCalled = true;
        return { id: 'bad' };
      },
    },
  );
  const obj = scanWithMatch();
  await bridge.saveScanResultToDressingRoom({ dressingRoomId: 'r1', scanResultObject: obj });
  assert.equal(productCalls, 1);
  assert.equal(scanImageCalled, false);
  // Source file must not IMPORT or CALL the raw scan-image persistence fn.
  // (A prose mention in the privacy doc-comment explaining why it's avoided is
  // fine; we only forbid an actual import statement or invocation.)
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'services/scanResultDressingRoom.ts'), 'utf8');
  assert.equal(/import[^;]*addScanImageToDressingRoom/.test(bridgeSrc), false);
  assert.equal(/addScanImageToDressingRoom\s*\(/.test(bridgeSrc), false);
  assert.equal(/uploadLocalScanImage\s*\(/.test(bridgeSrc), false);
});

// ── 10. Maps product fields to addProductToDressingRoom's expected shape ──────

test('save bridge maps product fields + returns StyleMemoryItem with savedToDressingRoomId', async () => {
  let receivedSource = null;
  const bridge = loadBridge(async (_roomId, source) => {
    receivedSource = source;
    return { id: 'item-10' };
  });
  const obj = scanWithMatch();
  const out = await bridge.saveScanResultToDressingRoom({
    dressingRoomId: 'room-xyz',
    scanResultObject: obj,
  });
  // mapped fields the existing path consumes
  assert.equal(receivedSource.id, 'p1');
  assert.equal(receivedSource.title, 'Leather Biker Jacket');
  assert.equal(receivedSource.retailer, 'Test Retailer');
  assert.equal(receivedSource.imageUrl, 'https://cdn.example.com/p1.jpg');
  assert.equal(receivedSource.productUrl, 'https://shop.example.com/p1');
  assert.equal(receivedSource.price, '129.99');
  // outcome
  assert.equal(out.item.id, 'item-10');
  assert.equal(out.styleMemoryItem.savedToDressingRoomId, 'item-10');
  assert.equal(out.styleMemoryItem.source, 'scan');
  assert.equal(out.styleMemoryItem.privacy.rawImageStored, false);
});

// ── 11 & 12. Result card view model ───────────────────────────────────────────

test('createResultCardViewModel derives title/subtitle/badges/matchCount', () => {
  const obj = scanWithMatch();
  const vm = sro.createResultCardViewModel(obj);
  assert.equal(typeof vm.title, 'string');
  assert.ok(vm.title.length > 0);
  assert.equal(vm.subtitle, 'Matched on category, color, material, and silhouette.');
  assert.ok(Array.isArray(vm.badges));
  assert.ok(vm.badges.length > 0);
  assert.equal(vm.matchCount, 2);
  assert.equal(vm.primaryMatch.id, 'p1');
  assert.equal(vm.confidenceLabel, 'high');
  assert.equal(vm.resultType, 'exact');
  assert.equal(vm.matchQualityLabel, 'Exact match candidate');
  assert.ok(vm.signalsFound.some((signal) => signal.label === 'Category'));
  assert.ok(vm.primaryReason.includes('Matched on category'));
  assert.equal(vm.privacyCaption, 'Saved as style metadata, not a raw photo.');
});

// ── 13. Save disabled state — no safe product match ───────────────────────────

test('view model exposes no primary match when recommendedProducts empty (save disabled)', () => {
  const obj = sro.createScanResultObject({
    status: 'completed',
    identification: { item_type: 'jacket', confidence_score: 0.8 },
    recommendedProducts: [],
  });
  const vm = sro.createResultCardViewModel(obj);
  assert.equal(vm.primaryMatch, null);
  assert.equal(vm.matchCount, 0);
  // The card uses primaryMatch + canAddProductToDressingRoom to gate Save; a
  // null primary match means Save is disabled by construction.
});

// ── 14 & 15. Share message safety ─────────────────────────────────────────────

test('share message excludes userId / private notes / raw image fields', () => {
  const obj = sro.createScanResultObject(
    {
      status: 'completed',
      identification: {
        item_type: 'jacket',
        primary_color: 'Black',
        material_estimate: 'Leather',
        style_tags: ['edgy'],
        confidence_score: 0.9,
        brand_guess: 'X',
      },
      recommendedProducts: [
        {
          id: 'p1',
          name: 'Jacket',
          imageUrl: 'https://cdn.example.com/p1.jpg',
          productUrl: 'https://shop.example.com/p1',
          localImageUri: 'file:///raw.jpg',
        },
      ],
    },
    { userId: 'user-secret-123' },
  );
  // attach a private note to ensure it never leaks into the share text
  obj.memory.notes = 'private internal note';

  const msg = sro.buildScanShareMessage(obj);
  assert.ok(msg.includes('Color: Black'));
  assert.ok(msg.includes('Material: Leather'));
  assert.ok(msg.includes('Product: https://shop.example.com/p1'));
  assert.equal(msg.includes('user-secret-123'), false);
  assert.equal(msg.includes('private internal note'), false);
  assert.equal(/file:\/\//.test(msg), false);
  assert.equal(/localImageUri|capturedImageUri|rawImageUri/.test(msg), false);
});

test('share message never includes a local/captured/raw image URI as Product', () => {
  // A match with ONLY a local URL must not surface any Product line.
  const obj = sro.createScanResultObject({
    status: 'completed',
    identification: { item_type: 'jacket', confidence_score: 0.8 },
    recommendedProducts: [{ id: 'p1', name: 'Jacket', imageUrl: 'https://cdn.example.com/p1.jpg', url: 'file:///local.html' }],
  });
  const msg = sro.buildScanShareMessage(obj);
  assert.equal(/file:\/\//.test(msg), false);
  assert.equal(msg.includes('Product:'), false);
});

// ── 16 & 17. Compare ──────────────────────────────────────────────────────────

test('compareScanResults is pure and does not query storage (no requireMap needed)', () => {
  // sro loaded with NO requireMap and no supabase stub — if compare touched
  // storage it would have thrown "Unexpected require" at load time.
  const a = scanWithMatch();
  const b = scanWithMatch();
  const cmp = sro.compareScanResults(a, b);
  assert.equal(typeof cmp.similarityScore, 'number');
  assert.ok(cmp.similarityScore >= 0 && cmp.similarityScore <= 1);
  assert.ok(Array.isArray(cmp.sharedStyleTags));
});

test('compare affordance source: a single scan has no second ScanResultObject', () => {
  // There is no in-app source of a second saved ScanResultObject yet, so the
  // card renders Compare disabled. This documents the deferred state: compare
  // needs exactly two ScanResultObjects, and only one exists per scan.
  const obj = scanWithMatch();
  const vm = sro.createResultCardViewModel(obj);
  // compareEnabled is structurally true on the VM, but the card gates the UI on
  // an explicit second-source prop (compareSource) which is absent by default.
  assert.equal(typeof vm.compareEnabled, 'boolean');
});
