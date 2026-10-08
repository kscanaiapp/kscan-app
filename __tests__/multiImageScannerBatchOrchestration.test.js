'use strict';

/**
 * Screen-level orchestration of the multi-image Scanner, executed.
 *
 * The result-queue, save, Add All, Elise and display-projection code lives in
 * app.js (a 2,000-line component). This suite extracts those exact source
 * regions with start/end markers and EXECUTES them against:
 *   - the real hooks/useKScan.js and real service graph (see
 *     __tests__/helpers/scannerHookHarness.js; only the device edges and the
 *     scan-identify invoke are simulated),
 *   - the real services/library.js running over an in-memory filesystem and the
 *     SAME actor-context instance the hook uses.
 * A marker that stops matching fails the suite instead of passing vacuously.
 *
 * Matrix points covered here: 10 rate limit + explicit resume, 11 cancellation,
 * 12 rapid taps, 13 source-image switching, 14 per-item persistence,
 * 15 reopening saved scans, 16 Save All, 17 Add All to Dressing Room,
 * 18 Elise handoff, 19 account switching, 20 offline.
 *
 * Not provable here (device only): real taps/animations, the native result
 * Modal, native gallery behaviour, real network loss timing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { deferred } = require('./helpers/componentRenderer');
const { mountUseKScan, rateLimitedPayload } = require('./helpers/scannerHookHarness');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// ── Source-region extraction ────────────────────────────────────────────────

function region(startMarker, endMarker, { source = APP, includeEnd = false } = {}) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `end marker not found after start: ${endMarker}`);
  return source.slice(start, includeEnd ? end + endMarker.length : end);
}

const QUEUE_SRC = region('const runBatchQueue = useCallback(', '\n  const persistBatchItem = useCallback(');
const PERSIST_SRC = region('const persistBatchItem = useCallback(', '\n  useEffect(() => () => {\n    batchGenerationRef');
const AUTOSAVE_SRC = region('// Preserve the established Scanner behavior', '\n  // perceiving: true while');
const RESET_SRC = region(
  'useEffect(() => {\n    if (!eligibleBatchSession || !batchSessionKey) {',
  '}, [eligibleBatchSession, batchSessionKey]);',
  { includeEnd: true },
);
const PROJECTION_SRC = region('const trueMultiPhotoSession =', '\n\n  const router = useRouter();');
const ELISE_SRC = region('onAskStyleChat={styleChatEnabled ? () => {', '            } : undefined}')
  .replace('onAskStyleChat={styleChatEnabled ? () => {', 'const askElise = styleChatEnabled ? () => {') + '            } : undefined;';
const ADD_ALL_SRC = 'const additionalScans = ' + region('additionalScans={', '\n      onClose=').slice('additionalScans={'.length).replace(/\}\s*$/, '') + ';';

/** Evaluate an app.js region in THIS realm with an explicit scope (so deepStrictEqual works). */
function evaluate(code, scope, returns = []) {
  const names = Object.keys(scope);
  const factory = new Function(...names, `${code}\nreturn { ${returns.join(', ')} };`);
  return factory(...names.map((name) => scope[name]));
}

// ── Screen state shim: setters apply immediately, refs persist across "renders" ──

function createStore(actorRequest) {
  const state = {
    batchSelectedCandidateIds: [], batchItems: [], batchItemStates: {}, batchQueueActive: false,
    batchQueueNotice: null, batchRemainingCandidateIds: [], batchSelectedItemId: null,
    savedBatchScanIds: {}, addAllBatchToRoom: false, savedToast: false,
  };
  const refs = {
    batchGenerationRef: { current: 1 },
    batchQueueLockRef: { current: false },
    batchActorRequestRef: { current: actorRequest },
    batchSavedIdsRef: { current: {} },
    batchSavingItemIdsRef: { current: new Set() },
    batchGroupIdRef: { current: 'multi-test-1' },
    batchSessionKeyRef: { current: null },
  };
  const setters = {};
  for (const key of Object.keys(state)) {
    const name = `set${key[0].toUpperCase()}${key.slice(1)}`;
    setters[name] = (value) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  }
  return { state, refs, setters };
}

