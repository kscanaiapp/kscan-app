// Composition coordinator integration (Phase 2, Stage 6).
//
// The pure coordinator additions are exercised directly. The hook's
// orchestration CONTRACT — sequencing, guards, and what it may not do — is
// asserted against source, in the style of this repository's other route tests,
// since the suite has no React renderer. End-to-end lifecycle behaviour with the
// real stores lives in __tests__/privateDressingRoomPhase2Integration.test.js.
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
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  vm.runInThisContext(`(function (exports, module, require) {\n${output}\n})`, { filename })(
    mod.exports,
    mod,
    localRequire,
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const coordinator = loadModule('services/privateDressingRoomCoordinator.ts');
const projection = loadModule('services/closetItemProjection.ts');

const HOOK = fs.readFileSync(path.join(ROOT, 'hooks/usePrivateDressingRoom.ts'), 'utf8');
// The hydration ordering the hook used to contain now lives in a production
// module that both the hook and the lifecycle suite call (P3-B3), so the
// orchestration contract is asserted against whichever file owns each rule.
const LIFECYCLE = fs.readFileSync(
  path.join(ROOT, 'services/privateDressingRoomLifecycle.ts'),
  'utf8',
);
const WORKSPACE = `${HOOK}\n${LIFECYCLE}`;

function project(id, fields = {}) {
  return projection.getClosetItemProjection({ id, title: id, ...fields });
}

function session(overrides = {}) {
  return {
    sessionId: 'drsession_1',
    actorId: 'user-a',
    anchorClosetItemId: null,
    occasion: null,
    status: 'active',
    createdAt: '2026-07-28T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

function look(overrides = {}) {
  return {
    lookId: 'drlook_0',
    rank: 0,
    completeness: 'complete',
    missingSlots: [],
    labelCodes: ['NO_PURCHASE_NEEDED'],
    items: [
      { slot: 'top', closetItemId: 'c-top' },
      { slot: 'bottom', closetItemId: 'c-bottom' },
      { slot: 'footwear', closetItemId: 'c-shoes' },
    ],
    ...overrides,
  };
}

const CLOSET = [project('c-top'), project('c-bottom'), project('c-shoes'), project('c-coat')];

// ── Error code vocabulary ────────────────────────────────────────────────────

test('every mandated coordinator error code is declared', () => {
  for (const code of [
    'FEATURE_DISABLED',
    'ACTOR_UNAVAILABLE',
    'ACTOR_CHANGED',
    'CLOSET_LOAD_FAILED',
    'CLOSET_EMPTY',
    'SESSION_MISSING',
    'SESSION_CONTEXT_REQUIRED',
    'ANCHOR_MISSING',
    'UNSUPPORTED_ANCHOR',
    'INSUFFICIENT_ITEMS',
    'COMPOSITION_STALE',
    'COMPOSITION_CORRUPT',
    'COMPOSITION_FAILED',
    'PERSISTENCE_FAILED',
  ]) {
    assert.ok(
      coordinator.PRIVATE_WORKSPACE_ERRORS.includes(code),
      `${code} must be a declared error code`,
    );
  }
});

test('composer codes map onto workspace states without leaking raw values', () => {
  const cases = [
    ['SUCCESS', 'ready', null],
    ['SUCCESS_PARTIAL', 'partial', null],
    ['CLOSET_LOAD_FAILED', 'failed', 'CLOSET_LOAD_FAILED'],
    ['CLOSET_EMPTY', 'insufficient', 'CLOSET_EMPTY'],
    ['SESSION_CONTEXT_REQUIRED', 'idle', 'SESSION_CONTEXT_REQUIRED'],
    ['ANCHOR_MISSING', 'failed', 'ANCHOR_MISSING'],
    ['UNSUPPORTED_ANCHOR', 'insufficient', 'UNSUPPORTED_ANCHOR'],
    ['INSUFFICIENT_ITEMS', 'insufficient', 'INSUFFICIENT_ITEMS'],
    ['ACTOR_CHANGED', 'failed', 'ACTOR_CHANGED'],
    ['SOMETHING_UNEXPECTED', 'failed', 'COMPOSITION_FAILED'],
  ];
  for (const [code, status, errorCode] of cases) {
    const mapped = coordinator.compositionStatusForComposerCode(code);
    assert.equal(mapped.status, status, code);
    assert.equal(mapped.errorCode, errorCode, code);
  }
});

// ── Automatic generation trigger ─────────────────────────────────────────────

test('an anchor alone is composition-ready', () => {
  assert.equal(
    coordinator.isCompositionReady({
      session: session({ anchorClosetItemId: 'c-top' }),
      anchorMissing: false,
    }),
    true,
  );
});

test('an occasion alone is composition-ready', () => {
  assert.equal(
    coordinator.isCompositionReady({ session: session({ occasion: 'Work' }), anchorMissing: false }),
    true,
  );
});

test('anchor plus occasion is composition-ready', () => {
  assert.equal(
    coordinator.isCompositionReady({
      session: session({ anchorClosetItemId: 'c-top', occasion: 'Work' }),
      anchorMissing: false,
    }),
    true,
  );
});

test('neither anchor nor occasion is not composition-ready', () => {
  assert.equal(
    coordinator.isCompositionReady({ session: session(), anchorMissing: false }),
    false,
  );
  assert.equal(
    coordinator.isCompositionReady({ session: session({ occasion: '   ' }), anchorMissing: false }),
    false,
  );
});

test('a missing anchor with no occasion is not composition-ready', () => {
  assert.equal(
    coordinator.isCompositionReady({
      session: session({ anchorClosetItemId: 'gone' }),
      anchorMissing: true,
    }),
    false,
  );
});

test('a missing anchor WITH an occasion is still composition-ready', () => {
  assert.equal(
    coordinator.isCompositionReady({
      session: session({ anchorClosetItemId: 'gone', occasion: 'Work' }),
      anchorMissing: true,
    }),
    true,
  );
});

test('a discarded or absent session is never composition-ready', () => {
  assert.equal(
    coordinator.isCompositionReady({
      session: session({ status: 'discarded', occasion: 'Work' }),
      anchorMissing: false,
    }),
    false,
  );
  assert.equal(coordinator.isCompositionReady({ session: null, anchorMissing: false }), false);
});

// ── Look resolution ──────────────────────────────────────────────────────────

test('every look item resolves through the current Closet projection', () => {
  const resolved = coordinator.resolveCompositionLooks({
    looks: [look()],
    closetItems: CLOSET,
    activeLookId: null,
    anchorClosetItemId: null,
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].itemCount, 3);
  for (const entry of resolved[0].items) {
    assert.ok(entry.item, `${entry.closetItemId} must resolve`);
    assert.equal(entry.item.id, entry.closetItemId);
  }
  assert.equal(resolved[0].stale, false);
});

test('a deleted garment resolves to null rather than stale metadata', () => {
  const resolved = coordinator.resolveCompositionLooks({
    looks: [look()],
    closetItems: [project('c-top'), project('c-shoes')],
  });
  const missing = resolved[0].items.find((entry) => entry.closetItemId === 'c-bottom');
  assert.equal(missing.item, null);
  assert.equal(resolved[0].stale, true);
});

test('the anchor is ordered first for display', () => {
  const resolved = coordinator.resolveCompositionLooks({
    looks: [look({ items: [
      { slot: 'top', closetItemId: 'c-top' },
      { slot: 'footwear', closetItemId: 'c-shoes' },
      { slot: 'outerwear', closetItemId: 'c-coat' },
    ] })],
    closetItems: CLOSET,
    anchorClosetItemId: 'c-shoes',
  });
  assert.equal(resolved[0].items[0].closetItemId, 'c-shoes');
});

test('without an anchor, slots follow the declared layering order', () => {
  const resolved = coordinator.resolveCompositionLooks({
    looks: [look({ items: [
      { slot: 'footwear', closetItemId: 'c-shoes' },
      { slot: 'top', closetItemId: 'c-top' },
      { slot: 'outerwear', closetItemId: 'c-coat' },
    ] })],
    closetItems: CLOSET,
  });
  assert.deepEqual(
    resolved[0].items.map((entry) => entry.slot),
    ['outerwear', 'top', 'footwear'],
  );
});

test('the active look is flagged and looks are ordered by rank', () => {
  const resolved = coordinator.resolveCompositionLooks({
    looks: [
      look({ lookId: 'b', rank: 1 }),
      look({ lookId: 'a', rank: 0 }),
    ],
    closetItems: CLOSET,
    activeLookId: 'b',
  });
  assert.deepEqual(resolved.map((entry) => entry.lookId), ['a', 'b']);
  assert.equal(resolved.find((entry) => entry.lookId === 'b').isActive, true);
  assert.equal(resolved.find((entry) => entry.lookId === 'a').isActive, false);
});

test('a partial look reports its missing count truthfully', () => {
  const resolved = coordinator.resolveCompositionLooks({
    looks: [
      look({
        completeness: 'partial',
        missingSlots: ['footwear'],
        labelCodes: ['PARTIAL_LOOK'],
        items: [
          { slot: 'top', closetItemId: 'c-top' },
          { slot: 'bottom', closetItemId: 'c-bottom' },
        ],
      }),
    ],
    closetItems: CLOSET,
  });
  assert.equal(resolved[0].completeness, 'partial');
  assert.equal(resolved[0].missingCount, 1);
  assert.deepEqual(resolved[0].missingSlots, ['footwear']);
});

test('look resolution handles empty and malformed input', () => {
  assert.deepEqual(coordinator.resolveCompositionLooks({ looks: [], closetItems: [] }), []);
  assert.deepEqual(
    coordinator.resolveCompositionLooks({ looks: undefined, closetItems: undefined }),
    [],
  );
});

// ── Rebuild / retry ──────────────────────────────────────────────────────────

test('rebuild is offered only when the composition needs rebuilding', () => {
  for (const status of ['stale', 'corrupt', 'insufficient']) {
    assert.equal(coordinator.canRebuildComposition(status), true, status);
  }
  for (const status of ['ready', 'partial', 'building', 'idle', 'failed']) {
    assert.equal(
      coordinator.canRebuildComposition(status),
      false,
      `${status} must not offer a rebuild that returns the same outfits`,
    );
  }
});

test('retry is offered only after a failed operation, never a bad context', () => {
  for (const code of ['CLOSET_LOAD_FAILED', 'PERSISTENCE_FAILED', 'COMPOSITION_FAILED']) {
    assert.equal(coordinator.canRetryComposition(code), true, code);
  }
  for (const code of ['SESSION_CONTEXT_REQUIRED', 'INSUFFICIENT_ITEMS', 'ANCHOR_MISSING', null]) {
    assert.equal(coordinator.canRetryComposition(code), false, String(code));
  }
});

// ── Copy ─────────────────────────────────────────────────────────────────────

test('missing slots are described specifically, never generically', () => {
  assert.equal(coordinator.describeMissingSlots(['footwear']), 'Missing shoes');
  assert.equal(coordinator.describeMissingSlots(['top']), 'Missing a top');
  assert.equal(coordinator.describeMissingSlots(['bottom']), 'Missing a bottom');
  assert.equal(coordinator.describeMissingSlots(['top', 'bottom']), 'Missing a top and a bottom');
  assert.equal(coordinator.describeMissingSlots([]), null);
  assert.equal(coordinator.describeMissingSlots(null), null);
});

test('every bounded label code has user-facing copy', () => {
  for (const code of [
    'NO_PURCHASE_NEEDED',
    'PARTIAL_LOOK',
    'MORE_CASUAL',
    'MORE_POLISHED',
    'EVENING_OPTION',
    'NEUTRAL_OPTION',
  ]) {
    assert.equal(typeof coordinator.PRIVATE_LOOK_LABELS[code], 'string');
    assert.ok(coordinator.PRIVATE_LOOK_LABELS[code].length > 0);
  }
});

test('error copy states what happened without blaming or leaking internals', () => {
  const copy = coordinator.PRIVATE_WORKSPACE_COPY;
  for (const key of [
    'building',
    'compositionStale',
    'compositionCorrupt',
    'compositionFailed',
    'persistenceFailed',
    'insufficient',
    'unsupportedAnchor',
    'rebuild',
    'retry',
    'returnToCloset',
  ]) {
    const value = copy[key];
    assert.equal(typeof value, 'string', key);
    assert.ok(value.length > 0, key);
    assert.equal(/\/doc\/|undefined|null|Error|Exception|\.json/.test(value), false, key);
    assert.equal(/you failed|your fault|invalid input/i.test(value), false, key);
  }
});

// ── Hook orchestration contract ──────────────────────────────────────────────

test('the hook uses the TYPED Closet loader, so empty and failed stay distinct', () => {
  assert.match(LIFECYCLE, /import \{ loadClosetTyped \} from '\.\/closetLibrary'/);
  assert.equal(
    /\bloadCloset\(/.test(WORKSPACE),
    false,
    'the untyped wrapper must not be used here',
  );
  assert.match(LIFECYCLE, /loadClosetTyped\(input\.actorId, \{ actorRequest: input\.actorRequest \}\)/);
});

test('a context change hides the old composition BEFORE building a replacement', () => {
  const body = HOOK.slice(HOOK.indexOf('const mutateContext'), HOOK.indexOf('const startSession'));
  const hideAt = body.indexOf("status: 'building'");
  const composeAt = body.indexOf('composeAndPersist(');
  assert.ok(hideAt > -1, 'the old composition must be cleared');
  assert.ok(composeAt > hideAt, 'the replacement is built only after the old one is hidden');
});

test('the replacement is published only after persistence succeeds', () => {
  const body = LIFECYCLE.slice(
    LIFECYCLE.indexOf('export async function composeAndPersistComposition'),
    LIFECYCLE.indexOf('export async function loadInteractionSnapshot'),
  );
  assert.match(body, /const saved = await replaceCompositionSet\(/);
  assert.match(body, /if \(!saved\.ok\)/);
  // The success path returns the PERSISTED composition, not the composed one.
  assert.match(body, /composition: saved\.composition/);
});

test('a valid restored composition is not recomposed', () => {
  const body = LIFECYCLE.slice(LIFECYCLE.indexOf('export async function hydratePrivateDressingRoom'));
  assert.match(body, /RESTORE WITHOUT RECOMPOSING/);
  const restoreAt = body.indexOf('if (stored.composition)');
  const composeAt = body.indexOf('await composeAndPersistComposition(');
  assert.ok(restoreAt > -1 && composeAt > restoreAt, 'restore returns before composing');
});

test('every asynchronous step revalidates the actor', () => {
  // The hook owns the freshness predicate; the module checks it after every
  // await. Both halves must be present.
  const guards = WORKSPACE.match(/isCurrent\(\)/g) ?? [];
  assert.ok(guards.length >= 8, `expected pervasive actor guards, found ${guards.length}`);
  assert.match(HOOK, /isActorRequestCurrent\(actorRequest\)/);
  assert.match(
    HOOK,
    /isCurrent = \(\) =>\s*live && generationRef\.current === generation && isActorRequestCurrent\(actorRequest\)/,
    'the hook supplies the predicate the module enforces',
  );
});

test('the actor transition effect invalidates every snapshot', () => {
  const body = HOOK.slice(HOOK.indexOf('An actor transition invalidates'), HOOK.indexOf('const view ='));
  assert.match(body, /generationRef\.current \+= 1/);
  assert.match(body, /setCloset\(/);
  assert.match(body, /setSession\(/);
  assert.match(body, /setComposition\(IDLE_COMPOSITION\)/);
});

test('foreground revalidation reuses the route-scoped seam, not a global subscriber', () => {
  assert.match(HOOK, /AppState\.addEventListener\('change'/);
  assert.match(HOOK, /subscription\?\.remove\?\.\(\)/);
  assert.match(HOOK, /useFocusEffect\(hydrate\)/);
});

test('selection never alters look contents', () => {
  const body = HOOK.slice(HOOK.indexOf('const selectLook'), HOOK.indexOf('const rebuildOutfits'));
  assert.match(body, /setActiveLook\(actorRequest, \{ lookId, expectedFingerprint/);
  assert.equal(/replaceCompositionSet\(/.test(body), false, 'selection must not rewrite outfits');
  assert.equal(/composePrivateOutfits\(/.test(body), false);
});

test('discarding a session does not depend on composition cleanup succeeding', () => {
  const body = LIFECYCLE.slice(
    LIFECYCLE.indexOf('export async function discardPrivateDressingRoomSession'),
    LIFECYCLE.indexOf('export async function hydratePrivateDressingRoom'),
  );
  const discardAt = body.indexOf('discardActiveSession(');
  const cleanupAt = body.indexOf('discardCompositionSet(');
  assert.ok(discardAt > -1 && cleanupAt > discardAt, 'the session discard lands first');
  // And a throwing cleanup cannot turn a successful discard into a failure.
  assert.match(body, /try \{\s*await discardCompositionSet/);
});

test('resetting a corrupt composition never touches the session', () => {
  const body = HOOK.slice(HOOK.indexOf('const resetComposition'), HOOK.indexOf('const retry'));
  assert.match(body, /resetCorruptComposition\(/);
  assert.equal(/resetCorruptSession\(/.test(body), false);
  assert.equal(/discardActiveSession\(/.test(body), false);
});

test('the hook never mutates the Closet or a collaborative room', () => {
  for (const forbidden of [
    'createClosetItem',
    'updateClosetItem',
    'deleteClosetItem',
    'promoteScanToCloset',
    'addItemToDressingRoom',
    'shareLooksToRoom',
    'saveLook',
  ]) {
    assert.equal(WORKSPACE.includes(forbidden), false, `workspace must not call ${forbidden}`);
  }
});

test('the hook makes no remote call', () => {
  const imports = WORKSPACE.match(/^import .*$/gm) ?? [];
  for (const line of imports) {
    for (const forbidden of ['supabase', 'styleOutfits', 'outfitDecisions', 'styleObjects']) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}`);
    }
  }
  assert.equal(/fetch\(|\.invoke\(/.test(WORKSPACE), false);
});

test('the hook reads no raw Closet manifest', () => {
  assert.equal(WORKSPACE.includes('FileSystem'), false);
  assert.equal(WORKSPACE.includes('kscan_closet'), false);
  assert.match(LIFECYCLE, /getClosetItemProjections/, 'garments arrive only as projections');
});
