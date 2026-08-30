/**
 * Build 32 — a reopened Recent Scan must not restate a failure as a no-match.
 *
 * attachScanMultiItemCommerce persists each card's `status`, so by the time a
 * scan is reopened the record already knows whether commerce found nothing or
 * failed outright. The reopen surface (components/AnalysisCard.tsx) previously
 * branched on `card.bestMatch` alone, so a stored `status: 'error'` rendered
 * the affirmative claim "No strong shopping match found." — a different, and
 * false, statement from the one the live scan showed for the same item.
 *
 * These assertions run against the REAL library persistence (in-memory
 * expo-file-system) plus the real AnalysisCard source branch table.
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

function createMemoryStorage() {
  const files = new Map();
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
      if (!files.has(from)) throw new Error(`Missing memory file: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    deleteAsync: async (uri) => { files.delete(uri); },
  };
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async () => ({ uri: 'memory://cache/thumb.jpg' }),
  };
  return { files, fileSystem, imageManipulator };
}

function loadLibrary(storage) {
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

const CANDIDATES = [
  { id: 'jacket', label: 'Biker Jacket', category: 'outerwear', subtype: 'jacket' },
  { id: 'boots', label: 'Chelsea Boot', category: 'footwear', subtype: 'boot' },
];

test('a card whose commerce failed persists as an error, not as a no-match', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);

  const saved = await library.saveMultiItemScan({
    photoUri: 'memory://capture.jpg',
    analysis: { result: 'two items', metadata: {} },
    candidates: CANDIDATES,
    source: 'camera',
  });
  assert.ok(saved, 'multi-item scan saved');

  const attached = await library.attachScanMultiItemCommerce(saved.id, [
    {
      candidateId: 'jacket',
      status: 'ready',
      bestMatch: { title: 'Jacket', retailer: 'AllSaints', productUrl: 'https://x.example.com/j' },
      alternatives: [],
    },
    // Commerce failed for this one — no offers, but NOT a no-match.
    { candidateId: 'boots', status: 'error', bestMatch: null, alternatives: [] },
  ]);
  assert.equal(attached, true);

  const [reopened] = await loadLibrary(storage).loadLibrary();
  const cards = reopened.multiItemCommerce;
  const boots = cards.find((c) => c.candidateId === 'boots');

  assert.ok(boots, 'the failed item is still represented after reopen');
  assert.equal(boots.status, 'error',
    'the failure cause survives serialization — the reopen surface has what it needs');
  assert.equal(boots.bestMatch, null, 'and no offer was invented for it');

  const jacket = cards.find((c) => c.candidateId === 'jacket');
  assert.equal(jacket.status, 'ready');
  assert.equal(jacket.bestMatch.retailer, 'AllSaints',
    'offers stay bound to their own garment across the round trip');
});

test('the reopen surface branches on stored status, not on bestMatch alone', () => {
  // AnalysisCard renders the persisted cards. Assert the branch table itself,
  // because the false claim was produced by an else-branch that could not see
  // the status the record carried.
  const source = fs.readFileSync(path.join(ROOT, 'components/AnalysisCard.tsx'), 'utf8');
  const start = source.indexOf('multiItemCandidates.length > 0');
  assert.ok(start > -1, 'the multi-item reopen block exists');
  const block = source.slice(start, start + 2600);

  assert.match(block, /card\?\.status === 'error'/,
    'the reopen block must consult the stored status');

  const noMatchIdx = block.indexOf('No strong shopping match found.');
  const errorIdx = block.indexOf("card?.status === 'error'");
  assert.ok(noMatchIdx > -1, 'the no-match copy is still present for genuine no-matches');
  assert.ok(errorIdx > -1 && errorIdx < noMatchIdx,
    'the error case is decided before falling through to the no-match claim');
});
