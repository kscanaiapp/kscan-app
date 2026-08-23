/**
 * Recent Scan persistence integrity (Build 32).
 *
 * Runs against the REAL services/library.js through a transpiling loader with
 * an in-memory expo-file-system, so every assertion here is about production
 * behavior rather than source text.
 *
 * What this file protects:
 *   1. An interrupted manifest write cannot destroy committed Recent Scans.
 *   2. A corrupt or missing manifest degrades to the last verified copy
 *      instead of reporting an empty history.
 *   3. Persistence failure never converts a successful scan into a failed one.
 *   4. Commerce attachment is idempotent — retrying cannot duplicate offers.
 *   5. Legacy, partial, malformed and multi-item-shaped stored records all
 *      hydrate without crashing and without inventing data.
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

const MANIFEST = 'memory://documents/kscan_library/kscan_library.json';
const TEMP = MANIFEST + '.tmp';
const BACKUP = MANIFEST + '.bak';

function createLoader(root, mocks = {}) {
  const cache = new Map();
  function resolveFile(candidate) {
    const candidates = path.extname(candidate)
      ? [candidate]
      : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
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
      try { return require(id); } catch { return {}; }
    };
    Function('exports', 'require', 'module', '__filename', '__dirname', output)(
      module.exports, localRequire, module, resolved, path.dirname(resolved),
    );
    return module.exports;
  }
  return (relativePath) => loadFile(path.resolve(root, relativePath));
}

/**
 * In-memory storage with a controllable write-failure mode.
 *   'ok'       — normal
 *   'truncate' — bytes land, then the device fails (the dangerous case: a
 *                short write that leaves readable-but-invalid JSON behind)
 *   'throw'    — the write fails outright, nothing lands
 */
function createMemoryStorage() {
  const files = new Map();
  const state = { mode: 'ok', target: 'kscan_library.json' };
  let manipulated = 0;
  const fileSystem = {
    documentDirectory: 'memory://documents/',
    EncodingType: { UTF8: 'utf8' },
    getInfoAsync: async (uri) => ({ exists: files.has(uri), uri }),
    readAsStringAsync: async (uri) => {
      if (!files.has(uri)) throw new Error(`Missing memory file: ${uri}`);
      return files.get(uri);
    },
    writeAsStringAsync: async (uri, value) => {
      if (state.mode !== 'ok' && uri.includes(state.target)) {
        if (state.mode === 'truncate') {
          files.set(uri, value.slice(0, Math.max(1, Math.floor(value.length / 2))));
        }
        throw new Error(`injected ${state.mode} failure`);
      }
      files.set(uri, value);
    },
    makeDirectoryAsync: async () => undefined,
    moveAsync: async ({ from, to }) => {
      if (!files.has(from)) throw new Error(`Missing memory file: ${from}`);
      files.set(to, files.get(from));
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
  return { files, fileSystem, imageManipulator, state };
}

function loadLibraryModule(storage) {
  return createLoader(ROOT, {
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
  })('services/library.js');
}

function analysisFor(n, options) {
  return {
    result: `scan ${n}`,
    metadata: { category: 'outerwear', color: 'black' },
    products: [],
    purchaseOptions: options ?? [{
      title: `Offer ${n}`,
      retailer: 'Shop',
      price: '100',
      currency: 'USD',
      productUrl: `https://shop.example.com/${n}`,
    }],
  };
}

async function seed(library, count, startAt = 1) {
  const saved = [];
  for (let i = startAt; i < startAt + count; i += 1) {
    saved.push(await library.saveScan({
      photoUri: `memory://capture-${i}.jpg`,
      analysis: analysisFor(i),
      source: 'camera',
    }));
  }
  return saved;
}

// ── 1. Interrupted write must not destroy the library ────────────────────────

test('an interrupted manifest write leaves every committed scan readable', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  await seed(library, 3);

  const before = await library.loadLibrary();
  const manifestBefore = storage.files.get(MANIFEST);
  assert.equal(before.length, 3);

  // A short write that lands bytes and then fails — the exact shape that used
  // to leave truncated JSON in the live manifest.
  storage.state.mode = 'truncate';
  const rejected = await library.saveScan({
    photoUri: 'memory://capture-4.jpg',
    analysis: analysisFor(4),
    source: 'camera',
  });
  storage.state.mode = 'ok';

  assert.equal(rejected, null, 'a failed save reports failure rather than a partial record');
  assert.equal(
    storage.files.get(MANIFEST), manifestBefore,
    'the live manifest is byte-identical — damage was confined to the staging file',
  );

  // Re-read through a completely fresh module instance: nothing may depend on
  // in-process state surviving.
  const relaunched = loadLibraryModule(storage);
  const after = await relaunched.loadLibrary();
  assert.equal(after.length, 3, 'previously committed history survives intact');
  assert.deepEqual(after.map((s) => s.id), before.map((s) => s.id));
  assert.ok(
    after.every((s) => s.purchaseOptions.length === 1),
    'surviving records keep their commerce snapshot',
  );
  assert.ok(
    !after.some((s) => s.result === 'scan 4'),
    'the interrupted record is absent, never half-written',
  );
});

test('a write that fails outright leaves the library untouched', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  await seed(library, 2);
  const manifestBefore = storage.files.get(MANIFEST);

  storage.state.mode = 'throw';
  const rejected = await library.saveScan({
    photoUri: 'memory://capture-x.jpg',
    analysis: analysisFor('x'),
    source: 'camera',
  });
  storage.state.mode = 'ok';

  assert.equal(rejected, null);
  assert.equal(storage.files.get(MANIFEST), manifestBefore);
  assert.equal((await loadLibraryModule(storage).loadLibrary()).length, 2);
});

