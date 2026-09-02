// VTO request lifecycle: duplicate taps, supersede, cancel, dismissal, and
// the stale result rule across an actor transition.
//
// The store is loaded with a real transpiled actorContext (so the epoch
// semantics under test are the shipping ones, not a stub's) and controlled
// fakes for transport and media. Nothing here touches the network or the
// filesystem, and there are no timers to race: every generation resolves when
// the test releases it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** Drains the microtask queue so every await inside the store has run.
 *  Counting individual ticks is brittle: the store's chain length is an
 *  implementation detail, and a test that hard-codes it fails for reasons
 *  that have nothing to do with the behaviour under test. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function transpile(absPath) {
  return ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function loadModule(absPath, requireMap = {}) {
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    Set,
    Math,
    Date,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(absPath)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(transpile(absPath), { filename: absPath }).runInContext(sandbox);
  return mod.exports;
}

const GARMENT = {
  productRef: 'prod_1',
  imageUrl: 'https://cdn.example.com/coat.jpg',
  category: 'wool coat',
  brand: 'Example',
  commerceSource: 'example',
};

const PERSON = {
  source: 'photo_library',
  sanitizedUri: 'file:///cache/person-a.jpg',
  width: 1024,
  height: 1280,
  metadataStripped: true,
  sanitizerVersion: 'test-1.0.0',
};

/** Builds a fresh store with controllable transport and media boundaries. */
function createHarness() {
  const released = [];
  const events = [];
  const pending = [];

  const actorContext = loadModule(path.join(ROOT, 'services', 'actorContext.js'));
  const clientTypes = loadModule(path.join(ROOT, 'types', 'vto.ts'));
  const failures = loadModule(path.join(ROOT, 'services', 'vto', 'vtoFailures.ts'), {
    '../../types/vto': clientTypes,
  });
  const eligibility = loadModule(path.join(ROOT, 'services', 'vto', 'vtoEligibility.ts'), {
    '../../types/vto': clientTypes,
  });

  const store = loadModule(path.join(ROOT, 'services', 'vto', 'vtoRequestStore.ts'), {
    '../actorContext': actorContext,
    '../../types/vto': clientTypes,
    './vtoClient': { requestVtoGeneration: () => Promise.resolve({ ok: false, code: 'unknown' }) },
    './vtoEligibility': eligibility,
    './vtoFailures': failures,
    './vtoPersonInput': {
      buildVtoPersonPayload: (person) =>
        Promise.resolve({
          ok: true,
          dataUri: 'data:image/jpeg;base64,AAAA',
          transientUri: `${person.sanitizedUri}.compressed`,
        }),
      releaseVtoPersonInput: (...uris) => {
        released.push(...uris);
        return Promise.resolve();
      },
    },
    './vtoTelemetry': {
      dimensionBucket: () => 'le1024',
      emitVtoEvent: (event, payload) => events.push({ event, payload }),
    },
  });

  /** A generation that resolves only when the test says so. */
  const generate = (args) =>
    new Promise((resolve) => {
      pending.push({ args, resolve });
    });

  return { store, actorContext, released, events, pending, generate };
}

function options(harness, extra = {}) {
  return {
    garment: GARMENT,
    origin: 'commerce_product',
    generate: harness.generate,
    ...extra,
  };
}

const SUCCESS = {
  ok: true,
  requestId: 'server-echo',
  provider: 'mock',
  dataUri: 'data:image/png;base64,AAAA',
  mediaType: 'image/png',
  width: 256,
  height: 320,
  latencyMs: 120,
};

// ── Happy path ───────────────────────────────────────────────────────────────

test('a generation moves through preparing, generating and success', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');
  assert.equal(h.store.getVtoSnapshot().status, 'ready');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  assert.equal(h.store.getVtoSnapshot().status, 'generating');

  h.pending[0].resolve(SUCCESS);
  await run;

  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.status, 'success');
  assert.equal(snapshot.result.isAiVisualization, true);
  assert.equal(snapshot.result.provider, 'mock');
});

