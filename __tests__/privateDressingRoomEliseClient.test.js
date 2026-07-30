// Private Dressing Room Elise — client projection, transport and lifecycle.
//
// Build 3 Phase 4, Commit 3. The properties under test are the ones that decide
// whether a remote suggestion can corrupt local state:
//
//   * the request carries aliases and fashion metadata, and nothing else
//   * the alias map is request-local and never escapes the request
//   * a cancelled or superseded response cannot mutate anything
//   * a LATE response, delivered after a newer lifecycle has progressed, is
//     rejected — cancellation alone is not accepted as proof
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const moduleCache = new Map();

function loadModule(relPath, overrides = {}) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier in overrides) return overrides[specifier];
    if (specifier === 'expo-crypto') {
      return { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 17) % 256) };
    }
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      const rel = path.relative(ROOT, resolved).replace(/\\/g, '/');
      // supabaseClient pulls the whole app runtime (native SDK, storage, env);
      // the client module only ever reaches it through the injectable `invoke`
      // seam, so it is stubbed rather than loaded.
      if (/services\/supabaseClient(\.[tj]s)?$/.test(rel)) {
        return { supabase: { functions: { invoke: () => {} } } };
      }
      return loadModule(rel);
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  const sandbox = { exports: mod.exports, module: mod, require: localRequire, console, setTimeout, clearTimeout, AbortController };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const projection = loadModule('services/privateDressingRoomEliseProjection.ts');
const client = loadModule('services/privateDressingRoomEliseClient.ts');
const contract = loadModule('types/privateDressingRoomElise.ts');

const REQ_A = '11111111-0000-4000-8000-00000000000a';
const REQ_B = '22222222-0000-4000-8000-00000000000b';

function closetItem(id, overrides = {}) {
  return {
    id,
    title: `Item ${id}`,
    category: 'Tops',
    clothingType: 'Shirt',
    subtype: null,
    brand: 'Acme',
    primaryColor: 'navy',
    secondaryColors: ['white'],
    material: ['cotton'],
    size: 'M',
    notes: 'bought in Rome',
    origin: 'scan',
    imageUri: 'file:///data/user/0/kscan/closet/1.jpg',
    thumbnailUri: 'file:///data/user/0/kscan/closet/1-thumb.jpg',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    displaySummary: 'Tops · Shirt · navy',
    taxonomyUnknown: false,
    ...overrides,
  };
}

const CLOSET = [
  closetItem('anchor-1', { category: 'Outerwear', clothingType: 'Blazer' }),
  closetItem('top-1'),
  closetItem('top-2'),
  closetItem('bottom-1', { category: 'Bottoms', clothingType: 'Trousers' }),
  closetItem('shoe-1', { category: 'Shoes', clothingType: 'Loafers' }),
];

function snapshot(overrides = {}) {
  return {
    actorId: 'actor-1',
    sessionId: 'session-1',
    sessionStatus: 'active',
    compositionFingerprint: 'fp-1',
    activeLookId: 'look-1',
    ...overrides,
  };
}

// ── Projection ────────────────────────────────────────────────────────────────