test('a failed save never throws out of saveScan — the live scan stays successful', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  storage.state.mode = 'throw';
  // The Scanner calls this fire-and-forget. A throw here would surface as an
  // unhandled rejection on a scan the user already sees on screen.
  const result = await library.saveScan({
    photoUri: 'memory://capture.jpg',
    analysis: analysisFor(1),
    source: 'camera',
  });
  storage.state.mode = 'ok';
  assert.equal(result, null, 'reports failure by return value, not by throwing');
});

test('a failed commerce attach reports false rather than throwing', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  const [saved] = await seed(library, 1);

  storage.state.mode = 'throw';
  const attached = await library.attachScanPurchaseOptions(saved.id, [{
    title: 'Late offer', retailer: 'Shop', price: '10', currency: 'USD',
    productUrl: 'https://shop.example.com/late',
  }]);
  storage.state.mode = 'ok';

  assert.equal(attached, false);
  const after = await loadLibraryModule(storage).loadLibrary();
  assert.equal(after.length, 1, 'the scan itself is still there');
  assert.equal(after[0].purchaseOptions.length, 1, 'its previous shelf is unchanged');
});

// ── 2. Corrupt / missing manifest recovery ───────────────────────────────────

test('a corrupt live manifest falls back to the last verified copy', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  await seed(library, 3); // 3 writes, so a .bak exists

  // External corruption (disk damage, OS-level truncation) of the primary.
  storage.files.set(MANIFEST, '[{"id":"scan_1","purchaseOpti');

  const recovered = await loadLibraryModule(storage).loadLibrary();
  assert.ok(recovered.length > 0, 'a corrupt manifest is not reported as "no scans"');
  assert.ok(
    recovered.every((s) => typeof s.id === 'string'),
    'recovered records are fully hydrated',
  );
});

test('a manifest lost inside the swap window is promoted back from staging', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  await seed(library, 2);
  const good = storage.files.get(MANIFEST);

  // Simulate dying between "move primary aside" and "move temp into place".
  storage.files.delete(MANIFEST);
  storage.files.set(TEMP, good);

  const recovered = await loadLibraryModule(storage).loadLibrary();
  assert.equal(recovered.length, 2);
  assert.ok(storage.files.has(MANIFEST), 'the manifest is restored in place');
});