test('generation without a chosen person fails instead of inventing one', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  await h.store.startVtoGeneration(options(h));
  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.failure.code, 'invalid_person_input');
  assert.equal(h.pending.length, 0, 'no request may be sent');
});

// ── P2: duplicate taps, supersede, cancel, dismissal ─────────────────────────

test('a double tap leaves exactly one authoritative generation', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const first = h.store.startVtoGeneration(options(h));
  await flush();
  const second = h.store.startVtoGeneration(options(h));
  await flush();

  assert.equal(h.pending.length, 2, 'both taps dispatched');
  // The FIRST result arrives last -- the classic ordering that corrupts state.
  h.pending[1].resolve({ ...SUCCESS, provider: 'second' });
  await second;
  h.pending[0].resolve({ ...SUCCESS, provider: 'first' });
  await first;

  assert.equal(h.store.getVtoSnapshot().status, 'success');
  assert.equal(
    h.store.getVtoSnapshot().result.provider,
    'second',
    'the older generation must not overwrite the newer result',
  );
});

test('the superseded request is aborted, not merely ignored', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  void h.store.startVtoGeneration(options(h));
  await flush();
  const firstSignal = h.pending[0].args.signal;
  assert.equal(firstSignal.aborted, false);

  void h.store.startVtoGeneration(options(h));
  assert.equal(firstSignal.aborted, true);
});

test('cancel ends in a defined state and drops the in-flight result', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  h.store.cancelVtoGeneration();
  assert.equal(h.store.getVtoSnapshot().status, 'cancelled');

  h.pending[0].resolve(SUCCESS);
  await run;
  assert.equal(h.store.getVtoSnapshot().status, 'cancelled', 'a cancelled request stays cancelled');
  assert.equal(h.store.getVtoSnapshot().result, null);
});

// ── Session-scoped person photo (leaveVtoSurface / attachSessionPerson) ──────
//
// Closing the sheet is not the same as ending the session: the photo a user
// picked survives so a second product in the same visit can reuse it.

test('leaving the surface mid-generation cancels the request but keeps the photo', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  h.store.leaveVtoSurface();

  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.status, 'ready', 'reopening should find a usable session, not idle');
  assert.equal(snapshot.person, PERSON);
  assert.equal(h.released.length, 0, 'the photo must NOT be deleted by a soft close');

  h.pending[0].resolve(SUCCESS);
  await run;
  assert.equal(
    h.store.getVtoSnapshot().status,
    'ready',
    'a result from a request the surface already left cannot resurrect',
  );
});

test('leaving the surface with no in-flight request is a no-op on state', () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');
  const before = h.store.getVtoSnapshot();

  h.store.leaveVtoSurface();

  const after = h.store.getVtoSnapshot();
  assert.equal(after.status, before.status);
  assert.equal(after.person, before.person);
  assert.equal(h.released.length, 0);
});

test('leaving the surface after a success keeps the result available on reopen', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');
  const run = h.store.startVtoGeneration(options(h));
  await flush();
  h.pending[0].resolve(SUCCESS);
  await run;
  assert.equal(h.store.getVtoSnapshot().status, 'success');

  h.store.leaveVtoSurface();

  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.status, 'success', 'a completed result is not an in-flight request');
  assert.ok(snapshot.result);
  assert.equal(h.released.length, 0);
});

test('attachSessionPerson reuses the photo for a different product, dropping the old result', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');
  const run = h.store.startVtoGeneration(options(h));
  await flush();
  h.pending[0].resolve(SUCCESS);
  await run;
  assert.equal(h.store.getVtoSnapshot().status, 'success');

  const otherGarment = { ...GARMENT, productRef: 'prod_2' };
  const outcome = h.store.attachSessionPerson(otherGarment, 'commerce_product');

  assert.equal(outcome, 'attached');
  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.person, PERSON, 'same photo, not re-picked');
  assert.equal(snapshot.garment, otherGarment);
  assert.equal(snapshot.result, null, "product A's result must not appear under product B");
  assert.equal(h.released.length, 0, 'reattaching must not delete the photo');
});

