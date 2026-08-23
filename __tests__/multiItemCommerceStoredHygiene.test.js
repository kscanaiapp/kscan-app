/**
 * Build 32 — stored per-item commerce is re-normalized on READ.
 *
 * attachScanMultiItemCommerce normalizes what it writes, so a card this build
 * wrote is already clean. That is not the threat model the single-item shelf
 * is written against: it re-normalizes on read precisely because what is on
 * disk is not necessarily what this build wrote — an older build, a partially
 * synced cloud record, or a damaged manifest can all put values there.
 *
 * Multi-item cards were handed back exactly as stored, so an unsafe productUrl
 * survived hydration and reached a reopened scan as a tappable offer, while
 * the identical value in the single-item shelf was stripped. Same data, same
 * hazard — these pin that they now get the same treatment.
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

function loadLibrary(files) {
  const fileSystem = {
    documentDirectory: 'memory://documents/',
    EncodingType: { UTF8: 'utf8' },
    getInfoAsync: async (uri) => ({ exists: files.has(uri), uri }),
    readAsStringAsync: async (uri) => {
      if (!files.has(uri)) throw new Error('missing ' + uri);
      return files.get(uri);
    },
    writeAsStringAsync: async (uri, v) => { files.set(uri, v); },
    makeDirectoryAsync: async () => undefined,
    moveAsync: async ({ from, to }) => {
      if (!files.has(from)) throw new Error('missing ' + from);
      files.set(to, files.get(from)); files.delete(from);
    },
    deleteAsync: async (uri) => { files.delete(uri); },
  };
  return createLoader(ROOT, {
    'expo-file-system/legacy': fileSystem,
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({ uri: 'memory://t.jpg' }) },
    './savedScansCloud': { saveScanToCloud: async () => ({ ok: false }), softDeleteCloudSavedScan: async () => ({ ok: false }) },
    './actorContext': { resolveWriteAuthority: () => ({ ok: true, ownerId: null }), isActorRequestCurrent: () => true },
  })('services/library.js');
}

function manifestWith(multiItemCommerce) {
  return JSON.stringify([{
    id: 'scan_stored_1',
    createdAt: '2026-08-01T00:00:00.000Z',
    ownerId: null,
    imageUri: 'memory://i1.jpg',
    thumbnailUri: 'memory://t1.jpg',
    attributes: {},
    result: 'a jacket',
    products: [],
    purchaseOptions: [],
    source: 'scan',
    multiItemCandidates: [{ id: 'jacket', label: 'Biker Jacket', category: 'outerwear', subtype: 'jacket' }],
    multiItemCommerce,
  }]);
}

const UNSAFE_SCHEMES = [
  'javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'file:///etc/passwd',
];

test('an unsafe stored bestMatch URL never reaches a reopened scan', async () => {
  for (const productUrl of UNSAFE_SCHEMES) {
    const files = new Map([[MANIFEST, manifestWith([
      { candidateId: 'jacket', status: 'ready', bestMatch: { title: 'Bad', retailer: 'R', productUrl }, alternatives: [] },
    ])]]);
    const [scan] = await loadLibrary(files).loadLibrary();
    const best = scan.multiItemCommerce[0].bestMatch;
    assert.ok(
      !best || !String(best.productUrl ?? '').toLowerCase().startsWith(productUrl.split(':')[0]),
      `stored ${productUrl.split(':')[0]}: URL survived hydration as ${JSON.stringify(best && best.productUrl)}`,
    );
  }
});

test('an unsafe stored alternative URL never reaches a reopened scan', async () => {
  const files = new Map([[MANIFEST, manifestWith([
    {
      candidateId: 'jacket',
      status: 'ready',
      bestMatch: { title: 'Good', retailer: 'R', productUrl: 'https://shop.example.com/ok' },
      alternatives: [
        { title: 'Bad', retailer: 'R', productUrl: 'javascript:alert(1)' },
        { title: 'Also good', retailer: 'R2', productUrl: 'https://shop.example.com/ok2' },
      ],
    },
  ])]]);
  const [scan] = await loadLibrary(files).loadLibrary();
  const alts = scan.multiItemCommerce[0].alternatives;
  assert.ok(
    alts.every((o) => !String(o.productUrl ?? '').toLowerCase().startsWith('javascript:')),
    `unsafe alternative survived: ${JSON.stringify(alts.map((o) => o.productUrl))}`,
  );
  assert.equal(scan.multiItemCommerce[0].bestMatch.productUrl, 'https://shop.example.com/ok',
    'the safe offer is untouched');
});

test('read-path hygiene matches the single-item shelf exactly', async () => {
  // The same unsafe value in both fields must get the same treatment; a
  // divergence here is what let the multi-item card through before.
  const raw = { title: 'Bad', retailer: 'R', productUrl: 'javascript:alert(1)' };
  const files = new Map([[MANIFEST, JSON.stringify([{
    id: 'scan_both_1',
    createdAt: '2026-08-01T00:00:00.000Z',
    ownerId: null,
    imageUri: 'memory://i.jpg',
    attributes: {},
    result: 'x',
    products: [],
    purchaseOptions: [raw],
    source: 'scan',
    multiItemCandidates: [{ id: 'jacket', label: 'J', category: 'c', subtype: 's' }],
    multiItemCommerce: [{ candidateId: 'jacket', status: 'ready', bestMatch: raw, alternatives: [raw] }],
  }])]]);

  const [scan] = await loadLibrary(files).loadLibrary();
  const singleSurvived = scan.purchaseOptions.some(
    (o) => String(o.productUrl ?? '').toLowerCase().startsWith('javascript:'));
  const card = scan.multiItemCommerce[0];
  const multiSurvived =
    String(card.bestMatch?.productUrl ?? '').toLowerCase().startsWith('javascript:')
    || card.alternatives.some((o) => String(o.productUrl ?? '').toLowerCase().startsWith('javascript:'));

  assert.equal(singleSurvived, false, 'single-item shelf strips it (pre-existing contract)');
  assert.equal(multiSurvived, singleSurvived, 'multi-item cards must not be more permissive');
});

test('good stored commerce is preserved verbatim through hydration', async () => {
  const files = new Map([[MANIFEST, manifestWith([
    {
      candidateId: 'jacket',
      status: 'ready',
      bestMatch: { title: 'Biker Jacket', retailer: 'AllSaints', price: '519', currency: 'USD', productUrl: 'https://shop.example.com/a1' },
      alternatives: [{ title: 'Leather Jacket', retailer: 'Schott', price: '890', currency: 'USD', productUrl: 'https://shop.example.com/a2' }],
    },
  ])]]);
  const [scan] = await loadLibrary(files).loadLibrary();
  const card = scan.multiItemCommerce[0];
  assert.equal(card.candidateId, 'jacket');
  assert.equal(card.status, 'ready');
  assert.equal(card.bestMatch.retailer, 'AllSaints');
  assert.equal(card.bestMatch.productUrl, 'https://shop.example.com/a1');
  assert.equal(card.alternatives.length, 1);
  assert.equal(card.alternatives[0].retailer, 'Schott');
});

test('a malformed card entry does not take the whole scan with it', async () => {
  const files = new Map([[MANIFEST, manifestWith([
    null,
    'not-a-card',
    { candidateId: 'jacket', status: 'ready', bestMatch: { title: 'OK', retailer: 'R', productUrl: 'https://shop.example.com/ok' }, alternatives: [] },
  ])]]);
  const [scan] = await loadLibrary(files).loadLibrary();
  assert.ok(scan, 'the scan still opens');
  assert.equal(scan.multiItemCommerce.length, 1, 'only the real card survives');
  assert.equal(scan.multiItemCommerce[0].bestMatch.retailer, 'R');
});