test('a corrupt staging file is never promoted over a valid backup', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  await seed(library, 2);
  const good = storage.files.get(MANIFEST);

  storage.files.delete(MANIFEST);
  storage.files.set(TEMP, '{"not":"an array"');   // unparseable staging file
  storage.files.set(BACKUP, good);                 // valid retained copy

  const recovered = await loadLibraryModule(storage).loadLibrary();
  assert.equal(recovered.length, 2, 'the valid backup wins over corrupt staging');
});

test('a first-run device with no manifest at all reads as an empty library', async () => {
  const storage = createMemoryStorage();
  assert.deepEqual(await loadLibraryModule(storage).loadLibrary(), []);
});

test('an unreadable live manifest is never retained over a good backup', async () => {
  // The whole point of the read fallback is that a corrupt live manifest is a
  // survivable state: the retained copy still holds the history. A write that
  // happens while in that state must not consume the good backup by promoting
  // the unusable file into it — otherwise one failed rename during the swap
  // restores the corrupt file, leaves no backup, and the library reads empty.
  const storage = createMemoryStorage();
  const good = JSON.stringify([
    { id: 'scan_keep_1', createdAt: '2026-08-01T00:00:00.000Z', ownerId: null,
      imageUri: 'memory://i1', thumbnailUri: 'memory://t1', attributes: {},
      result: 'kept 1', products: [], purchaseOptions: [], source: 'scan' },
    { id: 'scan_keep_2', createdAt: '2026-08-02T00:00:00.000Z', ownerId: null,
      imageUri: 'memory://i2', thumbnailUri: 'memory://t2', attributes: {},
      result: 'kept 2', products: [], purchaseOptions: [], source: 'scan' },
  ]);
  storage.files.set(MANIFEST, '{ truncated-live');   // unreadable live manifest
  storage.files.set(BACKUP, good);                   // the only good history

  // Fail the swap into the live path exactly once, then let recovery proceed.
  const realMove = storage.fileSystem.moveAsync;
  let failedOnce = false;
  storage.fileSystem.moveAsync = async (args) => {
    if (!failedOnce && args.to === MANIFEST) {
      failedOnce = true;
      throw new Error('injected transient rename failure');
    }
    return realMove(args);
  };

  const library = loadLibraryModule(storage);
  await library.attachScanPurchaseOptions('scan_keep_1', SNAPSHOT_A);
  storage.fileSystem.moveAsync = realMove;

  const survived = await loadLibraryModule(storage).loadLibrary();
  assert.equal(survived.length, 2,
    'the committed history survives a failed write taken while the live manifest was corrupt');
  assert.deepEqual(
    survived.map((s) => s.id).sort(),
    ['scan_keep_1', 'scan_keep_2'],
  );
});

// ── 3. Commerce attachment idempotence ───────────────────────────────────────

const SNAPSHOT_A = [
  { title: 'Biker Jacket', retailer: 'AllSaints', price: '519', currency: 'USD',
    productUrl: 'https://shop.example.com/a1', imageUrl: 'https://cdn.example.com/a1.jpg' },
  { title: 'Leather Jacket', retailer: 'Schott NYC', price: '890', currency: 'USD',
    productUrl: 'https://shop.example.com/a2' },
];
const SNAPSHOT_B = [
  { title: 'Biker Jacket', retailer: 'AllSaints', price: '479', currency: 'USD',
    productUrl: 'https://shop.example.com/a1', imageUrl: 'https://cdn.example.com/a1.jpg' },
];

test('attaching the identical snapshot twice creates no duplicate offers', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  const [saved] = await seed(library, 1);

  assert.equal(await library.attachScanPurchaseOptions(saved.id, SNAPSHOT_A), true);
  assert.equal(await library.attachScanPurchaseOptions(saved.id, SNAPSHOT_A), true);

  const [reopened] = await loadLibraryModule(storage).loadLibrary();
  assert.equal(reopened.purchaseOptions.length, 2, 'one copy of each offer, not four');
  assert.deepEqual(
    reopened.purchaseOptions.map((o) => o.productUrl),
    ['https://shop.example.com/a1', 'https://shop.example.com/a2'],
  );
  assert.equal(reopened.id, saved.id, 'canonical scan identity is unchanged');
});

