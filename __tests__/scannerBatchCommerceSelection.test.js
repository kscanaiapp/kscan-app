const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule } = require('./helpers/componentRenderer');

const { hydrateSelectedBatchCommerce } = runModule(
  'services/batchCommerceSelection.js', {}, { jsx: false },
);

function item(id, tag = id) {
  return {
    id,
    sourceImageId: 'photo-' + tag,
    sourceImageUri: 'file:///private/' + tag + '.jpg',
    batchGeneration: 8,
    actorRequest: { actorId: 'a' },
    analysis: {
      commerceDeferred: true,
      commerceEvidence: { identification: { category: 'jacket', tag }, attributes: { color: tag } },
    },
  };
}
const gate = (fetchCommerce, overrides = {}) => ({ fetchCommerce, isCurrent: () => true, ...overrides });

test('B35-SCAN-014: 2 selected garments keep identity and image when MODE B resolves out of order', async () => {
  const calls = [];
  const resolvers = {};
  const fetchCommerce = (evidence) => {
    calls.push(evidence);
    return new Promise((resolve) => { resolvers[evidence.candidateId] = resolve; });
  };
  const first = hydrateSelectedBatchCommerce(item('coat', 'p1'), gate(fetchCommerce));
  const second = hydrateSelectedBatchCommerce(item('skirt', 'p2'), gate(fetchCommerce));
  assert.deepEqual(calls.map(x => x.candidateId), ['coat', 'skirt']);
  assert.deepEqual(calls.map(x => x.identification.tag), ['p1', 'p2']);
  assert.ok(calls.every(x => !JSON.stringify(x).includes('file:///') && !JSON.stringify(x).includes('base64')));
  resolvers.skirt({ status: 'success', candidateId: 'skirt', retryable: true, purchaseOptions: [{ title: 'skirt match' }] });
  resolvers.coat({ status: 'success', candidateId: 'coat', retryable: true, purchaseOptions: [{ title: 'coat match' }] });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.item.id, 'coat');
  assert.equal(b.item.id, 'skirt');
  assert.equal(a.item.sourceImageUri, 'file:///private/p1.jpg');
  assert.equal(b.item.sourceImageUri, 'file:///private/p2.jpg');
  assert.equal(a.item.analysis.purchaseOptions[0].title, 'coat match');
  assert.equal(b.item.analysis.purchaseOptions[0].title, 'skirt match');
});

test('B35-SCAN-014: unselected or incomplete evidence makes zero MODE B calls', async () => {
  let calls = 0;
  const f = async () => { calls += 1; return { status: 'success', purchaseOptions: [] }; };
  const result = await hydrateSelectedBatchCommerce(
    { ...item('not-selected'), analysis: { commerceDeferred: false } }, gate(f),
  );
  assert.equal(result.status, 'not_required');
  const missing = await hydrateSelectedBatchCommerce({ ...item('x'), analysis: { commerceDeferred: true } }, gate(f));
  assert.equal(missing.status, 'not_required');
  assert.equal(calls, 0);
});

test('B35-SCAN-014: account switch and superseded scan drop late offers', async () => {
  let resolve;
  let current = true;
  const task = hydrateSelectedBatchCommerce(
    item('jacket'), gate(() => new Promise(r => { resolve = r; }), { isCurrent: () => current }),
  );
  current = false;
  resolve({ status: 'success', purchaseOptions: [{ title: 'wrong account' }] });
  const result = await task;
  assert.equal(result.status, 'stale');
  assert.equal(result.item, undefined);
});

test('B35-SCAN-014: abort drops late answers and conflicting response candidate ids are rejected', async () => {
  const controller = new AbortController();
  let complete;
  const job = hydrateSelectedBatchCommerce(
    item('first'), gate(() => new Promise(r => { complete = r; }), { signal: controller.signal }),
  );
  controller.abort();
  complete({ status: 'success', purchaseOptions: [{ title: 'aborted' }] });
  assert.equal((await job).status, 'stale');
  const mismatch = await hydrateSelectedBatchCommerce(item('first'), gate(async () => ({
    status: 'success', candidateId: 'second', purchaseOptions: [{ title: 'other item' }],
  })));
  assert.equal(mismatch.status, 'error');
  assert.equal(mismatch.item, undefined);
});

test('B35-SCAN-014: transport failure keeps identification and returns retryable error', async () => {
  const before = item('coat');
  const failed = await hydrateSelectedBatchCommerce(before, gate(async () => { throw Error('provider'); }));
  assert.equal(failed.status, 'error');
  assert.equal(failed.retryable, true);
  assert.equal(before.analysis.purchaseOptions, undefined);
  const empty = await hydrateSelectedBatchCommerce(before, gate(async () => ({
    status: 'empty', candidateId: 'coat', purchaseOptions: [], retryable: true,
  })));
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.item.analysis.purchaseOptions, []);
});

test('B35-SCAN-014: three selected items of a five-photo capture cannot swap offers', async () => {
  const ids = ['j1', 'j2', 'j3'];
  const results = await Promise.all(ids.map((id, i) => hydrateSelectedBatchCommerce(
    item(id, 'photo-' + (i + 1)),
    gate(async (evidence) => ({
      status: 'success', candidateId: evidence.candidateId,
      purchaseOptions: [{ title: evidence.identification.tag + '-match' }],
    })),
  )));
  assert.deepEqual(results.map(r => r.item.analysis.purchaseOptions[0].title), [
    'photo-1-match', 'photo-2-match', 'photo-3-match',
  ]);
});

test('B35-SCAN-014: UI dispatches only selected batch items and persists late matches', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/componentRenderer');
  const hook = fs.readFileSync(path.join(ROOT, 'hooks/useKScan.js'), 'utf8');
  const screen = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(hook, /retryRequestModeRef\.current === 'multi_item_detection'[\s\S]*?return;/,
    'detection result must not fan out commerce over unselected candidates');
  assert.match(screen, /hydrateSelectedBatchCommerce\(item, \{/,
    'each selected item must use the actor/generation-gated commerce helper');
  assert.match(screen, /batchCommerceAttemptedRef\.current\.has\(flightKey\)/,
    'a rerender must not repeat provider calls for the same selected item');
  assert.match(screen, /attachedBatchPurchaseOptionsRef\.current\.has\(key\)/,
    'a late commerce result must be attached to an already-saved item at most once per shelf');
  assert.match(screen, /attachScanPurchaseOptions\(savedId, options, \{ actorRequest: item\.actorRequest \}\)/);
  assert.match(screen, /onRetryCommerce=\{batchResultVisible/,
    'the selected garment has an explicit commerce retry without rerunning identification');
});