test('interpret_occasion sends no garment pool at all', () => {
  const result = projection.planOccasionRequest({
    requestId: REQ_A,
    instruction: 'dinner with clients',
    occasion: 'Work',
    occasionGroup: 'work',
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.body.candidates, undefined);
  assert.equal(result.plan.aliases.size, 0);
  assert.equal(result.plan.body.context.occasion, 'Work');
});

test('build_around_item sends aliases and fashion metadata, never identity or media', () => {
  const result = projection.planAnchorRequest({
    requestId: REQ_A,
    instruction: 'build around this blazer',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
  });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.plan.body);

  // Everything the record holds that Phase 4 must not disclose.
  for (const leaked of [
    'anchor-1',
    'top-1',
    'bought in Rome',
    'file:///',
    'Acme',
    'Item ',
    'actor-1',
    'session-1',
    'kscan',
    'displaySummary',
    'taxonomyUnknown',
    'secondaryColors',
  ]) {
    assert.equal(serialized.includes(leaked), false, `request leaked ${leaked}`);
  }
  for (const field of contract.PRIVATE_ELISE_FORBIDDEN_REQUEST_FIELDS) {
    assert.doesNotMatch(serialized, new RegExp(`"${field}"`), `request carried ${field}`);
  }

  // What it DOES carry is the sanctioned allowlist.
  for (const candidate of result.plan.body.candidates) {
    for (const key of Object.keys(candidate)) {
      assert.ok(
        contract.PRIVATE_ELISE_CANDIDATE_FIELDS.includes(key),
        `unexpected candidate field ${key}`,
      );
    }
    assert.match(candidate.ref, /^item_[0-9a-f]{8}_\d+$/);
  }
  assert.equal(result.plan.body.candidates[0].isAnchor, true);
  assert.equal(result.plan.body.lockedRefs.length, 1);
  assert.equal(result.plan.body.lockedRefs[0], result.plan.body.anchorRef);
});

test('the produced request passes the shared validator that the backend runs', () => {
  const result = projection.planAnchorRequest({
    requestId: REQ_A,
    instruction: 'build around this',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
  });
  const parsed = contract.parsePrivateEliseRequest(JSON.parse(JSON.stringify(result.plan.body)));
  assert.equal(parsed.ok, true, `backend would reject: ${JSON.stringify(parsed)}`);
});

