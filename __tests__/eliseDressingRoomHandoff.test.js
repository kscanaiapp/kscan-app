// Style This Item → private Dressing Room handoff (image styling loop, Commit 4).
//
// The handoff is two decisions, deliberately in two modules:
//
//   1. MAY THIS RUN — `resolveStyleTarget`, the ownership boundary, pure and in
//      services/style-chat.
//   2. WILL THE DESTINATION HONOUR IT — `preflightDressingRoomAnchor`, which
//      reads the Closet and therefore lives with the other Dressing Room
//      services, because the release gate in eliseClosetTransactionSeparation
//      forbids an Elise source file importing the Closet orchestrator.
//
// Both are exercised against real inputs with injected boundaries, so these
// prove the decision production makes rather than a restatement of it.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
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
      // The real Closet library reaches AsyncStorage and Supabase. The preflight
      // takes its loader by injection, so the module only has to LOAD.
      if (/services\/closetLibrary(\.[tj]s)?$/.test(rel)) {
        return { loadClosetTyped: () => Promise.resolve({ ok: false, items: [] }) };
      }
      if (/services\/actorContext(\.[tj]s)?$/.test(rel)) {
        return {
          isActorRequestCurrent: () => true,
          createActorRequest: () => ({ actorId: 'a', epoch: 1 }),
        };
      }
      if (/constants\/featureFlags(\.[tj]s)?$/.test(rel)) {
        return { PRIVATE_DRESSING_ROOM_V1: true };
      }
      return loadModule(rel);
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  const sandbox = { exports: mod.exports, module: mod, require: localRequire, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const anchor = loadModule('services/privateDressingRoomChatHandoff.ts');
const loop = loadModule('services/style-chat/eliseImageStylingLoop.ts');

const OWNED_ID = '11111111-2222-4333-8444-555555555555';
const ACTOR = 'actor-1';

function draft(overrides = {}) {
  return {
    draftId: 'att_1',
    state: 'sent',
    selection: { closetCandidateId: 'cand-1', closetCandidateBatchId: 'batch-1', retryCount: 0 },
    resolved: null,
    summary: { title: 'Black satin midi dress', subtitle: 'Dresses', imageUri: null, itemCount: 1 },
    closetState: 'saved',
    closetItemId: OWNED_ID,
    ...overrides,
  };
}

/** Records exactly how the Closet was read, so the fail-open form is provable. */
function closetLoader(result, calls) {
  return (actorId, options) => {
    calls.push({ actorId, options });
    return Promise.resolve(result);
  };
}

function run(overrides = {}, deps = {}) {
  return anchor.preflightDressingRoomAnchor(
    {
      closetItemId: OWNED_ID,
      actorId: ACTOR,
      actorRequest: { actorId: ACTOR, epoch: 1 },
      ...overrides,
    },
    { featureEnabled: true, isActorCurrent: () => true, ...deps },
  );
}

const okCloset = { ok: true, items: [{ id: OWNED_ID, title: 'Black satin midi dress' }] };

// ── Decision 1: ownership ────────────────────────────────────────────────────

test('an unsaved candidate can never produce an anchor', () => {
  for (const closetState of ['not_saved', 'saving', 'save_failed']) {
    assert.equal(
      loop.resolveStyleTarget([draft({ closetState, closetItemId: null })], 'att_1'),
      null,
      `${closetState} must not anchor a Dressing Room`,
    );
  }
});

test('saved without a committed Closet id produces no anchor', () => {
  assert.equal(loop.resolveStyleTarget([draft({ closetItemId: '   ' })], 'att_1'), null);
  assert.equal(loop.resolveStyleTarget([draft({ closetItemId: null })], 'att_1'), null);
});

test('an anchor is re-derived from the live drafts, not from a captured chip', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(screen, /resolveStyleTarget\(chatAttachments\.attachments, draftId\)/);
  const handler =
    screen.match(/const openDressingRoomForActiveItem = useCallback\(([\s\S]*?)\n  \}, \[/)?.[1] ?? '';
  assert.ok(handler, 'the handoff handler must exist');
  // Ownership is decided BEFORE the Closet read, so an unentitled tap costs no
  // storage access.
  assert.ok(
    handler.indexOf('resolveStyleTarget') < handler.indexOf('preflightDressingRoomAnchor'),
    'ownership must be proved before the Closet is read',
  );
  assert.match(handler, /ELISE_IMAGE_LOOP_COPY\.ownershipBlockedMessage/);
});

test('a removed or unidentified attachment cannot be styled', () => {
  assert.equal(loop.resolveStyleTarget([], 'att_1'), null);
  assert.equal(loop.resolveStyleTarget([draft()], 'att_gone'), null);
  assert.equal(loop.resolveStyleTarget([draft({ state: 'identifying' })], 'att_1'), null);
});

// ── Decision 2: will the destination honour it ───────────────────────────────

test('a confirmed save anchors the Dressing Room with that item', async () => {
  const decision = await run({}, { loadCloset: closetLoader(okCloset, []) });
  assert.equal(decision.ok, true);
  assert.equal(decision.closetItemId, OWNED_ID);
  assert.equal(anchor.isAnchorRefused(decision), false);
});

test('an item missing from the actor Closet does not navigate', async () => {
  // resolveRouteAnchorIntent returns null when the id is absent, and the route
  // then styles something else without a word. Refusing here is the whole point.
  const coordinator = read('services/privateDressingRoomCoordinator.ts');
  assert.match(coordinator, /if \(findProjection\(view\.closetItems, routeId\) === null\) return null;/);

  const decision = await run({}, { loadCloset: closetLoader({ ok: true, items: [] }, []) });
  assert.equal(decision.reason, 'anchor_missing');
});

test('a row that cannot project is not treated as an anchor', async () => {
  // The destination reads through getClosetItemProjections; a row without an id
  // is dropped there, so it must be dropped here too.
  const decision = await run(
    {},
    { loadCloset: closetLoader({ ok: true, items: [{ title: 'no id' }, null] }, []) },
  );
  assert.equal(decision.reason, 'anchor_missing');
});

test('a Closet fault is reported as a fault, not as a missing item', async () => {
  const decision = await run({}, { loadCloset: closetLoader({ ok: false, items: [] }, []) });
  assert.equal(decision.reason, 'closet_unavailable');
});

test('a missing anchor refuses before any read', async () => {
  const calls = [];
  for (const closetItemId of [null, '', '   ', undefined]) {
    const decision = await run({ closetItemId }, { loadCloset: closetLoader(okCloset, calls) });
    assert.equal(decision.reason, 'no_anchor');
  }
  assert.equal(calls.length, 0);
});

// ── Actor safety ─────────────────────────────────────────────────────────────

test('the Closet is read for an EXPLICIT actor, never the fail-open form', async () => {
  const calls = [];
  await run({}, { loadCloset: closetLoader(okCloset, calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actorId, ACTOR, 'loadClosetTyped() with no actor reads every account');
  assert.equal(Array.from(Object.keys(calls[0].options)).join(','), 'actorRequest');

  const source = read('services/privateDressingRoomChatHandoff.ts');
  assert.match(source, /loadCloset\(actorId, \{ actorRequest: input\.actorRequest \}\)/);
  assert.ok(!/loadClosetTyped\(\)/.test(source), 'the argument-less loader must never be called');
});

test('no signed-in actor refuses before any read', async () => {
  const calls = [];
  for (const actorId of [null, '', '   ', undefined]) {
    const decision = await run({ actorId }, { loadCloset: closetLoader(okCloset, calls) });
    assert.equal(decision.reason, 'no_actor');
  }
  assert.equal(calls.length, 0);
});

test('an actor change between the tap and the read rejects the handoff', async () => {
  const decision = await run(
    {},
    { loadCloset: closetLoader(okCloset, []), isActorCurrent: () => false },
  );
  assert.equal(decision.reason, 'actor_changed');
});

test('the flag being off refuses instead of navigating nowhere', async () => {
  const calls = [];
  const decision = await run({}, { featureEnabled: false, loadCloset: closetLoader(okCloset, calls) });
  assert.equal(decision.reason, 'feature_disabled');
  assert.equal(calls.length, 0);
});

// ── Refusal surface ──────────────────────────────────────────────────────────

test('every refusal has bounded, honest copy and leaks nothing', () => {
  for (const reason of Array.from(anchor.DRESSING_ROOM_ANCHOR_REFUSALS)) {
    const message = anchor.DRESSING_ROOM_ANCHOR_MESSAGES[reason];
    assert.ok(message && message.trim(), `${reason} needs a message`);
    assert.ok(!/https?:\/\/|file:\/\/|\/Users\/|C:\\/.test(message), `${reason} leaks a path or URL`);
    assert.ok(message.length < 140, `${reason} message is unbounded`);
  }
  const source = read('services/privateDressingRoomChatHandoff.ts');
  assert.ok(!source.includes('error.message'), 'a raw error string must never become a reason');
});

// ── Build 3 reuse, not reimplementation ──────────────────────────────────────

test('the preflight builds no styling of its own and writes nothing', () => {
  const source = read('services/privateDressingRoomChatHandoff.ts');
  for (const forbidden of [
    'startActiveSession',
    'updateActiveSession',
    'composeAndPersist',
    'setActiveLook',
    'savePrivateSavedLook',
    'privateDressingRoomComposer',
    'privateDressingRoomSessionStore',
    'privateDressingRoomCompositionStore',
  ]) {
    assert.ok(!source.includes(forbidden), `the preflight must not call ${forbidden}`);
  }
  // Anchored patterns, not bare substrings: `closetItemId` contains "setItem",
  // and a naive scan would fail on the identifier this module is about.
  for (const forbidden of [/\.setItem\(/, /AsyncStorage/, /\bsupabase\b/, /\.insert\(/, /\.upsert\(/]) {
    assert.ok(!forbidden.test(source), `the preflight must not persist via ${forbidden}`);
  }
});

test('the Elise/Closet transaction gate still holds', () => {
  // Reading the Closet is a Dressing Room concern, which is why this module sits
  // beside privateDressingRoomLifecycle.ts rather than under services/style-chat.
  const lifecycle = read('services/privateDressingRoomLifecycle.ts');
  assert.match(lifecycle, /from '\.\/closetLibrary'/);

  for (const rel of [
    'services/style-chat/eliseImageStylingLoop.ts',
    'app/style-chat/[sessionId].tsx',
    'components/style-chat/StyleChatFollowUpBar.tsx',
    'components/style-chat/StyleChatActiveItemBar.tsx',
  ]) {
    const source = read(rel);
    for (const orchestrator of ['closetLibrary', 'closetPromotion', 'useCloset']) {
      assert.ok(
        !new RegExp(`from\\s+['"][^'"]*${orchestrator}['"]`).test(source),
        `${rel} must not import ${orchestrator}`,
      );
    }
  }

  // And the preflight knows nothing about chat: the caller supplies the anchor.
  // Comments are stripped first — this is a claim about the CODE, and prose that
  // explains the boundary must not be mistaken for crossing it.
  const code = read('services/privateDressingRoomChatHandoff.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['DraftAttachment', 'styleChat', 'eliseImageStylingLoop', 'attachment']) {
    assert.ok(!code.includes(forbidden), `the preflight must not know about ${forbidden}`);
  }
});

test('the anchor is handed to the existing route contract', () => {
  const source = read('services/privateDressingRoomChatHandoff.ts');
  assert.match(source, /PRIVATE_DRESSING_ROOM_ROUTE = '\/stylist\/dressing-room'/);

  // The same pathname + params shape app/library.tsx already uses.
  const library = read('app/library.tsx');
  assert.match(library, /pathname: '\/stylist\/dressing-room',\s*params: \{ closetItemId: id \}/);

  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(screen, /pathname: PRIVATE_DRESSING_ROOM_ROUTE/);
  assert.match(screen, /params: dressingRoomAnchorParams\(decision\.closetItemId\)/);

  // And the route turns that param into the anchor through Build 3's own path:
  // create-or-reuse the session, compose, persist the active Look, render it.
  const route = read('app/stylist/dressing-room/index.tsx');
  assert.match(route, /usePrivateDressingRoom\(params\?\.closetItemId\)/);
  const hook = read('hooks/usePrivateDressingRoom.ts');
  assert.match(hook, /resolveRouteAnchorIntent\(view, routeClosetItemId\)/);
  assert.match(hook, /startSession\(\{ anchorClosetItemId: intent \}\)/);
  assert.match(hook, /requestContextChange\(\{ kind: 'anchor', anchorClosetItemId: intent \}\)/);
});

// ── Rapid-tap protection ─────────────────────────────────────────────────────

test('rapid taps produce one session operation and one navigation', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  const handler =
    screen.match(/const openDressingRoomForActiveItem = useCallback\(([\s\S]*?)\n  \}, \[/)?.[1] ?? '';
  assert.ok(handler, 'the handoff handler must exist');

  // A ref claimed BEFORE the first await. State would not be committed in time,
  // and a timer would only narrow the race.
  assert.match(handler, /if \(styleHandoffRef\.current\) return;/);
  const claim = handler.indexOf('styleHandoffRef.current = true');
  const firstAwait = handler.indexOf('preflightDressingRoomAnchor');
  assert.ok(claim > -1 && firstAwait > -1 && claim < firstAwait, 'claim before the first await');
  assert.match(screen, /const styleHandoffRef = useRef\(false\);/);
  assert.ok(!/setTimeout/.test(handler), 'the latch must not be a timer');

  // Released only on a refusal path; on success the destination owns the
  // interaction and the focus effect clears it when the user comes back.
  assert.equal(
    (handler.match(/styleHandoffRef\.current = false/g) ?? []).length,
    3,
    'released on the ownership refusal, the anchor refusal, and a throw — nowhere else',
  );
  assert.match(
    screen,
    /useFocusEffect\(\s*useCallback\(\(\) => \{\s*styleHandoffRef\.current = false;/,
  );

  // One push, one place.
  assert.equal(
    (screen.match(/router\.push\(\{\s*pathname: PRIVATE_DRESSING_ROOM_ROUTE/g) ?? []).length,
    1,
  );
});

test('all three navigating follow-ups reach the one guarded handoff', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  for (const handlerName of ['onStyleThisItem', 'onOpenDressingRoom', 'onChangeSomething']) {
    assert.match(screen, new RegExp(`${handlerName}: openDressingRoomForActiveItem`));
  }
});

test('the handoff mark is client-only and never becomes ownership', () => {
  const hook = read('hooks/useStyleChatAttachments.ts');
  const mark =
    hook.match(/const markStyledInDressingRoom = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.ok(mark, 'markStyledInDressingRoom must exist');
  assert.match(mark, /if \(!live \|\| live\.styledInDressingRoom === true\) return;/);
  assert.ok(!mark.includes('closetState'), 'the mark must not touch Closet state');
  assert.ok(!mark.includes('closetItemId'), 'the mark must not touch the Closet id');

  const loopSource = read('services/style-chat/eliseImageStylingLoop.ts');
  // Ownership stays both-halves, independent of the styled mark.
  assert.match(loopSource, /owned: closetState === 'saved' && closetItemId !== null,/);

  // Styling an item does not duplicate it: the mark is a flag, not a new record.
  assert.ok(!mark.includes('upsertDraftAttachment'), 'the mark must not add a draft');
  assert.match(mark, /updateDraftAttachment\(sessionId, \{/);
});
