'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deferred } = require('./helpers/componentRenderer');
const { mountUseKScan, detectionPayload, selectedPayload } = require('./helpers/scannerHookHarness');

/**
 * Scanner cancel / restart overlap: a canceled, timed-out or superseded analysis
 * must not repopulate results, change what is selectable, or cause a paid request.
 *
 * WHY THIS FILE EXISTS
 * The emulator campaign never exercised the overlap, and a negative-control pass
 * over hooks/useKScan.js (multi-image Scanner ON, the shipping configuration)
 * found that four of its stale-result checks could each be DELETED without any
 * existing test failing:
 *   - the two checks in finishAnalysis (detection result vs. a departed actor),
 *   - the post-settle check of a multi-photo detection,
 *   - the success-path and failure-path checks of the single selected garment.
 * The global guard (isOperationValid) was covered, which is why the suite looked
 * protected: delete everything and tests fail, delete one check and nothing does.
 *
 * Every scenario here runs the REAL hook (helpers/scannerHookHarness) and is
 * paired with a NEGATIVE CONTROL that removes exactly one check and shows the
 * bad outcome it prevents, so each check now has a test that depends on it.
 *
 * NOT PROVEN HERE: a physical device. Request timing, the native picker and real
 * provider latency are simulated. This is source-level evidence only.
 */

const URI = ['file:///cache/0.jpg', 'file:///cache/1.jpg'];
const garment = (candidateId, subtype) => ({ candidateId, category: 'coat', subtype, label: subtype, color: 'black' });
const TWO_PHOTOS = {
  [URI[0]]: { garments: [garment('g1', 'trench')] },
  [URI[1]]: { garments: [garment('g1', 'parka')] },
};
const asset = (uri, index) => ({ uri, assetId: `asset-${index}`, type: 'image' });

const TIMEOUT_COPY = 'Analysis is taking longer than expected. Please try again.';
const SHORT_BATCH_TIMEOUT = (source) => {
  const anchor = 'const MULTI_IMAGE_ATTEMPT_TIMEOUT_MS = 52_000;';
  assert.equal(source.split(anchor).length, 2, 'the batch timeout constant moved');
  return source.replace(anchor, 'const MULTI_IMAGE_ATTEMPT_TIMEOUT_MS = 60;');
};

/** Remove exactly one occurrence of `anchor`, or fail loudly if it is not there once. */
function removeOnce(source, anchor, replacement, label) {
  assert.equal(source.split(anchor).length, 2, `${label}: the guard under test is not where this control expects it`);
  return source.replace(anchor, replacement);
}

function recordingHaptics(log) {
  return {
    'services/haptics': {
      errorPulse() { log.push('errorPulse'); },
      softImpact() {},
      successPulse() { log.push('successPulse'); },
      warningPulse() {},
    },
  };
}

// ── 1. A multi-photo detection superseded by its own timeout ──────────────────

const POST_SETTLE_GUARD = '          if (!isOperationValid(operationId) || !isActorRequestCurrent(batchActorRequest)) return;\n\n          let baseAnalysis = null;';

async function partialBatchTimeout({ withoutPostSettleGuard = false } = {}) {
  const lateSecondPhoto = deferred();
  const haptics = [];
  const m = mountUseKScan({
    photos: TWO_PHOTOS,
    hookMutate: (source) => {
      const fast = SHORT_BATCH_TIMEOUT(source);
      return withoutPostSettleGuard
        ? removeOnce(fast, POST_SETTLE_GUARD, '          let baseAnalysis = null;', 'post-settle check')
        : fast;
    },
    // Photo 1 answers at once. Photo 2 stays open until the attempt times out.
    respond: (request) => (
      request.mode === 'multi_item_detection' && request.uri === URI[1]
        ? lateSecondPhoto.promise.then(() => undefined)
        : undefined
    ),
    stubs: recordingHaptics(haptics),
  });
  await m.selectPhotos(URI.map(asset));
  await m.hook.runAnalysis();
  await m.idle(10);
  return { m, haptics, lateSecondPhoto };
}