function compileQueue(store, { actor, analyzeSelectedCandidates, mutate = null }) {
  const code = mutate ? mutate(QUEUE_SRC) : QUEUE_SRC;
  if (mutate) assert.notEqual(code, QUEUE_SRC, 'a negative control that rewrites nothing proves nothing');
  return evaluate(code, {
    useCallback: (fn) => fn,
    eligibleBatchSession: true,
    isActorRequestCurrent: actor.isActorRequestCurrent,
    analyzeSelectedCandidates,
    ...store.refs,
    ...store.setters,
    batchSelectedCandidateIds: store.state.batchSelectedCandidateIds,
    batchItemStates: store.state.batchItemStates,
    batchItems: store.state.batchItems,
    batchQueueActive: store.state.batchQueueActive,
    batchRemainingCandidateIds: store.state.batchRemainingCandidateIds,
  }, ['runBatchQueue', 'resumeBatchQueue']);
}

// ── Scenario fixtures (same shapes as the hook matrix) ──────────────────────

const URI = ['a', 'b', 'c', 'd', 'e'].map((name) => `file:///cache/${name}.jpg`);
const garment = (candidateId, category, subtype, extra = {}) => ({ candidateId, category, subtype, label: subtype, color: 'black', ...extra });
const asset = (uri, index) => ({ uri, assetId: `asset-${index}`, type: 'image' });
const PHOTOS = {
  [URI[0]]: { garments: [garment('g1', 'coat', 'trench'), garment('g2', 'shoes', 'boot')] },
  [URI[1]]: { garments: [garment('g1', 'dress', 'midi')] },
  [URI[2]]: { garments: [garment('g1', 'bag', 'tote')] },
};
const IDS = ['asset-0:g1', 'asset-1:g1', 'asset-2:g1'];

async function openSession(options = {}) {
  const m = mountUseKScan({ photos: options.photos ?? PHOTOS, ...options });
  await m.selectPhotos(URI.slice(0, options.count ?? 3).map(asset));
  await m.analyze();
  assert.equal(m.hook.status, 'result');
  const store = createStore(m.actor.createActorRequest());
  store.state.batchSelectedCandidateIds = options.selected ?? IDS;
  const queue = () => compileQueue(store, {
    actor: m.actor,
    analyzeSelectedCandidates: (...args) => m.hook.analyzeSelectedCandidates(...args),
    mutate: options.queueMutate,
  });
  return { m, store, queue };
}

const readyIds = (store) => store.state.batchItems.map((item) => item.id);

// ── 10 / 12. Queue: rapid taps, quota pause and explicit resume ─────────────

test('12: a double tap on Find Matches runs one queue and spends each selected item once', async () => {
  const { m, store, queue } = await openSession();
  const render = queue();
  const first = render.runBatchQueue();
  const second = render.runBatchQueue();
  await Promise.all([first, second]);
  assert.equal(m.edge.selected.length, 3);
  assert.deepEqual(readyIds(store), IDS);
  assert.equal(store.state.batchQueueActive, false);
  assert.equal(store.refs.batchQueueLockRef.current, false, 'the lock is released when the queue ends');
  m.unmount();
});

test('10: a spent daily quota pauses the queue, keeps finished items, states the reason and resumes only the remainder', async () => {
  let spent = false;
  const { m, store, queue } = await openSession({
    respond: (request) => {
      if (request.mode === 'selected_item' && request.uri === URI[1] && !spent) { spent = true; return rateLimitedPayload(); }
      return undefined;
    },
  });
  await queue().runBatchQueue();
  assert.deepEqual(readyIds(store), ['asset-0:g1']);
  assert.deepEqual(store.state.batchRemainingCandidateIds, ['asset-1:g1', 'asset-2:g1']);
  assert.match(store.state.batchQueueNotice, /Daily scan limit/);
  assert.equal(store.state.batchQueueActive, false);
  assert.equal(m.edge.selected.length, 2, 'the third item is not spent against a spent quota');
  assert.equal(store.state.batchItemStates['asset-0:g1'], 'ready');
  assert.equal(store.state.batchItemStates['asset-1:g1'], 'queued');
  assert.equal(store.state.batchItemStates['asset-2:g1'], 'queued');

  // The explicit Resume press: a fresh render, remaining ids only.
  queue().resumeBatchQueue();
  await new Promise((resolve) => setTimeout(resolve, 0));
  while (store.state.batchQueueActive) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(readyIds(store), IDS);
  assert.deepEqual(store.state.batchRemainingCandidateIds, []);
  assert.equal(m.edge.selected.length, 4, 'exactly the two remaining items were dispatched on resume');
  assert.deepEqual(m.edge.selected.map((request) => request.uri), [URI[0], URI[1], URI[1], URI[2]]);
  m.unmount();
});

