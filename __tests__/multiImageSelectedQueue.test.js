const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the production callback, keeping the provider boundary simulated.
// A separate device/Staging certification is required for real provider proof.
const source = fs.readFileSync(path.join(__dirname, '../hooks/useKScan.js'), 'utf8');
const start = source.indexOf('const analyzeSelectedCandidates = useCallback(');
const end = source.indexOf('\n  const analyzeSelectedCandidate =', start);
assert.ok(start > 0 && end > start);

function harness(dispatch = async () => ({ response: { status: 'completed' } }), mutate = (text) => text) {
  let currentActor = true;
  let valid = true;
  let busy = false;
  const calls = [];
  const events = [];
  const actorRequest = { actorId: 'actor-a', epoch: 1, requestId: 'request-a' };
  const candidates = ['a', 'b', 'c'].map((id, index) => ({
    id, sourceImageId: `image-${index}`, sourceImageIndex: index,
    sourceImageUri: `file:///image-${index}.jpg`, category: 'coat', label: `Coat ${id}`,
    source: { attributes: { category: 'coat' } },
  }));
  const lookup = new Map(candidates.map((candidate) => [candidate.id, {
    image: { id: candidate.sourceImageId, uri: candidate.sourceImageUri, source: 'upload' },
    serverCandidateId: `server-${candidate.id}`, evidenceSource: 'gallery',
    session: {
      sourceImageUri: candidate.sourceImageUri, preparedImageUri: `prepared-${candidate.id}`,
      imageDigestPrefix: `digest-${candidate.id}`, evidenceId: `evidence-${candidate.id}`,
      v2Candidates: [{ candidateId: `server-${candidate.id}`, evidenceId: `evidence-${candidate.id}`,
        category: 'coat', detectionDigest: `detection-${candidate.id}` }],
    },
  }]));
  const context = {
    useCallback: (callback) => callback,
    multiImageActorRequestRef: { current: actorRequest },
    isActorRequestCurrent: () => currentActor,
    scanInFlightRef: { get current() { return busy; } },
    initialMultiItemAnalysisRef: { current: { confirmationCandidates: candidates } },
    multiImageCandidateLookupRef: { current: lookup },
    multiItemSessionRef: { current: null }, photo: null,
    startInFlight: () => { if (busy) return null; busy = true; return 1; },
    clearInFlight: () => { busy = false; },
    isOperationValid: () => valid,
    activeAbortControllerRef: { current: { signal: {} } },
    prepareScannerEvidence: ({ preparedImage, evidenceId }) => ({ preparedImage, evidenceId }),
    Platform: { OS: 'ios' }, createEvidenceId: () => 'request-evidence',
    scannerV2SessionRef: { current: { enabled: true } },
    runScannerIdentification: async (input) => { calls.push(input); return dispatch(input); },
    mapScanIdentifyToAnalysis: (response) => {
      if (response.status === 'failed') throw new Error('provider failed');
      return { result: 'Identified coat', metadata: response.attributes ?? {}, products: [] };
    },
  };
  vm.createContext(context);
  vm.runInContext(mutate(source.slice(start, end)) + '\nthis.run = analyzeSelectedCandidates;', context);
  return {
    run: (ids) => context.run(ids, (event) => events.push(event)), calls, events, actorRequest, lookup, context, candidates,
    switchActor: () => { currentActor = false; }, cancel: () => { valid = false; },
  };
}

test('queue deduplicates deliberate selection and identifies each original evidence in selection order', async () => {
  const h = harness();
  const result = await h.run(['b', 'a', 'b', 'unknown']);
  assert.deepEqual(Array.from(result.items, (item) => item.id), ['b', 'a']);
  assert.deepEqual(h.calls.map((call) => call.evidence.evidenceId), ['evidence-b', 'evidence-a']);
  assert.deepEqual(h.calls.map((call) => call.selectedCandidate.candidateId), ['server-b', 'server-a']);
  assert.deepEqual(Array.from(result.items, (item) => item.sourceImageUri), ['file:///image-1.jpg', 'file:///image-0.jpg']);
  assert.equal(result.items[0].actorRequest, h.actorRequest);
  assert.deepEqual(h.events.map((event) => event.state), ['analyzing', 'ready', 'analyzing', 'ready']);
});