test('attachSessionPerson is a no-op signal when there is no session to reuse', () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  const outcome = h.store.attachSessionPerson(GARMENT, 'commerce_product');
  assert.equal(outcome, 'no_session');
  assert.equal(h.store.getVtoSnapshot().status, 'idle');
});

test('an in-flight generation superseded by attachSessionPerson cannot resurrect', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');
  const run = h.store.startVtoGeneration(options(h));
  await flush();

  const otherGarment = { ...GARMENT, productRef: 'prod_2' };
  h.store.attachSessionPerson(otherGarment, 'commerce_product');

  h.pending[0].resolve(SUCCESS);
  await run;
  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.garment, otherGarment);
  assert.equal(snapshot.result, null, 'the superseded generation must not land under the new garment');
});

test('only the explicit clear (resetVtoRequestState) deletes the session photo', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  h.store.resetVtoRequestState();

  assert.equal(h.store.getVtoSnapshot().status, 'idle');
  assert.equal(h.store.getVtoSnapshot().person, null);
  assert.ok(h.released.includes(PERSON.sanitizedUri), 'the chosen photo must be deleted');
  assert.ok(
    h.released.includes(`${PERSON.sanitizedUri}.compressed`),
    'the compressed derivative must be deleted too',
  );

  h.pending[0].resolve(SUCCESS);
  await run;
  assert.equal(h.store.getVtoSnapshot().status, 'idle', 'a cleared request cannot resurrect');
});

test('choosing a different photo deletes the previous one', () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');
  h.store.setVtoPersonInput(
    { ...PERSON, sanitizedUri: 'file:///cache/person-b.jpg' },
    GARMENT,
    'commerce_product',
  );
  assert.deepEqual(h.released, [PERSON.sanitizedUri]);
  assert.equal(h.store.getVtoSnapshot().person.sanitizedUri, 'file:///cache/person-b.jpg');
});

// ── P1: the stale result rule across an actor transition ─────────────────────

test('a result that lands after an actor change cannot attach to the new actor', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const run = h.store.startVtoGeneration(options(h));
  await flush();

  // User A signs out, user B signs in. This is what the app does at the
  // actor boundary.
  h.store.resetVtoRequestState();
  h.actorContext.advanceActorEpoch('user-b');

  h.pending[0].resolve(SUCCESS);
  await run;

  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.result, null);
  assert.equal(snapshot.person, null);
  assert.ok(h.released.includes(PERSON.sanitizedUri), "A's photo must be gone");
});

test('a sign-out and sign-in as the SAME user still invalidates the request', async () => {
  // A captured user id would still match here. Only the epoch rejects it,
  // which is exactly why the store checks both.
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  const captured = h.pending[0].args.requestId;

  h.actorContext.advanceActorEpoch(null);
  h.actorContext.advanceActorEpoch('user-a');

  h.pending[0].resolve(SUCCESS);
  await run;

  assert.notEqual(h.store.getVtoSnapshot().status, 'success');
  assert.ok(captured.length > 0);
});

test('a failure that lands after an actor change is also dropped', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const run = h.store.startVtoGeneration(options(h));
  await flush();

  h.store.resetVtoRequestState();
  h.actorContext.advanceActorEpoch('user-b');

  h.pending[0].resolve({ ok: false, code: 'provider_timeout' });
  await run;

  assert.equal(h.store.getVtoSnapshot().status, 'idle');
  assert.equal(h.store.getVtoSnapshot().failure, null);
});

// ── Failures and retry ───────────────────────────────────────────────────────

