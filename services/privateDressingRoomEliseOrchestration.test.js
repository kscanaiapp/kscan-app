// Private Dressing Room Elise — orchestration, copy and affordances.
//
// Build 3 Phase 4, Commit 4. These call the SAME functions the hook calls, for
// the Phase 3.5 reason: there is no React test infrastructure here, so a harness
// that reimplemented the ordering would prove a sequence production never runs.
//
// The properties that matter:
//   * with the flag off, nothing renders and no request is made
//   * an accepted result reaches state ONLY through requestContextChange
//   * a manual action cancels and invalidates before the modal opens
//   * the user never sees provider-authored text
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

function loadModule(relPath) {
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
      if (/services\/supabaseClient(\.[tj]s)?$/.test(rel)) {
        return { supabase: { functions: { invoke: () => {} } } };
      }
      return loadModule(rel);
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  const sandbox = {
    exports: mod.exports,
    module: mod,
    require: localRequire,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

/**
 * Structural comparison across `vm` realm boundaries.
 *
 * Values returned by the loaded modules are built with that realm's
 * Object.prototype, so deepStrictEqual reports "same structure but not
 * reference-equal" for values that are identical. Round-tripping both sides
 * through JSON normalizes the realm without weakening the check.
 */
function same(actual, expected, message) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(actual)),
    JSON.parse(JSON.stringify(expected)),
    message,
  );
}

const orchestration = loadModule('services/privateDressingRoomEliseOrchestration.ts');
const ux = loadModule('services/privateDressingRoomEliseUx.ts');
const client = loadModule('services/privateDressingRoomEliseClient.ts');

function closetItem(id, category, clothingType) {
  return {
    id,
    title: `Item ${id}`,
    category,
    clothingType,
    subtype: null,
    brand: null,
    primaryColor: 'navy',
    secondaryColors: [],
    material: [],
    size: null,
    notes: null,
    origin: null,
    imageUri: null,
    thumbnailUri: null,
    createdAt: null,
    updatedAt: null,
    displaySummary: null,
    taxonomyUnknown: false,
  };
}

const CLOSET = [
  closetItem('anchor-1', 'Outerwear', 'Blazer'),
  closetItem('top-1', 'Tops', 'Shirt'),
  closetItem('bottom-1', 'Bottoms', 'Trousers'),
  closetItem('shoe-1', 'Shoes', 'Loafers'),
];

let requestCounter = 0;
function harness(overrides = {}) {
  const applied = [];
  const statuses = [];
  const deps = {
    eliseEnabled: true,
    coordinator: client.createEliseRequestCoordinator(),
    publish: { setStatus: (status) => statuses.push(status) },
    requestContextChange: async (change) => {
      applied.push(change);
    },
    snapshot: () => ({
      actorId: 'actor-1',
      sessionId: 'session-1',
      sessionStatus: 'active',
      compositionFingerprint: 'fp-1',
      activeLookId: 'look-1',
    }),
    newRequestId: () => {
      requestCounter += 1;
      return `${String(requestCounter).padStart(8, '0')}-0000-4000-8000-000000000000`;
    },
    ...overrides,
  };
  return { deps, applied, statuses };
}

function replyWith(build) {
  return async (_name, options) => ({ data: build(options.body), error: null });
}

const occasionSuccess = replyWith((body) => ({
  schemaVersion: 'private-dressing-room-elise-v1',
  requestId: body.requestId,
  intent: 'interpret_occasion',
  status: 'success',
  normalizedOccasion: 'Dinner',
  occasionGroup: 'evening',
}));

// ── Feature flag ──────────────────────────────────────────────────────────────

