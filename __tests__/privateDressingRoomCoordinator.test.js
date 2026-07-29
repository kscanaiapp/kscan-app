// Private Dressing Room coordinator: workspace state resolution, route-parameter
// guarding, missing-anchor reconciliation, and the feature-flag matrix.
//
// `.test.js` rather than `.test.ts` so scripts/run-all-tests.js discovers it.

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
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
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
  vm.runInNewContext(
    output,
    { module: mod, exports: mod.exports, require: localRequire, console, Object, Array, JSON },
    { filename },
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const coordinator = loadModule('services/privateDressingRoomCoordinator.ts');
const projection = loadModule('services/closetItemProjection.ts');

const {
  resolvePrivateWorkspaceView,
  normalizeRouteClosetItemId,
  resolveRouteAnchorIntent,
} = coordinator;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function closetItem(id, title = 'A coat') {
  return projection.getClosetItemProjection({
    id,
    title,
    category: 'Outerwear',
    imageUri: `file:///doc/kscan_closet/images/${id}.jpg`,
    createdAt: '2026-07-01T00:00:00.000Z',
  });
}

function sessionOk(session, recovered = 'primary') {
  return { ok: true, session, recovered, errorCode: null, recoverable: false };
}

function sessionFail(errorCode, recoverable = true) {
  return { ok: false, session: null, recovered: 'none', errorCode, recoverable };
}

function activeSession(overrides = {}) {
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

const BASE = {
  enabled: true,
  actorLoading: false,
  closetStatus: 'loaded',
  closetItems: [],
  session: sessionOk(null),
};

// ── Feature flag gate ────────────────────────────────────────────────────────

test('the flag gate precedes every other state', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    enabled: false,
    actorLoading: true,
    closetStatus: 'failed',
    session: sessionFail('session_store_corrupt'),
  });
  assert.equal(view.status, 'feature_disabled');
  assert.equal(view.session, null);
  assert.equal(view.errorCode, null);
});

test('the private flag only accepts the literal string true', () => {
  const source = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
  assert.match(
    source,
    /export const PRIVATE_DRESSING_ROOM_V1 =\s*process\.env\.EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_V1 === 'true';/,
  );
});

test('the private flag is independent of the collaborative dressingRooms freeze', () => {
  const source = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
  // The freeze key still exists and is untouched.
  assert.match(source, /NON_CORE_FEATURE_KEYS = \[\s*'dressingRooms',/);
  // The private flag does not read the freeze, and the freeze does not read it.
  const flagLine = source.split('\n').find((l) => l.includes('EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_V1'));
  assert.ok(flagLine);
  assert.equal(flagLine.includes('dressingRooms'), false);
  assert.equal(flagLine.includes('FREEZE'), false);
});

test('production EAS profiles do not enable the private flag', () => {
  const eas = fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8');
  assert.equal(
    eas.includes('EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_V1'),
    false,
    'no EAS profile may enable the private workspace',
  );
});

// ── Loading sequence ─────────────────────────────────────────────────────────

test('an unresolved actor blocks Closet and session classification', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    actorLoading: true,
    closetStatus: 'loaded',
    closetItems: [],
    session: sessionOk(activeSession({ anchorClosetItemId: 'gone' })),
  });
  assert.equal(view.status, 'actor_loading');
  assert.equal(view.anchorMissing, false, 'nothing is missing while the actor is loading');
  assert.equal(view.closetEmpty, false);
});

test('a loading Closet never reports an empty Closet or a missing anchor', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetStatus: 'loading',
    session: sessionOk(activeSession({ anchorClosetItemId: 'gone' })),
  });
  assert.equal(view.status, 'closet_loading');
  assert.equal(view.closetEmpty, false);
  assert.equal(view.anchorMissing, false);
});

test('a Closet failure is distinct from an empty Closet', () => {
  const failed = resolvePrivateWorkspaceView({ ...BASE, closetStatus: 'failed' });
  assert.equal(failed.status, 'closet_failed');
  assert.equal(failed.closetEmpty, false, 'a failure must not masquerade as empty');

  const empty = resolvePrivateWorkspaceView({ ...BASE, closetStatus: 'loaded', closetItems: [] });
  assert.equal(empty.status, 'no_session');
  assert.equal(empty.closetEmpty, true);
});

test('an unread session holds the workspace in a loading state', () => {
  const view = resolvePrivateWorkspaceView({ ...BASE, session: null });
  assert.equal(view.status, 'closet_loading');
});

// ── Session states ───────────────────────────────────────────────────────────

