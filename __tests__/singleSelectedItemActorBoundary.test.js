'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deferred } = require('./helpers/componentRenderer');
const { mountUseKScan, detectionPayload, selectedPayload } = require('./helpers/scannerHookHarness');

/**
 * The single selected-garment path honours the actor boundary, like the other
 * two Scanner paths.
 *
 * Detection (`runAnalysis`) and the multi-item queue (`analyzeSelectedCandidates`)
 * both refuse to publish a result once the account that started the scan is no
 * longer the current one. The single-garment path (`analyzeSelectedCandidate`,
 * which is what a one-photo, one-garment scan uses with the multi-image Scanner
 * on) checked only that the operation was still the current one. Its result is
 * then saved by the screen under a freshly captured actor, so a late answer for
 * account A's garment would have been published to, and saved for, whoever is
 * signed in when it lands.
 *
 * Today the only ways off the analyzing screen unmount the hook, which already
 * discards the result, so this closes a missing safeguard rather than a path a
 * user is known to reach. It is the same guard its two siblings carry.
 */

const URI = 'file:///cache/outfit.jpg';
const DRESS = { candidateId: 'g1', category: 'dresses', subtype: 'slip dress', label: 'slip dress', color: 'black' };

async function detectedByActorA({ selectedGate, hookMutate } = {}) {
  const photo = { garments: [DRESS] };
  const m = mountUseKScan({
    photos: { [URI]: photo },
    ...(hookMutate ? { hookMutate } : {}),
    respond: async (request) => {
      if (request.mode === 'multi_item_detection') return { data: detectionPayload(photo, request.uri) };
      if (request.mode === 'selected_item') {
        if (selectedGate) await selectedGate.promise;
        return { data: selectedPayload(request.uri, request.candidateId, DRESS) };
      }
      return undefined;
    },
  });
  await m.selectPhotos([{ uri: URI, assetId: 'asset-0', type: 'image' }]);
  await m.analyze();
  await m.idle(6);
  assert.equal(m.hook.status, 'result', 'actor A reached the confirmation step');
  assert.equal(m.hook.analysis.confirmationCandidates.length, 1);
  return m;
}

test('control: with no account change the selected garment\'s result is published', async () => {
  const m = await detectedByActorA();
  await m.hook.analyzeSelectedCandidate('g1');
  await m.idle(8);
  assert.equal(m.hook.status, 'result');
  assert.equal(m.hook.analysis.selectedItemResult, true);
  assert.equal(m.edge.selected.length, 1);
  m.unmount();
});

test('an account switch DURING the selected-garment request discards the late result', async () => {
  const selectedGate = deferred();
  const m = await detectedByActorA({ selectedGate });

  const running = m.hook.analyzeSelectedCandidate('g1');
  await m.idle(4);
  assert.equal(m.hook.status, 'processing');
  assert.equal(m.edge.selected.length, 1);

  m.actor.advanceActorEpoch('actor-b');
  selectedGate.resolve();
  await running;
  await m.idle(8);

  assert.notEqual(m.hook.analysis?.selectedItemResult, true, 'actor A\'s garment must not become actor B\'s result');
  assert.notEqual(m.hook.status, 'result', 'nothing is published for the new account');
  assert.equal(m.hook.isAnalyzing, false, 'the in-flight guard is released');
  m.unmount();
});

test('an account switch BEFORE Find Matches spends nothing and says to start a new scan', async () => {
  const m = await detectedByActorA();
  m.actor.advanceActorEpoch('actor-b');

  await m.hook.analyzeSelectedCandidate('g1');
  await m.idle(8);

  assert.equal(m.edge.selected.length, 0, 'actor A\'s detection cannot be spent on by actor B');
  assert.equal(m.hook.status, 'error');
  assert.equal(m.hook.error, 'Please start a new scan for this account.');
  assert.equal(m.hook.isAnalyzing, false);
  m.unmount();
});

test('NEGATIVE CONTROL: without the actor check a late result is published to the new account', async () => {
  const selectedGate = deferred();
  const guard = '      if (!isOperationValid(operationId) || !isActorRequestCurrent(actorRequest)) return;\n\n      if (Array.isArray(initialAnalysis?.confirmationCandidates)) {';
  const m = await detectedByActorA({
    selectedGate,
    hookMutate: (source) => {
      assert.equal(source.split(guard).length, 2, 'the guard under test is not where this control expects it');
      return source.replace(guard, '      if (Array.isArray(initialAnalysis?.confirmationCandidates)) {');
    },
  });
  const running = m.hook.analyzeSelectedCandidate('g1');
  await m.idle(4);
  m.actor.advanceActorEpoch('actor-b');
  selectedGate.resolve();
  await running;
  await m.idle(8);
  assert.equal(m.hook.status, 'result');
  assert.equal(m.hook.analysis.selectedItemResult, true, 'the mutant publishes actor A\'s garment to actor B');
  m.unmount();
});