test('a batch detection that times out with one photo answered publishes nothing and leaves nothing selectable', async () => {
  const { m, haptics, lateSecondPhoto } = await partialBatchTimeout();

  assert.equal(m.hook.status, 'error');
  assert.equal(m.hook.error, TIMEOUT_COPY);
  assert.equal(m.hook.analysis, null);
  assert.equal(m.hook.selectedCandidateId, null, 'the superseded detection selected nothing');
  assert.equal(m.hook.isAnalyzing, false, 'the in-flight guard is released');
  assert.deepEqual(haptics, ['errorPulse'], 'one failure pulse, and no success pulse for the stale answer');
  assert.equal(m.edge.detection.length, 2);
  assert.equal(m.edge.detection[1].signal.aborted, true, 'the open request was aborted');

  // The UI reported a failure, so the answered photo must not be spendable.
  const queued = await m.hook.analyzeSelectedCandidates(['asset-0:g1'], () => {});
  assert.deepEqual(queued.items, []);
  assert.equal(m.edge.selected.length, 0, 'no paid selected-item request for a detection reported as failed');

  // The late answer for the abandoned request changes nothing.
  lateSecondPhoto.resolve();
  await m.idle(10);
  assert.equal(m.hook.status, 'error');
  assert.equal(m.hook.analysis, null);
  assert.equal(m.hook.selectedCandidateId, null);
  m.unmount();
});

test('NEGATIVE CONTROL: without the post-settle check, the timed-out detection becomes selectable and spends a request', async () => {
  const { m } = await partialBatchTimeout({ withoutPostSettleGuard: true });
  assert.equal(m.hook.status, 'error', 'the screen still says the scan failed');
  assert.equal(m.hook.selectedCandidateId, 'asset-0:g1', 'yet the stale detection selected a garment');
  const queued = await m.hook.analyzeSelectedCandidates(['asset-0:g1'], () => {});
  assert.equal(queued.items.length, 1);
  assert.equal(m.edge.selected.length, 1, 'and a paid request was spent on it');
  m.unmount();
});

// ── 2. Timeout, then restart: the restarted scan is entirely its own ──────────

test('restart after a timeout: the new scan\'s result is its own and the abandoned answer never lands on it', async () => {
  const firstAttemptSecondPhoto = deferred();
  let attempt = 0;
  const m = mountUseKScan({
    photos: TWO_PHOTOS,
    hookMutate: SHORT_BATCH_TIMEOUT,
    respond: (request) => {
      if (request.mode !== 'multi_item_detection') return undefined;
      if (request.uri === URI[0]) attempt += 1;
      // Attempt 1 leaves photo 2 open; attempt 2 answers both.
      return attempt === 1 && request.uri === URI[1]
        ? firstAttemptSecondPhoto.promise.then(() => undefined)
        : undefined;
    },
  });
  await m.selectPhotos(URI.map(asset));
  await m.hook.runAnalysis();
  await m.idle(10);
  assert.equal(m.hook.status, 'error');
  assert.equal(m.hook.error, TIMEOUT_COPY);

  // Restart: Try Again returns to the review, Analyze starts a new attempt.
  m.hook.retry();
  await m.idle(4);
  assert.equal(m.hook.status, 'preview');
  assert.equal(m.hook.selectedImages.length, 2, 'the selection survives the failure');
  await m.analyze();

  assert.equal(m.hook.status, 'result');
  const restarted = m.hook.analysis;
  assert.deepEqual(
    restarted.confirmationCandidates.map((candidate) => candidate.id),
    ['asset-0:g1', 'asset-1:g1'],
    'both photos, each bound to its own source image',
  );
  assert.deepEqual(restarted.confirmationCandidates.map((candidate) => candidate.sourceImageIndex), [0, 1]);
  assert.equal(m.edge.detection.length, 4, 'two requests per attempt, none replayed');

  // The first attempt's abandoned request finally settles, mid-result.
  firstAttemptSecondPhoto.resolve();
  await m.idle(12);
  assert.equal(m.hook.status, 'result');
  assert.equal(m.hook.analysis, restarted, 'the restarted result object is untouched');
  assert.equal(m.hook.selectedCandidateId, 'asset-0:g1');
  assert.equal(m.edge.detection.length, 4, 'nothing was re-dispatched');
  m.unmount();
});

// ── 3. A single-photo detection answered after the account changed ────────────

const DETECTION_STALE_GUARD = '        if (!isOperationValid(operationId) || !isActorRequestCurrent(scanActorRequest)) {';

async function singlePhotoAccountSwitch({ withoutDetectionGuards = false } = {}) {
  const gate = deferred();
  const haptics = [];
  const photo = TWO_PHOTOS[URI[0]];
  const m = mountUseKScan({
    photos: { [URI[0]]: photo },
    ...(withoutDetectionGuards
      ? {
        hookMutate: (source) => {
          assert.equal(source.split(DETECTION_STALE_GUARD).length, 3, 'finishAnalysis should carry exactly two stale-result checks');
          return source.split(DETECTION_STALE_GUARD).join('        if (false) {');
        },
      }
      : {}),
    respond: (request) => (request.mode === 'multi_item_detection' ? gate.promise.then(() => undefined) : undefined),
    stubs: recordingHaptics(haptics),
  });
  await m.selectPhotos([asset(URI[0], 0)]);
  const running = m.hook.runAnalysis();
  await m.idle(3);
  m.actor.advanceActorEpoch('actor-b');
  gate.resolve();
  await running;
  await m.idle(8);
  return { m, haptics };
}

