// Build 5 Phase 2 — Today → Private Dressing Room handoff.
//
// Every dependency is injected, so the whole sequence runs here: rapid taps,
// an actor switch mid-flight, a deleted garment, a failed session, a Look that
// persists but cannot be read back, and the successful path. What a device can
// add is confirmation; what it cannot add is coverage of the races below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

if (!Module._extensions['.ts']) {
  Module._extensions['.ts'] = function compileTs(module, filename) {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    module._compile(out, filename);
  };
}

const handoff = require(path.join(ROOT, 'services/todayWithElise/handoff.ts'));
const actionRouting = require(path.join(ROOT, 'services/todayWithElise/actionRouting.ts'));

const hookSource = fs.readFileSync(path.join(ROOT, 'hooks/useTodayWithElise.ts'), 'utf8');

const ACTOR = 'actor-a';
const TOKEN = 'today_1_1';
const ROUTE = '/stylist/dressing-room';

function card(overrides = {}) {
  return {
    stateId: 'today_owned_look',
    actorId: ACTOR,
    actorEpoch: 1,
    generationToken: TOKEN,
    headlineKey: 'headline.today_owned_look',
    explanationKey: 'explanation.today_owned_look',
    primaryAction: {
      action: 'tap_to_get_ready',
      labelKey: 'action.tap_to_get_ready',
      target: 'private_dressing_room',
      runnable: true,
    },
    secondaryAction: {
      action: 'change_something',
      labelKey: 'action.change_something',
      target: 'elise_modification',
      runnable: true,
    },
    itemRefs: [{ closetItemId: 'item-top', slot: 'top' }],
    completeness: 'complete',
    source: 'owned_closet_composition',
    weatherDependent: false,
    dressingRoomDependent: true,
    analyticsClass: 'eligible',
    safeFallbackStateId: 'fallback',
    priority: 'today_owned_look',
    ...overrides,
  };
}

/**
 * A recording harness over the injected Build 3 surface.
 *
 * `delayMs` makes the session step genuinely asynchronous, which is what turns
 * "rapid taps create one session" into a real race rather than a formality.
 */
function harness(options = {}) {
  const calls = {
    startSession: 0,
    composeAndPersist: 0,
    setActiveLook: 0,
    loadComposition: 0,
    navigate: [],
    events: [],
  };
  let clock = options.startClock ?? 1_000_000;
  let actor = { actorId: ACTOR, epoch: 1 };

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const deps = {
    startSession: async () => {
      calls.startSession += 1;
      await settle();
      if (options.sessionFails) return { ok: false, session: null };
      return {
        ok: true,
        session: {
          sessionId: 'session-1',
          actorId: ACTOR,
          status: 'active',
          anchorClosetItemId: 'item-top',
          occasion: null,
        },
      };
    },
    loadCloset: async () => {
      await settle();
      if (options.closetFails) return { ok: false, items: [] };
      return { ok: true, items: options.closetItems ?? [{ id: 'item-top' }] };
    },
    project: (items) => items,
    composeAndPersist: async () => {
      calls.composeAndPersist += 1;
      await settle();
      if (options.composeFails) return { composition: null };
      return { composition: { looks: [{ lookId: 'look-1' }] } };
    },
    setActiveLook: async () => {
      calls.setActiveLook += 1;
      await settle();
      return options.activateFails ? { ok: false } : { ok: true, stale: false };
    },
    loadComposition: async () => {
      calls.loadComposition += 1;
      await settle();
      if (options.readbackFails) return { ok: false, composition: null };
      if (options.readbackHasNoActiveLook) {
        return { ok: true, composition: { activeLookId: null } };
      }
      return { ok: true, composition: { activeLookId: 'look-1' } };
    },
    fingerprintFor: () => 'fp-1',
    createActorRequest: () => ({ actorId: actor.actorId, epoch: actor.epoch }),
    isActorRequestCurrent: (request) =>
      request.actorId === actor.actorId && request.epoch === actor.epoch,
    liveActor: () => actor,
    navigate: (route) => calls.navigate.push(route),
    emit: (event, payload) => calls.events.push({ event, payload }),
    now: () => clock,
  };

  return {
    deps,
    calls,
    advance: (ms) => {
      clock += ms;
    },
    switchActor: (nextId) => {
      actor = { actorId: nextId, epoch: actor.epoch + 1 };
    },
  };
}