test('an oversized Closet still produces a bounded request', () => {
  const big = Array.from({ length: 400 }, (_, index) =>
    closetItem(`item-${String(index).padStart(4, '0')}`, {
      category: index % 3 === 0 ? 'Shoes' : index % 3 === 1 ? 'Bottoms' : 'Tops',
      clothingType: index % 3 === 0 ? 'Loafers' : index % 3 === 1 ? 'Trousers' : 'Shirt',
    }),
  );
  big.push(closetItem('anchor-1', { category: 'Outerwear', clothingType: 'Blazer' }));
  const result = projection.planAnchorRequest({
    requestId: REQ_A,
    instruction: 'build around this',
    anchorClosetItemId: 'anchor-1',
    closetItems: big,
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.body.candidates.length, contract.PRIVATE_ELISE_BOUNDS.candidates);
  assert.equal(result.plan.aliases.size, contract.PRIVATE_ELISE_BOUNDS.candidates);
  // Slot spread, not 20 of one thing.
  const slots = new Set(result.plan.body.candidates.map((candidate) => candidate.slot));
  assert.ok(slots.size >= 3, `expected a slot spread, saw ${[...slots].join(',')}`);
  // And the anchor survived the cap.
  assert.equal(result.plan.body.candidates[0].isAnchor, true);
});

test('an unowned or unsupported anchor never produces a request', () => {
  const foreign = projection.planAnchorRequest({
    requestId: REQ_A,
    instruction: 'build around this',
    anchorClosetItemId: 'not-mine',
    closetItems: CLOSET,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'anchor_not_owned');

  const unsupported = projection.planAnchorRequest({
    requestId: REQ_A,
    instruction: 'build around this',
    anchorClosetItemId: 'mystery-1',
    closetItems: [
      ...CLOSET,
      closetItem('mystery-1', {
        category: 'Homeware',
        clothingType: 'Lamp',
        subtype: null,
        title: 'Lamp',
        taxonomyUnknown: false,
      }),
    ],
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reason, 'anchor_unsupported');
});

test('aliases decode only through the map that minted them', () => {
  const a = projection.planAnchorRequest({
    requestId: REQ_A,
    instruction: 'x',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
  }).plan;
  const b = projection.planAnchorRequest({
    requestId: REQ_B,
    instruction: 'x',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
  }).plan;

  assert.equal(projection.resolveAlias(a, a.body.anchorRef), 'anchor-1');
  // B's alias is meaningless against A's map, even though both are well formed.
  assert.equal(projection.resolveAlias(a, b.body.anchorRef), null);
  assert.equal(projection.resolveAlias(a, 'anchor-1'), null);
  assert.equal(projection.resolveAlias(a, 'item_deadbeef_1'), null);
  assert.notEqual(a.body.anchorRef, b.body.anchorRef);
});

// ── Transport ─────────────────────────────────────────────────────────────────

function planFor(requestId = REQ_A) {
  return projection.planAnchorRequest({
    requestId,
    instruction: 'build around this',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
  }).plan;
}

function goodResponse(plan) {
  return {
    schemaVersion: 'private-dressing-room-elise-v1',
    requestId: plan.requestId,
    intent: 'build_around_item',
    status: 'success',
    anchorRef: plan.body.anchorRef,
    normalizedOccasion: 'Work',
  };
}

test('a valid reply is returned as a validated contract response', async () => {
  const plan = planFor();
  const outcome = await client.sendEliseRequest({
    plan,
    intent: 'build_around_item',
    invoke: async () => ({ data: goodResponse(plan), error: null }),
  });
  assert.equal(outcome.kind, 'response');
  assert.equal(outcome.response.status, 'success');
  assert.equal(outcome.response.anchorRef, plan.body.anchorRef);
});

test('an unversioned or unrecognisable reply is capability-unavailable', async () => {
  const plan = planFor();
  for (const data of [
    { error: 'Unsupported mode' }, // what a pre-Phase-4 deployment answers
    { status: 'success', outfits: [] }, // the legacy success shape
    'not json at all',
    null,
  ]) {
    const outcome = await client.sendEliseRequest({
      plan,
      intent: 'build_around_item',
      invoke: async () => ({ data, error: null }),
    });
    assert.equal(
      outcome.kind,
      'capability_unavailable',
      `${JSON.stringify(data)} should read as capability unavailable`,
    );
  }
});

test('a reply naming an alias from another request is refused', async () => {
  const plan = planFor(REQ_A);
  const other = planFor(REQ_B);
  const outcome = await client.sendEliseRequest({
    plan,
    intent: 'build_around_item',
    invoke: async () => ({
      data: { ...goodResponse(plan), anchorRef: other.body.anchorRef },
      error: null,
    }),
  });
  assert.equal(outcome.kind, 'failed');
});

test('an already-aborted signal spends no request at all', async () => {
  const plan = planFor();
  const controller = new AbortController();
  controller.abort();
  let invoked = false;
  const outcome = await client.sendEliseRequest({
    plan,
    intent: 'build_around_item',
    signal: controller.signal,
    invoke: async () => {
      invoked = true;
      return { data: goodResponse(plan), error: null };
    },
  });
  assert.equal(invoked, false, 'no network call for an already-cancelled request');
  assert.equal(outcome.kind, 'cancelled');
});

test('cancellation mid-flight reports cancelled, never an error', async () => {
  const plan = planFor();
  const controller = new AbortController();
  const outcome = await client.sendEliseRequest({
    plan,
    intent: 'build_around_item',
    signal: controller.signal,
    invoke: async () => {
      controller.abort();
      throw new Error('AbortError');
    },
  });
  assert.equal(outcome.kind, 'cancelled');
});

test('Phase 5 backend mismatch and provider failures are bounded with no automatic retry', async () => {
  const plan = planFor();
  const cases = [
    ['missing function 404', async () => ({ data: null, error: new Error('FunctionsHttpError: 404') }), 'failed'],
    ['non-200 response', async () => ({ data: { message: 'unavailable' }, error: new Error('503') }), 'failed'],
    ['malformed private response', async () => ({ data: { schemaVersion: 'private-dressing-room-elise-v1', status: 'success' }, error: null }), 'failed'],
    ['unsupported contract', async () => ({ data: { schemaVersion: 'private-dressing-room-elise-v2' }, error: null }), 'capability_unavailable'],
    ['capability unavailable', async () => ({ data: { error: 'Unsupported mode' }, error: null }), 'capability_unavailable'],
    ['provider failure', async () => ({ data: { ...goodResponse(plan), status: 'safe_failure' }, error: null }), 'response'],
  ];
  for (const [label, response, kind] of cases) {
    let calls = 0;
    const outcome = await client.sendEliseRequest({
      plan,
      intent: 'build_around_item',
      invoke: async (...args) => { calls += 1; return response(...args); },
    });
    assert.equal(outcome.kind, kind, label);
    assert.equal(calls, 1, `${label} retried automatically`);
  }
});

test('internal timeout is a retryable failure, not silent user cancellation', async () => {
  const plan = planFor();
  let calls = 0;
  const outcome = await client.sendEliseRequest({
    plan,
    intent: 'build_around_item',
    timeoutMs: 5,
    invoke: async (_name, options) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
      });
    },
  });
  assert.equal(outcome.kind, 'failed');
  assert.equal(calls, 1);
});

