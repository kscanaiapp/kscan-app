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
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

function loadLibraryModule({ cloudCalls = [] } = {}) {
  const purchaseOptions = loadTsModule('services/purchaseOptions.ts');
  const libraryPath = path.join(ROOT, 'services/library.js');
  const source = fs.readFileSync(libraryPath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
  const store = { json: null };

  const FileSystem = {
    documentDirectory: 'file:///doc/',
    EncodingType: { UTF8: 'utf8' },
    makeDirectoryAsync: async () => {},
    getInfoAsync: async () => ({ exists: Boolean(store.json) }),
    readAsStringAsync: async () => store.json || '[]',
    writeAsStringAsync: async (_path, contents) => { store.json = contents; },
    moveAsync: async () => {},
    deleteAsync: async () => {},
  };

  const ImageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => ({ uri: `${uri}-out.jpg` }),
  };

  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    process,
    URL,
    exports: module.exports,
    module,
    require: (id) => {
      if (id === 'expo-file-system/legacy') return FileSystem;
      if (id === 'expo-image-manipulator') return ImageManipulator;
      if (id === './savedScansCloud') {
        return {
          saveScanToCloud: async (...args) => {
            cloudCalls.push({ type: 'save', args });
            return { ok: true };
          },
          softDeleteCloudSavedScan: async (...args) => {
            cloudCalls.push({ type: 'delete', args });
            return { ok: true };
          },
        };
      }
      if (id === './purchaseOptions') return purchaseOptions;
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename: libraryPath });
  return { library: module.exports, store, cloudCalls, purchaseOptions };
}

test('normalizePurchaseOptions returns arrays unchanged for renderable entries', () => {
  const { normalizePurchaseOptions } = loadTsModule('services/purchaseOptions.ts');
  const input = [{ id: 'po-1', title: 'Item' }];
  const result = normalizePurchaseOptions(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'po-1');
  assert.notStrictEqual(result, input);
});

test('normalizePurchaseOptions recovers stringified JSON arrays', () => {
  const { normalizePurchaseOptions } = loadTsModule('services/purchaseOptions.ts');
  const input = [{ id: 'po-1', title: 'Item' }];
  const result = normalizePurchaseOptions(JSON.stringify(input));
  assert.equal(result[0].id, 'po-1');
});

test('normalizePurchaseOptions degrades invalid values to empty array', () => {
  const { normalizePurchaseOptions } = loadTsModule('services/purchaseOptions.ts');
  assert.equal(normalizePurchaseOptions(null).length, 0);
  assert.equal(normalizePurchaseOptions(undefined).length, 0);
  assert.equal(normalizePurchaseOptions('not json').length, 0);
  assert.equal(normalizePurchaseOptions({ not: 'array' }).length, 0);
  assert.equal(normalizePurchaseOptions(42).length, 0);
});

test('normalizePurchaseOptions blocks unsafe URLs without inventing data', () => {
  const { normalizePurchaseOptions } = loadTsModule('services/purchaseOptions.ts');
  const result = normalizePurchaseOptions([
    { id: 'safe', title: 'Safe', url: 'javascript:alert(1)' },
    { id: 'http', product_url: 'https://example.com/item' },
    { price: '$10' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].productUrl, null);
  assert.equal(Object.hasOwn(result[0], 'url'), false);
  assert.equal(result[1].productUrl, 'https://example.com/item');
});

test('normalizePurchaseOptions strips unknown debug and credential-bearing fields', () => {
  const { normalizePurchaseOptions } = loadTsModule('services/purchaseOptions.ts');
  const result = normalizePurchaseOptions([{
    id: 'safe',
    title: 'Safe',
    retailer: 'Store',
    productUrl: 'https://example.com/item',
    headers: { authorization: 'Bearer secret' },
    providerDebug: { raw: 'private' },
    token: 'secret',
  }]);

  assert.equal(result.length, 1);
  assert.equal(result[0].productUrl, 'https://example.com/item');
  assert.equal(Object.hasOwn(result[0], 'headers'), false);
  assert.equal(Object.hasOwn(result[0], 'providerDebug'), false);
  assert.equal(Object.hasOwn(result[0], 'token'), false);
});

test('normalizePurchaseOptions collapses duplicate aliases deterministically', () => {
  const { normalizePurchaseOptions } = loadTsModule('services/purchaseOptions.ts');
  const result = normalizePurchaseOptions([
    { id: 'same', title: 'First', product_url: 'https://example.com/first' },
    { id: 'same', title: 'Second', productUrl: 'https://example.com/second' },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'First');
  assert.equal(result[0].productUrl, 'https://example.com/first');
});

test('saveScan persists purchaseOptions for camera and upload sources', async () => {
  for (const source of ['camera', 'upload']) {
    const { library, store } = loadLibraryModule();
    const saved = await library.saveScan({
      photoUri: 'file:///tmp/photo.jpg',
      source,
      ownerId: 'user-1',
      analysis: {
        result: 'Navy blazer',
        metadata: { category: 'blazer', color: 'navy', silhouette: 'structured' },
        products: [{ id: 'sim-1', title: 'Similar' }],
        purchaseOptions: [
          { id: 'po-1', title: 'Buy blazer', retailer: 'Store', productUrl: 'https://shop.example/1' },
        ],
      },
    });
    assert.ok(saved);
    assert.equal(saved.source, source);
    assert.equal(saved.purchaseOptions.length, 1);
    assert.equal(saved.commerceSnapshotVersion, 1);
    assert.equal(saved.ownerId, 'user-1');

    const loaded = await library.loadLibrary('user-1');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].purchaseOptions[0].id, 'po-1');
    assert.ok(store.json.includes('purchaseOptions'));
  }
});