function input(overrides = {}) {
  return {
    card: card(),
    generationToken: TOKEN,
    actorId: ACTOR,
    actorEpoch: 1,
    anchorClosetItemId: 'item-top',
    occasion: null,
    route: ROUTE,
    dressingRoomActive: true,
    analyticsPayload: { stateId: 'today_owned_look' },
    isCardCurrent: () => true,
    ...overrides,
  };
}

test.beforeEach(() => {
  handoff.__resetTodayHandoffLocks();
  actionRouting.__resetTodayPrimaryActionDedupe();
});

// ── The successful sequence ──────────────────────────────────────────────────

test('a successful handoff opens the Dressing Room exactly once', async () => {
  const h = harness();
  const result = await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(result.outcome, 'opened');
  assert.equal(h.calls.startSession, 1);
  assert.deepEqual(h.calls.navigate, [ROUTE]);
});

test('the Look is hydrated and made active BEFORE navigation', async () => {
  const order = [];
  const h = harness();
  const deps = {
    ...h.deps,
    setActiveLook: async (...args) => {
      order.push('setActiveLook');
      return h.deps.setActiveLook(...args);
    },
    loadComposition: async (...args) => {
      order.push('readback');
      return h.deps.loadComposition(...args);
    },
    navigate: (route) => {
      order.push('navigate');
      h.calls.navigate.push(route);
    },
  };
  await handoff.openTodayDressingRoom(deps, input());
  assert.deepEqual(order, ['setActiveLook', 'readback', 'navigate']);
});

test('the destination proves it can read the Look before we navigate', async () => {
  const h = harness();
  await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(h.calls.loadComposition, 1);
});

test('exactly one action event and one opened event are emitted', async () => {
  const h = harness();
  await handoff.openTodayDressingRoom(h.deps, input());
  const names = h.calls.events.map((e) => e.event);
  assert.deepEqual(names, [
    'today_with_elise_primary_action',
    'today_with_elise_dressing_room_opened',
  ]);
});

test('the handoff carries the bounded source attribution', () => {
  assert.equal(actionRouting.TODAY_WITH_ELISE_SOURCE_ATTRIBUTION, 'today_with_elise');
  const intent = actionRouting.buildTapToGetReadyIntent({
    actorId: ACTOR,
    itemRefs: [],
    generationToken: TOKEN,
  });
  assert.equal(intent.source, 'today_with_elise');
  assert.equal(intent.automaticCommerce, false);
  assert.equal(intent.useBuild3OwnershipResolution, true);
  assert.equal(intent.loadRecommendedLookImmediately, true);
});

// ── Rapid taps ───────────────────────────────────────────────────────────────

test('three taps within 500 ms produce one session, one navigation, one event', async () => {
  const h = harness();
  const first = handoff.openTodayDressingRoom(h.deps, input());
  h.advance(200);
  const second = handoff.openTodayDressingRoom(h.deps, input());
  h.advance(200);
  const third = handoff.openTodayDressingRoom(h.deps, input());
  const results = await Promise.all([first, second, third]);

  assert.equal(results.filter((r) => r.outcome === 'opened').length, 1);
  assert.equal(h.calls.startSession, 1, 'more than one session operation ran');
  assert.equal(h.calls.navigate.length, 1);
  assert.equal(
    h.calls.events.filter((e) => e.event === 'today_with_elise_primary_action').length,
    1,
  );
  assert.equal(
    h.calls.events.filter((e) => e.event === 'today_with_elise_dressing_room_opened').length,
    1,
  );
});

test('a tap while the operation is pending is ignored, never duplicated', async () => {
  const h = harness();
  const first = handoff.openTodayDressingRoom(h.deps, input());
  // Push the clock past the debounce window: the LOCK, not the timer, must
  // be what refuses the second tap. This is the case a timer alone misses.
  h.advance(actionRouting.TODAY_PRIMARY_ACTION_DEDUPE_MS + 500);
  const second = await handoff.openTodayDressingRoom(h.deps, input());
  await first;
  assert.equal(second.outcome, 'ignored_in_flight');
  assert.equal(h.calls.startSession, 1);
  assert.equal(h.calls.navigate.length, 1);
});

test('the lock is released after a failure so a retry is possible', async () => {
  const h = harness({ sessionFails: true });
  const failed = await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(failed.outcome, 'failed_session');
  assert.equal(
    handoff.isTodayHandoffInFlight(
      handoff.todayHandoffLockKey({ actorId: ACTOR, generationToken: TOKEN, action: 'primary' }),
    ),
    false,
  );
});