test('with Phase 4 OFF no request is made and no status is published', async () => {
  let invoked = false;
  const { deps, applied, statuses } = harness({
    eliseEnabled: false,
    invoke: async () => {
      invoked = true;
      return { data: null, error: null };
    },
  });

  const a = await orchestration.interpretOccasion(deps, {
    instruction: 'dinner with clients',
    currentOccasion: 'Work',
  });
  const b = await orchestration.buildAroundItem(deps, {
    instruction: 'build around this',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
    currentOccasion: 'Work',
  });
  const c = await orchestration.makeMoreCasual(deps, { currentOccasion: 'Dinner' });

  assert.equal(invoked, false, 'no Edge Function may be invoked with the flag off');
  same(applied, [], 'no context change with the flag off');
  same(statuses, [], 'no status with the flag off');
  for (const outcome of [a, b, c]) {
    assert.equal(outcome.applied, false);
    assert.equal(outcome.status.kind, 'idle');
  }
});

test('with Phase 4 OFF every affordance is hidden', () => {
  const off = ux.eliseAffordances({
    eliseEnabled: false,
    sessionActive: true,
    hasEffectiveLook: true,
    currentOccasion: 'Dinner',
    busy: false,
  });
  same(off, {
    showOccasionEntry: false,
    showMakeMoreCasual: false,
    canSubmitOccasion: false,
  });
});

// ── Capability A ──────────────────────────────────────────────────────────────

test('an interpreted occasion is applied through the governed context change', async () => {
  const { deps, applied, statuses } = harness({ invoke: occasionSuccess });
  const outcome = await orchestration.interpretOccasion(deps, {
    instruction: 'dinner with clients',
    currentOccasion: 'Work',
  });

  assert.equal(outcome.applied, true);
  // The ONLY mutation path is requestContextChange — the same one the chips use.
  same(applied, [{ kind: 'occasion', occasion: 'Dinner' }]);
  same(
    statuses.map((status) => status.kind),
    ['loading', 'success'],
  );
  assert.equal(ux.eliseStatusCopy(statuses[1]), 'Using “Dinner” for this occasion.');
});

test('clarification and unsupported leave the composition untouched', async () => {
  for (const [status, expected] of [
    ['clarification_required', 'clarification'],
    ['unsupported', 'unsupported'],
  ]) {
    const { deps, applied, statuses } = harness({
      invoke: replyWith((body) => ({
        schemaVersion: 'private-dressing-room-elise-v1',
        requestId: body.requestId,
        intent: 'interpret_occasion',
        status,
      })),
    });
    const outcome = await orchestration.interpretOccasion(deps, {
      instruction: 'something',
      currentOccasion: 'Work',
    });
    assert.equal(outcome.applied, false);
    same(applied, [], `${status} must not change context`);
    assert.equal(statuses[statuses.length - 1].kind, expected);
  }
});

test('an invented occasion never reaches the application', async () => {
  const { deps, applied, statuses } = harness({
    invoke: replyWith((body) => ({
      schemaVersion: 'private-dressing-room-elise-v1',
      requestId: body.requestId,
      intent: 'interpret_occasion',
      status: 'success',
      normalizedOccasion: 'Gala',
    })),
  });
  const outcome = await orchestration.interpretOccasion(deps, {
    instruction: 'a gala',
    currentOccasion: 'Work',
  });
  assert.equal(outcome.applied, false);
  same(applied, []);
  assert.equal(statuses[statuses.length - 1].kind, 'failed');
});

test('an unrecognised backend version shows the updating copy, not a retry', async () => {
  const { deps, applied, statuses } = harness({
    // Exactly what a pre-Phase-4 deployment answers a versioned body with.
    invoke: async () => ({ data: { error: 'Unsupported mode' }, error: null }),
  });
  const outcome = await orchestration.interpretOccasion(deps, {
    instruction: 'dinner',
    currentOccasion: 'Work',
  });
  assert.equal(outcome.applied, false);
  same(applied, []);
  assert.equal(statuses[statuses.length - 1].kind, 'capability_unavailable');
  assert.equal(
    ux.eliseStatusCopy(statuses[statuses.length - 1]),
    'Elise is being updated. Try again soon.',
  );
});

