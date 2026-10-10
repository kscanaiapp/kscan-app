'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deferred, readSource } = require('./helpers/componentRenderer');
const { mountUseKScan, detectionPayload, selectedPayload } = require('./helpers/scannerHookHarness');

/**
 * ONE commerce request per selected garment (Production Scanner debugger, P-COM-2).
 *
 * `analyzeSelectedCandidate` gives the selected garment's result the detection's
 * `confirmationCandidates` back so the item list stays on screen. Once the request
 * mode flips to `selected_item`, the multi-item hydration effect (written for the
 * legacy one-photo detection shelf) stopped holding off and read those candidates
 * as a fresh detection to fan out over, in parallel with the single-item
 * hydration that already covers the selected garment:
 *   - one selected garment => TWO commerce_only requests in the same second;
 *   - a photo with several garments => a request for EVERY candidate, including
 *     the ones the user did not select;
 *   - two shelves for one garment on the result screen.
 * Observed on an Android emulator as paired commerce_only rows in Production
 * telemetry. Every existing test missed it because the mini renderer only commits
 * the intermediate `processing` frame if the test renders during the request.
 */

const COMMERCE_DEFERRED = {
  provider: 'deferred', query: '', count: 0, providersTried: [], catalogCount: 0,
  similarityMatches: 0, commerceSkipped: true, deferred: true, funnelVersion: 'v127',
  reason: 'deferred_to_commerce_only_request',
};

const URI = 'file:///cache/outfit.jpg';
const SNEAKER = { candidateId: 'g1', category: 'footwear', subtype: 'low-top sneaker', label: 'low-top sneaker', color: 'red' };
const JACKET = { candidateId: 'g2', category: 'jackets', subtype: 'moto jacket', label: 'moto jacket', color: 'black' };

async function selectOneGarment({ garments, selectId = 'g1', hookMutate } = {}) {
  const calls = [];
  const selectedGate = deferred();
  const commerceGate = deferred();
  const photo = { garments };
  const m = mountUseKScan({
    photos: { [URI]: photo },
    ...(hookMutate ? { hookMutate } : {}),
    respond: async (request) => {
      if (request.mode === 'multi_item_detection') {
        return { data: { ...detectionPayload(photo, request.uri), commerce: COMMERCE_DEFERRED } };
      }
      if (request.mode === 'selected_item') {
        await selectedGate.promise;
        const garment = garments.find((entry) => entry.candidateId === request.candidateId);
        return { data: { ...selectedPayload(request.uri, request.candidateId, garment), commerce: COMMERCE_DEFERRED } };
      }
      return undefined;
    },
    stubs: {
      'services/commerceHydration': {
        fetchDeferredCommerce: async (_evidence, options) => {
          calls.push(options && options.enrich ? 'single+enrich' : 'single');
          await commerceGate.promise;
          return {
            status: 'success',
            purchaseOptions: [{ id: 'o1', title: 'offer', retailer: 'shop', productUrl: 'https://shop.test/1' }],
            enrichmentCandidates: [],
            retryable: false,
          };
        },
        mergeEnrichedOffers: (current) => current,
      },
      'services/multiItemCommerce': {
        fetchMultiItemCommerce: async (candidates) => {
          calls.push(`multi(${(candidates || []).map((c) => c.id).join(',')})`);
          await commerceGate.promise;
          return new Map();
        },
      },
    },
  });

  await m.selectPhotos([{ uri: URI, assetId: 'asset-0', type: 'image' }]);
  await m.analyze();
  await m.idle(6);
  assert.equal(m.hook.status, 'result', 'detection reached the confirmation step');
  assert.deepEqual(calls, [], 'a detection result dispatches nothing (multi-image Scanner)');

  await m.hook.selectConfirmationCandidate(selectId);
  await m.idle(4);
  const pending = m.hook.analyzeSelectedCandidate();
  // Commit the `processing` frame, exactly as a device does while the request is out.
  await m.idle(4);
  assert.equal(m.hook.status, 'processing');
  selectedGate.resolve();
  await pending;
  await m.idle(12);
  return { m, calls, release: () => commerceGate.resolve() };
}

