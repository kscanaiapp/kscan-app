'use strict';

/**
 * P-COPY-2: a reopened scan with no visible offers showed awkward, repeated
 * shopping-match copy.
 *
 * The reopened card borrowed the LIVE shelf's NOT_STARTED copy:
 *
 *   "Shopping matches aren't shown here."
 *   "This item was identified, but where-to-buy results aren't shown in this view."
 *
 * On a saved list of N detected items it printed that pair N+1 times (once per
 * item, with nothing to tell the blocks apart, and once more for the single-item
 * shelf), and it read as if matches existed somewhere the screen would not say.
 *
 * The saved record is the only evidence a reopened scan has, so the copy now
 * says what the record establishes and nothing more:
 *   - offers were saved                      -> the offers (unchanged)
 *   - none were saved with this scan         -> says so, and how to get them
 *   - a saved list of items, none with offers -> ONE notice: matches are kept
 *                                               with each chosen item's own entry
 * It never says offers do not exist or were lost.
 *
 * Runs the REAL library persistence (in-memory expo-file-system) and the REAL
 * AnalysisCard, mounted the way app/library.tsx mounts a reopened scan.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
globalThis.__DEV__ = false;

// ── TypeScript-aware production module loader ───────────────────────────────
function createLoader(root, mocks = {}) {
  const cache = new Map();
  function resolveFile(candidate) {
    const candidates = path.extname(candidate)
      ? [candidate]
      : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
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

// ── Minimal React element recorder (no react-test-renderer in this repo) ────
function createReactRecorder() {
  return {
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child);
        else if (child !== null && child !== undefined && child !== false) flat.push(child);
      }
      return { __node: true, type: typeof type === 'function' ? (type.name || 'Component') : String(type), props: props || {}, children: flat };
    },
    Fragment: 'Fragment',
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  };
}
function collect(node, nodes = []) {
  if (!node || typeof node !== 'object' || !node.__node) return nodes;
  nodes.push(node);
  for (const child of node.children) collect(child, nodes);
  return nodes;
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
  return { fileSystem, imageManipulator: { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({ uri: 'memory://cache/thumb.jpg' }) } };
}
function loadLibrary(storage) {
  return createLoader(ROOT, {
    'expo-file-system/legacy': storage.fileSystem,
    'expo-image-manipulator': storage.imageManipulator,
    './savedScansCloud': {
      saveScanToCloud: async () => ({ ok: false, reason: 'disabled' }),
      softDeleteCloudSavedScan: async () => ({ ok: false, reason: 'disabled' }),
    },
    './actorContext': { resolveWriteAuthority: () => ({ ok: true, ownerId: null }), isActorRequestCurrent: () => true },
  })('services/library.js');
}

/** The real AnalysisCard, rendered as a plain function with inert React Native. */
function loadAnalysisCard() {
  class AnimatedValue { constructor(value) { this.value = value; } setValue(value) { this.value = value; } }
  const animation = () => ({ start: (callback) => { if (typeof callback === 'function') callback(); } });
  return createLoader(ROOT, {
    react: createReactRecorder(),
    'react-native': {
      View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', Modal: 'Modal', ScrollView: 'ScrollView',
      StyleSheet: { create: (styles) => styles, absoluteFillObject: {}, hairlineWidth: 1, flatten: (style) => style },
      Animated: { Value: AnimatedValue, View: 'Animated.View', timing: animation, parallel: animation, stagger: animation },
      PanResponder: { create: () => ({ panHandlers: {} }) },
      Easing: { bezier: () => () => 0 },
      Platform: { OS: 'ios', select: (spec) => (spec && (spec.ios !== undefined ? spec.ios : spec.default)) },
      Dimensions: { get: () => ({ width: 390, height: 844 }) },
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    './MetadataChip': { MetadataChip: 'MetadataChip' },
    './ProductShelf': { ProductShelf: 'ProductShelf' },
    './scan/ScanResultCard': { ScanResultCard: 'ScanResultCard' },
    './SecondhandShelf': { SecondhandShelf: 'SecondhandShelf' },
    './SneakerMatchCard': { SneakerMatchCard: 'SneakerMatchCard' },
    '../hooks/useFeatureFreeze': { useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }) },
    '../hooks/useResponsiveLayout': { useResponsiveLayout: () => ({ height: 844, modalMaxWidth: 640 }) },
    '../contexts/AiOutputReportingContext': { useAiOutputReporting: () => ({ openAiOutputReport: () => {} }) },
    './scan-results/ResultSurfaceModal': { ResultSurfaceModal: 'Modal' },
    './free-tier/SavedItemUtilityPanel': { SavedItemUtilityPanel: 'SavedItemUtilityPanel' },
    '../services/free-tier/itemNormalization': { normalizeItem: (item) => item, normalizeItems: (items) => items },
  })('components/AnalysisCard.tsx').AnalysisCard;
}
const AnalysisCard = loadAnalysisCard();
const state = createLoader(ROOT)('services/commerceShelfState.ts');