test('12: the second tap never reaches the hook, so no misleading "already in progress" notice is shown', async () => {
  const { m, store, queue } = await openSession();
  const render = queue();
  await Promise.all([render.runBatchQueue(), render.runBatchQueue()]);
  assert.equal(store.state.batchQueueNotice, null);
  m.unmount();
});

test('NEGATIVE CONTROL: without the screen lock a rapid second tap reaches the hook, is refused as busy and flips the queue to inactive mid-run', async () => {
  const { m, store, queue } = await openSession({
    queueMutate: (text) => text.replace('if (!eligibleBatchSession || batchQueueLockRef.current ||', 'if (!eligibleBatchSession ||'),
  });
  const render = queue();
  await Promise.all([render.runBatchQueue(), render.runBatchQueue()]);
  assert.match(store.state.batchQueueNotice, /already in progress/);
  assert.equal(m.edge.selected.length, 3, 'the hook-level guard still prevents a duplicate spend');
  m.unmount();
});

// ── 9. Failed siblings: explicit retry without replaying ready items ────────

test('9: a failed sibling is retried alone; ready siblings are never replayed, even when every id is passed', async () => {
  const photos = {
    ...PHOTOS,
    [URI[1]]: { garments: [garment('g1', 'dress', 'midi', { bare: true })] },
  };
  let failOnce = true;
  const { m, store, queue } = await openSession({
    photos,
    respond: (request) => {
      if (request.mode === 'selected_item' && request.uri === URI[1] && failOnce) { failOnce = false; return { __error: new Error('HTTP 502') }; }
      return undefined;
    },
  });
  await queue().runBatchQueue();
  assert.deepEqual(readyIds(store), ['asset-0:g1', 'asset-2:g1']);
  assert.equal(store.state.batchItemStates['asset-1:g1'], 'failed');
  assert.equal(m.edge.selected.length, 3);

  await queue().runBatchQueue(IDS);
  assert.equal(m.edge.selected.length, 4, 'only the failed item is dispatched again');
  assert.equal(m.edge.selected.at(-1).uri, URI[1]);
  assert.deepEqual(readyIds(store).sort(), [...IDS].sort());
  assert.equal(store.state.batchItems.length, 3, 'no sibling is duplicated');
  m.unmount();
});

test('9: retrying a PARTIAL item replaces it in place with the complete result and spends one call', async () => {
  let failOnce = true;
  const { m, store, queue } = await openSession({
    respond: (request) => {
      if (request.mode === 'selected_item' && request.uri === URI[1] && failOnce) { failOnce = false; return { __error: new Error('HTTP 502') }; }
      return undefined;
    },
  });
  await queue().runBatchQueue();
  const before = store.state.batchItems.map((item) => [item.id, item.detailStatus]);
  assert.deepEqual(before, [['asset-0:g1', 'complete'], ['asset-1:g1', 'partial'], ['asset-2:g1', 'complete']]);
  await queue().runBatchQueue(['asset-1:g1']);
  assert.deepEqual(store.state.batchItems.map((item) => [item.id, item.detailStatus]), [
    ['asset-0:g1', 'complete'], ['asset-1:g1', 'complete'], ['asset-2:g1', 'complete'],
  ]);
  assert.equal(m.edge.selected.length, 4);
  m.unmount();
});

// ── 11. Cancellation / new session ──────────────────────────────────────────

test('11: a new scan session during processing makes every late result inert', async () => {
  const gate = deferred();
  const { m, store, queue } = await openSession();
  m.edge.respond = (request) => (request.mode === 'selected_item' && request.uri === URI[0] ? gate.promise.then(() => undefined) : undefined);
  const running = queue().runBatchQueue();
  await m.idle(3);
  assert.equal(store.state.batchQueueActive, true);
  store.refs.batchGenerationRef.current += 1; // what the session-reset effect does
  gate.resolve();
  await running;
  assert.deepEqual(store.state.batchItems, [], 'a superseded session publishes nothing');
  assert.deepEqual(store.state.batchItemStates, { 'asset-0:g1': 'analyzing', 'asset-1:g1': 'queued', 'asset-2:g1': 'queued' },
    'no late event rewrites state of the new session');
  m.unmount();
});