test('a provider failure ends in a defined state with K Scan copy', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  h.pending[0].resolve({ ok: false, code: 'provider_timeout' });
  await run;

  const snapshot = h.store.getVtoSnapshot();
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.failure.code, 'provider_timeout');
  assert.equal(snapshot.failure.retryable, true);
  assert.ok(!snapshot.failure.message.toLowerCase().includes('provider'));
});

test('a transport-level cancellation is reported as cancelled, not failed', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  h.pending[0].resolve({ ok: false, code: 'cancelled' });
  await run;

  assert.equal(h.store.getVtoSnapshot().status, 'cancelled');
  assert.equal(h.store.getVtoSnapshot().failure, null);
});

test('a thrown transport is a defined failure, not an unhandled rejection', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  await h.store.startVtoGeneration(
    options(h, { generate: () => Promise.reject(new Error('boom')) }),
  );
  assert.equal(h.store.getVtoSnapshot().status, 'failed');
  assert.equal(h.store.getVtoSnapshot().failure.code, 'unknown');
});

test('retry is counted and never automatic', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const first = h.store.startVtoGeneration(options(h));
  await flush();
  h.pending[0].resolve({ ok: false, code: 'provider_timeout' });
  await first;
  assert.equal(h.store.getVtoSnapshot().retryCount, 0, 'a failure alone must not retry');

  const second = h.store.retryVtoGeneration(options(h));
  await flush();
  assert.equal(h.store.getVtoSnapshot().retryCount, 1);
  h.pending[1].resolve(SUCCESS);
  await second;
  assert.equal(h.store.getVtoSnapshot().status, 'success');
});

test('a failed person payload never reaches the network', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  await h.store.startVtoGeneration(
    options(h, {
      buildPayload: () => Promise.resolve({ ok: false, reason: 'invalid_person_input' }),
    }),
  );
  assert.equal(h.pending.length, 0);
  assert.equal(h.store.getVtoSnapshot().failure.code, 'invalid_person_input');
});

// ── Persistence and ownership posture ────────────────────────────────────────

test('a successful try-on writes nothing and claims no ownership', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  const run = h.store.startVtoGeneration(options(h));
  await flush();
  h.pending[0].resolve(SUCCESS);
  await run;

  // The store has no import through which a Closet, library, or cloud write
  // could happen -- loadModule throws on any unexpected specifier, so this
  // test failing means a persistence dependency was added.
  const snapshot = h.store.getVtoSnapshot();
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'owned'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'savedItemId'), false);
});

test('the request payload carries no identity field for the server to trust', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');

  void h.store.startVtoGeneration(options(h));
  await flush();

  const sent = Object.keys(h.pending[0].args).sort();
  // VTO-QUOTA-001 added `requestGeneration`. It is deliberately NOT an identity
  // field: it is an opaque attempt label (the retry count), bounded and
  // character-restricted by the server and never used for authorization -- the
  // actor still comes from the verified JWT alone. It is listed here so this
  // assertion keeps being an exact-set check rather than being loosened.
  assert.deepEqual(sent, [
    'devScenario',
    'garment',
    'origin',
    'personDataUri',
    'requestGeneration',
    'requestId',
    'signal',
  ]);
  for (const forbidden of ['userId', 'user_id', 'actorId', 'accessToken', 'provider']) {
    assert.equal(forbidden in h.pending[0].args, false, `${forbidden} must not be sent`);
  }
  // The attempt label must never become a channel for identity.
  assert.match(
    String(h.pending[0].args.requestGeneration),
    /^\d+$/,
    'requestGeneration must be a plain attempt counter, not an identifier',
  );
});

// ── VTO-DUP-001: an intent boundary is not a retry counter ───────────────────
//
// `requestGeneration` is the client's half of the server's idempotency
// identity. It was `retryCount`, which IDLE_VTO_SNAPSHOT resets to 0 every time
// the store moves to a new garment context -- so the ordinary session "try A,
// look at B, come back to A" rebuilt the exact key of A's earlier attempt. The
// server found a `succeeded` row, answered `duplicate`, and the person was told
// "You've reached the try-on limit for now" for a limit they had not reached.