test('a stale response mutates nothing and shows nothing', async () => {
  let snapshotActor = 'actor-1';
  const { deps, applied, statuses } = harness({
    invoke: replyWith((body) => {
      // The actor changes while the request is in flight.
      snapshotActor = 'actor-2';
      return {
        schemaVersion: 'private-dressing-room-elise-v1',
        requestId: body.requestId,
        intent: 'interpret_occasion',
        status: 'success',
        normalizedOccasion: 'Dinner',
      };
    }),
    snapshot: () => ({
      actorId: snapshotActor,
      sessionId: 'session-1',
      sessionStatus: 'active',
      compositionFingerprint: 'fp-1',
      activeLookId: 'look-1',
    }),
  });
  const outcome = await orchestration.interpretOccasion(deps, {
    instruction: 'dinner',
    currentOccasion: 'Work',
  });
  assert.equal(outcome.applied, false);
  same(applied, [], 'a stale response must not change context');
  same(statuses.map((s) => s.kind), ['loading'], 'and must show no result');
});

// ── Capability B ──────────────────────────────────────────────────────────────

test('Build Around This applies the anchor the client chose', async () => {
  const { deps, applied } = harness({
    invoke: replyWith((body) => ({
      schemaVersion: 'private-dressing-room-elise-v1',
      requestId: body.requestId,
      intent: 'build_around_item',
      status: 'success',
      anchorRef: body.anchorRef,
    })),
  });
  const outcome = await orchestration.buildAroundItem(deps, {
    instruction: 'build around this blazer',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
    currentOccasion: 'Work',
  });
  assert.equal(outcome.applied, true);
  same(applied, [{ kind: 'anchor', anchorClosetItemId: 'anchor-1' }]);
});

test('an anchor alias that decodes to a different item is refused', async () => {
  const { deps, applied, statuses } = harness({
    invoke: replyWith((body) => ({
      schemaVersion: 'private-dressing-room-elise-v1',
      requestId: body.requestId,
      intent: 'build_around_item',
      status: 'success',
      // A different, but authorized, alias from the same request.
      anchorRef: body.candidates[1].ref,
    })),
  });
  const outcome = await orchestration.buildAroundItem(deps, {
    instruction: 'build around this',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
    currentOccasion: 'Work',
  });
  assert.equal(outcome.applied, false);
  same(applied, [], 'Elise may not substitute the anchor');
  assert.equal(statuses[statuses.length - 1].kind, 'failed');
});

test('an unsupported anchor category never reaches the backend', async () => {
  let invoked = false;
  const { deps, applied, statuses } = harness({
    invoke: async () => {
      invoked = true;
      return { data: null, error: null };
    },
  });
  const outcome = await orchestration.buildAroundItem(deps, {
    instruction: 'build around this lamp',
    anchorClosetItemId: 'lamp-1',
    closetItems: [...CLOSET, closetItem('lamp-1', 'Homeware', 'Lamp')],
    currentOccasion: 'Work',
  });
  assert.equal(invoked, false);
  assert.equal(outcome.applied, false);
  same(applied, []);
  assert.equal(statuses[statuses.length - 1].kind, 'unsupported');
  assert.equal(
    ux.eliseStatusCopy(statuses[statuses.length - 1]),
    "This item can't be used as the anchor for a look yet.",
  );
});

test('the single entry point dispatches by whether an anchor exists', async () => {
  // No anchor → interpret_occasion, and no Closet is disclosed.
  const withoutAnchor = harness({ invoke: occasionSuccess });
  let sentBody = null;
  withoutAnchor.deps.invoke = async (_name, options) => {
    sentBody = options.body;
    return { data: await occasionSuccess(_name, options).then((r) => r.data), error: null };
  };
  await orchestration.askElise(withoutAnchor.deps, {
    instruction: 'dinner with clients',
    currentOccasion: 'Work',
    anchorClosetItemId: null,
    closetItems: CLOSET,
  });
  assert.equal(sentBody.intent, 'interpret_occasion');
  assert.equal(sentBody.candidates, undefined, 'no anchor means no Closet is sent');

  // Anchor present → build_around_item, with a bounded pool.
  const withAnchor = harness({
    invoke: async (_name, options) => {
      sentBody = options.body;
      return {
        data: {
          schemaVersion: 'private-dressing-room-elise-v1',
          requestId: options.body.requestId,
          intent: 'build_around_item',
          status: 'success',
          anchorRef: options.body.anchorRef,
        },
        error: null,
      };
    },
  });
  await orchestration.askElise(withAnchor.deps, {
    instruction: 'something for dinner',
    currentOccasion: 'Work',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
  });
  assert.equal(sentBody.intent, 'build_around_item');
  assert.ok(sentBody.candidates.length > 0);
  same(withAnchor.applied, [{ kind: 'anchor', anchorClosetItemId: 'anchor-1' }]);
});