test('a newer snapshot replaces the previous shelf rather than accumulating', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  const [saved] = await seed(library, 1);

  await library.attachScanPurchaseOptions(saved.id, SNAPSHOT_A);
  await library.attachScanPurchaseOptions(saved.id, SNAPSHOT_B);

  const [reopened] = await loadLibraryModule(storage).loadLibrary();
  assert.equal(reopened.purchaseOptions.length, 1, 'REPLACE semantics, not MERGE or APPEND');
  assert.equal(reopened.purchaseOptions[0].price, '479', 'the newer snapshot wins');
});

test('an empty snapshot never clears a shelf that was legitimately filled', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  const [saved] = await seed(library, 1);
  await library.attachScanPurchaseOptions(saved.id, SNAPSHOT_A);

  assert.equal(await library.attachScanPurchaseOptions(saved.id, []), false);
  const [reopened] = await loadLibraryModule(storage).loadLibrary();
  assert.equal(reopened.purchaseOptions.length, 2);
});

test('commerce for one scan can never land on another scan', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  const [first] = await seed(library, 1, 1);
  const [second] = await seed(library, 1, 2);
  await library.attachScanPurchaseOptions(first.id, SNAPSHOT_A);

  const all = await loadLibraryModule(storage).loadLibrary();
  const a = all.find((s) => s.id === first.id);
  const b = all.find((s) => s.id === second.id);
  assert.equal(a.purchaseOptions.length, 2);
  assert.equal(b.purchaseOptions.length, 1, 'the other scan keeps only its own save-time shelf');
  assert.equal(b.purchaseOptions[0].productUrl, 'https://shop.example.com/2');
});

test('attaching to an unknown scan id is a no-op, not a new record', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  await seed(library, 1);
  assert.equal(await library.attachScanPurchaseOptions('scan_does_not_exist', SNAPSHOT_A), false);
  assert.equal((await loadLibraryModule(storage).loadLibrary()).length, 1);
});

// ── 4. Stored-record compatibility ───────────────────────────────────────────

const LEGACY_FIXTURES = [
  ['pre-commerce legacy scan', { id: 'l1', createdAt: '2024-01-01T00:00:00.000Z', result: 'old',
    attributes: { category: 'top' }, products: [], source: 'scan' }],
  ['commerce field absent', { id: 'l2', createdAt: '2024-01-02T00:00:00.000Z', result: 'x',
    attributes: {}, source: 'scan' }],
  ['commerce field null', { id: 'l3', createdAt: '2024-01-03T00:00:00.000Z', purchaseOptions: null,
    attributes: {}, source: 'scan' }],
  ['commerce field a string', { id: 'l4', createdAt: '2024-01-04T00:00:00.000Z',
    purchaseOptions: 'not-an-array', attributes: {}, source: 'scan' }],
  ['commerce field an object', { id: 'l5', createdAt: '2024-01-05T00:00:00.000Z',
    purchaseOptions: { nope: true }, attributes: {}, source: 'scan' }],
  ['empty offer array', { id: 'l6', createdAt: '2024-01-06T00:00:00.000Z', purchaseOptions: [],
    attributes: {}, source: 'scan' }],
  ['offers that are junk', { id: 'l7', createdAt: '2024-01-07T00:00:00.000Z',
    purchaseOptions: [null, 42, 'x', []], attributes: {}, source: 'scan' }],
  ['partial offer, no image', { id: 'l8', createdAt: '2024-01-08T00:00:00.000Z',
    purchaseOptions: [{ title: 'T', retailer: 'R' }], attributes: {}, source: 'scan' }],
  ['snake_case alias', { id: 'l9', createdAt: '2024-01-09T00:00:00.000Z',
    purchase_options: [{ title: 'T', retailer: 'R', product_url: 'https://shop.example.com/s' }],
    attributes: {}, source: 'scan' }],
  ['no image at all', { id: 'l10', createdAt: '2024-01-10T00:00:00.000Z', imageUri: null,
    thumbnailUri: null, purchaseOptions: [], attributes: {}, source: 'scan' }],
];