test('one selected garment => exactly ONE commerce request, and the multi-item shelf is never dispatched', async () => {
  const { m, calls, release } = await selectOneGarment({ garments: [SNEAKER] });
  assert.equal(m.hook.status, 'result');
  assert.equal(m.hook.analysis.selectedItemResult, true, 'the result is marked as the selected garment\'s');
  assert.equal(m.hook.analysis.confirmationCandidates.length, 1, 'the item list is still shown');
  assert.deepEqual(calls, ['single']);
  assert.equal(m.hook.multiItemCommerceStatus, 'idle');
  assert.equal(m.hook.commerceStatus, 'pending');
  release();
  await m.idle(12);
  assert.equal(m.hook.commerceStatus, 'success');
  assert.deepEqual(calls, ['single'], 'nothing else is dispatched when the first request settles');
  m.unmount();
});

test('a photo with TWO garments: selecting one spends on that garment only, never on the unselected one', async () => {
  const { m, calls, release } = await selectOneGarment({ garments: [SNEAKER, JACKET], selectId: 'g1' });
  assert.equal(m.hook.analysis.confirmationCandidates.length, 2);
  assert.deepEqual(calls, ['single'], 'no request fans out over the unselected garment');
  release();
  await m.idle(8);
  assert.deepEqual(calls, ['single']);
  m.unmount();
});

test('an explicit user retry still issues its own single-item request (and still never the multi-item one)', async () => {
  const { m, calls, release } = await selectOneGarment({ garments: [SNEAKER] });
  release();
  await m.idle(12);
  m.hook.retryCommerce();
  await m.idle(12);
  assert.deepEqual(calls, ['single', 'single']);
  m.unmount();
});

test('NEGATIVE CONTROL: without the selected-item guard the pair of requests returns', async () => {
  const guard = 'if (analysis?.selectedItemResult) return;';
  const { m, calls } = await selectOneGarment({
    garments: [SNEAKER],
    hookMutate: (source) => {
      assert.ok(source.includes(guard), 'the guard exists to be removed');
      return source.replace(guard, '');
    },
  });
  assert.deepEqual([...calls].sort(), ['multi(g1)', 'single'], 'the pre-repair pair: one single-item + one multi-item request');
  m.unmount();
});

test('NEGATIVE CONTROL: with two garments the old code also spent on the one that was not selected', async () => {
  const guard = 'if (analysis?.selectedItemResult) return;';
  const { m, calls } = await selectOneGarment({
    garments: [SNEAKER, JACKET],
    hookMutate: (source) => source.replace(guard, ''),
  });
  assert.deepEqual([...calls].sort(), ['multi(g1,g2)', 'single']);
  m.unmount();
});

test('the screen shows one shelf for a selected garment: the per-candidate section is not rendered for it', () => {
  const source = readSource('components/scan-results/ScanResultV2.tsx');
  assert.match(source, /\{isConfirmationStep && !analysis\?\.selectedItemResult \? \(\s*<MultiItemCommerceSection/);
  const types = readSource('components/scan-results/types.ts');
  assert.match(types, /selectedItemResult\?: boolean;/);
});

test('the marker is set only on the selected garment\'s result', () => {
  const hook = readSource('hooks/useKScan.js');
  const matches = hook.match(/data\.selectedItemResult = true;/g) || [];
  assert.equal(matches.length, 1);
  const at = hook.indexOf('data.selectedItemResult = true;');
  const enclosing = hook.lastIndexOf('const analyzeSelectedCandidate = useCallback(', at);
  const next = hook.indexOf('const retake = useCallback(', at);
  assert.ok(enclosing !== -1 && next !== -1 && enclosing < at && at < next, 'set inside analyzeSelectedCandidate only');
});