/** Mirrors the reopened-scan mount in app/library.tsx for the props under test. */
function renderReopened(scan) {
  return AnalysisCard({
    result: scan.result,
    metadata: {
      category: scan.attributes.category, color: scan.attributes.color_palette,
      silhouette: scan.attributes.silhouette, pattern: scan.attributes.pattern ?? null,
    },
    products: scan.products,
    purchaseOptions: scan.purchaseOptions ?? [],
    multiItemCandidates: scan.multiItemCandidates ?? [],
    multiItemCommerce: scan.multiItemCommerce ?? [],
    scanImageUri: scan.imageUri ?? null,
    scanSourceId: scan.id,
    scanSourceType: 'style_library_scan',
    relatedSavedScans: [],
    onDismiss: () => {},
  });
}
const shelves = (tree) => collect(tree).filter((node) => node.type === 'ProductShelf');
const emptyShelves = (tree) => shelves(tree).filter((node) => (node.props.products ?? []).length === 0);
const copyOf = (node) => [node.props.emptyTitle, node.props.emptyBody];

const BEFORE = [
  "Shopping matches aren't shown here.",
  "This item was identified, but where-to-buy results aren't shown in this view.",
];
const NOT_SAVED = [
  "Shopping matches weren't saved with this scan.",
  'Scan the item again to see where to buy it.',
];
const NOT_SAVED_FOR_ITEM = [
  "Shopping matches weren't saved for this item.",
  'Scan it again to see where to buy it.',
];
const SAVED_WITH_EACH_ITEM = [
  'Shopping matches are saved with each item.',
  "When you choose an item from a scan, its matches are kept on that item's own entry in Recent Scans.",
];

const OFFERS = [
  { title: 'Biker Jacket', retailer: 'AllSaints', price: 519, purchaseUrl: 'https://allsaints.com/p/1' },
  { title: 'Perfecto', retailer: 'Schott', price: 900, purchaseUrl: 'https://schottnyc.com/p/2' },
];
const CANDIDATES = [
  { id: 'jacket', label: 'Biker Jacket', category: 'outerwear', subtype: 'jacket' },
  { id: 'boots', label: 'Chelsea Boot', category: 'footwear', subtype: 'boot' },
  { id: 'bag', label: 'Tote Bag', category: 'bags', subtype: 'tote' },
];
const ANALYSIS = { result: 'A black biker jacket.', metadata: { category: 'outerwear', color: 'black', silhouette: 'cropped' } };

async function saveSingle(analysis) {
  const storage = createMemoryStorage();
  const saved = await loadLibrary(storage).saveScan({ photoUri: 'memory://capture.jpg', analysis, source: 'camera' });
  assert.ok(saved, 'scan saved');
  return { storage, saved };
}
async function saveMulti(cards) {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);
  const saved = await library.saveMultiItemScan({
    photoUri: 'memory://capture.jpg', analysis: { result: 'three items', metadata: {} },
    candidates: CANDIDATES, source: 'camera',
  });
  assert.ok(saved, 'multi-item scan saved');
  if (cards) assert.equal(await library.attachScanMultiItemCommerce(saved.id, cards), true);
  return { storage, saved };
}
const reopen = async (storage) => (await loadLibrary(storage).loadLibrary())[0];

// ── The copy itself ───────────────────────────────────────────────────────────

test('exact after-copy for the three saved-scan empty states', () => {
  assert.deepEqual(Object.values(state.SAVED_SCAN_EMPTY_COPY.NOT_SAVED), NOT_SAVED);
  assert.deepEqual(Object.values(state.SAVED_SCAN_EMPTY_COPY.NOT_SAVED_FOR_ITEM), NOT_SAVED_FOR_ITEM);
  assert.deepEqual(Object.values(state.SAVED_SCAN_EMPTY_COPY.SAVED_WITH_EACH_ITEM), SAVED_WITH_EACH_ITEM);
});

test('none of the saved-scan copy says offers do not exist, were lost, or that a search found nothing', () => {
  for (const entry of Object.values(state.SAVED_SCAN_EMPTY_COPY)) {
    for (const text of Object.values(entry)) {
      assert.doesNotMatch(text, /\bno (?:\w+ ){0,2}match(?:es)?\b/i, text);
      assert.doesNotMatch(text, /\bnothing (?:was )?(?:matched|found)\b/i, text);
      assert.doesNotMatch(text, /\b(lost|deleted|removed|unavailable|don't exist|do not exist|aren't shown)\b/i, text);
    }
  }
});