test('one image with multiple garments reuses its original session sequentially without duplicate analysis', async () => {
  const h = harness();
  h.lookup.clear();
  h.context.photo = { uri: 'file:///one-photo.jpg', source: 'upload' };
  h.context.multiItemSessionRef.current = {
    sourceImageUri: 'file:///one-photo.jpg', preparedImageUri: 'one-prepared-image',
    imageDigestPrefix: 'one-image-digest', evidenceId: 'one-evidence', evidenceSource: 'gallery',
    v2Candidates: ['a', 'b'].map((id) => ({ candidateId: id, evidenceId: 'one-evidence', category: 'coat' })),
  };
  for (const candidate of h.candidates) {
    delete candidate.sourceImageUri;
    delete candidate.sourceImageId;
    delete candidate.sourceImageIndex;
  }
  const result = await h.run(['b', 'a', 'b']);
  assert.deepEqual(h.calls.map((call) => call.selectedCandidate.candidateId), ['b', 'a']);
  assert.deepEqual(h.calls.map((call) => call.evidence.evidenceId), ['one-evidence', 'one-evidence']);
  assert.deepEqual(Array.from(result.items, (item) => item.sourceImageUri), ['file:///one-photo.jpg', 'file:///one-photo.jpg']);
  assert.ok(result.items.every((item) => item.sourceImageIndex === 0 && item.sourceImageId === 'primary'));
});

test('quota halt keeps completed items and resume only dispatches remaining selections', async () => {
  let count = 0;
  const h = harness(async () => ({ response: { status: ++count === 2 ? 'rate_limited' : 'completed' } }));
  const paused = await h.run(['a', 'b', 'c']);
  assert.equal(paused.halted, 'quota');
  assert.deepEqual(Array.from(paused.items, (item) => item.id), ['a']);
  assert.deepEqual(Array.from(paused.remainingCandidateIds), ['b', 'c']);
  const resumed = await h.run(paused.remainingCandidateIds);
  assert.deepEqual(Array.from(resumed.items, (item) => item.id), ['b', 'c']);
  assert.deepEqual(h.calls.map((call) => call.selectedCandidate.candidateId), ['server-a', 'server-b', 'server-b', 'server-c']);
});

test('actor switch during one request rejects its result and spends no sibling dispatch', async () => {
  const h = harness(async () => { h.switchActor(); return { response: { status: 'completed' } }; });
  const result = await h.run(['a', 'b']);
  assert.equal(result.halted, 'superseded');
  assert.equal(result.items.length, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.filter((event) => event.state === 'ready').length, 0);
  assert.equal((await h.run(['b'])).halted, 'actor_changed');
  assert.equal(h.calls.length, 1);
});

test('cancellation ignores late results and stops remaining dispatches', async () => {
  const h = harness(async () => { h.cancel(); return { response: { status: 'completed' } }; });
  const result = await h.run(['a', 'b']);
  assert.equal(result.items.length, 0);
  assert.equal(h.calls.length, 1);
});

test('wrong source binding is rejected before any selected-item dispatch', async () => {
  const h = harness();
  h.lookup.get('b').session.sourceImageUri = 'file:///image-0.jpg';
  const result = await h.run(['b']);
  assert.equal(result.items.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.events.at(-1).state, 'failed');
});

test('provider failure preserves genuine detection as a partial result and continues siblings', async () => {
  const h = harness(async (input) => {
    if (input.selectedCandidate.candidateId === 'server-b') throw new Error('network timeout');
    return { response: { status: 'completed' } };
  });
  const result = await h.run(['b', 'a']);
  assert.deepEqual(Array.from(result.items, (item) => item.detailStatus), ['partial', 'complete']);
  assert.deepEqual(Array.from(result.items, (item) => item.sourceImageUri), ['file:///image-1.jpg', 'file:///image-0.jpg']);
});

test('rapid repeat calls spend only one active queue', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const h = harness(async () => pending);
  const first = h.run(['a']);
  assert.equal((await h.run(['b'])).halted, 'busy');
  assert.equal(h.calls.length, 1);
  resolve({ response: { status: 'completed' } });
  await first;
});

test('NEGATIVE CONTROL: removing actor validation lets a stale result enter the batch', async () => {
  const h = harness(async () => { h.switchActor(); return { response: { status: 'completed' } }; },
    (text) => text.replaceAll(' || !isActorRequestCurrent(actorRequest)', '').replaceAll(' && isActorRequestCurrent(actorRequest)', ''));
  const result = await h.run(['a', 'b']);
  assert.throws(() => assert.equal(result.items.length, 0));
  assert.equal(h.calls.length, 2);
});

test('NEGATIVE CONTROL: rebinding a result to the first image breaks per-item media proof', async () => {
  const h = harness(undefined, (text) => text.replace('          sourceImageUri,', "          sourceImageUri: 'file:///image-0.jpg',"));
  const result = await h.run(['b']);
  assert.throws(() => assert.equal(result.items[0].sourceImageUri, 'file:///image-1.jpg'));
});