test('the lock is released after success', async () => {
  const h = harness();
  await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(
    handoff.isTodayHandoffInFlight(
      handoff.todayHandoffLockKey({ actorId: ACTOR, generationToken: TOKEN, action: 'primary' }),
    ),
    false,
  );
});

test('the lock is scoped to actor, generation and action', () => {
  const base = { actorId: ACTOR, generationToken: TOKEN, action: 'primary' };
  assert.notEqual(
    handoff.todayHandoffLockKey(base),
    handoff.todayHandoffLockKey({ ...base, actorId: 'actor-b' }),
  );
  assert.notEqual(
    handoff.todayHandoffLockKey(base),
    handoff.todayHandoffLockKey({ ...base, generationToken: 'today_1_2' }),
  );
  assert.notEqual(
    handoff.todayHandoffLockKey(base),
    handoff.todayHandoffLockKey({ ...base, action: 'secondary' }),
  );
});

// ── Actor and generation safety ──────────────────────────────────────────────

test('an actor switch before the tap refuses the handoff', async () => {
  const h = harness();
  h.switchActor('actor-b');
  const result = await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(result.outcome, 'refused_actor_changed');
  assert.equal(h.calls.startSession, 0);
  assert.equal(h.calls.navigate.length, 0);
  assert.equal(h.calls.events.length, 0);
});

test('an actor switch mid-flight rejects the completion and does not navigate', async () => {
  const h = harness();
  const pending = handoff.openTodayDressingRoom(h.deps, input());
  h.switchActor('actor-b');
  const result = await pending;
  assert.equal(result.outcome, 'refused_actor_changed');
  assert.equal(h.calls.navigate.length, 0);
  assert.equal(h.calls.events.length, 0);
});

test('a stale card generation refuses the handoff', async () => {
  const h = harness();
  const result = await handoff.openTodayDressingRoom(
    h.deps,
    input({ isCardCurrent: () => false }),
  );
  assert.equal(result.outcome, 'refused_stale_card');
  assert.equal(h.calls.startSession, 0);
  assert.equal(h.calls.events.length, 0);
});

test('a card whose token no longer matches the generation refuses', async () => {
  const h = harness();
  const result = await handoff.openTodayDressingRoom(
    h.deps,
    input({ card: card({ generationToken: 'today_1_9' }) }),
  );
  assert.equal(result.outcome, 'refused_stale_card');
});

test('a card generation change mid-flight rejects the stale action', async () => {
  const h = harness();
  let current = TOKEN;
  const pending = handoff.openTodayDressingRoom(
    h.deps,
    input({ isCardCurrent: () => current === TOKEN }),
  );
  current = 'today_1_2';
  const result = await pending;
  assert.notEqual(result.outcome, 'opened');
  assert.equal(h.calls.navigate.length, 0);
});

// ── Dependency and data refusals ─────────────────────────────────────────────

test('the handoff refuses outright when the dependency is unavailable', async () => {
  const h = harness();
  const result = await handoff.openTodayDressingRoom(
    h.deps,
    input({ dressingRoomActive: false }),
  );
  assert.equal(result.outcome, 'refused_dependency_unavailable');
  assert.equal(h.calls.startSession, 0);
  assert.equal(h.calls.navigate.length, 0);
  assert.equal(h.calls.events.length, 0);
});

test('a garment deleted since the card was built refuses before any session work', async () => {
  const h = harness({ closetItems: [{ id: 'something-else' }] });
  const result = await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(result.outcome, 'refused_items_unavailable');
  assert.equal(h.calls.startSession, 0);
  assert.equal(h.calls.navigate.length, 0);
  assert.match(result.message, /no longer in your Closet/);
});

test('session creation failure stays on Home with bounded copy', async () => {
  const h = harness({ sessionFails: true });
  const result = await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(result.outcome, 'failed_session');
  assert.equal(h.calls.navigate.length, 0);
  assert.equal(h.calls.events.length, 0);
  assert.match(result.message, /Try again\.$/);
  assert.doesNotMatch(result.message, /error|undefined|null|Error/i);
});

test('hydration failure does not navigate to a blank room', async () => {
  for (const mode of [{ composeFails: true }, { activateFails: true }]) {
    handoff.__resetTodayHandoffLocks();
    actionRouting.__resetTodayPrimaryActionDedupe();
    const h = harness(mode);
    const result = await handoff.openTodayDressingRoom(h.deps, input());
    assert.equal(result.outcome, 'failed_hydration');
    assert.equal(h.calls.navigate.length, 0);
    assert.equal(h.calls.events.length, 0);
  }
});

