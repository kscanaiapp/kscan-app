'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const { mountUseKScan, detectionPayload } = require('./helpers/scannerHookHarness');

/**
 * P-ERR-1: the failed-analysis screen offered "Add Scan to Dressing Room" with no
 * analyzed item.
 *
 * When the selected garment's analysis fails, useKScan puts the detection result
 * back into `analysis` (Try Again resumes from it) and moves to `error`. The error
 * screen's "is there anything usable to save" guard only looked for a summary or a
 * category, both of which a detection result has, so the screen that had just said
 * the analysis failed also offered to add the scan to a Dressing Room, with the
 * detection's metadata standing in for a garment that was never analyzed.
 *
 * The hook is executed for real here (helpers/scannerHookHarness): the state the
 * predicate judges is the one the app actually produces, not a hand-built object.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP_SOURCE = read('app.js');
const HOOK_SOURCE = read('hooks/useKScan.js');

function loadHelper() {
  const output = ts.transpileModule(read('services/failedScanActions.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { exports: mod.exports, module: mod });
  return mod.exports;
}

const { hasUsableAnalyzedItem } = loadHelper();

/** The guard app.js used before this repair, kept verbatim as the negative control. */
function preRepairGuard(analysis) {
  return Boolean(
    analysis &&
      (analysis.result ||
        analysis.metadata?.category ||
        (Array.isArray(analysis.products) && analysis.products.length) ||
        analysis.type === 'non-fashion'),
  );
}

const URI = 'file:///cache/outfit.jpg';
const DRESS = { candidateId: 'g1', category: 'dresses', subtype: 'slip dress', label: 'slip dress', color: 'black' };

/** One photo, one garment, and a selected-item request that the test controls. */
async function mountWithSelectedItemOutcome(selectedOutcome) {
  const photo = { garments: [DRESS] };
  const m = mountUseKScan({
    photos: { [URI]: photo },
    respond: async (request) => {
      if (request.mode === 'multi_item_detection') return { data: detectionPayload(photo, request.uri) };
      if (request.mode === 'selected_item') return selectedOutcome(request);
      return undefined;
    },
  });
  await m.selectPhotos([{ uri: URI, assetId: 'asset-0', type: 'image' }]);
  await m.analyze();
  await m.idle(6);
  assert.equal(m.hook.status, 'result', 'detection reached the confirmation step');
  return m;
}

// ── The predicate ─────────────────────────────────────────────────────────────

test('nothing, and an empty object, are not a usable analyzed item', () => {
  for (const value of [null, undefined, {}, { metadata: {} }, { products: [] }, 'text', 0]) {
    assert.equal(hasUsableAnalyzedItem(value), false, JSON.stringify(value));
  }
});

test('an identified single item is usable', () => {
  assert.equal(hasUsableAnalyzedItem({ result: 'A black slip dress.' }), true);
  assert.equal(hasUsableAnalyzedItem({ metadata: { category: 'dresses' } }), true);
  assert.equal(hasUsableAnalyzedItem({ products: [{ id: 'p1' }] }), true);
});

test('a detection result (garments to choose from) is NOT an analyzed item', () => {
  const detection = {
    result: 'Identified a fashion item from your scan.',
    metadata: { category: 'dresses' },
    confirmationCandidates: [{ id: 'g1', label: 'slip dress' }],
  };
  assert.equal(hasUsableAnalyzedItem(detection), false);
  assert.equal(preRepairGuard(detection), true, 'negative control: the old guard accepted it');
});

test('the selected garment\'s own result is usable although it keeps the candidate list', () => {
  assert.equal(
    hasUsableAnalyzedItem({
      result: 'A black slip dress.',
      metadata: { category: 'dresses' },
      confirmationCandidates: [{ id: 'g1', label: 'slip dress' }],
      selectedItemResult: true,
    }),
    true,
  );
});

test('only an explicit selectedItemResult:true makes a candidate-carrying result an item', () => {
  for (const marker of [undefined, null, false, 'true', 1]) {
    assert.equal(
      hasUsableAnalyzedItem({
        result: 'x',
        confirmationCandidates: [{ id: 'g1' }],
        selectedItemResult: marker,
      }),
      false,
      `selectedItemResult=${JSON.stringify(marker)}`,
    );
  }
});

// ── The state the app really reaches ──────────────────────────────────────────

test('a failed selected-garment analysis leaves a state the screen must not offer to keep', async () => {
  const m = await mountWithSelectedItemOutcome(() => ({ __error: new Error('provider unavailable') }));
  await m.hook.analyzeSelectedCandidate('g1');
  await m.idle(8);

  assert.equal(m.hook.status, 'error');
  assert.equal(typeof m.hook.error, 'string');
  assert.ok(m.hook.photo?.uri, 'the photo is still there, which is what made the button reachable');
  // The detection result is back in `analysis`, with a category and a summary.
  assert.ok(m.hook.analysis, 'detection result restored for Try Again');
  assert.equal(m.hook.analysis.confirmationCandidates.length, 1);
  assert.notEqual(m.hook.analysis.selectedItemResult, true);

  assert.equal(preRepairGuard(m.hook.analysis), true, 'negative control: the old guard offered the action here');
  assert.equal(hasUsableAnalyzedItem(m.hook.analysis), false, 'no analyzed item => no Add Scan to Dressing Room');
  m.unmount();
});