test('a ONE-photo detection answered after an account switch publishes nothing for the new account', async () => {
  const { m, haptics } = await singlePhotoAccountSwitch();
  assert.equal(m.hook.analysis, null, 'account A\'s detection must not become account B\'s state');
  assert.notEqual(m.hook.status, 'result');
  assert.deepEqual(haptics, [], 'no success pulse for a result nobody is shown');
  assert.equal(m.hook.isAnalyzing, false, 'the in-flight guard is released');
  m.unmount();
});

test('NEGATIVE CONTROL: without finishAnalysis\'s checks the one-photo detection IS published to the new account', async () => {
  const { m, haptics } = await singlePhotoAccountSwitch({ withoutDetectionGuards: true });
  assert.equal(m.hook.status, 'result');
  assert.equal(m.hook.analysis.confirmationCandidates.length, 1);
  assert.deepEqual(haptics, ['successPulse']);
  m.unmount();
});

// ── 4. The single selected garment, answered after the screen was left ────────

const SELECTED_SUCCESS_GUARD = '      if (!isOperationValid(operationId) || !isActorRequestCurrent(actorRequest)) return;\n\n      if (Array.isArray(initialAnalysis?.confirmationCandidates)) {';
const SELECTED_FAILURE_GUARD = '    } catch (err) {\n      if (!isOperationValid(operationId) || !isActorRequestCurrent(actorRequest)) return;\n      errorPulse();\n      setAnalysis(initialAnalysis);';

async function leaveDuringSelectedItem({ outcome, hookMutate } = {}) {
  const gate = deferred();
  const haptics = [];
  const commerce = [];
  const photo = TWO_PHOTOS[URI[0]];
  const deferredCommerce = {
    provider: 'deferred', query: '', count: 0, providersTried: [], catalogCount: 0,
    similarityMatches: 0, commerceSkipped: true, deferred: true, funnelVersion: 'v127',
    reason: 'deferred_to_commerce_only_request',
  };
  const m = mountUseKScan({
    photos: { [URI[0]]: photo },
    ...(hookMutate ? { hookMutate } : {}),
    respond: async (request) => {
      if (request.mode === 'multi_item_detection') {
        return { data: { ...detectionPayload(photo, request.uri), commerce: deferredCommerce } };
      }
      if (request.mode === 'selected_item') {
        await gate.promise;
        return outcome === 'failure'
          ? { __error: new Error('provider unavailable') }
          : { data: { ...selectedPayload(request.uri, request.candidateId, photo.garments[0]), commerce: deferredCommerce } };
      }
      return undefined;
    },
    stubs: {
      ...recordingHaptics(haptics),
      'services/commerceHydration': {
        fetchDeferredCommerce: async () => {
          commerce.push('commerce_only');
          return { status: 'empty', purchaseOptions: [], enrichmentCandidates: [], retryable: false };
        },
        mergeEnrichedOffers: (current) => current,
      },
    },
  });
  await m.selectPhotos([asset(URI[0], 0)]);
  await m.analyze();
  await m.idle(6);
  assert.equal(m.hook.status, 'result');
  haptics.length = 0; // the detection's own success pulse is not under test

  const running = m.hook.analyzeSelectedCandidate('g1');
  await m.idle(4);
  assert.equal(m.hook.status, 'processing');
  const request = m.edge.selected[0];

  // The user leaves the screen (Home / back) while the request is out.
  m.unmount();
  assert.equal(request.signal.aborted, true, 'leaving aborts the selected-item request');

  // A transport that had already produced its answer still delivers it.
  gate.resolve();
  await running;
  await m.idle(8);
  return { m, haptics, commerce };
}

test('leaving during a selected-garment request: a late SUCCESS publishes nothing and starts no commerce', async () => {
  const { haptics, commerce } = await leaveDuringSelectedItem({ outcome: 'success' });
  assert.deepEqual(haptics, [], 'no success pulse after the screen is gone');
  assert.deepEqual(commerce, [], 'an obsolete result never triggers a commerce request');
});

test('leaving during a selected-garment request: a late FAILURE raises no error after the screen is gone', async () => {
  const { haptics, commerce } = await leaveDuringSelectedItem({ outcome: 'failure' });
  assert.deepEqual(haptics, [], 'no error pulse after the screen is gone');
  assert.deepEqual(commerce, []);
});

/**
 * The harness aborts an open request the moment its signal fires, exactly as
 * fetch does, so in the two tests above the late answer is an abort rejection and
 * it is the FAILURE-path check that drops it. The success-path check matters when
 * the answer was already produced before the abort; both controls below remove
 * one check and show the pulse it suppresses.
 */