const GARMENT_A = { ...GARMENT, productRef: 'prod_A', imageUrl: 'https://cdn.example.com/a.jpg' };
const GARMENT_B = { ...GARMENT, productRef: 'prod_B', imageUrl: 'https://cdn.example.com/b.jpg' };

async function generateOnce(h, garment) {
  const run = h.store.startVtoGeneration({
    garment, origin: 'commerce_product', generate: h.generate,
  });
  await flush();
  const sent = h.pending[h.pending.length - 1];
  sent.resolve(SUCCESS);
  await run;
  return String(sent.args.requestGeneration);
}

test('VTO-DUP-001: returning to a product tried earlier is a NEW intent', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT_A, 'commerce_product');

  const first = await generateOnce(h, GARMENT_A);

  // What hooks/useVirtualTryOn.ts does on mount when the sheet opens for a
  // different product than the one the session photo is attached to.
  h.store.attachSessionPerson(GARMENT_B, 'commerce_product');
  await generateOnce(h, GARMENT_B);

  h.store.attachSessionPerson(GARMENT_A, 'commerce_product');
  const again = await generateOnce(h, GARMENT_A);

  assert.notEqual(again, first, 'a new intent must not reuse a spent idempotency identity');
});

test('VTO-DUP-001: a different photo for the same product is a NEW intent', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT_A, 'commerce_product');
  const first = await generateOnce(h, GARMENT_A);

  h.store.setVtoPersonInput(
    { ...PERSON, sanitizedUri: 'file:///cache/person-b.jpg' },
    GARMENT_A,
    'commerce_product',
  );
  const second = await generateOnce(h, GARMENT_A);
  assert.notEqual(second, first);
});

test('VTO-DUP-001: an explicit Retry is a NEW intent', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT_A, 'commerce_product');
  const first = await generateOnce(h, GARMENT_A);

  const run = h.store.retryVtoGeneration({
    garment: GARMENT_A, origin: 'commerce_product', generate: h.generate,
  });
  await flush();
  const retryGeneration = String(h.pending[h.pending.length - 1].args.requestGeneration);
  h.pending[h.pending.length - 1].resolve(SUCCESS);
  await run;

  assert.notEqual(retryGeneration, first);
});

test('VTO-DUP-001: two taps of ONE intent still share a key', async () => {
  // The property the old design was protecting, and the reason the fix could
  // not simply be "use the store's generation token". Two starts with no
  // intervening intent boundary must present the SAME identity to the server,
  // so the second collapses into the first rather than buying a second job.
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  h.store.setVtoPersonInput(PERSON, GARMENT_A, 'commerce_product');

  void h.store.startVtoGeneration(options(h, { garment: GARMENT_A }));
  await flush();
  void h.store.startVtoGeneration(options(h, { garment: GARMENT_A }));
  await flush();

  assert.equal(h.pending.length, 2, 'both taps reached the transport boundary');
  assert.equal(
    String(h.pending[0].args.requestGeneration),
    String(h.pending[1].args.requestGeneration),
    'two taps of one intent must not buy two generations',
  );
});

test('VTO-DUP-001: the intent sequence never walks backwards', async () => {
  const h = createHarness();
  h.actorContext.advanceActorEpoch('user-a');
  const seen = [];
  for (const garment of [GARMENT_A, GARMENT_B, GARMENT_A, GARMENT_B]) {
    if (h.store.getVtoSnapshot().person) h.store.attachSessionPerson(garment, 'commerce_product');
    else h.store.setVtoPersonInput(PERSON, garment, 'commerce_product');
    seen.push(Number(await generateOnce(h, garment)));
  }
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] > seen[i - 1], `intent ${seen[i]} must exceed ${seen[i - 1]}`);
  }
});
