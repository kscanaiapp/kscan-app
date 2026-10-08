'use strict';

/**
 * Multi-image Scanner matrix, executed against the REAL hooks/useKScan.js and the
 * real Scanner service graph (transport, normaliser, adapter, mapper). Only the
 * device edges and the Supabase `scan-identify` invoke are simulated, and that
 * invoke returns RAW edge-function payloads so nothing between the hook and the
 * network is faked. See __tests__/helpers/scannerHookHarness.js.
 *
 * Matrix points covered here (the numbers are the Build 35 certification points):
 *   1 ordered selection          2 add/remove            3 duplicate photos
 *   4 invalid images             5 mixed fashion         6 several garments/photo
 *   7 independent processing     8 evidence binding      9 partial failure
 *   10 rate limit + resume      11 cancellation         12 rapid taps
 *   13 source-image provenance  19 account switching    20 offline
 *
 * Titles starting with DEFECT name the repairs made by this lane; each was
 * written first and observed failing against the unrepaired code.
 *
 * Not provable here (device only): native picker ordering, real HEIC/EXIF
 * handling, real provider behaviour, real network loss timing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { deferred } = require('./helpers/componentRenderer');
const { mountUseKScan, rateLimitedPayload } = require('./helpers/scannerHookHarness');

const URI = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `file:///cache/${name}.jpg`);
const NETWORK_COPY = "We couldn't connect to the analysis service. Please check your connection and try again.";

const garment = (candidateId, category, subtype, color = 'black') => ({
  candidateId, category, subtype, label: `${color} ${subtype}`, color,
});
const asset = (uri, index) => ({ uri, assetId: `asset-${index}`, type: 'image' });

function photosOf(map) {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [URI[key], value]));
}

const THREE_PHOTOS = {
  0: { garments: [garment('g1', 'coat', 'trench', 'tan'), garment('g2', 'shoes', 'boot')] },
  1: { garments: [garment('g1', 'dress', 'midi', 'red')] },
  2: { garments: [garment('g1', 'bag', 'tote', 'brown')] },
};

async function analyzed(photos, count, options = {}) {
  const m = mountUseKScan({ photos: photosOf(photos), ...options });
  await m.selectPhotos(URI.slice(0, count).map(asset));
  await m.analyze();
  return m;
}

const candidateIds = (m) => m.hook.analysis.confirmationCandidates.map((candidate) => candidate.id);

// ── 1. Ordered selection of 1, 2 and 5 photos ───────────────────────────────

for (const count of [1, 2, 5]) {
  test(`1: ${count} selected photo(s) keep picker order and dispatch nothing before the explicit analyze tap`, async () => {
    const m = mountUseKScan({ photos: {} });
    await m.selectPhotos(URI.slice(0, count).map(asset));
    assert.equal(m.hook.status, 'preview');
    assert.deepEqual(m.hook.selectedImages.map((image) => image.uri), URI.slice(0, count));
    assert.deepEqual(m.hook.selectedImages.map((image) => image.originalIndex), [...Array(count).keys()]);
    assert.equal(m.hook.photo.uri, URI[0], 'the first picked photo is the primary photo');
    assert.deepEqual(
      { ...m.picker.launches[0] },
      { mediaTypes: ['images'], quality: 1, allowsEditing: false, allowsMultipleSelection: true, selectionLimit: 5, orderedSelection: true },
    );
    assert.equal(m.edge.requests.length, 0, 'selecting photos never spends a provider call');
    m.unmount();
  });
}

// ── 2. Add and remove photos ────────────────────────────────────────────────

test('2: adding photos appends in order within the remaining limit; removing re-indexes; removing all returns to idle', async () => {
  const m = mountUseKScan({ photos: {} });
  await m.selectPhotos([asset(URI[0], 0), asset(URI[1], 1)]);
  await m.addPhotos([asset(URI[2], 2), asset(URI[3], 3)]);
  assert.deepEqual(m.hook.selectedImages.map((image) => image.uri), URI.slice(0, 4));
  assert.equal(m.picker.launches[1].selectionLimit, 3, 'the picker may only offer the remaining slots');

  m.hook.removeSelectedImage(m.hook.selectedImages[1].id);
  await m.idle();
  assert.deepEqual(m.hook.selectedImages.map((image) => image.uri), [URI[0], URI[2], URI[3]]);
  assert.deepEqual(m.hook.selectedImages.map((image) => image.originalIndex), [0, 1, 2]);
  assert.equal(m.hook.status, 'preview');

  m.hook.removeSelectedImage(m.hook.selectedImages[0].id);
  await m.idle();
  assert.equal(m.hook.photo.uri, URI[2], 'removing the primary promotes the next photo');

  for (const image of [...m.hook.selectedImages]) {
    m.hook.removeSelectedImage(image.id);
    await m.idle();
  }
  assert.equal(m.hook.status, 'idle');
  assert.equal(m.hook.photo, null);
  assert.deepEqual(m.hook.selectedImages, []);
  m.unmount();
});

test('2: a sixth photo is refused explicitly and never truncates silently', async () => {
  const m = mountUseKScan({ photos: {} });
  await m.selectPhotos(URI.slice(0, 5).map(asset));
  await m.addPhotos([asset(URI[5], 5)]);
  assert.equal(m.hook.selectedImages.length, 5);
  assert.equal(m.hook.status, 'preview');
  assert.equal(m.alerts.length, 1);
  assert.equal(m.alerts[0][0], 'Maximum 5 Images');
  m.unmount();
});

// ── 3. Duplicate photos ─────────────────────────────────────────────────────

test('3: the same photo URI chosen twice is selected once and analysed once', async () => {
  const m = mountUseKScan({ photos: photosOf({ 0: THREE_PHOTOS[0], 1: THREE_PHOTOS[1] }) });
  await m.selectPhotos([asset(URI[0], 0), asset(URI[1], 1)]);
  await m.addPhotos([asset(URI[0], 0)]);
  assert.deepEqual(m.hook.selectedImages.map((image) => image.uri), [URI[0], URI[1]]);
  await m.analyze();
  assert.equal(m.edge.detection.length, 2);
  m.unmount();
});

test('DEFECT B35-SCAN-011: the same library asset picked twice (new cache copy, same assetId) is one image, never two with one id', async () => {
  const m = mountUseKScan({ photos: photosOf({ 0: THREE_PHOTOS[0], 1: THREE_PHOTOS[1] }) });
  await m.selectPhotos([asset(URI[0], 0), asset(URI[1], 1)]);
  // A second pick of the SAME library asset arrives as a different cache file.
  await m.addPhotos([{ uri: 'file:///cache/a-copy-2.jpg', assetId: 'asset-0', type: 'image' }]);
  const ids = m.hook.selectedImages.map((image) => image.id);
  assert.equal(new Set(ids).size, ids.length, 'image ids must be unique');
  assert.equal(m.hook.selectedImages.length, 2, 'a duplicate library asset must not become a second image');
  m.unmount();
});

// ── 4. Invalid / unsupported images ─────────────────────────────────────────

test('4: a video-only or malformed selection is rejected before any provider call', async () => {
  for (const assets of [[{ uri: 'file:///cache/v.mp4', type: 'video' }], [{ uri: '' }]]) {
    const m = mountUseKScan({ photos: {} });
    await m.selectPhotos(assets);
    assert.equal(m.hook.status, 'error');
    assert.equal(m.hook.error, 'Uploaded image could not be loaded.');
    assert.equal(m.edge.requests.length, 0);
    m.unmount();
  }
});

test('4: a video mixed into a photo selection is dropped and the photos are kept in order', async () => {
  const m = mountUseKScan({ photos: {} });
  await m.selectPhotos([asset(URI[0], 0), { uri: 'file:///cache/v.mp4', type: 'video' }, asset(URI[1], 1)]);
  assert.deepEqual(m.hook.selectedImages.map((image) => image.uri), [URI[0], URI[1]]);
  m.unmount();
});

test('4: an image that cannot be prepared fails the batch closed with ZERO provider calls and is recoverable by removing it', async () => {
  const m = mountUseKScan({ photos: photosOf(THREE_PHOTOS), compress: { [URI[1]]: true } });
  await m.selectPhotos(URI.slice(0, 3).map(asset));
  await m.analyze();
  assert.equal(m.hook.status, 'error');
  assert.equal(m.edge.requests.length, 0, 'no sibling may be spent before the bad image is found');
  assert.equal(m.hook.isAnalyzing, false, 'the in-flight guard is released');
  assert.equal(m.hook.selectedImages.length, 3, 'the user keeps the selection');

  m.hook.removeSelectedImage(m.hook.selectedImages[1].id);
  await m.idle();
  assert.equal(m.hook.status, 'preview');
  await m.analyze();
  assert.equal(m.hook.status, 'result');
  assert.deepEqual(candidateIds(m), ['asset-0:g1', 'asset-0:g2', 'asset-2:g1']);
  m.unmount();
});

// ── 5. Mixed fashion / non-fashion ──────────────────────────────────────────

test('5: a non-fashion photo among fashion photos yields only the fashion candidates with correct source indices', async () => {
  const m = await analyzed({ 0: THREE_PHOTOS[0], 1: { nonFashion: true }, 2: THREE_PHOTOS[2] }, 3);
  assert.equal(m.hook.status, 'result');
  assert.deepEqual(candidateIds(m), ['asset-0:g1', 'asset-0:g2', 'asset-2:g1']);
  assert.deepEqual(m.hook.analysis.confirmationCandidates.map((c) => c.sourceImageIndex), [0, 0, 2]);
  assert.equal(m.edge.detection.length, 3, 'every photo is analysed once');
  m.unmount();
});

test('5: when every photo is non-fashion the result is the graceful non-fashion state, not an error', async () => {
  const m = await analyzed({ 0: { nonFashion: true }, 1: { nonFashion: true } }, 2);
  assert.equal(m.hook.status, 'non-fashion');
  assert.equal(m.hook.analysis, null);
  assert.match(m.hook.nonFashionMessage, /No fashion items/);
  m.unmount();
});

// ── 6. Multiple garments per photo ──────────────────────────────────────────

test('6: one photo with several garments produces one candidate per garment, all bound to that photo', async () => {
  const m = await analyzed({ 0: { garments: [garment('g1', 'coat', 'trench'), garment('g2', 'shoes', 'boot'), garment('g3', 'bag', 'tote')] } }, 1);
  assert.equal(m.hook.status, 'result');
  assert.equal(m.hook.analysis.confirmationCandidates.length, 3);
  const out = await m.hook.analyzeSelectedCandidates(candidateIds(m), () => {});
  assert.deepEqual(out.items.map((item) => item.sourceImageUri), [URI[0], URI[0], URI[0]]);
  assert.deepEqual(m.edge.selected.map((request) => request.candidateId), ['g1', 'g2', 'g3']);
  assert.equal(new Set(m.edge.selected.map((request) => request.body.imageBase64)).size, 1, 'one photo, one evidence image');
  assert.equal(new Set(m.edge.selected.map((request) => request.body.imageDigestPrefix)).size, 1);
  m.unmount();
});

test('6: the global five-item bound keeps stable image/garment order and never invents candidates', async () => {
  const many = (prefix) => ({ garments: [1, 2, 3].map((n) => garment(`${prefix}${n}`, 'coat', `style-${n}`)) });
  const m = await analyzed({ 0: many('a'), 1: many('b'), 2: many('c') }, 3);
  assert.deepEqual(candidateIds(m), ['asset-0:a1', 'asset-0:a2', 'asset-0:a3', 'asset-1:b1', 'asset-1:b2']);
  m.unmount();
});

// ── 7. Independent image processing ─────────────────────────────────────────

test('7: every photo is its own request, in flight together, and the result order follows the photos, not completion order', async () => {
  const gates = new Map();
  const m = mountUseKScan({
    photos: photosOf(THREE_PHOTOS),
    respond: (request) => {
      if (request.mode !== 'multi_item_detection') return undefined;
      const gate = deferred();
      gates.set(request.uri, gate);
      return gate.promise.then(() => undefined);
    },
  });
  await m.selectPhotos(URI.slice(0, 3).map(asset));
  const running = m.hook.runAnalysis();
  await m.idle(4);
  assert.equal(m.edge.detection.length, 3, 'all three detections are dispatched before any completes');
  assert.equal(new Set(m.edge.detection.map((request) => request.body.imageBase64)).size, 3, 'one distinct evidence image per request');
  assert.ok(m.edge.detection.every((request) => typeof request.body.imageBase64 === 'string' && !Array.isArray(request.body.imageBase64)));
  assert.equal(new Set(m.edge.detection.map((request) => request.body.scanSessionId)).size, 3, 'one scan session per photo');
  for (const uri of [URI[2], URI[0], URI[1]]) gates.get(uri).resolve();
  await running;
  await m.idle();
  assert.deepEqual(candidateIds(m), ['asset-0:g1', 'asset-0:g2', 'asset-1:g1', 'asset-2:g1']);
  m.unmount();
});

// ── 8 / 13. Selected-item evidence binding and source-image provenance ───────

test('8/13: each selected garment is analysed against ITS OWN photo bytes, digest, session and server candidate id, even when server ids repeat', async () => {
  const m = await analyzed({ 0: THREE_PHOTOS[0], 1: THREE_PHOTOS[1], 2: THREE_PHOTOS[2] }, 3);
  const events = [];
  const out = await m.hook.analyzeSelectedCandidates(['asset-2:g1', 'asset-0:g2', 'asset-1:g1', 'asset-0:g1'], (e) => events.push(`${e.state}:${e.candidateId}`));

  assert.deepEqual(out.items.map((item) => item.id), ['asset-2:g1', 'asset-0:g2', 'asset-1:g1', 'asset-0:g1']);
  assert.deepEqual(out.items.map((item) => item.sourceImageUri), [URI[2], URI[0], URI[1], URI[0]]);
  assert.deepEqual(out.items.map((item) => item.sourceImageIndex), [2, 0, 1, 0]);
  assert.deepEqual(out.items.map((item) => item.sourceImageId), ['asset-2', 'asset-0', 'asset-1', 'asset-0']);
  // The analysis text embeds what the provider actually received: image + candidate.
  assert.deepEqual(out.items.map((item) => item.analysis.result), [
    `SEL|${URI[2]}|g1`, `SEL|${URI[0]}|g2`, `SEL|${URI[1]}|g1`, `SEL|${URI[0]}|g1`,
  ]);
  assert.deepEqual(m.edge.selected.map((request) => [request.uri, request.candidateId]), [
    [URI[2], 'g1'], [URI[0], 'g2'], [URI[1], 'g1'], [URI[0], 'g1'],
  ]);
  // Evidence continuity: the digest and session sent for an item are the ones detection used for that photo.
  for (const selected of m.edge.selected) {
    const detection = m.edge.detection.find((request) => request.uri === selected.uri);
    assert.equal(selected.body.imageDigestPrefix, detection.body.imageDigestPrefix);
    assert.equal(selected.body.scanSessionId, detection.body.scanSessionId);
    assert.equal(selected.body.imageBase64, detection.body.imageBase64);
  }
  assert.deepEqual(events.filter((entry) => entry.startsWith('ready')), [
    'ready:asset-2:g1', 'ready:asset-0:g2', 'ready:asset-1:g1', 'ready:asset-0:g1',
  ]);
  m.unmount();
});

test('8: a duplicate id in the selection dispatches once and an unknown id dispatches nothing', async () => {
  const m = await analyzed(THREE_PHOTOS, 3);
  const out = await m.hook.analyzeSelectedCandidates(['asset-1:g1', 'asset-1:g1', 'not-a-candidate'], () => {});
  assert.equal(out.items.length, 1);
  assert.equal(m.edge.selected.length, 1);
  m.unmount();
});

// ── 9. Partial backend failure ──────────────────────────────────────────────

test('9: a detection failure for one photo keeps the other photos usable', async () => {
  const m = await analyzed(THREE_PHOTOS, 3, {
    respond: (request) => (request.mode === 'multi_item_detection' && request.uri === URI[1] ? { __error: new Error('HTTP 500') } : undefined),
  });
  assert.equal(m.hook.status, 'result');
  assert.deepEqual(candidateIds(m), ['asset-0:g1', 'asset-0:g2', 'asset-2:g1']);
  m.unmount();
});

test('9: a selected-item provider failure leaves that item PARTIAL (genuine detection kept), siblings complete, and only that item is re-dispatched on retry', async () => {
  let failOnce = true;
  const m = await analyzed(THREE_PHOTOS, 3, {
    respond: (request) => {
      if (request.mode === 'selected_item' && request.uri === URI[1] && failOnce) {
        failOnce = false;
        return { __error: new Error('HTTP 502') };
      }
      return undefined;
    },
  });
  const states = [];
  const first = await m.hook.analyzeSelectedCandidates(['asset-0:g1', 'asset-1:g1', 'asset-2:g1'], (e) => states.push(`${e.candidateId}=${e.state}`));
  assert.deepEqual(first.items.map((item) => [item.id, item.detailStatus]), [
    ['asset-0:g1', 'complete'], ['asset-1:g1', 'partial'], ['asset-2:g1', 'complete'],
  ]);
  assert.equal(first.items[1].sourceImageUri, URI[1]);
  const before = m.edge.selected.length;
  const retry = await m.hook.analyzeSelectedCandidates(['asset-1:g1'], () => {});
  assert.equal(retry.items[0].detailStatus, 'complete');
  assert.equal(m.edge.selected.length, before + 1, 'retry spends exactly one more call');
  assert.equal(m.edge.selected.at(-1).uri, URI[1]);
  m.unmount();
});

// ── 10. Rate limiting and explicit resume (through the REAL transport) ──────

test('DEFECT B35-SCAN-010: a real edge rate_limited payload halts the queue, keeps finished items, spends no further call and resumes only the remainder', async () => {
  let quotaSpent = false;
  const m = await analyzed(THREE_PHOTOS, 3, {
    respond: (request) => {
      if (request.mode !== 'selected_item') return undefined;
      if (request.uri === URI[1] && !quotaSpent) { quotaSpent = true; return rateLimitedPayload(); }
      return undefined;
    },
  });
  const paused = await m.hook.analyzeSelectedCandidates(['asset-0:g1', 'asset-1:g1', 'asset-2:g1'], () => {});
  assert.equal(paused.halted, 'quota', 'the production transport must surface the quota halt');
  assert.deepEqual(paused.items.map((item) => item.id), ['asset-0:g1']);
  assert.deepEqual(Array.from(paused.remainingCandidateIds), ['asset-1:g1', 'asset-2:g1']);
  assert.match(paused.message, /Daily scan limit/);
  assert.equal(m.edge.selected.length, 2, 'nothing is dispatched after the quota is hit');

  const resumed = await m.hook.analyzeSelectedCandidates(paused.remainingCandidateIds, () => {});
  assert.deepEqual(resumed.items.map((item) => item.id), ['asset-1:g1', 'asset-2:g1']);
  assert.deepEqual(resumed.items.map((item) => item.detailStatus), ['complete', 'complete']);
  assert.equal(m.edge.selected.length, 4, 'the finished first item is never replayed');
  m.unmount();
});

test('DEFECT B35-SCAN-013: detection that hits the daily limit says so instead of blaming the photos', async () => {
  const m = await analyzed(THREE_PHOTOS, 2, { respond: (request) => (request.mode === 'multi_item_detection' ? rateLimitedPayload() : undefined) });
  assert.equal(m.hook.status, 'error');
  assert.match(m.hook.error, /Daily scan limit/);
  assert.doesNotMatch(m.hook.error, /clear fashion item/);
  assert.equal(m.hook.selectedImages.length, 2, 'the selection is kept for a later retry');
  m.unmount();
});

// ── 11. Cancellation during processing ──────────────────────────────────────

test('11: leaving the screen during detection aborts every in-flight request and publishes nothing', async () => {
  const gate = deferred();
  const m = mountUseKScan({
    photos: photosOf(THREE_PHOTOS),
    respond: (request) => (request.mode === 'multi_item_detection' ? gate.promise.then(() => undefined) : undefined),
  });
  await m.selectPhotos(URI.slice(0, 3).map(asset));
  const running = m.hook.runAnalysis();
  await m.idle(4);
  assert.equal(m.edge.detection.length, 3);
  m.unmount();
  assert.ok(m.edge.detection.every((request) => request.signal.aborted), 'unmount aborts all three requests');
  gate.resolve();
  await running;
  await m.idle();
  assert.equal(m.hook.status, 'processing', 'no result is published after the screen is gone');
  assert.equal(m.edge.selected.length, 0);
});

test('11: leaving the screen mid-queue stops the remaining dispatches and keeps the finished item only in the returned list', async () => {
  const m = await analyzed(THREE_PHOTOS, 3);
  const gate = deferred();
  m.edge.respond = (request) => (request.mode === 'selected_item' && request.uri === URI[1] ? gate.promise.then(() => undefined) : undefined);
  const events = [];
  const running = m.hook.analyzeSelectedCandidates(['asset-0:g1', 'asset-1:g1', 'asset-2:g1'], (e) => events.push(`${e.candidateId}=${e.state}`));
  await m.idle(4);
  m.unmount();
  gate.resolve();
  const out = await running;
  assert.equal(out.halted, 'superseded');
  assert.equal(m.edge.selected.length, 2, 'the third item is never dispatched');
  assert.ok(!events.includes('asset-1:g1=ready') && !events.includes('asset-2:g1=analyzing'), 'no late progress is published');
});

test('11: dismiss and retake are refused while the queue is running, so the queue cannot be torn out from under itself', async () => {
  const m = await analyzed(THREE_PHOTOS, 3);
  const gate = deferred();
  m.edge.respond = (request) => (request.mode === 'selected_item' ? gate.promise.then(() => undefined) : undefined);
  const running = m.hook.analyzeSelectedCandidates(['asset-0:g1'], () => {});
  await m.idle(4);
  m.hook.dismissResult();
  m.hook.retake();
  await m.idle();
  assert.equal(m.hook.status, 'result');
  assert.equal(m.hook.selectedImages.length, 3);
  gate.resolve();
  await running;
  m.unmount();
});

// ── 12. Rapid repeated taps ─────────────────────────────────────────────────

test('12: a double tap on Analyze spends exactly one detection batch', async () => {
  const m = mountUseKScan({ photos: photosOf(THREE_PHOTOS) });
  await m.selectPhotos(URI.slice(0, 3).map(asset));
  const first = m.hook.runAnalysis();
  const second = m.hook.runAnalysis();
  await Promise.all([first, second]);
  await m.idle();
  assert.equal(m.edge.detection.length, 3);
  m.unmount();
});

test('12: a second queue started while one is running is refused and spends nothing', async () => {
  const m = await analyzed(THREE_PHOTOS, 3);
  const gate = deferred();
  m.edge.respond = (request) => (request.mode === 'selected_item' ? gate.promise.then(() => undefined) : undefined);
  const first = m.hook.analyzeSelectedCandidates(['asset-0:g1', 'asset-1:g1'], () => {});
  await m.idle(3);
  const second = await m.hook.analyzeSelectedCandidates(['asset-2:g1'], () => {});
  assert.equal(second.halted, 'busy');
  assert.equal(m.edge.selected.length, 1);
  gate.resolve();
  await first;
  assert.equal(m.edge.selected.length, 2);
  m.unmount();
});

test('12: a double tap on Add image opens the picker once', async () => {
  const m = mountUseKScan({ photos: {} });
  await m.selectPhotos([asset(URI[0], 0)]);
  const slow = deferred();
  m.picker.queue.push(() => slow.promise);
  const first = m.hook.addGalleryPhotos();
  const second = m.hook.addGalleryPhotos();
  slow.resolve({ canceled: true });
  await Promise.all([first, second]);
  assert.equal(m.picker.launches.length, 2, 'initial selection + exactly one add');
  m.unmount();
});

// ── 19. Account switching during processing ─────────────────────────────────

test('19: an account switch during selected-item processing discards the late result and dispatches nothing further', async () => {
  const m = await analyzed(THREE_PHOTOS, 3);
  const gate = deferred();
  m.edge.respond = (request) => (request.mode === 'selected_item' && request.uri === URI[0] ? gate.promise.then(() => undefined) : undefined);
  const events = [];
  const running = m.hook.analyzeSelectedCandidates(['asset-0:g1', 'asset-1:g1'], (e) => events.push(`${e.candidateId}=${e.state}`));
  await m.idle(3);
  m.actor.advanceActorEpoch('actor-b');
  gate.resolve();
  const out = await running;
  assert.equal(out.halted, 'superseded');
  assert.deepEqual(out.items, []);
  assert.equal(m.edge.selected.length, 1);
  assert.ok(!events.some((entry) => entry.endsWith('=ready')), 'no actor-A item is announced to actor B');
  const again = await m.hook.analyzeSelectedCandidates(['asset-1:g1'], () => {});
  assert.equal(again.halted, 'actor_changed', 'a completed actor-A detection cannot be used by actor B');
  assert.equal(m.edge.selected.length, 1);
  m.unmount();
});

test('19: an account switch during detection publishes no result for the new account', async () => {
  const gate = deferred();
  const m = mountUseKScan({
    photos: photosOf(THREE_PHOTOS),
    respond: (request) => (request.mode === 'multi_item_detection' ? gate.promise.then(() => undefined) : undefined),
  });
  await m.selectPhotos(URI.slice(0, 2).map(asset));
  const running = m.hook.runAnalysis();
  await m.idle(3);
  m.actor.advanceActorEpoch('actor-b');
  gate.resolve();
  await running;
  await m.idle();
  assert.equal(m.hook.analysis, null, 'actor A detection must not become actor B state');
  assert.equal(m.hook.isAnalyzing, false, 'the in-flight guard is released');
  m.unmount();
});

// ── 20. Offline / network interruption ──────────────────────────────────────

test('DEFECT B35-SCAN-013: detection with no connection reports the real cause, keeps the selection and succeeds on retry', async () => {
  let online = false;
  const m = mountUseKScan({
    photos: photosOf(THREE_PHOTOS),
    respond: (request) => (!online ? { __error: new Error('Failed to send a request to the Edge Function') } : undefined),
  });
  await m.selectPhotos(URI.slice(0, 2).map(asset));
  await m.analyze();
  assert.equal(m.hook.status, 'error');
  assert.equal(m.hook.error, NETWORK_COPY);
  assert.equal(m.hook.isAnalyzing, false);
  assert.equal(m.hook.selectedImages.length, 2);

  online = true;
  m.hook.retry();
  await m.idle();
  assert.equal(m.hook.status, 'preview');
  await m.analyze();
  assert.equal(m.hook.status, 'result');
  assert.deepEqual(candidateIds(m), ['asset-0:g1', 'asset-0:g2', 'asset-1:g1']);
  m.unmount();
});

test('20: connection loss during the queue never hangs it: finished work stays, the rest are PARTIAL and retryable, the guard is released', async () => {
  const m = await analyzed(THREE_PHOTOS, 3);
  let online = true;
  m.edge.respond = (request) => {
    if (request.mode !== 'selected_item') return undefined;
    if (request.uri === URI[0]) return undefined;
    return online ? undefined : { __error: new Error('network request failed') };
  };
  const events = [];
  const first = m.hook.analyzeSelectedCandidates(['asset-0:g1'], () => {});
  await first;
  online = false;
  const out = await m.hook.analyzeSelectedCandidates(['asset-1:g1', 'asset-2:g1'], (e) => events.push(`${e.candidateId}=${e.state}`));
  assert.deepEqual(out.items.map((item) => item.detailStatus), ['partial', 'partial']);
  assert.deepEqual(out.items.map((item) => item.sourceImageUri), [URI[1], URI[2]]);
  assert.equal(m.hook.isAnalyzing, false);
  online = true;
  const healed = await m.hook.analyzeSelectedCandidates(['asset-1:g1', 'asset-2:g1'], () => {});
  assert.deepEqual(healed.items.map((item) => item.detailStatus), ['complete', 'complete']);
  m.unmount();
});

// ── Detection-stage truthfulness (B35-SCAN-013) ─────────────────────────────

test('DEFECT B35-SCAN-013: photos that failed, had no fashion items, or were cut by the five-item bound are named, not silently dropped', async () => {
  const failed = await analyzed(THREE_PHOTOS, 3, {
    respond: (request) => (request.mode === 'multi_item_detection' && request.uri === URI[1] ? { __error: new Error('HTTP 500') } : undefined),
  });
  assert.match(failed.hook.analysis.detectionNotice, /Photo 2/);
  assert.match(failed.hook.analysis.detectionNotice, /could not be analyzed/);
  failed.unmount();

  const nonFashion = await analyzed({ 0: THREE_PHOTOS[0], 1: { nonFashion: true }, 2: THREE_PHOTOS[2] }, 3);
  assert.match(nonFashion.hook.analysis.detectionNotice, /Photo 2/);
  assert.match(nonFashion.hook.analysis.detectionNotice, /no fashion items/i);
  nonFashion.unmount();

  const many = (prefix) => ({ garments: [1, 2, 3].map((n) => garment(`${prefix}${n}`, 'coat', `style-${n}`)) });
  const capped = await analyzed({ 0: many('a'), 1: many('b'), 2: many('c') }, 3);
  assert.match(capped.hook.analysis.detectionNotice, /first 5/);
  assert.match(capped.hook.analysis.detectionNotice, /4 more/);
  capped.unmount();

  const empty = await analyzed({ 0: { garments: [] }, 1: THREE_PHOTOS[1], 2: { garments: [] } }, 3);
  assert.match(empty.hook.analysis.detectionNotice, /Photos 1, 3 had no fashion items/);
  assert.deepEqual(candidateIds(empty), ['asset-1:g1'], 'the merged analysis is built from a photo that produced items');
  assert.equal(empty.hook.analysis.result, 'DET-TOP|file:///cache/b.jpg', 'an empty photo never becomes the base of the merged analysis');
  empty.unmount();

  const clean = await analyzed({ 0: THREE_PHOTOS[0], 1: THREE_PHOTOS[1] }, 2);
  assert.equal(clean.hook.analysis.detectionNotice ?? null, null, 'a fully successful batch carries no notice');
  clean.unmount();
});

// ── Negative controls: the repaired scenarios, run against the reverted code ──
// Each control rewrites ONE real module (the helper refuses a rewrite that
// changes nothing) and requires the repaired behaviour to disappear.

test('NEGATIVE CONTROL B35-SCAN-010: without the rateLimited flag the production transport hides the quota halt', async () => {
  let quotaSpent = false;
  const m = await analyzed(THREE_PHOTOS, 3, {
    mutate: {
      'services/scanIdentification.ts': (text) => text.replace("if (rawStatus === 'rate_limited') {", 'if (false) {'),
    },
    respond: (request) => {
      if (request.mode !== 'selected_item' || request.uri !== URI[1] || quotaSpent) return undefined;
      quotaSpent = true;
      return rateLimitedPayload();
    },
  });
  const out = await m.hook.analyzeSelectedCandidates(['asset-0:g1', 'asset-1:g1', 'asset-2:g1'], () => {});
  assert.notEqual(out.halted, 'quota');
  assert.equal(out.items[1].detailStatus, 'partial', 'the spent quota is misread as an item failure');
  m.unmount();
});

test('NEGATIVE CONTROL B35-SCAN-011: without the assetId check a repeated library asset becomes a second image with the same id', async () => {
  const m = mountUseKScan({
    photos: {},
    mutate: {
      'services/multiImageScan.ts': (text) => text.replace('if (suppliedId && seenIds.has(suppliedId)) continue;', ''),
    },
  });
  await m.selectPhotos([asset(URI[0], 0), asset(URI[1], 1)]);
  await m.addPhotos([{ uri: 'file:///cache/a-copy-2.jpg', assetId: 'asset-0', type: 'image' }]);
  const ids = m.hook.selectedImages.map((image) => image.id);
  assert.equal(m.hook.selectedImages.length, 3);
  assert.notEqual(new Set(ids).size, ids.length);
  m.unmount();
});

test('NEGATIVE CONTROL B35-SCAN-013: without the real-cause rethrow an offline batch is blamed on unclear photos', async () => {
  const m = mountUseKScan({
    photos: photosOf(THREE_PHOTOS),
    respond: () => ({ __error: new Error('Failed to send a request to the Edge Function') }),
    hookMutate: (text) => text.replace("typeof firstFailure.reason?.userMessage === 'string'", 'false'),
  });
  await m.selectPhotos(URI.slice(0, 2).map(asset));
  await m.analyze();
  assert.match(m.hook.error, /clear fashion item/);
  m.unmount();
});