test('11: leaving the screen mid-queue stops dispatch; nothing is published afterwards', async () => {
  const gate = deferred();
  const { m, store, queue } = await openSession();
  m.edge.respond = (request) => (request.mode === 'selected_item' && request.uri === URI[1] ? gate.promise.then(() => undefined) : undefined);
  const running = queue().runBatchQueue();
  await m.idle(3);
  const published = readyIds(store);
  m.unmount();
  gate.resolve();
  await running;
  assert.equal(m.edge.selected.length, 2, 'the third item is never dispatched');
  assert.deepEqual(readyIds(store), published, 'no item appears after the screen is gone');
  m.unmount();
});

// ── 19. Account switching ───────────────────────────────────────────────────

test('19: an account switch mid-queue publishes nothing to the new account and blocks every further run', async () => {
  const gate = deferred();
  const { m, store, queue } = await openSession();
  m.edge.respond = (request) => (request.mode === 'selected_item' && request.uri === URI[0] ? gate.promise.then(() => undefined) : undefined);
  const running = queue().runBatchQueue();
  await m.idle(3);
  m.actor.advanceActorEpoch('actor-b');
  gate.resolve();
  await running;
  assert.deepEqual(store.state.batchItems, []);
  const dispatched = m.edge.selected.length;
  await queue().runBatchQueue();
  assert.equal(m.edge.selected.length, dispatched, 'actor B cannot continue actor A\'s queue');
  m.unmount();
});

// ── 20. Offline ─────────────────────────────────────────────────────────────

test('20: losing the connection mid-queue leaves retryable items, a released lock and no spinner', async () => {
  let online = true;
  const { m, store, queue } = await openSession({
    respond: (request) => (request.mode === 'selected_item' && request.uri !== URI[0] && !online ? { __error: new Error('offline') } : undefined),
  });
  await queue().runBatchQueue(['asset-0:g1']);
  online = false;
  await queue().runBatchQueue(['asset-1:g1', 'asset-2:g1']);
  assert.equal(store.state.batchQueueActive, false);
  assert.equal(store.refs.batchQueueLockRef.current, false);
  assert.deepEqual(store.state.batchItems.map((item) => item.detailStatus), ['complete', 'partial', 'partial']);
  online = true;
  await queue().runBatchQueue(['asset-1:g1', 'asset-2:g1']);
  assert.deepEqual(store.state.batchItems.map((item) => item.detailStatus), ['complete', 'complete', 'complete']);
  m.unmount();
});

// ── Session boundary (new batch vs benign re-render) ────────────────────────

function runResetEffect(store, { eligible, key, actor }) {
  const setters = store.setters;
  let cleanup;
  const scope = {
    useEffect: (callback) => { cleanup = callback(); },
    eligibleBatchSession: eligible,
    batchSessionKey: key,
    createActorRequest: actor.createActorRequest,
    Date,
    ...store.refs,
    ...setters,
  };
  evaluate(RESET_SRC, scope);
  return cleanup;
}

test('session boundary: a new batch resets everything; the same batch re-rendering with enriched analysis does not', async () => {
  const { m, store } = await openSession();
  const generation0 = store.refs.batchGenerationRef.current;
  store.refs.batchActorRequestRef.current = null;

  runResetEffect(store, { eligible: true, key: 'batch-1', actor: m.actor });
  const generation1 = store.refs.batchGenerationRef.current;
  assert.equal(generation1, generation0 + 1);
  assert.ok(m.actor.isActorRequestCurrent(store.refs.batchActorRequestRef.current), 'a fresh actor request is captured');

  store.state.batchItems = [{ id: 'x' }];
  store.state.savedBatchScanIds = { x: 'saved-x' };
  runResetEffect(store, { eligible: true, key: 'batch-1', actor: m.actor });
  assert.equal(store.refs.batchGenerationRef.current, generation1, 'same key: no reset');
  assert.deepEqual(store.state.batchItems, [{ id: 'x' }]);

  runResetEffect(store, { eligible: true, key: 'batch-2', actor: m.actor });
  assert.equal(store.refs.batchGenerationRef.current, generation1 + 1);
  assert.deepEqual(store.state.batchItems, []);
  assert.deepEqual(store.state.savedBatchScanIds, {});

  store.state.batchItems = [{ id: 'y' }];
  store.refs.batchQueueLockRef.current = true;
  runResetEffect(store, { eligible: false, key: null, actor: m.actor });
  assert.deepEqual(store.state.batchItems, [], 'leaving the batch path clears it');
  assert.equal(store.refs.batchQueueLockRef.current, false, 'and releases the queue lock');
  assert.equal(store.refs.batchActorRequestRef.current, null);
  m.unmount();
});