// ── Capability C ──────────────────────────────────────────────────────────────

test('Make It More Casual reaches no backend at all', async () => {
  let invoked = false;
  const { deps, applied, statuses } = harness({
    invoke: async () => {
      invoked = true;
      return { data: null, error: null };
    },
  });
  const outcome = await orchestration.makeMoreCasual(deps, { currentOccasion: 'Dinner' });
  assert.equal(invoked, false, 'this capability is deterministic and local');
  assert.equal(outcome.applied, true);
  same(applied, [{ kind: 'occasion', occasion: 'Work' }]);
  assert.equal(statuses[statuses.length - 1].kind, 'success');
  assert.equal(ux.eliseStatusCopy(statuses[statuses.length - 1]), 'This look is now more casual.');
});

test('at the floor it says so, and is not a network failure', async () => {
  const { deps, applied, statuses } = harness();
  const outcome = await orchestration.makeMoreCasual(deps, { currentOccasion: 'Weekend' });
  assert.equal(outcome.applied, false);
  same(applied, []);
  assert.equal(statuses[statuses.length - 1].kind, 'already_casual');
  assert.equal(
    ux.eliseStatusCopy(statuses[statuses.length - 1]),
    'This look is already at its most casual. Try changing the occasion or anchor.',
  );
  assert.notEqual(ux.eliseStatusCopy(statuses[statuses.length - 1]), ux.PRIVATE_ELISE_COPY.safeFailure);
});

test('Make It More Casual cancels an in-flight request first', async () => {
  const { deps } = harness();
  const plan = { requestId: 'x', body: {}, aliases: new Map() };
  const started = deps.coordinator.begin({
    plan,
    intent: 'interpret_occasion',
    snapshot: deps.snapshot(),
  });
  await orchestration.makeMoreCasual(deps, { currentOccasion: 'Dinner' });
  assert.equal(started.signal.aborted, true, 'a manual action must abort the active request');
  assert.equal(deps.coordinator.isBusy(), false);
});

// ── Manual-action race ────────────────────────────────────────────────────────

test('MANUAL CONTEXT CHANGE RACE: a late response cannot land during a modal', async () => {
  const { deps, applied } = harness();
  const plan = { requestId: 'r-1', body: {}, aliases: new Map() };

  // Request A begins.
  const a = deps.coordinator.begin({
    plan,
    intent: 'interpret_occasion',
    snapshot: deps.snapshot(),
  });

  // The user starts a manual context change; the modal is about to open.
  orchestration.cancelActiveEliseRequest(deps);
  assert.equal(a.signal.aborted, true, 'request A must be aborted before the modal opens');

  // A late Response A arrives while the modal is open.
  const late = deps.coordinator.accept({
    generation: a.generation,
    response: {
      schemaVersion: 'private-dressing-room-elise-v1',
      requestId: 'r-1',
      intent: 'interpret_occasion',
      status: 'success',
      normalizedOccasion: 'Dinner',
    },
    now: deps.snapshot(),
  });
  assert.equal(late.accepted, false, 'a late response must not apply during a modal');
  same(applied, [], 'and must not change the composition the modal is asking about');
});

test('cancelling clears the transient status so no stale copy remains', () => {
  const { deps, statuses } = harness();
  deps.publish.setStatus({ kind: 'loading', operation: 'interpret_occasion' });
  orchestration.cancelActiveEliseRequest(deps);
  assert.equal(statuses[statuses.length - 1].kind, 'idle');
  assert.equal(ux.eliseStatusCopy(statuses[statuses.length - 1]), null);
});