test('NEGATIVE CONTROL: without the failure-path check, a request abandoned by leaving raises an error pulse', async () => {
  const { haptics } = await leaveDuringSelectedItem({
    outcome: 'success',
    hookMutate: (source) => removeOnce(
      source,
      SELECTED_FAILURE_GUARD,
      '    } catch (err) {\n      errorPulse();\n      setAnalysis(initialAnalysis);',
      'selected-item failure-path check',
    ),
  });
  assert.deepEqual(haptics, ['errorPulse']);
});

test('the success-path check is what stops an already-produced answer after the account changed', async () => {
  // Leaving aborts the request, so the success path cannot be reached that way.
  // An account change does not abort it: the answer arrives, and only this check
  // stands between it and the new account's screen.
  const gate = deferred();
  const photo = TWO_PHOTOS[URI[0]];
  const mount = (hookMutate) => mountUseKScan({
    photos: { [URI[0]]: photo },
    ...(hookMutate ? { hookMutate } : {}),
    respond: async (request) => {
      if (request.mode === 'selected_item') {
        await gate.promise;
        return { data: selectedPayload(request.uri, request.candidateId, photo.garments[0]) };
      }
      return undefined;
    },
  });
  const run = async (m) => {
    await m.selectPhotos([asset(URI[0], 0)]);
    await m.analyze();
    await m.idle(6);
    const running = m.hook.analyzeSelectedCandidate('g1');
    await m.idle(4);
    m.actor.advanceActorEpoch('actor-b');
    gate.resolve();
    await running;
    await m.idle(8);
  };

  const guarded = mount();
  await run(guarded);
  assert.notEqual(guarded.hook.analysis?.selectedItemResult, true);
  assert.notEqual(guarded.hook.status, 'result');
  guarded.unmount();

  const mutant = mount((source) => removeOnce(
    source,
    SELECTED_SUCCESS_GUARD,
    '      if (Array.isArray(initialAnalysis?.confirmationCandidates)) {',
    'selected-item success-path check',
  ));
  await run(mutant);
  assert.equal(mutant.hook.status, 'result', 'NEGATIVE CONTROL: the mutant publishes it');
  assert.equal(mutant.hook.analysis.selectedItemResult, true);
  mutant.unmount();
});

// ── 5. The queue must not report progress for a superseded run ────────────────

const PROGRESS_GUARD = "typeof onProgress === 'function' && isOperationValid(operationId) && isActorRequestCurrent(actorRequest)";

async function queueProgressAfterLeaving({ withoutProgressGuard = false } = {}) {
  const gate = deferred();
  const events = [];
  const m = mountUseKScan({
    photos: TWO_PHOTOS,
    ...(withoutProgressGuard
      ? { hookMutate: (source) => removeOnce(source, PROGRESS_GUARD, "typeof onProgress === 'function'", 'queue progress check') }
      : {}),
    respond: (request) => (request.mode === 'selected_item' ? gate.promise.then(() => undefined) : undefined),
  });
  await m.selectPhotos(URI.map(asset));
  await m.analyze();
  assert.equal(m.hook.status, 'result');

  const running = m.hook.analyzeSelectedCandidates(['asset-0:g1', 'asset-1:g1'], (event) => {
    events.push(`${event.candidateId}=${event.state}`);
  });
  await m.idle(3);
  assert.deepEqual(events, ['asset-0:g1=analyzing']);
  m.unmount();
  gate.resolve();
  const outcome = await running;
  await m.idle(6);
  return { events, outcome, m };
}

test('a queue abandoned by leaving the screen reports no further progress and dispatches nothing more', async () => {
  const { events, outcome, m } = await queueProgressAfterLeaving();
  assert.deepEqual(events, ['asset-0:g1=analyzing'], 'no ready / failed / analyzing event after the screen is gone');
  assert.equal(outcome.halted, 'superseded');
  assert.deepEqual(outcome.items, []);
  assert.equal(m.edge.selected.length, 1, 'the second garment is never dispatched');
});

test('NEGATIVE CONTROL: without the progress check alone, the abandoned queue is still stopped by the dispatch guard', async () => {
  // The progress check is defence in depth: with it removed, the superseded/actor
  // check that follows each response still halts the queue before any event is
  // emitted. Recorded so the redundancy is a known fact, not an assumption.
  const { events, outcome, m } = await queueProgressAfterLeaving({ withoutProgressGuard: true });
  assert.deepEqual(events, ['asset-0:g1=analyzing']);
  assert.equal(outcome.halted, 'superseded');
  assert.equal(m.edge.selected.length, 1);
});