// ── 13. Source-image switching: what the result surface shows for the active item ──

test('13: the displayed analysis, photo and source follow the active item and fall back to the first ready item', async () => {
  const { m, store, queue } = await openSession();
  await queue().runBatchQueue();
  const project = (selectedItemId) => evaluate(PROJECTION_SRC, {
    MULTI_IMAGE_SCANNER_ENABLED: true,
    status: m.hook.status,
    analysis: m.hook.analysis,
    selectedImages: m.hook.selectedImages,
    photo: m.hook.photo,
    selectedCandidateId: m.hook.selectedCandidateId ?? null,
    batchItems: store.state.batchItems,
    batchSelectedItemId: selectedItemId,
    batchSelectedCandidateIds: store.state.batchSelectedCandidateIds,
    batchItemStates: store.state.batchItemStates,
    savedBatchScanIds: { 'asset-2:g1': 'saved-c' },
  }, ['batchResultVisible', 'displayAnalysis', 'activeResultImageUri', 'activeResultSource', 'activeBatchSavedId', 'failedBatchCandidateIds']);

  for (const [id, uri] of [['asset-0:g1', URI[0]], ['asset-1:g1', URI[1]], ['asset-2:g1', URI[2]]]) {
    const view = project(id);
    assert.equal(view.batchResultVisible, true);
    assert.equal(view.activeResultImageUri, uri);
    assert.equal(view.displayAnalysis.result, `SEL|${uri}|g1`, 'the analysis shown is the one produced for this photo');
    assert.equal(view.activeResultSource, 'upload');
  }
  assert.equal(project('asset-2:g1').activeBatchSavedId, 'saved-c');
  assert.equal(project('asset-1:g1').activeBatchSavedId, null);
  const fallback = project('unknown-id');
  assert.equal(fallback.activeResultImageUri, URI[0], 'an unknown selection falls back to the first ready item');
  m.unmount();
});

// ── 14 / 15 / 16. Per-item persistence, reopening, Save All ─────────────────

function createMemoryFs() {
  const files = new Map();
  return {
    files,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) { return { exists: files.has(p) }; },
      async readAsStringAsync(p) { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
      async writeAsStringAsync(p, contents) { files.set(p, contents); },
      async moveAsync({ from, to }) { files.set(to, files.get(from) ?? `bytes(${from})`); files.delete(from); },
      async deleteAsync(p) { files.delete(p); },
    },
  };
}