test('no stored session resolves to no_session', () => {
  const view = resolvePrivateWorkspaceView({ ...BASE, closetItems: [closetItem('c1')] });
  assert.equal(view.status, 'no_session');
  assert.equal(view.session, null);
  assert.equal(view.closetEmpty, false);
});

test('an active session with a resolvable anchor is ready', () => {
  const item = closetItem('c1', 'Navy coat');
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [item],
    session: sessionOk(activeSession({ anchorClosetItemId: 'c1', occasion: 'Dinner' })),
  });
  assert.equal(view.status, 'active');
  assert.equal(view.anchor.id, 'c1');
  assert.equal(view.anchor.title, 'Navy coat');
  assert.equal(view.anchorMissing, false);
  assert.equal(view.session.occasion, 'Dinner');
});

test('an occasion-only session is a valid active session', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [closetItem('c1')],
    session: sessionOk(activeSession({ occasion: 'Wedding' })),
  });
  assert.equal(view.status, 'active');
  assert.equal(view.anchor, null);
  assert.equal(view.anchorMissing, false, 'no anchor is not a MISSING anchor');
});

test('a restored-from-backup session is flagged for a recovery notice', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [closetItem('c1')],
    session: sessionOk(activeSession(), 'backup'),
  });
  assert.equal(view.status, 'active');
  assert.equal(view.recoveredFromBackup, true);
});

// ── Missing anchor reconciliation ────────────────────────────────────────────

test('a stored anchor the Closet cannot resolve is reported missing, not dropped', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [closetItem('c1')],
    session: sessionOk(activeSession({ anchorClosetItemId: 'deleted-item', occasion: 'Dinner' })),
  });
  assert.equal(view.status, 'active', 'the session still loads');
  assert.equal(view.anchorMissing, true);
  assert.equal(view.anchor, null, 'no stale garment metadata is reconstructed');
  assert.equal(
    view.session.anchorClosetItemId,
    'deleted-item',
    'the stored id is retained in persisted state',
  );
  assert.equal(view.session.occasion, 'Dinner', 'occasion is unaffected');
});

test('replacing a missing anchor clears the computed missing state', () => {
  const item = closetItem('c2');
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [item],
    session: sessionOk(activeSession({ anchorClosetItemId: 'c2' })),
  });
  assert.equal(view.anchorMissing, false);
  assert.equal(view.anchor.id, 'c2');
});

test('a missing anchor with an empty Closet is still an active session', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [],
    session: sessionOk(activeSession({ anchorClosetItemId: 'gone' })),
  });
  assert.equal(view.status, 'active');
  assert.equal(view.anchorMissing, true);
  assert.equal(view.closetEmpty, true);
});

// ── Route parameter guard ────────────────────────────────────────────────────

test('route ids: arrays and malformed shapes are refused', () => {
  for (const bad of [['a', 'b'], [], null, undefined, 42, {}, true, '', '   ']) {
    assert.equal(
      normalizeRouteClosetItemId(bad),
      null,
      `expected refusal for ${JSON.stringify(bad)}`,
    );
  }
});

test('route ids are length-bounded by the session contract', () => {
  assert.equal(normalizeRouteClosetItemId('c'.repeat(200)), 'c'.repeat(200));
  assert.equal(normalizeRouteClosetItemId('c'.repeat(201)), null);
});

test('a route id is trimmed but otherwise opaque', () => {
  assert.equal(normalizeRouteClosetItemId('  closet-1  '), 'closet-1');
});

test('a valid route id matching an owned item is available', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [closetItem('c1')],
    routeClosetItemId: 'c1',
  });
  assert.equal(view.routeItemUnavailable, false);
  assert.equal(resolveRouteAnchorIntent(view, 'c1'), 'c1');
});

test('an unknown or unowned route id is unavailable and never written', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [closetItem('c1')],
    routeClosetItemId: 'someone-elses-item',
  });
  assert.equal(view.routeItemUnavailable, true);
  assert.equal(
    resolveRouteAnchorIntent(view, 'someone-elses-item'),
    null,
    'an unowned id must never reach the session',
  );
});

test('an unknown item and another actor’s item are indistinguishable to the caller', () => {
  const unknown = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [closetItem('c1')],
    routeClosetItemId: 'never-existed',
  });
  const foreign = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [closetItem('c1')],
    routeClosetItemId: 'belongs-to-user-b',
  });
  assert.equal(unknown.routeItemUnavailable, foreign.routeItemUnavailable);
  assert.equal(unknown.status, foreign.status);
});