test('a selected garment the backend calls non-fashion fails the same way', async () => {
  const m = await mountWithSelectedItemOutcome(() => ({ data: { status: 'non_fashion', userMessage: 'Not fashion.' } }));
  await m.hook.analyzeSelectedCandidate('g1');
  await m.idle(8);

  assert.equal(m.hook.status, 'error');
  assert.equal(hasUsableAnalyzedItem(m.hook.analysis), false);
  // The message names the two actions the failed screen actually has.
  assert.equal(m.hook.error, 'The selected garment could not be identified. Try again or retake the photo.');
  m.unmount();
});

test('a detection failure has no analysis at all, so nothing is offered either', async () => {
  const m = mountUseKScan({
    photos: {},
    respond: async () => ({ __error: new Error('offline') }),
  });
  await m.selectPhotos([{ uri: URI, assetId: 'asset-0', type: 'image' }]);
  await m.analyze();
  await m.idle(6);
  assert.equal(m.hook.status, 'error');
  assert.equal(m.hook.analysis, null);
  assert.equal(hasUsableAnalyzedItem(m.hook.analysis), false);
  m.unmount();
});

// ── Recovery still works ──────────────────────────────────────────────────────

test('Try Again re-runs the SAME garment once, and a success is a usable item again', async () => {
  let fail = true;
  const m = await mountWithSelectedItemOutcome((request) => (
    fail
      ? { __error: new Error('provider unavailable') }
      : {
        data: {
          status: 'completed',
          attributes: { category: 'dresses', colorPalette: ['black'] },
          identification: { visual_observation: `SEL|${request.uri}|${request.candidateId}` },
          recommendedProducts: [],
          userMessage: 'Identified a fashion item from your scan.',
        },
      }
  ));
  await m.hook.analyzeSelectedCandidate('g1');
  await m.idle(8);
  assert.equal(m.hook.status, 'error');
  assert.equal(m.edge.selected.length, 1);

  fail = false;
  m.hook.retry();
  await m.idle(16);

  assert.equal(m.edge.selected.length, 2, 'exactly one more selected-item request');
  assert.equal(m.edge.selected[1].candidateId, 'g1', 'for the same garment');
  assert.equal(m.edge.detection.length, 1, 'detection is not re-run');
  assert.equal(m.hook.status, 'result');
  assert.equal(m.hook.analysis.selectedItemResult, true);
  assert.equal(hasUsableAnalyzedItem(m.hook.analysis), true);
  m.unmount();
});

test('Retake leaves the failed screen for a clean start', async () => {
  const m = await mountWithSelectedItemOutcome(() => ({ __error: new Error('provider unavailable') }));
  await m.hook.analyzeSelectedCandidate('g1');
  await m.idle(8);
  assert.equal(m.hook.status, 'error');

  m.hook.retake();
  await m.idle(4);
  assert.equal(m.hook.status, 'idle');
  assert.equal(m.hook.photo, null);
  assert.equal(m.hook.analysis, null);
  assert.equal(m.hook.error, null);
  m.unmount();
});

// ── The screen uses the predicate, and keeps its recovery actions ─────────────

function errorBranch() {
  const start = APP_SOURCE.indexOf("if (status === 'error') {", APP_SOURCE.indexOf('const renderActionArea = () => {'));
  assert.ok(start > 0, 'error branch of renderActionArea is missing');
  return APP_SOURCE.slice(start, APP_SOURCE.indexOf('return <View style={styles.actionsContainer} />;', start));
}

test('the failed screen gates Add Scan to Dressing Room on the predicate', () => {
  assert.match(APP_SOURCE, /import \{ hasUsableAnalyzedItem \} from '\.\/services\/failedScanActions';/);
  const branch = errorBranch();
  assert.match(branch, /const hasUsableAnalysis = hasUsableAnalyzedItem\(analysis\);/);
  assert.match(
    branch,
    /\{photo\?\.uri && dressingRoomsEnabled && hasUsableAnalysis \? \(\s*<ActionButton\s*label="Add Scan to Dressing Room"/,
  );
  // No second, ungated copy of the action in this branch.
  assert.equal((branch.match(/Add Scan to Dressing Room/g) || []).length, 1);
});

test('the failed screen keeps exactly its two recovery actions, and nothing destructive', () => {
  const branch = errorBranch();
  assert.match(branch, /<ActionButton label="Try Again" onPress=\{retry\}/);
  assert.match(branch, /<ActionButton label="Retake Photo" onPress=\{retake\}/);
  assert.match(branch, /\{error \? <Text style=\{styles\.errorText\}>\{error\}<\/Text> : null\}/);
  const labels = [...branch.matchAll(/label="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['Add Scan to Dressing Room', 'Try Again', 'Retake Photo']);
  assert.doesNotMatch(branch, /delete|remove|discard/i);
});

test('the selected-garment failure message no longer points at an action the screen lacks', () => {
  assert.doesNotMatch(HOOK_SOURCE, /Please choose another item/);
  assert.match(HOOK_SOURCE, /'The selected garment could not be identified\. Try again or retake the photo\.'/);
});
