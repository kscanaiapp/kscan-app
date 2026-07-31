// Build 5 Phase 2 — no dead actions when a Build 3 dependency is unavailable.
//
// Private Dressing Room production flags are OFF and stay OFF. This suite is
// what proves the card behaves correctly in exactly that configuration: it
// offers a Closet action, onboarding or the fallback, and it never shows a
// control whose destination cannot act.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
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

function loadFlags(env) {
  const full = path.join(ROOT, 'constants/featureFlags.ts');
  const mod = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(
    source,
    { module: mod, exports: mod.exports, require: (r) => require(r), console, Object, Array, Map, Set, Number, String, JSON, process: { env }, __DEV__: false },
    { filename: full },
  );
  return mod.exports;
}

const orchestrator = require(path.join(ROOT, 'services/todayWithElise/orchestrator.ts'));
const presentation = require(path.join(ROOT, 'services/todayWithElise/presentation.ts'));
const reporting = require(path.join(ROOT, 'services/todayWithElise/reporting.ts'));

const hookSource = fs.readFileSync(path.join(ROOT, 'hooks/useTodayWithElise.ts'), 'utf8');
const cardSource = fs.readFileSync(
  path.join(ROOT, 'components/home/TodayWithEliseCard.tsx'),
  'utf8',
);

const NOW = Date.parse('2026-07-30T09:00:00Z');
const ACTOR = 'actor-a';

function closetItem(id, category) {
  return {
    id,
    title: id,
    category,
    clothingType: category,
    subtype: null,
    brand: null,
    primaryColor: 'Black',
    secondaryColors: [],
    material: [],
    size: null,
    notes: null,
    origin: null,
    imageUri: null,
    thumbnailUri: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    displaySummary: null,
    taxonomyUnknown: false,
  };
}

const CLOSET = [
  closetItem('item-top', 'Tops'),
  closetItem('item-bottom', 'Bottoms'),
  closetItem('item-shoes', 'Shoes'),
];

const COLLABORATORS = {
  project: (items) => items,
  classifySlot: (item) =>
    ({ primarySlot: { Tops: 'top', Bottoms: 'bottom', Shoes: 'footwear' }[item.category] ?? null }),
  compose: () => ({
    code: 'SUCCESS',
    looks: [
      {
        lookId: 'look-1',
        items: [
          { slot: 'top', closetItemId: 'item-top' },
          { slot: 'bottom', closetItemId: 'item-bottom' },
          { slot: 'footwear', closetItemId: 'item-shoes' },
        ],
      },
    ],
  }),
};

function evaluateWith(dressingRoomActive, readsOverride = {}) {
  const built = orchestrator.buildTodaySnapshot({
    handle: { actorId: ACTOR, actorEpoch: 1, generationToken: 'today_1_1' },
    reads: {
      closet: { ok: true, items: CLOSET },
      session: {
        ok: true,
        session: {
          sessionId: 'session-1',
          actorId: ACTOR,
          status: 'active',
          anchorClosetItemId: null,
          occasion: null,
          createdAt: new Date(NOW - 1000).toISOString(),
          updatedAt: new Date(NOW - 1000).toISOString(),
        },
      },
      composition: {
        ok: true,
        stale: false,
        composition: {
          compositionId: 'composition-1',
          activeLookId: 'look-1',
          inputFingerprint: 'fp-1',
          looks: [{ lookId: 'look-1', items: [{ slot: 'top', closetItemId: 'item-top' }] }],
        },
      },
      savedLooks: { ok: true, looks: [] },
      candidates: { ok: true, candidates: [] },
      ...readsOverride,
    },
    capabilities: {
      todayWithEliseActive: true,
      privateDressingRoomActive: dressingRoomActive,
      weatherActive: false,
      generatedGreetingActive: false,
      closetReviewActive: true,
    },
    collaborators: COLLABORATORS,
    nowMs: NOW,
  });
  return orchestrator.evaluateTodaySnapshot(built);
}

// ── The production configuration ─────────────────────────────────────────────

test('Private Dressing Room production flags are OFF and Build 5 leaves them so', () => {
  const flags = loadFlags({});
  assert.equal(flags.PRIVATE_DRESSING_ROOM_V1, false);
  assert.equal(flags.PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE, false);
  assert.equal(flags.PRIVATE_DRESSING_ROOM_ELISE_ACTIVE, false);
  assert.equal(flags.PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE, false);
});

test('Today reads the existing Build 3 gates and defines no availability flag', () => {
  assert.match(hookSource, /PRIVATE_DRESSING_ROOM_V1/);
  assert.match(hookSource, /PRIVATE_DRESSING_ROOM_ELISE_ACTIVE/);
  // No second flag system, no route probe, no Home-specific capability test.
  assert.doesNotMatch(hookSource, /TODAY_DRESSING_ROOM_AVAILABLE|canOpenDressingRoom\s*=|routeExists|Linking\.canOpenURL/);
  assert.doesNotMatch(hookSource, /process\.env/);
});

// ── With the dependency unavailable ──────────────────────────────────────────

test('no Dressing Room state is selected when the workspace is unavailable', () => {
  const result = evaluateWith(false);
  assert.ok(
    !['unfinished_look', 'today_owned_look', 'recent_styling', 'partial_look'].includes(
      result.card.stateId,
    ),
    `selected ${result.card.stateId}`,
  );
});

test('the card falls through to a Closet action', () => {
  const result = evaluateWith(false);
  assert.equal(result.card.stateId, 'closet_action');
  assert.equal(result.card.dressingRoomDependent, false);
});

