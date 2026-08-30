/**
 * Build 32 — multi-item commerce persistence.
 *
 * Exercises the real saveMultiItemScan/attachScanMultiItemCommerce/
 * hydrateSavedScan functions (not re-implementations) against an in-memory
 * expo-file-system, using the same loader/mock pattern as
 * recentScansCommerceActualRoundTrip.test.js.
 *
 * What this pins:
 *   - offers stay keyed to their own candidateId (the invariant the old
 *     "just don't save multi-item scans" guard existed to protect, now
 *     proven directly instead of by avoidance);
 *   - a legacy record with neither field still loads safely;
 *   - one candidate's attach failure/absence never corrupts another's card.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = process.env.KSCAN_COMMERCE_SOURCE_ROOT
  ? path.resolve(process.env.KSCAN_COMMERCE_SOURCE_ROOT)
  : path.resolve(__dirname, '..');

globalThis.__DEV__ = false;

function createLoader(root, mocks = {}) {
  const cache = new Map();

  function resolveFile(candidate) {
    const candidates = path.extname(candidate)
      ? [candidate]
      : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((filename) => fs.existsSync(filename) && fs.statSync(filename).isFile());
  }

  function loadFile(filename) {
    const resolved = resolveFile(filename);
    if (!resolved) throw new Error(`Unable to resolve production module: ${filename}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;

    const module = { exports: {} };
    cache.set(resolved, module);
    const output = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
      fileName: resolved,
    }).outputText;

    const localRequire = (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      if (id.startsWith('.')) return loadFile(path.resolve(path.dirname(resolved), id));
      try {
        return require(id);
      } catch {
        return {};
      }
    };
    Function('exports', 'require', 'module', '__filename', '__dirname', output)(
      module.exports,
      localRequire,
      module,
      resolved,
      path.dirname(resolved),
    );
    return module.exports;
  }

  return (relativePath) => loadFile(path.resolve(root, relativePath));
}

function createMemoryStorage() {
  const files = new Map();
  let manipulated = 0;
  const fileSystem = {
    documentDirectory: 'memory://documents/',
    EncodingType: { UTF8: 'utf8' },
    getInfoAsync: async (uri) => ({ exists: files.has(uri), uri }),
    readAsStringAsync: async (uri) => {
      if (!files.has(uri)) throw new Error(`Missing memory file: ${uri}`);
      return files.get(uri);
    },
    writeAsStringAsync: async (uri, value) => { files.set(uri, value); },
    makeDirectoryAsync: async () => undefined,
    moveAsync: async ({ from, to }) => {
      files.set(to, files.get(from) || 'image');
      files.delete(from);
    },
    deleteAsync: async (uri) => { files.delete(uri); },
  };
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async () => {
      const uri = `memory://cache/manipulated-${++manipulated}.jpg`;
      files.set(uri, 'image');
      return { uri };
    },
  };
  return { files, fileSystem, imageManipulator };
}

function loadLibrary(storage) {
  const load = createLoader(ROOT, {
    'expo-file-system/legacy': storage.fileSystem,
    'expo-image-manipulator': storage.imageManipulator,
    './savedScansCloud': {
      saveScanToCloud: async () => ({ ok: false, reason: 'disabled' }),
      softDeleteCloudSavedScan: async () => ({ ok: false, reason: 'disabled' }),
    },
    './actorContext': {
      resolveWriteAuthority: () => ({ ok: true, ownerId: null }),
      isActorRequestCurrent: () => true,
    },
  });
  return load('services/library.js');
}

function candidate(id, label, category, subtype) {
  return { id, label, category, subtype, confidenceScore: 0.8 };
}

function offer(id, retailer, price) {
  return {
    id,
    title: `${retailer} offer`,
    retailer,
    price,
    currency: 'USD',
    imageUrl: `https://cdn.example.com/${id}.jpg`,
    productUrl: `https://shop.example.com/${id}`,
    availability: 'in_stock',
  };
}

const CANDIDATES = [
  candidate('g1', 'Biker Jacket', 'outerwear', 'biker jacket'),
  candidate('g2', 'Chelsea Boot', 'footwear', 'chelsea boot'),
];

const MULTI_ITEM_ANALYSIS = {
  result: 'ok',
  metadata: { category: 'outerwear', color: 'black', silhouette: 'fitted' },
};

test('saveMultiItemScan writes empty products/purchaseOptions and the candidate identities', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);

  const saved = await library.saveMultiItemScan({
    photoUri: 'memory://capture.jpg',
    analysis: MULTI_ITEM_ANALYSIS,
    candidates: CANDIDATES,
    source: 'camera',
  });

  assert.ok(saved?.id, 'multi-item scan is now persisted');
  assert.deepEqual(saved.products, [], 'never pooled: products stays empty');
  assert.deepEqual(saved.purchaseOptions, [], 'never pooled: purchaseOptions stays empty');
  assert.equal(saved.multiItemCandidates.length, 2);
  assert.equal(saved.multiItemCandidates[0].id, 'g1');
  assert.equal(saved.multiItemCandidates[1].id, 'g2');
  assert.deepEqual(saved.multiItemCommerce, [], 'commerce attaches later, after hydration');
});

test('attachScanMultiItemCommerce keeps each candidate\'s offers under its own candidateId', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);

  const saved = await library.saveMultiItemScan({
    photoUri: 'memory://capture.jpg',
    analysis: MULTI_ITEM_ANALYSIS,
    candidates: CANDIDATES,
    source: 'camera',
  });

  const attached = await library.attachScanMultiItemCommerce(saved.id, [
    { candidateId: 'g1', status: 'ready', bestMatch: offer('j1', 'AllSaints', 519), alternatives: [offer('j2', 'Schott', 890)] },
    { candidateId: 'g2', status: 'no_match', bestMatch: null, alternatives: [] },
  ]);
  assert.equal(attached, true);

  const all = await library.loadLibrary(null);
  const reopened = all.find((s) => s.id === saved.id);
  const jacketCard = reopened.multiItemCommerce.find((c) => c.candidateId === 'g1');
  const bootCard = reopened.multiItemCommerce.find((c) => c.candidateId === 'g2');

  assert.equal(jacketCard.bestMatch.retailer, 'AllSaints');
  assert.equal(jacketCard.alternatives[0].retailer, 'Schott');
  assert.equal(bootCard.status, 'no_match');
  assert.equal(bootCard.bestMatch, null, 'no fabricated Best Match for the no-match item');
  // The core invariant the old "don't save multi-item scans" guard protected:
  // one garment's offers never appear under the other garment's card.
  assert.notEqual(jacketCard.bestMatch.retailer, bootCard.bestMatch?.retailer);
});

test('a legacy scan record with neither field hydrates safely', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);

  // Simulate a pre-Build-32 record already on disk: no multiItemCandidates,
  // no multiItemCommerce, exactly as every scan saved before this feature.
  storage.files.set(
    'memory://documents/kscan_library/kscan_library.json',
    JSON.stringify([
      {
        id: 'scan_legacy',
        createdAt: new Date().toISOString(),
        ownerId: null,
        imageUri: null,
        thumbnailUri: null,
        attributes: { category: 'top', silhouette: '', color_palette: '', material_estimate: null, pattern: null, style_tags: [], confidence_score: null },
        result: 'legacy scan',
        products: [],
        purchaseOptions: [],
        source: 'scan',
      },
    ]),
  );

  const all = await library.loadLibrary(null);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].multiItemCandidates, [], 'legacy record defaults to empty, not undefined');
  assert.deepEqual(all[0].multiItemCommerce, []);
});

test('attaching commerce for an unknown scan id is a no-op, not a crash', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);

  const result = await library.attachScanMultiItemCommerce('scan_does_not_exist', [
    { candidateId: 'g1', status: 'ready', bestMatch: offer('x', 'Nowhere', 10), alternatives: [] },
  ]);
  assert.equal(result, false);
});

test('a partial attach (one candidate only) leaves the record valid, not half-corrupted', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);

  const saved = await library.saveMultiItemScan({
    photoUri: 'memory://capture.jpg',
    analysis: MULTI_ITEM_ANALYSIS,
    candidates: CANDIDATES,
    source: 'camera',
  });

  // Only g1 ever resolved — g2's request is still in flight or failed and
  // simply never called attach for it.
  await library.attachScanMultiItemCommerce(saved.id, [
    { candidateId: 'g1', status: 'ready', bestMatch: offer('j1', 'AllSaints', 519), alternatives: [] },
  ]);

  const all = await library.loadLibrary(null);
  const reopened = all.find((s) => s.id === saved.id);
  assert.equal(reopened.multiItemCandidates.length, 2, 'both identities remain — g2 was detected too');
  assert.equal(reopened.multiItemCommerce.length, 1, 'only g1 has a commerce card yet');
  assert.equal(reopened.multiItemCommerce[0].candidateId, 'g1');
});
