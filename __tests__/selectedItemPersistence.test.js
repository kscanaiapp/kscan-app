'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * A selected garment's result must still be SAVED WITH ITS OFFERS
 * (Production Scanner debugger, P-COM-2 follow-up found on the emulator).
 *
 * singleFlightCommerce.test.js proves a selected garment now sends ONE commerce
 * request. Before that, the saved Recent Scan for a single-photo scan only had
 * offers because of the DUPLICATE per-candidate request: the second multi-item save
 * (re-armed when the selected analysis starts, with the detection's candidates
 * restored) was fed its offers by that request. With the duplicate gone the saved
 * record reopened with "Shopping matches aren't shown here" although the live
 * screen had offers. The selected result is now saved through the single-item path
 * (saveScan + attachScanPurchaseOptions), which is what carries offers.
 *
 * The real effects are sliced out of app.js and executed.
 */

const APP = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function slice(startMarker, endMarker) {
  const start = APP.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = APP.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return APP.slice(start, end + endMarker.length);
}

const SINGLE_SAVE = () => slice(
  '  // Save each successful scan once to the local Style Library.',
  '  }, [status, photo, analysis]);',
);
const MULTI_SAVE = () => slice(
  '  // Build 32: save a multi-item detection result once.',
  '  }, [status, photo, analysis, selectedImages.length]);',
);

function harness({ mutate } = {}) {
  const calls = { single: [], multi: [], savedScanId: [], savedMultiId: [], toast: 0 };
  const effects = [];
  const context = {
    status: 'result',
    photo: { uri: 'file:///cache/photo.jpg', source: 'upload' },
    analysis: null,
    selectedImages: [{ id: 'image-0' }],
    hasSavedRef: { current: false },
    hasSavedMultiItemRef: { current: false },
    scanPersistenceGenerationRef: { current: 1 },
    createActorRequest: () => ({ actorId: 'a', epoch: 1, requestId: 'a-1' }),
    isActorRequestCurrent: () => true,
    saveScan: async (input) => { calls.single.push(input); return { id: `scan_${calls.single.length}` }; },
    saveMultiItemScan: async (input) => { calls.multi.push(input); return { id: `multi_${calls.multi.length}` }; },
    setSavedScanId: (id) => calls.savedScanId.push(id),
    setSavedMultiItemScanId: (id) => calls.savedMultiId.push(id),
    setSavedToast: () => { calls.toast += 1; },
    useEffect: (effect) => effects.push(effect),
  };
  vm.createContext(context);
  let singleSource = SINGLE_SAVE();
  let multiSource = MULTI_SAVE();
  if (mutate) {
    const mutated = mutate({ singleSource, multiSource });
    singleSource = mutated.singleSource;
    multiSource = mutated.multiSource;
  }
  vm.runInContext(`${singleSource}\n${multiSource}`, context);
  assert.equal(effects.length, 2, 'both save effects were registered');
  const [runSingle, runMulti] = effects;
  const run = async () => {
    runSingle();
    runMulti();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  // The 'processing' branch re-arms both saves when a new analysis starts.
  const rearm = () => {
    context.hasSavedRef.current = false;
    context.hasSavedMultiItemRef.current = false;
  };
  return { context, calls, run, rearm };
}

const CANDIDATES = [{ id: 'g1', label: 'low-top sneaker' }];
const DETECTION = () => ({ result: 'detected', confirmationCandidates: CANDIDATES, commerceDeferred: true });
const SELECTED = () => ({
  result: 'Red low-top sneaker', metadata: { category: 'footwear' }, confirmationCandidates: CANDIDATES,
  commerceDeferred: true, selectedItemResult: true,
});

test('a detection result is saved once as a multi-item record, never as a single item', async () => {
  const h = harness();
  h.context.analysis = DETECTION();
  await h.run();
  assert.equal(h.calls.multi.length, 1);
  assert.equal(h.calls.single.length, 0);
});

test('the SELECTED garment\'s result is saved through the single-item path, and not saved again as multi-item', async () => {
  const h = harness();
  h.context.analysis = DETECTION();
  await h.run();
  assert.equal(h.calls.multi.length, 1, 'detection record');

  h.rearm();                                  // selected-item analysis started
  h.context.analysis = SELECTED();
  await h.run();

  assert.equal(h.calls.single.length, 1, 'the selected result is saved as one item (this record carries its offers)');
  assert.equal(h.calls.single[0].analysis.selectedItemResult, true);
  assert.equal(h.calls.single[0].photoUri, 'file:///cache/photo.jpg');
  assert.equal(h.calls.multi.length, 1, 'no second multi-item record');
  assert.deepEqual(h.calls.savedScanId, ['scan_1'], 'the id the commerce-attach effect keys on is set');
});

test('the selected result is saved once even if the effect runs again before dismiss', async () => {
  const h = harness();
  h.context.analysis = SELECTED();
  await h.run();
  await h.run();
  assert.equal(h.calls.single.length, 1);
});

test('a plain single-item result (no candidates) is saved exactly as before', async () => {
  const h = harness();
  h.context.analysis = { result: 'plain', metadata: { category: 'tops' } };
  await h.run();
  assert.equal(h.calls.single.length, 1);
  assert.equal(h.calls.multi.length, 0);
});

test('multi-photo batches still do not write the detection-time record', async () => {
  const h = harness();
  h.context.selectedImages = [{ id: 'a' }, { id: 'b' }];
  h.context.analysis = DETECTION();
  await h.run();
  assert.equal(h.calls.multi.length, 0);
  assert.equal(h.calls.single.length, 0);
});

test('NEGATIVE CONTROL: with the previous conditions the selected result is NOT saved with offers (multi-item record instead)', async () => {
  const h = harness({
    mutate: ({ singleSource, multiSource }) => {
      const a = singleSource.replace(
        '(analysis.confirmationCandidates?.length && !analysis.selectedItemResult) ||',
        'analysis.confirmationCandidates?.length ||',
      );
      const b = multiSource.replace('analysis.selectedItemResult ||', '');
      assert.notEqual(a, singleSource, 'the single-save condition was mutated');
      assert.notEqual(b, multiSource, 'the multi-save condition was mutated');
      return { singleSource: a, multiSource: b };
    },
  });
  h.context.analysis = DETECTION();
  await h.run();
  h.rearm();
  h.context.analysis = SELECTED();
  await h.run();
  assert.equal(h.calls.single.length, 0, 'previous behaviour: nothing carried the offers');
  assert.equal(h.calls.multi.length, 2, 'previous behaviour: a second multi-item record');
});

test('the commerce-attach effect keys on the single-item record id (so the saved record gets its offers)', () => {
  const attach = slice(
    '  const attachedCommerceRef = useRef(null);',
    '  }, [status, savedScanId, analysis]);',
  );
  assert.match(attach, /status !== 'result' \|\| !savedScanId/);
  assert.match(attach, /attachScanPurchaseOptions\(savedScanId, options, \{ actorRequest \}\)/);
});