test('the live shelf copy is untouched (this repair is about reopened scans only)', () => {
  assert.deepEqual(
    [state.COMMERCE_SHELF_COPY.NOT_STARTED.shelfTitle, state.COMMERCE_SHELF_COPY.NOT_STARTED.shelfBody],
    BEFORE,
  );
  assert.deepEqual(Object.values(state.purchaseShelfEmptyProps(0, 'idle')), BEFORE, 'live single-item shelf, idle');
  assert.deepEqual(Object.values(state.purchaseShelfEmptyProps(0, undefined, { savedScan: false })), BEFORE);
});

test('a saved scan changes only the NOT_STARTED state; a completed-empty or failed search keeps its own copy', () => {
  const saved = { savedScan: true };
  assert.deepEqual(Object.values(state.purchaseShelfEmptyProps(0, 'idle', saved)), NOT_SAVED);
  assert.deepEqual(Object.values(state.purchaseShelfEmptyProps(0, undefined, saved)), NOT_SAVED);
  for (const status of ['empty', 'error', 'pending']) {
    assert.deepEqual(
      state.purchaseShelfEmptyProps(0, status, saved),
      state.purchaseShelfEmptyProps(0, status),
      `status ${status}`,
    );
  }
  assert.match(state.purchaseShelfEmptyProps(0, 'empty', saved).emptyTitle, /No strong shopping match found\./);
});

test('"no commerce for any item" is decided from stored cards alone', () => {
  const has = state.savedMultiItemScanHasNoCommerce;
  assert.equal(has(CANDIDATES, []), true);
  assert.equal(has(CANDIDATES, undefined), true);
  assert.equal(has(CANDIDATES, null), true);
  assert.equal(has(CANDIDATES, [{ candidateId: 'someone-else' }]), true, 'a card for another scan\'s item is not evidence');
  assert.equal(has(CANDIDATES, [{ candidateId: 'boots', status: 'no_match' }]), false, 'a completed-empty search is evidence');
  assert.equal(has(CANDIDATES, [{ candidateId: 'boots', status: 'error' }]), false, 'a failed search is evidence');
  assert.equal(has([], []), false, 'not a multi-item scan at all');
});

// ── Reopened single-item scans ────────────────────────────────────────────────

test('REOPEN, single item WITH saved offers: the offers render and no empty copy appears', async () => {
  const { storage } = await saveSingle({ ...ANALYSIS, purchaseOptions: OFFERS });
  const scan = await reopen(storage);
  assert.equal(scan.purchaseOptions.length, 2, 'offers survived save and reopen');

  const tree = renderReopened(scan);
  const shelf = shelves(tree).find((node) => node.props.testID === 'purchase-options-shelf');
  assert.ok(shelf, 'WHERE TO BUY shelf');
  assert.equal(shelf.props.label, 'WHERE TO BUY');
  assert.deepEqual(shelf.props.products.map((offer) => offer.retailer), ['AllSaints', 'Schott']);
  assert.equal(emptyShelves(tree).length, 0, 'nothing claims matches are missing');
});

test('REOPEN, single item WITHOUT saved offers: one notice, saying none were saved with this scan', async () => {
  const { storage } = await saveSingle(ANALYSIS);
  const scan = await reopen(storage);
  assert.equal(scan.purchaseOptions.length, 0);

  const empty = emptyShelves(renderReopened(scan));
  assert.equal(empty.length, 1);
  assert.equal(empty[0].props.testID, 'purchase-options-shelf');
  assert.deepEqual(copyOf(empty[0]), NOT_SAVED);
  assert.notDeepEqual(copyOf(empty[0]), BEFORE, 'negative control: this is not the pre-repair copy');
});

test('REOPEN, offers attached AFTER the save are shown too (save-before-commerce)', async () => {
  const { storage, saved } = await saveSingle(ANALYSIS);
  assert.equal(await loadLibrary(storage).attachScanPurchaseOptions(saved.id, OFFERS), true);
  const tree = renderReopened(await reopen(storage));
  assert.equal(emptyShelves(tree).length, 0);
  assert.equal(shelves(tree).find((node) => node.props.testID === 'purchase-options-shelf').props.products.length, 2);
});

// ── Live multi-item regression: saved-only copy must never leak into live ────

