// VTO UX polish: input guidance, honest staged progress, background polling,
// the explicit save bridge, and the sizing disclaimer.
//
// WHAT THIS FILE IS FOR. Four of the five changes here are UX behaviour whose
// failure mode is silent: a progress indicator that lies, a "minimize" that
// quietly kills the generation it claims to be running, a save bridge that
// persists something the user never asked to keep, or a disclaimer that gets
// dropped in a later refactor. None of those are type errors and none would
// fail an existing suite, so they are pinned here.
//
// The repo has no react-test-renderer, so this follows the house pattern
// (see vtoShippedSurfaceReach.test.js): the decidable logic is executed for
// real, and the wiring that regressed is guarded at source level.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that
// literal suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const code = (rel) => stripComments(read(rel));

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const progress = loadTsModule('services/vto/vtoProgressStages.ts', {
  '../../types/vto': {},
});

// The module is evaluated inside a vm context, so every value it returns
// belongs to another realm. deepStrictEqual compares prototypes, so structures
// crossing that boundary are rehydrated into this realm before comparison.
const intoThisRealm = (value) => JSON.parse(JSON.stringify(value));

// ── Task 2: the progress indicator may move, but it may not lie ─────────────

test('progress: each running status pins a minimum stage', () => {
  const at = (status) => progress.resolveVtoProgress({ status, elapsedMs: 0 });
  assert.equal(at('preparing').index, 0);
  assert.equal(at('generating').index, 1);
  assert.equal(at('validating_result').index, 2);
  for (const view of [at('preparing'), at('generating'), at('validating_result')]) {
    assert.equal(view.running, true);
    assert.equal(view.complete, false);
    assert.equal(view.total, 3);
  }
});

test('progress: a long generating phase still advances on elapsed time', () => {
  // The whole reason the stage list exists: `generating` is one status that
  // can last most of a 30s wait, and a frozen indicator reads as a hang.
  const early = progress.resolveVtoProgress({ status: 'generating', elapsedMs: 0 });
  const late = progress.resolveVtoProgress({ status: 'generating', elapsedMs: 20_000 });
  assert.equal(early.index, 1);
  assert.equal(late.index, 2);
});

test('progress: time NEVER produces completion, however long it runs', () => {
  // This is the honesty invariant. Success is a validated provider result, and
  // only the store may declare it.
  for (const elapsedMs of [0, 30_000, 5 * 60_000, Number.MAX_SAFE_INTEGER]) {
    for (const status of ['preparing', 'generating', 'validating_result']) {
      const view = progress.resolveVtoProgress({ status, elapsedMs });
      assert.equal(view.complete, false, `${status} @ ${elapsedMs}ms must not complete`);
      assert.ok(
        view.index <= progress.VTO_PROGRESS_LAST_INDEX,
        'time must not advance past the final stage',
      );
    }
  }
});

test('progress: completion comes from the validated success status alone', () => {
  const done = progress.resolveVtoProgress({ status: 'success', elapsedMs: 0 });
  assert.deepEqual(intoThisRealm(done), { running: false, complete: true });
});

test('progress: non-running statuses render no stepper', () => {
  for (const status of ['idle', 'selecting_input', 'validating', 'ready', 'failed', 'cancelled']) {
    const view = progress.resolveVtoProgress({ status, elapsedMs: 10_000 });
    assert.equal(view.running, false, `${status} is not a running generation`);
    assert.equal(view.complete, false, `${status} must never read as complete`);
  }
});

test('progress: the status floor wins when it is ahead of the clock', () => {
  // A fast provider can reach validating_result before the time thresholds do.
  // The indicator must follow reality, never trail it.
  const view = progress.resolveVtoProgress({ status: 'validating_result', elapsedMs: 0 });
  assert.equal(view.index, 2);
});

test('progress: stage labels name the real work and promise no fit judgement', () => {
  const labels = Array.from(progress.VTO_PROGRESS_STAGES, (stage) => stage.label);
  assert.deepEqual(labels, ['Analyzing garment', 'Mapping the fit', 'Rendering visualization']);
  for (const label of labels) {
    assert.doesNotMatch(label, /\d+\s*%/, 'no invented percentage');
    for (const forbidden of ['size', 'measurement', 'fits you', 'your size']) {
      assert.ok(!label.toLowerCase().includes(forbidden), `stage must not claim: ${forbidden}`);
    }
  }
});