test('every legacy and malformed stored record hydrates without crashing', async () => {
  const storage = createMemoryStorage();
  storage.files.set(MANIFEST, JSON.stringify(LEGACY_FIXTURES.map(([, record]) => record)));

  const loaded = await loadLibraryModule(storage).loadLibrary();
  assert.equal(loaded.length, LEGACY_FIXTURES.length, 'no record is silently dropped');
  for (const record of loaded) {
    assert.ok(Array.isArray(record.purchaseOptions),
      `${record.id}: commerce always hydrates to an array`);
    assert.equal(record.ownerId, null, `${record.id}: legacy records stay ownerless`);
  }
  const byId = Object.fromEntries(loaded.map((r) => [r.id, r]));
  assert.deepEqual(byId.l7.purchaseOptions, [], 'junk offers normalize away, record survives');
  assert.equal(byId.l8.purchaseOptions.length, 1, 'title+retailer is enough to keep an offer');
  assert.equal(byId.l8.purchaseOptions[0].imageUrl, null, 'a missing image stays null, never invented');
  assert.equal(byId.l9.purchaseOptions.length, 1, 'snake_case aliases still hydrate');
});

test('one unreadable record does not take the rest of the library with it', async () => {
  const storage = createMemoryStorage();
  storage.files.set(MANIFEST, JSON.stringify([
    { id: 'good-1', createdAt: '2024-01-01T00:00:00.000Z', purchaseOptions: [], attributes: {} },
    null,
    'not-a-record',
    [1, 2, 3],
    { id: 'good-2', createdAt: '2024-01-02T00:00:00.000Z', purchaseOptions: [], attributes: {} },
  ]));
  const loaded = await loadLibraryModule(storage).loadLibrary();
  assert.deepEqual(loaded.map((r) => r.id), ['good-1', 'good-2'],
    'valid scans still open; only the unreadable entries are suppressed');
});

test('unsafe stored URLs are rejected and never reach a reopened scan', async () => {
  const storage = createMemoryStorage();
  storage.files.set(MANIFEST, JSON.stringify([{
    id: 'u1', createdAt: '2024-01-01T00:00:00.000Z', attributes: {}, source: 'scan',
    purchaseOptions: [
      { title: 'http downgrade', retailer: 'R', productUrl: 'http://shop.example.com/insecure' },
      { title: 'javascript uri', retailer: 'R', productUrl: 'javascript:alert(1)' },
      { title: 'malformed', retailer: 'R', productUrl: 'https://' },
      { title: 'credentialed', retailer: 'R', productUrl: 'https://user:pw@shop.example.com/x' },
      { title: 'token leak', retailer: 'R', productUrl: 'https://shop.example.com/x?access_token=abc' },
      { title: 'good', retailer: 'R', productUrl: 'https://shop.example.com/ok?utm_source=kscan' },
    ],
  }]));

  const [reopened] = await loadLibraryModule(storage).loadLibrary();
  const urls = reopened.purchaseOptions.map((o) => o.productUrl);
  assert.ok(!urls.includes('http://shop.example.com/insecure'), 'no protocol downgrade');
  assert.ok(!urls.some((u) => typeof u === 'string' && u.startsWith('javascript:')));
  assert.ok(!urls.some((u) => typeof u === 'string' && u.includes('access_token')));
  assert.ok(!urls.some((u) => typeof u === 'string' && u.includes('user:pw@')));
  assert.ok(urls.includes('https://shop.example.com/ok?utm_source=kscan'),
    'a legitimate tracked retailer URL is retained');
  // Entries whose only destination was rejected survive as title+retailer rows
  // rather than crashing the reopen.
  assert.ok(reopened.purchaseOptions.length >= 1);
});

// ── 5. Multi-item schema forward compatibility (READ ONLY) ───────────────────
//
// Shape mirrors feature/build32-multi-item-commerce-refinement's persisted
// record. That branch is NOT merged, cherry-picked or imported here; this only
// proves that its additive record shape survives THIS branch's storage and
// hydration boundary untouched, so the two lines can be integrated later
// without a storage redesign.