test('LIVE scan with multiple candidates and no commerce retains per-item shelves, not the saved-only summary', () => {
  const tree = AnalysisCard({
    result: 'Three detected garments.',
    metadata: { category: 'outerwear', color: 'black', silhouette: 'cropped' },
    products: [],
    purchaseOptions: [],
    multiItemCandidates: CANDIDATES,
    multiItemCommerce: [],
    scanSourceType: 'live_scan',
    onDismiss: () => {},
  });
  const ids = shelves(tree).map((node) => node.props.testID);
  assert.equal(ids.includes('multi-item-commerce-not-started-summary'), false,
    'reopened-scan-only summary must not appear on a live scan');
  for (const candidate of CANDIDATES) {
    assert.ok(ids.includes(`multi-item-commerce-not-started-${candidate.id}`),
      `live scan should retain the commerce shelf for ${candidate.id}`);
  }
  assert.equal(ids.filter((id) => /^multi-item-commerce-not-started-(jacket|boots|bag)$/.test(id)).length, CANDIDATES.length);
});

// ── Reopened multi-item scans ─────────────────────────────────────────────────

test('REOPEN, saved list of items with NO commerce: exactly ONE notice, not one per item plus one', async () => {
  const { storage } = await saveMulti(null);
  const scan = await reopen(storage);
  assert.equal(scan.multiItemCandidates.length, 3);
  assert.deepEqual(scan.multiItemCommerce, []);

  const empty = emptyShelves(renderReopened(scan));
  assert.equal(empty.length, 1, `the pre-repair card rendered ${CANDIDATES.length + 1} identical blocks here`);
  assert.equal(empty[0].props.testID, 'multi-item-commerce-not-started-summary');
  assert.deepEqual(copyOf(empty[0]), SAVED_WITH_EACH_ITEM);
  // It says where matches are kept; it does not say there are none.
  assert.match(empty[0].props.emptyBody, /kept on that item's own entry in Recent Scans/);
});

test('REOPEN, saved list WITH stored offers: each item keeps its own shelf, and nothing is repeated', async () => {
  const { storage } = await saveMulti([
    { candidateId: 'jacket', status: 'ready', bestMatch: OFFERS[0], alternatives: [OFFERS[1]] },
    { candidateId: 'boots', status: 'no_match', bestMatch: null, alternatives: [] },
    // `bag` has no stored card.
  ]);
  const tree = renderReopened(await reopen(storage));
  const byId = Object.fromEntries(shelves(tree).map((node) => [node.props.testID, node]));

  assert.equal(byId['multi-item-commerce-best-match-jacket'].props.products.length, 1, 'saved offer is shown');
  assert.equal(byId['multi-item-commerce-alternatives-jacket'].props.products.length, 1);
  assert.match(byId['multi-item-commerce-no-match-boots'].props.emptyTitle, /No strong shopping match found\./,
    'a completed empty search still says so');
  assert.deepEqual(copyOf(byId['multi-item-commerce-not-started-bag']), NOT_SAVED_FOR_ITEM,
    'an item with no stored card says its matches were not saved');
  assert.equal(byId['multi-item-commerce-not-started-summary'], undefined, 'no summary when commerce is stored');
  assert.equal(byId['purchase-options-shelf'], undefined, 'no second, single-item empty shelf under the per-item section');
});

test('REOPEN, a stored failure is still reported as a failure', async () => {
  const { storage } = await saveMulti([
    { candidateId: 'jacket', status: 'error', bestMatch: null, alternatives: [] },
  ]);
  const byId = Object.fromEntries(shelves(renderReopened(await reopen(storage))).map((node) => [node.props.testID, node]));
  assert.equal(byId['multi-item-commerce-error-jacket'].props.emptyTitle, "Purchase options couldn't be loaded.");
  assert.deepEqual(copyOf(byId['multi-item-commerce-not-started-boots']), NOT_SAVED_FOR_ITEM);
});

test('the pre-repair sentences no longer reach any reopened scan', async () => {
  const scans = [
    await reopen((await saveSingle(ANALYSIS)).storage),
    await reopen((await saveSingle({ ...ANALYSIS, purchaseOptions: OFFERS })).storage),
    await reopen((await saveMulti(null)).storage),
    await reopen((await saveMulti([{ candidateId: 'boots', status: 'no_match', bestMatch: null, alternatives: [] }])).storage),
  ];
  for (const scan of scans) {
    for (const node of shelves(renderReopened(scan))) {
      for (const text of copyOf(node)) {
        if (typeof text !== 'string') continue;
        assert.ok(!BEFORE.includes(text), `pre-repair copy on ${node.props.testID}: "${text}"`);
      }
    }
  }
});