// ── Coordinator and races ─────────────────────────────────────────────────────

test('a new request cancels and invalidates the previous one', () => {
  const coordinator = client.createEliseRequestCoordinator();
  const planA = planFor(REQ_A);
  const planB = planFor(REQ_B);

  const a = coordinator.begin({ plan: planA, intent: 'build_around_item', snapshot: snapshot() });
  const b = coordinator.begin({ plan: planB, intent: 'build_around_item', snapshot: snapshot() });
  assert.equal(a.signal.aborted, true, 'starting B must abort A');
  assert.equal(b.signal.aborted, false);
  assert.notEqual(a.generation, b.generation);

  const late = coordinator.accept({
    generation: a.generation,
    response: goodResponse(planA),
    now: snapshot(),
  });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'superseded');
});

test('LATE RESPONSE ORDERING: A cancelled, B accepted, then A arrives and is refused', () => {
  const coordinator = client.createEliseRequestCoordinator();
  const planA = planFor(REQ_A);
  const planB = planFor(REQ_B);

  // Request A begins.
  const a = coordinator.begin({ plan: planA, intent: 'build_around_item', snapshot: snapshot() });
  // Request A is cancelled, Request B begins.
  const b = coordinator.begin({ plan: planB, intent: 'build_around_item', snapshot: snapshot() });

  // Response B arrives first and is accepted.
  const acceptedB = coordinator.accept({
    generation: b.generation,
    response: goodResponse(planB),
    now: snapshot(),
  });
  assert.equal(acceptedB.accepted, true);
  assert.equal(acceptedB.response.requestId, REQ_B);

  // Response A arrives AFTER B has already been applied.
  const lateA = coordinator.accept({
    generation: a.generation,
    response: goodResponse(planA),
    now: snapshot(),
  });
  assert.equal(lateA.accepted, false, 'a late response must never apply');
  assert.equal(a.signal.aborted, true);
});

test('a response is refused when the state it depended on has moved', () => {
  const cases = [
    ['actor_changed', { actorId: 'actor-2' }],
    ['session_changed', { sessionId: 'session-2' }],
    ['session_discarded', { sessionStatus: 'discarded' }],
    ['composition_changed', { compositionFingerprint: 'fp-2' }],
  ];
  for (const [reason, drift] of cases) {
    const coordinator = client.createEliseRequestCoordinator();
    const plan = planFor();
    const started = coordinator.begin({
      plan,
      intent: 'build_around_item',
      snapshot: snapshot(),
    });
    const result = coordinator.accept({
      generation: started.generation,
      response: goodResponse(plan),
      now: snapshot(drift),
    });
    assert.equal(result.accepted, false, `${reason} must reject`);
    assert.equal(result.reason, reason);
  }
});