const MULTI_ITEM_RECORD = {
  id: 'scan_multi_1',
  createdAt: '2026-08-22T00:00:00.000Z',
  ownerId: null,
  imageUri: 'memory://documents/kscan_library/images/m1.jpg',
  thumbnailUri: null,
  attributes: { category: 'outfit', color_palette: 'mixed', silhouette: '', pattern: null },
  result: 'Three garments detected',
  products: [],
  purchaseOptions: [],
  multiItemCandidates: [
    { id: 'cand-a', label: 'Jacket', category: 'outerwear', subtype: 'biker', confidenceScore: 0.91 },
    { id: 'cand-b', label: 'Jeans', category: 'bottoms', subtype: 'straight' },
  ],
  multiItemCommerce: [
    { candidateId: 'cand-b', status: 'success',
      bestMatch: { title: 'Straight Jean', retailer: 'Levi', price: '98', currency: 'USD',
        productUrl: 'https://shop.example.com/jean' },
      alternatives: [{ title: 'Alt Jean', retailer: 'Uniqlo',
        productUrl: 'https://shop.example.com/jean-alt' }] },
    { candidateId: 'cand-a', status: 'success',
      bestMatch: { title: 'Biker Jacket', retailer: 'AllSaints', price: '519', currency: 'USD',
        productUrl: 'https://shop.example.com/jacket' },
      alternatives: [] },
  ],
  source: 'scan',
};

/**
 * Compare stored multi-item commerce by the properties that actually carry
 * meaning, not by object identity with the raw stored literal.
 *
 * Hydration is allowed to canonicalize an offer — the single-item shelf has
 * always done so, filling the commerce contract's optional fields with
 * explicit nulls — and the Build 32 commerce branch extends that same pass to
 * per-item cards so a stored unsafe URL cannot reach a reopened scan. What
 * must never change is the association and ordering asserted here, and that
 * holds whether or not that normalization is present.
 */
function assertCardsMatch(actual, expected, message) {
  assert.equal(actual.length, expected.length, `${message}: card count`);
  actual.forEach((card, i) => {
    const want = expected[i];
    assert.equal(card.candidateId, want.candidateId, `${message}: card ${i} candidateId (order preserved)`);
    assert.equal(card.status, want.status, `${message}: card ${i} status`);
    if (want.bestMatch) {
      assert.ok(card.bestMatch, `${message}: card ${i} kept its best match`);
      for (const key of ['title', 'retailer', 'price', 'currency', 'productUrl']) {
        if (want.bestMatch[key] === undefined) continue;
        assert.equal(card.bestMatch[key], want.bestMatch[key], `${message}: card ${i} bestMatch.${key}`);
      }
    } else {
      assert.equal(card.bestMatch, null, `${message}: card ${i} invented no best match`);
    }
    assert.equal(card.alternatives.length, want.alternatives.length, `${message}: card ${i} alternatives count`);
    card.alternatives.forEach((alt, j) => {
      assert.equal(alt.productUrl, want.alternatives[j].productUrl, `${message}: card ${i} alt ${j} url`);
      assert.equal(alt.retailer, want.alternatives[j].retailer, `${message}: card ${i} alt ${j} retailer`);
    });
  });
}

test('a multi-item-shaped record loads through this branch untouched', async () => {
  const storage = createMemoryStorage();
  storage.files.set(MANIFEST, JSON.stringify([MULTI_ITEM_RECORD]));

  const [loaded] = await loadLibraryModule(storage).loadLibrary();
  assert.ok(loaded, 'LOAD: the record hydrates');
  assert.deepEqual(
    loaded.multiItemCandidates, MULTI_ITEM_RECORD.multiItemCandidates,
    'candidateId and every candidate field survive save/hydrate without mutation',
  );
  assertCardsMatch(
    loaded.multiItemCommerce, MULTI_ITEM_RECORD.multiItemCommerce,
    'item<->offer association is preserved exactly, including card order',
  );

  // The association itself, asserted independently of ordering.
  const byCandidate = Object.fromEntries(
    loaded.multiItemCommerce.map((card) => [card.candidateId, card]),
  );
  assert.equal(byCandidate['cand-a'].bestMatch.title, 'Biker Jacket');
  assert.equal(byCandidate['cand-b'].bestMatch.title, 'Straight Jean');
  assert.ok(
    !byCandidate['cand-a'].alternatives.some((o) => o.productUrl.includes('jean')),
    'candidate A never inherits candidate B offers',
  );
});