// ── Task 3: minimizing must not kill the generation it reports on ──────────

test('minimize: the sheet stays MOUNTED while collapsed', () => {
  // This is the whole correctness question for background polling.
  // useVirtualTryOn calls leaveVtoSurface on unmount, so rendering the sheet
  // conditionally on `!minimized` would cancel the generation the pill claims
  // is still running. Collapsing must go through Modal visibility instead.
  const entry = code('components/vto/TryItOnEntry.tsx');
  assert.match(
    entry,
    /<VirtualTryOnSheet\s+visible=\{!minimized\}/,
    'collapse must be expressed as Modal visibility, not conditional mounting',
  );
  assert.doesNotMatch(
    entry,
    /\{\s*sheetVisible\s*&&\s*!minimized\s*\?\s*\(\s*<VirtualTryOnSheet/,
    'the sheet must never be unmounted merely because it is collapsed',
  );
});

test('minimize: collapsing calls no teardown action', () => {
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  const handler = sheet.match(/const handleMinimize = useCallback\([\s\S]*?\}, \[[^\]]*\]\);/);
  assert.ok(handler, 'handleMinimize must exist');
  for (const teardown of ['vto.cancel', 'vto.dismiss', 'leaveVtoSurface', 'onClose', 'clearPerson']) {
    assert.ok(
      !handler[0].includes(teardown),
      `minimize must not ${teardown}: the request has to survive the collapse`,
    );
  }
});

test('minimize: the observing hook holds no authority over the request', () => {
  // The pill needs status, not control. A second surface calling
  // leaveVtoSurface / attachSessionPerson on mount or unmount would fight
  // useVirtualTryOn for ownership of the one module-scoped operation.
  const hook = code('hooks/useVtoSessionStatus.ts');
  assert.match(hook, /useSyncExternalStore\(subscribeToVto, getVtoSnapshot, getVtoSnapshot\)/);
  for (const authority of [
    'useEffect',
    'leaveVtoSurface',
    'attachSessionPerson',
    'startVtoGeneration',
    'cancelVtoGeneration',
    'resetVtoRequestState',
    'setVtoPersonInput',
  ]) {
    assert.ok(!hook.includes(authority), `the read-only hook must not use ${authority}`);
  }
});

test('minimize: only the card that opened the try-on shows a pill', () => {
  // TryItOnEntry renders once per product card. A pill keyed on session status
  // alone would appear on every eligible card on screen.
  const entry = code('components/vto/TryItOnEntry.tsx');
  assert.match(
    entry,
    /\{sheetVisible && minimized \? \(\s*<VtoMinimizedPill/,
    'the pill must be gated on this card owning the open sheet',
  );
});

test('minimize: the pill is offered only while something is actually running', () => {
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  assert.match(
    sheet,
    /const canMinimize = !!onMinimize && isGenerating;/,
    'minimize is a wait-management affordance, not a second close button',
  );
});

test('minimize: the pill reports ready only from a validated success', () => {
  const entry = code('components/vto/TryItOnEntry.tsx');
  assert.match(entry, /ready=\{session\.status === 'success'\}/);
  const pillModule = loadTsModule('services/vto/vtoProgressStages.ts', { '../../types/vto': {} });
  assert.equal(pillModule.VTO_PILL_RENDERING_LABEL, 'Try-On Rendering…');
  assert.equal(pillModule.VTO_PILL_READY_LABEL, 'Try-On Ready');
});

test('minimize: swiping down while idle closes rather than pretending to collapse', () => {
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  const release = sheet.match(/onPanResponderRelease:[\s\S]*?\},\n/);
  assert.ok(release, 'the drag gesture must exist');
  assert.ok(release[0].includes('canMinimize'), 'the gesture must branch on what is running');
  assert.ok(release[0].includes('handleClose'), 'with nothing in flight it closes');
});