test('it falls through to onboarding for an empty Closet', () => {
  const result = evaluateWith(false, { closet: { ok: true, items: [] } });
  assert.equal(result.card.stateId, 'onboarding');
  assert.equal(result.card.primaryAction.target, 'closet_intake');
});

test('Tap to Get Ready is never offered', () => {
  const result = evaluateWith(false);
  assert.notEqual(result.card.primaryAction.action, 'tap_to_get_ready');
});

test('Continue Your Look is never offered', () => {
  const result = evaluateWith(false);
  assert.notEqual(result.card.primaryAction.action, 'continue_your_look');
});

test('Open Look is never offered', () => {
  const result = evaluateWith(false);
  assert.notEqual(result.card.primaryAction.action, 'open_look');
});

test('Change Something is never offered', () => {
  const result = evaluateWith(false);
  assert.equal(result.card.secondaryAction, null);
});

test('no action targets the Dressing Room', () => {
  const result = evaluateWith(false);
  assert.notEqual(result.card.primaryAction.target, 'private_dressing_room');
  assert.notEqual(result.card.primaryAction.target, 'elise_modification');
  assert.equal(result.card.secondaryAction, null);
});

test('every emitted primary action is runnable', () => {
  for (const active of [true, false]) {
    for (const closet of [CLOSET, []]) {
      const result = evaluateWith(active, { closet: { ok: true, items: closet } });
      const primary = result.card.primaryAction;
      if (primary.action !== 'none') {
        assert.equal(primary.runnable, true, `${result.card.stateId} emitted a dead primary`);
      }
    }
  }
});

// ── Capability projection: the Elise modification gate ───────────────────────

test('Change Something is dropped when the Elise modification flow is off', () => {
  const result = evaluateWith(true);
  assert.equal(result.card.secondaryAction?.target, 'elise_modification');
  const gated = presentation.projectCapabilityGatedActions(result.card, {
    dressingRoomActive: true,
    eliseModificationActive: false,
  });
  assert.equal(gated.secondaryAction, null);
  // The primary is untouched: opening the workspace does not need Elise.
  assert.equal(gated.primaryAction.action, result.card.primaryAction.action);
});

test('Change Something survives only when both gates are on', () => {
  const result = evaluateWith(true);
  const gated = presentation.projectCapabilityGatedActions(result.card, {
    dressingRoomActive: true,
    eliseModificationActive: true,
  });
  assert.equal(gated.secondaryAction?.target, 'elise_modification');
});

test('the capability projection is defence in depth, not the live primary path', () => {
  // The engine already refuses to select a Dressing Room state with the
  // workspace off, so the primary downgrade below must be unreachable in
  // practice — which is exactly what makes it a safe backstop.
  const result = evaluateWith(false);
  const gated = presentation.projectCapabilityGatedActions(result.card, {
    dressingRoomActive: false,
    eliseModificationActive: false,
  });
  assert.deepEqual(gated, result.card);
});

test('a forged Dressing Room primary is downgraded to no action', () => {
  const forged = {
    ...evaluateWith(false).card,
    primaryAction: {
      action: 'tap_to_get_ready',
      labelKey: 'action.tap_to_get_ready',
      target: 'private_dressing_room',
      runnable: true,
    },
  };
  const gated = presentation.projectCapabilityGatedActions(forged, {
    dressingRoomActive: false,
    eliseModificationActive: false,
  });
  assert.equal(gated.primaryAction.action, 'none');
  assert.equal(gated.primaryAction.runnable, false);
});

test('the gated card renders no button at all', () => {
  const forged = {
    ...evaluateWith(false).card,
    primaryAction: {
      action: 'tap_to_get_ready',
      labelKey: 'action.tap_to_get_ready',
      target: 'private_dressing_room',
      runnable: true,
    },
  };
  const gated = presentation.projectCapabilityGatedActions(forged, {
    dressingRoomActive: false,
    eliseModificationActive: false,
  });
  const view = presentation.projectTodayCard({
    card: gated,
    projections: CLOSET,
    missingSlots: [],
    nowMs: NOW,
  });
  assert.equal(view.primaryLabel, null);
  assert.equal(view.secondaryLabel, null);
  assert.equal(view.actionless, true);
});

// ── No navigation, no session, no success event ──────────────────────────────

test('the card component performs no navigation of its own', () => {
  assert.doesNotMatch(cardSource, /router\.|useRouter|navigate\(/);
});

test('the card component creates no Dressing Room session', () => {
  assert.doesNotMatch(cardSource, /startActiveSession|updateActiveSession|setActiveLook/);
});

test('a fallback-class card emits no dressing-room-opened event', () => {
  const events = [];
  reporting.reportTodayCardCommitted({
    card: evaluateWith(false).card,
    platform: 'ios',
    emit: (event, payload) => events.push(event),
    emitImpression: () => true,
  });
  assert.ok(!events.includes('today_with_elise_dressing_room_opened'));
  assert.ok(!events.includes('today_with_elise_primary_action'));
});

test('Home stays fully usable: the disabled path renders a card, never a block', () => {
  const view = presentation.projectTodayCard({
    card: evaluateWith(false).card,
    projections: CLOSET,
    missingSlots: [],
    nowMs: NOW,
  });
  assert.ok(view.explanation.length > 0);
  assert.doesNotMatch(view.explanation, /unavailable|disabled|not available|error/i);
});