test('a multi-item record survives a full write/read round trip on this branch', async () => {
  const storage = createMemoryStorage();
  storage.files.set(MANIFEST, JSON.stringify([MULTI_ITEM_RECORD]));
  const library = loadLibraryModule(storage);

  // Force a rewrite of the whole manifest through the atomic path by saving a
  // normal single-item scan alongside it.
  await library.saveScan({
    photoUri: 'memory://capture.jpg', analysis: analysisFor(1), source: 'camera',
  });

  const loaded = await loadLibraryModule(storage).loadLibrary();
  const multi = loaded.find((r) => r.id === 'scan_multi_1');
  assert.ok(multi, 'the multi-item record is not evicted or dropped by a single-item write');
  assert.deepEqual(multi.multiItemCandidates, MULTI_ITEM_RECORD.multiItemCandidates);
  assertCardsMatch(multi.multiItemCommerce, MULTI_ITEM_RECORD.multiItemCommerce,
    'a full manifest rewrite does not disturb item<->offer association');
});

test('single-item records are unaffected by multi-item fields being present', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);
  const [saved] = await seed(library, 1);
  await library.attachScanPurchaseOptions(saved.id, SNAPSHOT_A);

  // Introduce a multi-item record into the same manifest.
  const all = JSON.parse(storage.files.get(MANIFEST));
  storage.files.set(MANIFEST, JSON.stringify([MULTI_ITEM_RECORD, ...all]));

  const loaded = await loadLibraryModule(storage).loadLibrary();
  const single = loaded.find((r) => r.id === saved.id);
  assert.equal(single.purchaseOptions.length, 2, 'single-item commerce is unchanged');
  // No multi-item CONTENT may be invented for a single-item record. The field
  // may legitimately be absent (this branch alone) or an empty array (once the
  // Build 32 commerce branch hydrates it to [] so readers can always iterate);
  // what must never happen is a populated card appearing from nowhere.
  const singleMulti = single.multiItemCommerce;
  assert.ok(
    singleMulti === undefined || (Array.isArray(singleMulti) && singleMulti.length === 0),
    `single-item records carry no multi-item commerce, got ${JSON.stringify(singleMulti)}`,
  );
  const singleCandidates = single.multiItemCandidates;
  assert.ok(
    singleCandidates === undefined
      || (Array.isArray(singleCandidates) && singleCandidates.length === 0),
    'and no multi-item candidates either',
  );
});

// ── 6. Payload growth ────────────────────────────────────────────────────────

test('a commerce scan stays small and stores no raw provider payload', async () => {
  const storage = createMemoryStorage();
  const library = loadLibraryModule(storage);

  const noisyOffer = (i) => ({
    title: `Offer ${i}`, retailer: 'Retailer', price: '199', currency: 'USD',
    productUrl: `https://shop.example.com/p${i}`,
    imageUrl: `https://cdn.example.com/p${i}.jpg`,
    // Everything below is provider noise that must NOT be persisted.
    rawProviderResponse: { html: 'x'.repeat(5000) },
    debug: { latencyMs: 1234, upstream: 'serper', trace: 'y'.repeat(2000) },
    rankerScores: { brand: 5, title: 90 },
    base64: 'z'.repeat(4000),
  });

  await library.saveScan({
    photoUri: 'memory://capture.jpg',
    analysis: analysisFor(1, Array.from({ length: 12 }, (_, i) => noisyOffer(i))),
    source: 'camera',
  });

  const serialized = storage.files.get(MANIFEST);
  for (const banned of ['rawProviderResponse', 'debug', 'rankerScores', 'base64']) {
    assert.ok(!serialized.includes(banned), `${banned} is never persisted`);
  }
  const [reopened] = await loadLibraryModule(storage).loadLibrary();
  assert.equal(reopened.purchaseOptions.length, 12);
  assert.ok(serialized.length < 12000,
    `one commerce scan serializes small (was ${serialized.length} bytes)`);
});
