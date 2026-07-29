// Slot-editing coordinator: preview identity, stale-preview rejection,
// context-change confirmation, and the nested flag matrix (Phase 3, Stage 4).
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
const FLAGS = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');

const PREVIEW = {
  generation: 3,
  lookId: 'drlook_0',
  slot: 'top',
  candidateClosetItemId: 'c-knit',
  sessionId: 'drsession_1',
  compositionId: 'drcomp_1',
  inputFingerprint: 'fp-work',
  actorEpoch: 7,
};

const request = (overrides = {}) => ({ ...PREVIEW, ...overrides });

// ── Preview identity ─────────────────────────────────────────────────────────

test('a matching preview may be applied', () => {
  const result = coordinator.validatePreviewForApply(PREVIEW, request());
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test('apply with NO preview is refused', () => {
  assert.equal(coordinator.validatePreviewForApply(null, request()).reason, 'STALE_PREVIEW');
  assert.equal(coordinator.validatePreviewForApply(undefined, request()).reason, 'STALE_PREVIEW');
});

test('PREVIEW A then PREVIEW B then APPLY A is rejected', () => {
  // B replaced A, so the live preview carries generation 4.
  const livePreviewB = { ...PREVIEW, generation: 4, candidateClosetItemId: 'c-blouse' };
  const applyA = request({ generation: 3, candidateClosetItemId: 'c-knit' });
  const result = coordinator.validatePreviewForApply(livePreviewB, applyA);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'STALE_PREVIEW');
});

test('applying a candidate the user never previewed is refused', () => {
  const result = coordinator.validatePreviewForApply(
    PREVIEW,
    request({ candidateClosetItemId: 'c-something-else' }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'STALE_PREVIEW');
});

test('applying to a different look or slot than previewed is refused', () => {
  assert.equal(
    coordinator.validatePreviewForApply(PREVIEW, request({ lookId: 'drlook_9' })).reason,
    'STALE_PREVIEW',
  );
  assert.equal(
    coordinator.validatePreviewForApply(PREVIEW, request({ slot: 'bottom' })).reason,
    'STALE_PREVIEW',
  );
});

test('an actor change between preview and apply is refused as ACTOR_CHANGED', () => {
  const result = coordinator.validatePreviewForApply(PREVIEW, request({ actorEpoch: 8 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ACTOR_CHANGED');
});

test('an occasion change between preview and apply is refused as INTERACTION_STALE', () => {
  const result = coordinator.validatePreviewForApply(
    PREVIEW,
    request({ inputFingerprint: 'fp-dinner' }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INTERACTION_STALE');
});

test('a composition rebuild between preview and apply is refused', () => {
  const result = coordinator.validatePreviewForApply(
    PREVIEW,
    request({ compositionId: 'drcomp_rebuilt' }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INTERACTION_STALE');
});

test('a session change between preview and apply is refused', () => {
  assert.equal(
    coordinator.validatePreviewForApply(PREVIEW, request({ sessionId: 'drsession_new' })).reason,
    'INTERACTION_STALE',
  );
});

test('preview identity carries every component needed to prove an apply', () => {
  for (const key of [
    'generation',
    'lookId',
    'slot',
    'candidateClosetItemId',
    'sessionId',
    'compositionId',
    'inputFingerprint',
    'actorEpoch',
  ]) {
    assert.ok(key in PREVIEW, `${key} must be part of preview identity`);
    // And changing it must matter.
    const mutated = request({ [key]: key === 'generation' || key === 'actorEpoch' ? 99 : 'changed' });
    assert.equal(
      coordinator.validatePreviewForApply(PREVIEW, mutated).ok,
      false,
      `${key} must be validated`,
    );
  }
});

// ── Context-change confirmation ──────────────────────────────────────────────

test('a context change warns only when it would discard visible work', () => {
  assert.equal(
    coordinator.contextChangeDiscardsWork({
      hasOverrides: false,
      hasHistory: false,
      hasComparison: false,
      hasPreview: false,
    }),
    false,
    'an untouched workspace must not nag',
  );
  for (const key of ['hasOverrides', 'hasHistory', 'hasComparison', 'hasPreview']) {
    const input = {
      hasOverrides: false,
      hasHistory: false,
      hasComparison: false,
      hasPreview: false,
      [key]: true,
    };
    assert.equal(coordinator.contextChangeDiscardsWork(input), true, key);
  }
});

test('contextChangeDiscardsWork handles malformed input', () => {
  assert.equal(coordinator.contextChangeDiscardsWork({}), false);
  assert.equal(coordinator.contextChangeDiscardsWork(null), false);
});

// ── Nested flag matrix ───────────────────────────────────────────────────────

test('the Phase 3 flag only accepts the literal string true', () => {
  assert.match(
    FLAGS,
    /export const PRIVATE_DRESSING_ROOM_INTERACTIONS_V1 =\s*process\.env\.EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_INTERACTIONS_V1 === 'true';/,
  );
});

test('interactions are NESTED and cannot override the Phase 2 flag', () => {
  assert.match(
    FLAGS,
    /export const PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE =\s*PRIVATE_DRESSING_ROOM_V1 && PRIVATE_DRESSING_ROOM_INTERACTIONS_V1;/,
  );
});

test('the derived flag reproduces the required matrix', () => {
  // The derived constant is a plain conjunction, so the matrix is exhaustive.
  const active = (privateDr, interactions) => privateDr && interactions;
  assert.equal(active(false, false), false, 'OFF/OFF  -> route hidden');
  assert.equal(active(false, true), false, 'OFF/ON   -> route hidden');
  assert.equal(active(true, false), false, 'ON/OFF   -> Phase 2 view only');
  assert.equal(active(true, true), true, 'ON/ON    -> Phase 3 available');
});

test('no second flag evaluator is introduced', () => {
  // It follows the existing derived-constant pattern (CLOSET_CANDIDATE_STAGING_ACTIVE).
  assert.match(FLAGS, /CLOSET_CANDIDATE_STAGING_ACTIVE =\s*CLOSET_SEPARATION_V1 && CLOSET_DIRECT_INTAKE_V1/);
  const line = FLAGS.split('\n').find((l) =>
    l.includes('EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_INTERACTIONS_V1'),
  );
  assert.ok(line);
  assert.equal(/resolve|function|=>/.test(line), false, 'no bespoke evaluator');
});

test('neither private flag is enabled in any EAS profile', () => {
  const eas = fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8');
  assert.equal(eas.includes('PRIVATE_DRESSING_ROOM_V1'), false);
  assert.equal(eas.includes('PRIVATE_DRESSING_ROOM_INTERACTIONS_V1'), false);
});

// ── Slot editor states ───────────────────────────────────────────────────────

test('every mandated slot-editor status is expressible', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomCoordinator.ts'),
    'utf8',
  );
  for (const status of [
    'closed',
    'loading',
    'ready',
    'no_candidates',
    'anchor_locked',
    'applying',
    'failed',
  ]) {
    assert.ok(source.includes(`'${status}'`), `missing slot-editor status ${status}`);
  }
});

test('error copy states what happened, gives one action, and blames nobody', () => {
  const copy = coordinator.PRIVATE_WORKSPACE_COPY;
  for (const key of [
    'anchorLocked',
    'noAlternatives',
    'applyFailed',
    'interactionCorrupt',
    'swappedItemMissing',
    'stalePreview',
    'priorItemUnavailable',
  ]) {
    const value = copy[key];
    assert.equal(typeof value, 'string', key);
    assert.ok(value.length > 0, key);
    assert.equal(/\/doc\/|undefined|null|Error|Exception|\.json|epoch/i.test(value), false, key);
    assert.equal(/you failed|your fault|invalid|illegal/i.test(value), false, key);
  }
  assert.match(copy.anchorLocked, /Dressing Room header/);
  assert.match(copy.swappedItemMissing, /no longer in your Closet/);
});

test('destructive context-change copy names the consequence', () => {
  const copy = coordinator.PRIVATE_WORKSPACE_COPY;
  assert.match(copy.editsDiscardedAnchor, /discard your current outfit edits/);
  assert.match(copy.editsDiscardedOccasion, /discard your current outfit edits/);
  assert.ok(copy.keepEditing.length > 0);
  assert.ok(copy.continueChange.length > 0);
});

test('restore-original copy is slot-scoped, not outfit-scoped', () => {
  const copy = coordinator.PRIVATE_WORKSPACE_COPY;
  assert.equal(copy.restoreOriginal, 'Restore original');
  assert.equal(/reset outfit|reset look/i.test(copy.restoreOriginal), false);
});

test('no redo copy exists anywhere in the coordinator', () => {
  const copy = coordinator.PRIVATE_WORKSPACE_COPY;
  for (const value of Object.values(copy)) {
    assert.equal(/\bredo\b/i.test(String(value)), false, String(value));
  }
});
