const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

function harness(save = async (input) => ({ id: input.analysis.multiScan.itemId })) {
  const calls = [];
  const notices = [];
  let current = true;
  let savedState = {};
  const actorRequest = { actorId: 'a', epoch: 1, requestId: 'a-1' };
  const items = ['first', 'second'].map((id, index) => ({
    id, sourceImageUri: `file:///${id}.jpg`, sourceImageId: `image-${index}`,
    sourceImageIndex: index, source: 'upload', analysis: { result: id }, actorRequest, batchGeneration: 1,
  }));
  const context = {
    useCallback: (callback) => callback,
    savedBatchScanIds: {}, batchSavingItemIdsRef: { current: new Set() },
    batchSavedIdsRef: { current: {} }, batchGenerationRef: { current: 1 },
    batchGroupIdRef: { current: 'batch-group' }, batchActorRequestRef: { current: actorRequest },
    isActorRequestCurrent: (request) => current && request === actorRequest,
    saveScan: async (input) => { calls.push(input); return save(input); },
    selectedImages: items, batchSelectedCandidateIds: items.map((item) => item.id), batchItems: items,
    setSavedBatchScanIds: (next) => { savedState = next(savedState); },
    setSavedToast: () => {}, setBatchQueueNotice: (message) => notices.push(message),
  };
  vm.createContext(context);
  const start = app.indexOf('const persistBatchItem = useCallback(');
  const middle = app.indexOf('\n  // B35-SCAN-014: hydrate MODE B', start);
  const saveAllStart = app.indexOf('const saveAllBatchItems = useCallback(', middle);
  const end = app.indexOf('\n  useEffect(() => () => {\n    batchGenerationRef', saveAllStart);
  assert.ok(start > 0 && middle > start && saveAllStart > middle && end > saveAllStart);
  // The intervening commerce effects have their own async tests. Keep the
  // original persistence/save callbacks under the exact existing harness.
  const persistence = app.slice(start, middle) + '\n' + app.slice(saveAllStart, end);
  vm.runInContext(persistence + '\nthis.persist = persistBatchItem; this.saveAll = saveAllBatchItems;', context);
  return { context, items, calls, notices, persist: context.persist, saveAll: context.saveAll,
    saved: () => savedState, switchActor: () => { current = false; } };
}

test('Save All calls the real per-item callback with correct media, snapshot and original actor', async () => {
  const h = harness();
  await h.saveAll();
  assert.deepEqual(h.calls.map((call) => call.photoUri), ['file:///first.jpg', 'file:///second.jpg']);
  assert.deepEqual(h.calls.map((call) => call.analysis.result), ['first', 'second']);
  assert.deepEqual(h.calls.map((call) => call.analysis.multiScan.sourceImageIndex), [0, 1]);
  assert.deepEqual(Object.keys(h.saved()), ['first', 'second']);
  await h.saveAll();
  assert.equal(h.calls.length, 2, 'saved IDs prevent repeats even before React rerenders');
});

test('saving twice while media persistence is pending spends only one write', async () => {
  let done;
  const pending = new Promise((resolve) => { done = resolve; });
  const h = harness(async () => pending);
  const first = h.persist(h.items[0]);
  assert.equal(await h.persist(h.items[0]), null);
  assert.equal(h.calls.length, 1);
  done({ id: 'saved-first' });
  await first;
});

test('actor switch in Save All prevents the remaining item and rejects the late saved ID', async () => {
  const h = harness(async () => { h.switchActor(); return { id: 'stale' }; });
  await h.saveAll();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(Object.keys(h.saved()), []);
});

test('save failures retain successful siblings and surface a retry notice', async () => {
  const h = harness(async (input) => input.analysis.result === 'first' ? null : { id: 'saved-second' });
  await h.saveAll();
  assert.deepEqual(Object.keys(h.saved()), ['second']);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /could not be saved/);
});

test('new session or unmount invalidates pending save presentation', async () => {
  const h = harness(async () => { h.context.batchGenerationRef.current += 1; return { id: 'old' }; });
  await h.persist(h.items[0]);
  assert.deepEqual(Object.keys(h.saved()), []);
  await h.persist(h.items[1]);
  assert.equal(h.calls.length, 1, 'a pending Save All cannot persist siblings from a superseded session');
});

test('restored result actions render the active item and keep aggregate batch saving closed', () => {
  assert.match(app, /analysis=\{displayAnalysis\}/);
  assert.match(app, /candidateReview=\{eligibleBatchSession && !batchResultVisible/);
  assert.match(app, /multiItem=\{batchResultVisible/);
  assert.match(app, /analysisText: displayAnalysis\?\.result/);
  assert.match(app, /additionalScans=\{addAllBatchToRoom && batchResultVisible/);
  const aggregate = app.slice(app.indexOf('// Build 32: save a multi-item detection result once'), app.indexOf('// Build 32: attach multi-item commerce once hydration completes.'));
  assert.match(aggregate, /selectedImages\.length > 1/);
});

test('deliberate queue activates for one-image multiple garments and 2/5 image batches, preserving one-item path', () => {
  const start = app.indexOf('const trueMultiPhotoSession =');
  const end = app.indexOf('\n\n', start);
  for (const [images, garments, expected] of [[1, 1, false], [1, 2, true], [2, 1, true], [5, 3, true]]) {
    const context = { MULTI_IMAGE_SCANNER_ENABLED: true, selectedImages: Array(images).fill({}),
      status: 'result', analysis: { confirmationCandidates: Array(garments).fill({}) } };
    vm.createContext(context);
    vm.runInContext(app.slice(start, end) + '\nthis.enabled = trueMultiPhotoSession;', context);
    assert.equal(context.enabled, expected, `${images} image(s), ${garments} garment(s)`);
  }
});