test('the selected look is compared only when the result depends on it', () => {
  const coordinator = client.createEliseRequestCoordinator();
  const plan = planFor();
  const started = coordinator.begin({ plan, intent: 'build_around_item', snapshot: snapshot() });
  const ignored = coordinator.accept({
    generation: started.generation,
    response: goodResponse(plan),
    now: snapshot({ activeLookId: 'look-2' }),
  });
  assert.equal(ignored.accepted, true, 'a look change is irrelevant to an anchor request');

  const coordinator2 = client.createEliseRequestCoordinator();
  const plan2 = planFor();
  const started2 = coordinator2.begin({ plan: plan2, intent: 'build_around_item', snapshot: snapshot() });
  const compared = coordinator2.accept({
    generation: started2.generation,
    response: goodResponse(plan2),
    now: snapshot({ activeLookId: 'look-2' }),
    compareActiveLook: true,
  });
  assert.equal(compared.accepted, false);
  assert.equal(compared.reason, 'look_changed');
});

test('route unmount aborts and permanently invalidates', () => {
  const coordinator = client.createEliseRequestCoordinator();
  const plan = planFor();
  const started = coordinator.begin({ plan, intent: 'build_around_item', snapshot: snapshot() });
  coordinator.dispose();
  assert.equal(started.signal.aborted, true);
  const result = coordinator.accept({
    generation: started.generation,
    response: goodResponse(plan),
    now: snapshot(),
  });
  assert.equal(result.accepted, false);
  assert.equal(coordinator.isBusy(), false);
});

test('an explicit cancel invalidates even with nothing in flight', () => {
  const coordinator = client.createEliseRequestCoordinator();
  const plan = planFor();
  const started = coordinator.begin({ plan, intent: 'build_around_item', snapshot: snapshot() });
  coordinator.cancel();
  assert.equal(started.signal.aborted, true);
  assert.equal(coordinator.isBusy(), false);
  const result = coordinator.accept({
    generation: started.generation,
    response: goodResponse(plan),
    now: snapshot(),
  });
  assert.equal(result.accepted, false);
});

test('accepting or rejecting a generation releases its alias map', () => {
  const coordinator = client.createEliseRequestCoordinator();
  const plan = planFor();
  const started = coordinator.begin({ plan, intent: 'build_around_item', snapshot: snapshot() });
  const first = coordinator.accept({
    generation: started.generation,
    response: goodResponse(plan),
    now: snapshot(),
  });
  assert.equal(first.accepted, true);
  // The same generation cannot be replayed: its map is gone.
  const replay = coordinator.accept({
    generation: started.generation,
    response: goodResponse(plan),
    now: snapshot(),
  });
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, 'unknown_generation');
});

test('two coordinators never share aliases', () => {
  const one = client.createEliseRequestCoordinator();
  const two = client.createEliseRequestCoordinator();
  const planA = planFor(REQ_A);
  const startedA = one.begin({ plan: planA, intent: 'build_around_item', snapshot: snapshot() });
  const stolen = two.accept({
    generation: startedA.generation,
    response: goodResponse(planA),
    now: snapshot(),
  });
  assert.equal(stolen.accepted, false);
  assert.equal(stolen.reason, 'unknown_generation');
});

// ── Persistence ───────────────────────────────────────────────────────────────