test('route resolution is deferred while the actor is loading', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    actorLoading: true,
    closetItems: [closetItem('c1')],
    routeClosetItemId: 'c1',
  });
  assert.equal(view.status, 'actor_loading');
  assert.equal(view.routeItemUnavailable, false, 'not yet judged');
  assert.equal(resolveRouteAnchorIntent(view, 'c1'), null, 'nothing is written yet');
});

test('route resolution is deferred while the Closet is loading', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetStatus: 'loading',
    routeClosetItemId: 'c1',
  });
  assert.equal(view.status, 'closet_loading');
  assert.equal(view.routeItemUnavailable, false);
  assert.equal(resolveRouteAnchorIntent(view, 'c1'), null);
});

test('a route id equal to the current anchor is not rewritten', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [closetItem('c1')],
    session: sessionOk(activeSession({ anchorClosetItemId: 'c1' })),
    routeClosetItemId: 'c1',
  });
  assert.equal(resolveRouteAnchorIntent(view, 'c1'), null, 'no redundant write');
});

test('a route id replaces a different existing anchor', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    closetItems: [closetItem('c1'), closetItem('c2')],
    session: sessionOk(activeSession({ anchorClosetItemId: 'c1' })),
    routeClosetItemId: 'c2',
  });
  assert.equal(resolveRouteAnchorIntent(view, 'c2'), 'c2');
});

// ── Actor and recovery failures ──────────────────────────────────────────────

test('an actor failure is reported as actor_unavailable, not as corruption', () => {
  for (const code of ['missing_actor_context', 'stale_actor_context']) {
    const view = resolvePrivateWorkspaceView({ ...BASE, session: sessionFail(code, false) });
    assert.equal(view.status, 'actor_unavailable');
    assert.equal(view.errorCode, code);
    assert.equal(view.canReset, false, 'a reset cannot fix an actor problem');
  }
});

test('an unrecoverable session offers an explicit reset', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    session: sessionFail('session_store_corrupt', true),
  });
  assert.equal(view.status, 'session_unrecoverable');
  assert.equal(view.errorCode, 'session_store_corrupt');
  assert.equal(view.canReset, true);
  assert.equal(view.session, null);
});

test('a future-schema session is surfaced with its own code', () => {
  const view = resolvePrivateWorkspaceView({
    ...BASE,
    session: sessionFail('session_store_future_schema', true),
  });
  assert.equal(view.status, 'session_unrecoverable');
  assert.equal(view.errorCode, 'session_store_future_schema');
});

// ── Domain boundaries ────────────────────────────────────────────────────────

test('the coordinator imports nothing from the collaborative room domain', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomCoordinator.ts'),
    'utf8',
  );
  const imports = source.match(/^import .*$/gm) ?? [];
  for (const line of imports) {
    for (const forbidden of [
      'styleObjects',
      'dressingRoomCollaboration',
      'outfitDecisions',
      'dressingRoomCommerce',
      'supabase',
    ]) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}: ${line}`);
    }
  }
});

test('the hook never calls Closet or collaborative mutations', () => {
  // Hydration ordering moved into a production lifecycle module (P3-B3), so the
  // read-only guarantee is asserted across both halves of the workspace.
  const source = [
    fs.readFileSync(path.join(ROOT, 'hooks/usePrivateDressingRoom.ts'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'services/privateDressingRoomLifecycle.ts'), 'utf8'),
  ].join('\n');
  for (const forbidden of [
    'createClosetItem',
    'updateClosetItem',
    'deleteClosetItem',
    'promoteScanToCloset',
    'addItemToDressingRoom',
    'saveLook',
    'generateOutfit',
  ]) {
    assert.equal(source.includes(forbidden), false, `hook must not call ${forbidden}`);
  }
  // It reads the Closet through the projection boundary only.
  assert.ok(source.includes('loadCloset'));
  assert.ok(source.includes('getClosetItemProjections'));
});

test('the workspace exposes copy for every user-facing state', () => {
  const copy = coordinator.PRIVATE_WORKSPACE_COPY;
  for (const key of [
    'actorLoading',
    'actorUnavailable',
    'closetLoading',
    'closetFailed',
    'closetEmpty',
    'noSession',
    'unrecoverable',
    'futureSchema',
    'recovered',
    'anchorMissing',
    'routeItemUnavailable',
    'ready',
    'reset',
    'discard',
  ]) {
    assert.equal(typeof copy[key], 'string');
    assert.ok(copy[key].length > 0, `${key} copy must not be empty`);
  }
});

test('the ready copy promises no Phase 1 generation', () => {
  const copy = coordinator.PRIVATE_WORKSPACE_COPY;
  assert.equal(/generating|creating your outfit|building now/i.test(copy.ready), false);
});