test('loadLibrary normalizes stringified and legacy missing purchaseOptions', async () => {
  const { library, store } = loadLibraryModule();
  store.json = JSON.stringify([
    {
      id: 'legacy',
      createdAt: new Date().toISOString(),
      thumbnailUri: null,
      attributes: {},
      result: 'Legacy',
      products: [],
      source: 'camera',
    },
    {
      id: 'stringified',
      createdAt: new Date().toISOString(),
      thumbnailUri: null,
      attributes: {},
      result: 'Stringified',
      products: [],
      source: 'upload',
      purchaseOptions: JSON.stringify([{ id: 'po-s', title: 'Parsed' }]),
    },
  ]);

  const loaded = await library.loadLibrary();
  assert.equal(loaded.length, 2);
  assert.equal(loaded.find((s) => s.id === 'legacy').purchaseOptions.length, 0);
  assert.equal(loaded.find((s) => s.id === 'stringified').purchaseOptions[0].id, 'po-s');
});

test('ownerless legacy records stay device-local and hidden from signed-in actors', async () => {
  const { library, store } = loadLibraryModule();
  store.json = JSON.stringify([
    {
      id: 'ownerless',
      createdAt: new Date().toISOString(),
      thumbnailUri: null,
      attributes: {},
      result: 'Open',
      products: [],
      purchaseOptions: [],
      source: 'camera',
    },
    {
      id: 'owned-a',
      ownerId: 'user-a',
      createdAt: new Date().toISOString(),
      thumbnailUri: null,
      attributes: {},
      result: 'A',
      products: [],
      purchaseOptions: [],
      source: 'camera',
    },
  ]);

  const deviceLocal = await library.loadLibrary(null);
  const forB = await library.loadLibrary('user-b');
  assert.equal(deviceLocal.length, 1);
  assert.equal(deviceLocal[0].id, 'ownerless');
  assert.equal(forB.length, 0);
});

test('malformed local purchase options are ignored rather than promoted to explicit empty commerce', async () => {
  const { library, store } = loadLibraryModule();
  store.json = JSON.stringify([{
    id: 'corrupt-commerce',
    ownerId: 'user-a',
    createdAt: new Date().toISOString(),
    thumbnailUri: null,
    attributes: {},
    result: 'Corrupt',
    products: [],
    purchaseOptions: { not: 'an array' },
    commerceSnapshotVersion: 1,
    source: 'camera',
  }]);

  const loaded = await library.loadLibrary('user-a');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].purchaseOptions.length, 0);
  assert.equal(loaded[0].commerceSnapshotVersion, undefined);
});

test('concurrent local saves are serialized without losing either scan', async () => {
  const { library } = loadLibraryModule();
  await Promise.all([
    library.saveScan({
      photoUri: 'file:///tmp/a.jpg',
      source: 'camera',
      ownerId: 'user-a',
      analysis: { result: 'A', metadata: {}, products: [], purchaseOptions: [] },
    }),
    library.saveScan({
      photoUri: 'file:///tmp/b.jpg',
      source: 'upload',
      ownerId: 'user-a',
      analysis: { result: 'B', metadata: {}, products: [], purchaseOptions: [] },
    }),
  ]);

  const loaded = await library.loadLibrary('user-a');
  assert.equal(loaded.length, 2);
  assert.deepEqual(new Set(loaded.map((scan) => scan.result)), new Set(['A', 'B']));
});

test('cloud save receives normalized array purchase_options args from local save', async () => {
  const cloudCalls = [];
  const { library } = loadLibraryModule({ cloudCalls });
  await library.saveScan({
    photoUri: 'file:///tmp/photo.jpg',
    source: 'camera',
    ownerId: 'user-1',
    analysis: {
      result: 'Item',
      metadata: {},
      products: [],
      purchaseOptions: JSON.stringify([{ id: 'po-net', title: 'Net' }]),
    },
  });
  // Allow fire-and-forget cloud call to settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cloudCalls.length, 1);
  assert.ok(Array.isArray(cloudCalls[0].args[0].purchaseOptions));
  assert.equal(cloudCalls[0].args[0].purchaseOptions[0].id, 'po-net');
  assert.equal(cloudCalls[0].args[2], 'user-1');
});