test('no Elise request state is ever written to persistent storage', () => {
  for (const relativePath of [
    'services/privateDressingRoomEliseProjection.ts',
    'services/privateDressingRoomEliseClient.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Word-anchored: `ClosetItemProjection` contains the substring "setItem",
    // and a check that cannot tell those apart proves nothing.
    for (const forbidden of [
      /\bAsyncStorage\b/,
      /\bSecureStore\b/,
      /\bFileSystem\b/,
      /\bwriteAsStringAsync\s*\(/,
      /\bsetItem\s*\(/,
      /\bpersist[A-Z(]/,
      /\banalytics\b/,
      /\btrack\s*\(/,
      /\bJSON\.stringify\s*\(\s*\w*[Aa]lias/,
    ]) {
      assert.doesNotMatch(code, forbidden, `${relativePath} matches ${forbidden}`);
    }
  }
});

test('the alias map is a plain in-memory Map and is never serialized', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomEliseClient.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The request body is what crosses the wire; the alias map is not part of it.
  const plan = planFor();
  // `instanceof` is unusable here: the Map was constructed inside the vm realm,
  // so it is not an instance of THIS realm's Map. Shape is the honest check.
  assert.equal(Object.getPrototypeOf(plan.aliases).constructor.name, 'Map');
  assert.equal(typeof plan.aliases.get, 'function');
  assert.ok(plan.aliases.size > 0);
  assert.equal(JSON.stringify(plan.body).includes('aliases'), false);
  // A Map does not serialize, so even an accidental stringify discloses nothing.
  assert.equal(JSON.stringify({ aliases: plan.aliases }), '{"aliases":{}}');
  // The coordinator never hands its plan store out, so no caller can hold an
  // alias map past the request it belongs to.
  assert.doesNotMatch(code, /\breturn\s+plans\b/);
  assert.doesNotMatch(code, /\bexport\b[^\n]*\bplans\b/);
  // `plans` is only ever (re)assigned a fresh Map.
  for (const [, assigned] of code.matchAll(/\bplans\s*=\s*([^;]+);/g)) {
    assert.match(assigned.trim(), /^new Map/, `plans assigned a non-Map: ${assigned.trim()}`);
  }
});

// ── Phase 6 regression: the auth preflight is bound to its transport ─────────
//
// The Phase 5 auth hotfix added a session preflight to sendEliseRequest, but
// called the real Supabase-backed resolver unconditionally — ahead of the
// injectable `invoke` seam. That short-circuited every injected transport to
// `session_expired` and broke 17 certified Phase 5 transport/orchestration
// tests, and it coupled the __DEV__ controlled QA provider to a real login.
//
// The property: a transport that actually reaches Supabase is gated; one that
// does not, is not. Release builds can only select `defaultInvoke`, so the
// production path stays gated by construction.

test('an injected transport is not gated on a real Supabase session', async () => {
  const plan = planFor();
  const outcome = await client.sendEliseRequest({
    plan,
    intent: 'build_around_item',
    invoke: async () => ({ data: goodResponse(plan), error: null }),
  });
  assert.equal(outcome.kind, 'response', 'injected transport must not require a live session');
  assert.equal(outcome.response.status, 'success');
});

test('the default Supabase transport IS gated on a usable session', async () => {
  // resolveEliseInvoke() yields defaultInvoke here (__DEV__ is undefined, so the
  // controlled QA provider factory returns null). The stubbed supabaseClient has
  // no `auth`, so the real preflight cannot produce a token and must fail closed.
  const outcome = await client.sendEliseRequest({
    plan: planFor(),
    intent: 'build_around_item',
  });
  assert.equal(outcome.kind, 'session_expired', 'the real transport must fail closed without a session');
});

test('an explicit preflight is honoured and never auto-retries', async () => {
  const plan = planFor();
  let invoked = 0;
  const outcome = await client.sendEliseRequest({
    plan,
    intent: 'build_around_item',
    resolveSession: async () => ({ ok: false }),
    invoke: async () => {
      invoked += 1;
      return { data: goodResponse(plan), error: null };
    },
  });
  assert.equal(outcome.kind, 'session_expired');
  assert.equal(invoked, 0, 'a failed preflight must not reach the transport');
});

test('resolveElisePreflight gates the default transport and only that', async () => {
  const real = client.resolveElisePreflight(client.resolveEliseInvoke());
  const injected = client.resolveElisePreflight(async () => ({ data: null, error: null }));
  assert.equal(await injected().then((r) => r.ok), true, 'an injected transport needs no session');
  // The real one reaches the stubbed client and fails closed rather than throwing.
  assert.equal(await real().then((r) => r.ok), false, 'the default transport resolves a real session');
});