// ── Copy and accessibility ────────────────────────────────────────────────────

test('every user-facing string comes from the approved table', () => {
  const approved = new Set(Object.values(ux.PRIVATE_ELISE_COPY));
  const dynamic = [
    ux.eliseStatusCopy({ kind: 'success', operation: 'interpret_occasion', occasion: 'Work' }),
    ux.eliseStatusCopy({ kind: 'success', operation: 'build_around_item', itemType: 'blazer' }),
  ];
  for (const copy of dynamic) {
    assert.ok(copy && copy.length > 0);
  }
  for (const kind of [
    'clarification',
    'unsupported',
    'already_casual',
    'capability_unavailable',
    'failed',
  ]) {
    const copy = ux.eliseStatusCopy({ kind, operation: 'interpret_occasion' });
    assert.ok(approved.has(copy), `${kind} copy is not in the approved table: ${copy}`);
  }
  // Nothing internal is ever surfaced.
  for (const value of Object.values(ux.PRIVATE_ELISE_COPY)) {
    assert.doesNotMatch(value, /supabase|edge function|gemini|http|schema|request id|token/i);
  }
});

test('the response contract has copy fields, and the UI reads none of them', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomEliseUx.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The approved table legitimately has a `clarification` KEY of its own; what
  // must never appear is a read of the response's fields.
  assert.equal(code.includes('displayCopy'), false, 'provider copy must never be rendered');
  assert.doesNotMatch(code, /\bstatus\.clarification\b|\bresponse\.clarification\b/);
  // The orchestration layer does not forward it either.
  const orchestrationSource = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomEliseOrchestration.ts'),
    'utf8',
  );
  const orchestrationCode = orchestrationSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(orchestrationCode.includes('displayCopy'), false);
  assert.equal(orchestrationCode.includes('response.clarification'), false);
});

test('status changes are announced once, and loading never interrupts', () => {
  assert.equal(ux.eliseAnnouncement({ kind: 'idle', operation: null }), null);

  const loading = ux.eliseAnnouncement({ kind: 'loading', operation: 'interpret_occasion' });
  assert.equal(loading.politeness, 'polite');
  assert.equal(loading.message, 'Understanding your occasion…');

  for (const kind of ['clarification', 'unsupported', 'failed', 'capability_unavailable']) {
    const announcement = ux.eliseAnnouncement({ kind, operation: 'interpret_occasion' });
    assert.equal(announcement.politeness, 'assertive', `${kind} must be announced`);
  }
});

test('the submit control is disabled while a request is running', () => {
  assert.equal(ux.isEliseBusy({ kind: 'loading', operation: 'interpret_occasion' }), true);
  assert.equal(ux.isEliseBusy({ kind: 'idle', operation: null }), false);
  const busy = ux.eliseAffordances({
    eliseEnabled: true,
    sessionActive: true,
    hasEffectiveLook: true,
    currentOccasion: 'Dinner',
    busy: true,
  });
  assert.equal(busy.canSubmitOccasion, false, 'no second request may be queued');
});

test('Make It More Casual is offered across the ladder, including the floor', () => {
  const base = { eliseEnabled: true, sessionActive: true, hasEffectiveLook: true, busy: false };
  assert.equal(ux.eliseAffordances({ ...base, currentOccasion: 'Dinner' }).showMakeMoreCasual, true);
  // The FLOOR stays offered so the approved already-most-casual copy is
  // reachable; device QA found that hiding it left that copy unreachable.
  assert.equal(ux.eliseAffordances({ ...base, currentOccasion: 'Weekend' }).showMakeMoreCasual, true);
  assert.equal(ux.eliseAffordances({ ...base, currentOccasion: 'Travel' }).showMakeMoreCasual, false);
  assert.equal(
    ux.eliseAffordances({ ...base, hasEffectiveLook: false, currentOccasion: 'Dinner' })
      .showMakeMoreCasual,
    false,
    'no look means nothing to make casual',
  );
});

