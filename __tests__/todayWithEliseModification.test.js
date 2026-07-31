// Build 5 Phase 2 — Change Something, the save observation, and the return.
//
// The modification flow is Build 3's. What Build 5 owns is reaching it with the
// right actor, the right session and the right Look, reporting the outcome
// truthfully, and giving the user their place back when they return.

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

const orchestrator = require(path.join(ROOT, 'services/todayWithElise/orchestrator.ts'));
const presentation = require(path.join(ROOT, 'services/todayWithElise/presentation.ts'));

const hook = fs.readFileSync(path.join(ROOT, 'hooks/useTodayWithElise.ts'), 'utf8');
const handoffSource = fs.readFileSync(
  path.join(ROOT, 'services/todayWithElise/handoff.ts'),
  'utf8',
);

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ── The destination is Build 3's, unchanged ──────────────────────────────────

test('Change Something routes to the existing Private Dressing Room workspace', () => {
  assert.equal(
    presentation.resolveTodayRoute('elise_modification', { closetSeparationActive: false }),
    '/stylist/dressing-room',
  );
});

test('the modification target is the same route as the primary handoff', () => {
  // Same workspace, same session, same active Look — which is precisely why no
  // second session and no second Look can be created by taking this path.
  assert.equal(
    presentation.resolveTodayRoute('elise_modification', { closetSeparationActive: true }),
    presentation.resolveTodayRoute('private_dressing_room', { closetSeparationActive: true }),
  );
});

test('Build 5 builds no Look editor of its own', () => {
  const files = fs
    .readdirSync(path.join(ROOT, 'services/todayWithElise'))
    .filter((name) => name.endsWith('.ts'));
  for (const name of files) {
    const source = codeOnly(
      fs.readFileSync(path.join(ROOT, 'services/todayWithElise', name), 'utf8'),
    );
    assert.doesNotMatch(
      source,
      /applySlotOverride|restoreBaseSlot|undoLastSwap|rankSlotCandidates|askElise|makeMoreCasual/,
      `${name} reimplements a Build 3 editing capability`,
    );
  }
});

test('Build 5 writes no Saved Look and no Closet record', () => {
  const files = fs
    .readdirSync(path.join(ROOT, 'services/todayWithElise'))
    .filter((name) => name.endsWith('.ts'));
  for (const name of files) {
    const source = codeOnly(
      fs.readFileSync(path.join(ROOT, 'services/todayWithElise', name), 'utf8'),
    );
    assert.doesNotMatch(
      source,
      /savePrivateSavedLook|renameSavedLook|deleteSavedLook|createClosetItem|deleteClosetItem/,
      `${name} writes outside its domain`,
    );
  }
});

test('Save and Discard remain the Dressing Room\'s, untouched by Today', () => {
  assert.doesNotMatch(codeOnly(handoffSource), /discardSession|discardActiveSession|saveActiveLook/);
});

// ── The save observation ─────────────────────────────────────────────────────

test('saved-look session ids are extracted from the Build 3 read', () => {
  const ids = orchestrator.savedLookSessionIdsFrom({
    ok: true,
    looks: [
      { id: 'saved-1', sourceCompositionId: 'c-1', sourceSessionId: 'session-1' },
      { id: 'saved-2', sourceCompositionId: 'c-2', sourceSessionId: 'session-2' },
    ],
  });
  assert.deepEqual(ids, ['session-1', 'session-2']);
});

test('a failed or absent Saved Look read yields no observation', () => {
  assert.deepEqual(orchestrator.savedLookSessionIdsFrom(null), []);
  assert.deepEqual(orchestrator.savedLookSessionIdsFrom({ ok: false, looks: [] }), []);
  assert.deepEqual(orchestrator.savedLookSessionIdsFrom({ ok: true, looks: null }), []);
});

test('a malformed saved record is skipped rather than reported', () => {
  const ids = orchestrator.savedLookSessionIdsFrom({
    ok: true,
    looks: [{ id: 'saved-1', sourceCompositionId: 'c-1', sourceSessionId: '' }, null],
  });
  assert.deepEqual(ids, []);
});

test('the save observation reports once, and only for a new save', () => {
  // The hook's rule, restated as data: report when the session was NOT already
  // saved at departure and IS saved now, and never twice for the same session.
  const departure = { sessionId: 'session-1', knownSavedSessionIds: [] };
  const before = orchestrator.savedLookSessionIdsFrom({ ok: true, looks: [] });
  const after = orchestrator.savedLookSessionIdsFrom({
    ok: true,
    looks: [{ id: 's', sourceCompositionId: 'c', sourceSessionId: 'session-1' }],
  });
  const shouldReport = (known, current) =>
    !known.includes(departure.sessionId) && current.includes(departure.sessionId);
  assert.equal(shouldReport(departure.knownSavedSessionIds, before), false);
  assert.equal(shouldReport(departure.knownSavedSessionIds, after), true);
  // Already saved before we left: nothing new happened.
  assert.equal(shouldReport(['session-1'], after), false);
});

test('the hook emits look_saved from the observation, not from a Build 3 hook', () => {
  assert.match(hook, /today_with_elise_look_saved/);
  assert.match(hook, /savedReportedRef/);
  assert.doesNotMatch(hook, /savePrivateSavedLook/);
});

test('the observation carries no session id into analytics', () => {
  const emitBlock = hook.slice(
    hook.indexOf("emitTodayWithEliseEvent('today_with_elise_look_saved'"),
    hook.indexOf("emitTodayWithEliseEvent('today_with_elise_look_saved'") + 300,
  );
  assert.doesNotMatch(emitBlock, /sessionId|departure\.sessionId/);
  assert.match(emitBlock, /todayEventPayload/);
});

// ── Return from the Dressing Room ────────────────────────────────────────────

test('a departure is armed only by a successful handoff', () => {
  const armBlocks = hook.split("awaitingReturn: true");
  assert.equal(armBlocks.length - 1, 2, 'expected exactly the two action paths to arm');
  assert.match(hook, /if \(result\.outcome === 'opened'\) \{/);
  assert.match(hook, /if \(modification\.outcome === 'opened'\) \{/);
});

test('focus restoration is gated on an armed return, never on plain Home focus', () => {
  assert.match(hook, /if \(!departure\.awaitingReturn\) return undefined;/);
  assert.match(hook, /departure\.awaitingReturn = false;/);
  assert.match(hook, /AccessibilityInfo\.setAccessibilityFocus/);
});

test('focus restoration failure never blocks the return', () => {
  const block = hook.slice(hook.indexOf('AccessibilityInfo.setAccessibilityFocus') - 400);
  assert.match(block, /try \{/);
  assert.match(block, /\} catch \{/);
});

test('returning re-evaluates rather than restoring a stale snapshot', () => {
  // Focus drives a fresh generation; nothing caches a card across navigation.
  assert.match(hook, /useFocusEffect\(orchestrate\)/);
  assert.doesNotMatch(hook, /AsyncStorage|persistCard|cachedCard|restoreSnapshot/);
});

test('returning creates no second Dressing Room', () => {
  const orchestrationPath = hook.slice(
    hook.indexOf('const orchestrate = useCallback'),
    hook.indexOf('// ── Actions ─'),
  );
  assert.doesNotMatch(orchestrationPath, /startActiveSession\(|composeAndPersistComposition\(/);
});

test('the heading is the registered focus target', () => {
  const section = fs.readFileSync(
    path.join(ROOT, 'components/home/TodayWithEliseSection.tsx'),
    'utf8',
  );
  assert.match(section, /registerHeading\(node\)/);
  assert.match(section, /headingRef=\{attachHeading\}/);
});