function loadLibrary(actor) {
  const memfs = createMemoryFs();
  const compile = (rel) => ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, allowJs: true },
  }).outputText;
  const shim = (spec) => {
    if (spec === 'expo-file-system/legacy') return memfs.api;
    if (spec === 'expo-image-manipulator') {
      return { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async (uri) => ({ uri: `${uri}#tmp${Math.random()}` }) };
    }
    if (spec === './savedScansCloud') return { saveScanToCloud: async () => ({ ok: true }), softDeleteCloudSavedScan: async () => ({ ok: true }) };
    if (spec === './identificationSnapshot') {
      return {
        hydrateScanHistory: (raw, hydrateOne) => {
          const records = [];
          for (const record of Array.isArray(raw) ? raw : []) { const hydrated = hydrateOne(record); if (hydrated) records.push(hydrated); }
          return { records, corruptedCount: 0 };
        },
      };
    }
    if (spec === './dressingRoomCommerce') return { normalizePurchaseOptions: (v) => (Array.isArray(v) ? v.slice() : []) };
    if (spec === './actorContext') return actor;
    return {};
  };
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${compile('services/library.js')}\n})`, { filename: 'services/library.js' })(mod.exports, mod, shim);
  return { library: mod.exports, memfs };
}

function compilePersist(store, { m, library, selectedImages }) {
  return evaluate(PERSIST_SRC, {
    useCallback: (fn) => fn,
    isActorRequestCurrent: m.actor.isActorRequestCurrent,
    saveScan: library.saveScan,
    selectedImages,
    ...store.refs,
    ...store.setters,
    batchSelectedCandidateIds: store.state.batchSelectedCandidateIds,
    batchItems: store.state.batchItems,
    savedBatchScanIds: store.state.savedBatchScanIds,
  }, ['persistBatchItem', 'saveAllBatchItems']);
}

test('14/15/16: Save All writes one Recent Scan per item from the REAL hook output; each keeps its own photo, analysis and provenance when reopened', async () => {
  const { m, store, queue } = await openSession();
  await queue().runBatchQueue();
  const { library, memfs } = loadLibrary(m.actor);
  const save = () => compilePersist(store, { m, library, selectedImages: m.hook.selectedImages });

  await save().saveAllBatchItems();
  assert.deepEqual(Object.keys(store.state.savedBatchScanIds).sort(), [...IDS].sort());
  await save().saveAllBatchItems();
  const all = await library.loadLibrary('actor-a');
  assert.equal(all.length, 3, 'a second Save All writes nothing new');

  for (const [index, id] of IDS.entries()) {
    const item = store.state.batchItems.find((entry) => entry.id === id);
    const record = all.find((entry) => entry.id === store.state.savedBatchScanIds[id]);
    assert.ok(record, `${id} was saved`);
    assert.equal(record.result, `SEL|${item.sourceImageUri}|g1`, 'the saved analysis is the one produced for this item');
    assert.match(memfs.files.get(record.imageUri), new RegExp(item.sourceImageUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the saved media bytes belong to this item\'s own photo');
    assert.equal(record.metadata.multiScan.itemId, id);
    assert.equal(record.metadata.multiScan.sourceImageId, `asset-${index}`);
    assert.equal(record.metadata.multiScan.sourceImageIndex, index);
    assert.equal(record.metadata.multiScan.imageCount, 3);
    assert.equal(record.metadata.multiScan.itemCount, 3);
    assert.equal(record.metadata.multiScan.groupId, 'multi-test-1');
  }
  assert.equal(new Set(all.map((record) => record.imageUri)).size, 3, 'three distinct media files, not one aggregate');
  assert.deepEqual(await library.loadLibrary('actor-b'), [], 'another account never sees the items');
  m.unmount();
});

test('16: Save All after an account switch writes nothing for the new account', async () => {
  const { m, store, queue } = await openSession();
  await queue().runBatchQueue();
  const { library } = loadLibrary(m.actor);
  const persist = compilePersist(store, { m, library, selectedImages: m.hook.selectedImages });
  m.actor.advanceActorEpoch('actor-b');
  await persist.saveAllBatchItems();
  assert.deepEqual(store.state.savedBatchScanIds, {});
  assert.deepEqual(await library.loadLibrary('actor-b'), []);
  assert.deepEqual(await library.loadLibrary('actor-a'), []);
  m.unmount();
});

// ── 1 / 2 / 5 selected photos, end to end ───────────────────────────────────

for (const [label, photoCount, garmentsPerPhoto] of [
  ['1 photo with 2 garments', 1, 2],
  ['2 photos', 2, 1],
  ['5 photos', 5, 1],
]) {
  test(`1/2/5 end to end: ${label} -> detect, select all, process, Save All, reopen, Add All with every item on its own photo`, async () => {
    const photos = {};
    for (let index = 0; index < photoCount; index += 1) {
      photos[URI[index]] = {
        garments: Array.from({ length: garmentsPerPhoto }, (_, g) => garment(`g${g + 1}`, g === 0 ? 'coat' : 'shoes', `style-${index}-${g}`)),
      };
    }
    const { m, store, queue } = await openSession({ photos, count: photoCount });
    const ids = m.hook.analysis.confirmationCandidates.map((candidate) => candidate.id);
    const total = photoCount * garmentsPerPhoto;
    assert.equal(ids.length, total);
    store.state.batchSelectedCandidateIds = ids;

    await queue().runBatchQueue();
    assert.deepEqual(readyIds(store), ids, 'every selected item finished, in selection order');
    assert.equal(m.edge.selected.length, total, 'one selected-item call per item, none replayed');
    for (const item of store.state.batchItems) {
      assert.match(item.analysis.result, new RegExp(`^SEL\\|${item.sourceImageUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`));
    }
    assert.equal(new Set(store.state.batchItems.map((item) => item.sourceImageUri)).size, photoCount);

    const { library, memfs } = loadLibrary(m.actor);
    await compilePersist(store, { m, library, selectedImages: m.hook.selectedImages }).saveAllBatchItems();
    const reopened = await library.loadLibrary('actor-a');
    assert.equal(reopened.length, total, 'one Recent Scan per item, never one aggregate');
    for (const item of store.state.batchItems) {
      const record = reopened.find((entry) => entry.id === store.state.savedBatchScanIds[item.id]);
      assert.ok(record, `${item.id} reopened`);
      assert.equal(record.result, item.analysis.result);
      assert.ok(memfs.files.get(record.imageUri).includes(item.sourceImageUri), 'the saved media is this item\'s own photo');
      assert.equal(record.metadata.multiScan.itemId, item.id);
      assert.equal(record.metadata.multiScan.sourceImageIndex, item.sourceImageIndex);
      assert.equal(record.metadata.multiScan.imageCount, photoCount);
      assert.equal(record.metadata.multiScan.itemCount, total);
    }

    const active = store.state.batchItems[0];
    const { additionalScans } = evaluate(ADD_ALL_SRC, {
      addAllBatchToRoom: true, batchResultVisible: true, batchItems: store.state.batchItems, activeBatchItem: active,
    }, ['additionalScans']);
    assert.deepEqual(additionalScans.map((entry) => entry.scan.sourceId), ids.slice(1));
    assert.deepEqual(additionalScans.map((entry) => entry.localImageUri), store.state.batchItems.slice(1).map((item) => item.sourceImageUri));
    m.unmount();
  });
}

// ── DEFECT B35-SCAN-012: a partially analysed single item is not auto-saved ──

async function singleItemSession(failDetail) {
  // One photo keeps the server's own candidate ids (no per-image qualification).
  const { m, store, queue } = await openSession({
    count: 1,
    selected: ['g1'],
    respond: (request) => (failDetail && request.mode === 'selected_item' ? { __error: new Error('HTTP 502') } : undefined),
  });
  await queue().runBatchQueue();
  return { m, store };
}

function runAutoSave(store, persistCalls) {
  let effect;
  evaluate(AUTOSAVE_SRC, {
    useEffect: (callback) => { effect = callback; },
    eligibleBatchSession: true,
    batchQueueActive: false,
    batchSelectedCandidateIds: store.state.batchSelectedCandidateIds,
    batchItems: store.state.batchItems,
    persistBatchItem: (item) => { persistCalls.push(item.id); return Promise.resolve(null); },
    savedBatchScanIds: store.state.savedBatchScanIds,
  });
  effect();
}

test('DEFECT B35-SCAN-012: a single completely analysed item is saved automatically; a PARTIAL one waits for an explicit save or a successful retry', async () => {
  const complete = await singleItemSession(false);
  assert.equal(complete.store.state.batchItems[0].detailStatus, 'complete');
  const completeCalls = [];
  runAutoSave(complete.store, completeCalls);
  assert.deepEqual(completeCalls, ['g1']);
  complete.m.unmount();

  const partial = await singleItemSession(true);
  assert.equal(partial.store.state.batchItems[0].detailStatus, 'partial');
  const partialCalls = [];
  runAutoSave(partial.store, partialCalls);
  assert.deepEqual(partialCalls, [], 'a detection-only result must not be persisted as if it were the finished analysis');
  partial.m.unmount();
});

test('auto-save is for the one-item case only: two selected items are never saved without an explicit action', async () => {
  const { m, store, queue } = await openSession({ selected: IDS.slice(0, 2) });
  await queue().runBatchQueue();
  const calls = [];
  runAutoSave(store, calls);
  assert.deepEqual(calls, []);
  m.unmount();
});

test('NEGATIVE CONTROL B35-SCAN-012: without the completeness check a partial item is auto-saved', async () => {
  const { m, store } = await singleItemSession(true);
  const calls = [];
  let effect;
  const reverted = AUTOSAVE_SRC.replace("batchItems[0].detailStatus === 'partial' ||", '');
  assert.notEqual(reverted, AUTOSAVE_SRC, 'a negative control that rewrites nothing proves nothing');
  evaluate(reverted, {
    useEffect: (callback) => { effect = callback; },
    eligibleBatchSession: true,
    batchQueueActive: false,
    batchSelectedCandidateIds: store.state.batchSelectedCandidateIds,
    batchItems: store.state.batchItems,
    persistBatchItem: (item) => { calls.push(item.id); return Promise.resolve(null); },
    savedBatchScanIds: {},
  });
  effect();
  assert.deepEqual(calls, ['g1']);
  m.unmount();
});

// ── Static pin (not behaviour): the review surface is handed the detection notice ──

test('STATIC PIN: the candidate review receives the detection notice and the queue notice', () => {
  const review = region('candidateReview={eligibleBatchSession && !batchResultVisible ? {', '} : undefined}');
  assert.match(review, /detectionNotice: analysis\?\.detectionNotice \?\? null/);
  assert.match(review, /queueNotice: batchQueueNotice/);
});

// ── 17. Add All to Dressing Room: what the sheet is handed ──────────────────

test('17: Add All hands the sheet every other ready item with its OWN photo, analysis and id, in batch order', async () => {
  const { m, store, queue } = await openSession();
  await queue().runBatchQueue();
  const active = store.state.batchItems[1];
  const { additionalScans } = evaluate(ADD_ALL_SRC, {
    addAllBatchToRoom: true,
    batchResultVisible: true,
    batchItems: store.state.batchItems,
    activeBatchItem: active,
  }, ['additionalScans']);
  assert.deepEqual(additionalScans.map((entry) => entry.scan.sourceId), ['asset-0:g1', 'asset-2:g1'], 'the active item is the sheet\'s own scan, not repeated');
  assert.deepEqual(additionalScans.map((entry) => entry.localImageUri), [URI[0], URI[2]]);
  assert.deepEqual(additionalScans.map((entry) => entry.scan.result), [`SEL|${URI[0]}|g1`, `SEL|${URI[2]}|g1`]);
  assert.ok(additionalScans.every((entry) => entry.scan.sourceType === 'upload_inspiration'));

  const { additionalScans: off } = evaluate(ADD_ALL_SRC, {
    addAllBatchToRoom: false, batchResultVisible: true, batchItems: store.state.batchItems, activeBatchItem: active,
  }, ['additionalScans']);
  assert.deepEqual(off, [], 'a single-item add never carries siblings');
  m.unmount();
});

// ── 18. Elise handoff for the active item ───────────────────────────────────

function runEliseHandoff(store, m, itemIndex, { actorCurrent = true } = {}) {
  const handoffs = [];
  const pushed = [];
  const item = store.state.batchItems[itemIndex];
  const { askElise } = evaluate(ELISE_SRC, {
    styleChatEnabled: true,
    batchResultVisible: true,
    isActorRequestCurrent: () => actorCurrent,
    batchActorRequestRef: store.refs.batchActorRequestRef,
    activeResultSource: item.source,
    activeResultImageUri: item.sourceImageUri,
    displayAnalysis: item.analysis,
    setStyleChatHandoffContext: (context) => handoffs.push(context),
    router: { push: (route) => pushed.push(route) },
  }, ['askElise']);
  askElise();
  return { handoffs, pushed, item };
}

test('18: Ask Elise hands off the ACTIVE item\'s own photo and analysis, and refuses after an account switch', async () => {
  const { m, store, queue } = await openSession();
  await queue().runBatchQueue();
  for (const index of [0, 1, 2]) {
    const { handoffs, pushed, item } = runEliseHandoff(store, m, index);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].imageUri, item.sourceImageUri);
    assert.equal(handoffs[0].analysisText, item.analysis.result);
    assert.equal(handoffs[0].source, 'upload');
    assert.deepEqual(pushed, ['/style-chat']);
  }
  const stale = runEliseHandoff(store, m, 1, { actorCurrent: false });
  assert.deepEqual(stale.handoffs, [], 'a handoff queued for actor A is not delivered to actor B');
  assert.deepEqual(stale.pushed, []);
  m.unmount();
});