test('the occasion input is bounded and rejects whitespace', () => {
  assert.equal(ux.normalizeOccasionInput('  dinner with clients '), 'dinner with clients');
  assert.equal(ux.normalizeOccasionInput('   '), null);
  assert.equal(ux.normalizeOccasionInput(null), null);
  assert.equal(
    ux.normalizeOccasionInput('x'.repeat(500)).length,
    ux.PRIVATE_ELISE_INPUT_MAX_LENGTH,
  );
});

test('a completed action never renders a loading message', () => {
  // Device QA found build_around_item success rendering "Building around this
  // item…" — the progress copy — because itemType was unset.
  const loadingStrings = [
    ux.PRIVATE_ELISE_COPY.loadingOccasion,
    ux.PRIVATE_ELISE_COPY.loadingAnchor,
    ux.PRIVATE_ELISE_COPY.loadingCasual,
  ];
  for (const operation of ['interpret_occasion', 'build_around_item', 'make_more_casual']) {
    for (const extra of [{}, { itemType: 'trousers' }, { occasion: 'Dinner' }]) {
      const copy = ux.eliseStatusCopy({ kind: 'success', operation, ...extra });
      if (copy === null) continue;
      assert.ok(!loadingStrings.includes(copy), `${operation} success rendered loading copy: ${copy}`);
      assert.doesNotMatch(copy, /…$/, `${operation} success ends in an ellipsis: ${copy}`);
    }
  }
});

test('the anchor success copy names the garment from its own taxonomy', async () => {
  const { deps, statuses } = harness({
    invoke: replyWith((body) => ({
      schemaVersion: 'private-dressing-room-elise-v1',
      requestId: body.requestId,
      intent: 'build_around_item',
      status: 'success',
      anchorRef: body.anchorRef,
    })),
  });
  await orchestration.buildAroundItem(deps, {
    instruction: 'build around this',
    anchorClosetItemId: 'anchor-1',
    closetItems: CLOSET,
    currentOccasion: 'Work',
  });
  const final = statuses[statuses.length - 1];
  assert.equal(final.kind, 'success');
  // CLOSET's anchor-1 is category Outerwear / clothingType Blazer.
  assert.equal(final.itemType, 'blazer');
  assert.equal(ux.eliseStatusCopy(final), 'Building around your blazer.');
});

test('a backend safe_failure is NOT reported as unsupported', async () => {
  // Device QA found safe_failure published as `unsupported`, which for
  // build_around_item told the user their garment was unusable when the truth
  // was a transient backend failure. These are different facts.
  const cases = [
    ['safe_failure', 'failed'],
    ['invalid_request', 'failed'],
    ['unsupported', 'unsupported'],
    ['clarification_required', 'clarification'],
  ];
  for (const [backendStatus, expectedKind] of cases) {
    for (const intent of ['interpret_occasion', 'build_around_item']) {
      const { deps, applied, statuses } = harness({
        invoke: replyWith((body) => ({
          schemaVersion: 'private-dressing-room-elise-v1',
          requestId: body.requestId,
          intent,
          status: backendStatus,
        })),
      });
      if (intent === 'interpret_occasion') {
        await orchestration.interpretOccasion(deps, { instruction: 'x', currentOccasion: 'Work' });
      } else {
        await orchestration.buildAroundItem(deps, {
          instruction: 'x',
          anchorClosetItemId: 'anchor-1',
          closetItems: CLOSET,
          currentOccasion: 'Work',
        });
      }
      const final = statuses[statuses.length - 1];
      assert.equal(final.kind, expectedKind, `${intent}/${backendStatus} -> ${final.kind}`);
      same(applied, [], `${intent}/${backendStatus} must not mutate`);
    }
  }
});

test('a backend failure renders retry copy, never the unsupported-anchor copy', () => {
  assert.equal(
    ux.eliseStatusCopy({ kind: 'failed', operation: 'build_around_item' }),
    "I couldn't update this look. Try again.",
  );
  assert.notEqual(
    ux.eliseStatusCopy({ kind: 'failed', operation: 'build_around_item' }),
    ux.PRIVATE_ELISE_COPY.unsupportedAnchor,
  );
});
