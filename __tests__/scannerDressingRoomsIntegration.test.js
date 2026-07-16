/**
 * Controlled Scanner ↔ Dressing Rooms reconciliation regressions.
 * Proves commerce persistence does not erase portable room image refs.
 */
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

function loadLibraryModule() {
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
          saveScanToCloud: async () => ({ ok: false, reason: 'disabled' }),
          softDeleteCloudSavedScan: async () => ({ ok: false }),
        };
      }
      if (id === './purchaseOptions') return purchaseOptions;
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename: libraryPath });
  return { library: module.exports, store };
}

test('saved scan with commerce keeps storage refs usable for Dressing Room add-item', async () => {
  const { library, store } = loadLibraryModule();
  const contract = loadTsModule('services/dressingRoomItemContract.ts');

  const saved = await library.saveScan({
    photoUri: 'file:///tmp/dress.jpg',
    source: 'upload',
    ownerId: 'actor-a',
    analysis: {
      result: 'Black dress',
      metadata: { category: 'dress', color: 'black', silhouette: 'midi' },
      products: [{ id: 'sim-1', title: 'Similar dress' }],
      purchaseOptions: [
        {
          id: 'po-1',
          title: 'Buy dress',
          retailer: 'Nordstrom',
          productUrl: 'https://shop.example/dress',
        },
      ],
    },
  });

  assert.ok(saved);
  assert.equal(saved.purchaseOptions.length, 1);
  assert.equal(saved.ownerId, 'actor-a');

  const hydrated = JSON.parse(store.json);
  hydrated[0].storageBucket = 'style-library-images';
  hydrated[0].storagePath = 'actor-a/saved-scans/dress.jpg';
  hydrated[0].mediaStatus = 'ready';
  store.json = JSON.stringify(hydrated);

  const [reopened] = await library.loadLibrary('actor-a');
  assert.equal(reopened.purchaseOptions[0].id, 'po-1');
  assert.equal(reopened.storageBucket, 'style-library-images');
  assert.equal(reopened.storagePath, 'actor-a/saved-scans/dress.jpg');

  const resolved = contract.resolveDressingRoomImageSource({
    localUri: reopened.imageUri,
    storageBucket: reopened.storageBucket,
    storagePath: reopened.storagePath,
  });
  assert.equal(resolved.kind, 'storage');
  assert.equal(
    contract.hasUsableDressingRoomImageSource({
      localUri: reopened.imageUri,
      storageBucket: reopened.storageBucket,
      storagePath: reopened.storagePath,
    }),
    true,
  );
});

test('actor B cannot see actor A saved commerce or room-add candidate', async () => {
  const { library } = loadLibraryModule();
  await library.saveScan({
    photoUri: 'file:///tmp/a.jpg',
    source: 'camera',
    ownerId: 'actor-a',
    analysis: {
      result: 'Coat',
      metadata: {},
      products: [],
      purchaseOptions: [
        { id: 'secret', title: 'Secret', productUrl: 'https://shop.example/secret' },
      ],
    },
  });

  const forB = await library.loadLibrary('actor-b');
  assert.equal(forB.length, 0);
});

test('library reopen path wires purchaseOptions and storage fields into AnalysisCard props', () => {
  const librarySrc = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
  assert.match(librarySrc, /purchaseOptions=\{selectedScan\.purchaseOptions\}/);
  assert.match(librarySrc, /storageBucket=\{selectedScan\.storageBucket\}/);
  assert.match(librarySrc, /storagePath=\{selectedScan\.storagePath\}/);
  assert.match(librarySrc, /localImageUri=\{selectedScan\.imageUri\}/);
  assert.match(librarySrc, /AddScanToDressingRoomModal/);
});

test('analysis card keeps Dressing Room affordances while rendering purchase options', () => {
  const cardSrc = fs.readFileSync(path.join(ROOT, 'components/AnalysisCard.tsx'), 'utf8');
  assert.match(cardSrc, /purchaseOptions/);
  assert.match(cardSrc, /PurchaseOptionsPanel/);
  assert.match(cardSrc, /onAddToDressingRoom/);
});