test('a Look that persists but cannot be read back does not navigate', async () => {
  const h = harness({ readbackFails: true });
  const result = await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(result.outcome, 'failed_unreadable');
  assert.equal(h.calls.navigate.length, 0);
});

test('a readable composition with no active Look does not navigate', async () => {
  const h = harness({ readbackHasNoActiveLook: true });
  const result = await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(result.outcome, 'failed_unreadable');
  assert.equal(h.calls.navigate.length, 0);
});

test('a Closet that will not load is a failure, not an empty Look', async () => {
  const h = harness({ closetFails: true });
  const result = await handoff.openTodayDressingRoom(h.deps, input());
  assert.equal(result.outcome, 'failed_session');
  assert.equal(h.calls.startSession, 0);
});

// ── Change Something ─────────────────────────────────────────────────────────

test('Change Something reuses the active Look and creates no session', () => {
  const h = harness();
  const result = handoff.openTodayEliseModification(h.deps, {
    card: card(),
    generationToken: TOKEN,
    actorId: ACTOR,
    actorEpoch: 1,
    route: ROUTE,
    dressingRoomActive: true,
    eliseModificationActive: true,
    analyticsPayload: { stateId: 'today_owned_look' },
    isCardCurrent: () => true,
  });
  assert.equal(result.outcome, 'opened');
  assert.equal(h.calls.startSession, 0);
  assert.equal(h.calls.composeAndPersist, 0);
  assert.deepEqual(h.calls.navigate, [ROUTE]);
});

test('Change Something is refused when the modification flow is unavailable', () => {
  const h = harness();
  const result = handoff.openTodayEliseModification(h.deps, {
    card: card(),
    generationToken: TOKEN,
    actorId: ACTOR,
    actorEpoch: 1,
    route: ROUTE,
    dressingRoomActive: true,
    eliseModificationActive: false,
    analyticsPayload: {},
    isCardCurrent: () => true,
  });
  assert.equal(result.outcome, 'refused_dependency_unavailable');
  assert.equal(h.calls.navigate.length, 0);
  assert.equal(h.calls.events.length, 0);
});

test('Change Something preserves actor identity and refuses after a switch', () => {
  const h = harness();
  h.switchActor('actor-b');
  const result = handoff.openTodayEliseModification(h.deps, {
    card: card(),
    generationToken: TOKEN,
    actorId: ACTOR,
    actorEpoch: 1,
    route: ROUTE,
    dressingRoomActive: true,
    eliseModificationActive: true,
    analyticsPayload: {},
    isCardCurrent: () => true,
  });
  assert.equal(result.outcome, 'refused_actor_changed');
  assert.equal(h.calls.navigate.length, 0);
});

test('rapid Change Something taps navigate once', () => {
  const h = harness();
  const base = {
    card: card(),
    generationToken: TOKEN,
    actorId: ACTOR,
    actorEpoch: 1,
    route: ROUTE,
    dressingRoomActive: true,
    eliseModificationActive: true,
    analyticsPayload: {},
    isCardCurrent: () => true,
  };
  handoff.openTodayEliseModification(h.deps, base);
  h.advance(100);
  handoff.openTodayEliseModification(h.deps, base);
  h.advance(100);
  handoff.openTodayEliseModification(h.deps, base);
  assert.equal(h.calls.navigate.length, 1);
  assert.equal(
    h.calls.events.filter((e) => e.event === 'today_with_elise_secondary_action').length,
    1,
  );
});

test('Change Something introduces no route parameter of its own', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/todayWithElise/handoff.ts'), 'utf8');
  // Scanned against CODE. The file's own comment names `?mode=modify` and
  // `modifyLook()` as the contracts it refuses to invent, and a naive substring
  // scan would read that explanation as the violation.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /mode=modify|modifyLook\(|\?look=|createLook\(/);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('the hook binds the handoff to existing Build 3 modules only', () => {
  assert.match(hookSource, /startActiveSession\(actorRequest, input\)/);
  assert.match(hookSource, /composeAndPersistComposition\(/);
  assert.match(hookSource, /setActiveLook\(actorRequest, input\)/);
  assert.match(hookSource, /loadCompositionSet\(actorRequest, fingerprint\)/);
});

test('no runnable-less action is ever given a handler', () => {
  assert.match(hookSource, /onPrimaryPress: card\?\.primaryAction\?\.runnable \? onPrimaryPress : undefined/);
  assert.match(
    hookSource,
    /onSecondaryPress: card\?\.secondaryAction\?\.runnable \? onSecondaryPress : undefined/,
  );
});
