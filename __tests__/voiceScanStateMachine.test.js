// Voice Scan V1 -- UI state machine hostile test suite.
//
// Covers services/voice/voiceStateMachine.ts: the pure reducer useVoiceScan
// dispatches into. The single most important property under test is that
// review is mandatory -- there is no event sequence that reaches
// "reviewing" without passing through "finalizing" first, and nothing in
// this machine represents a submitted/Commerce state at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require in ${relativePath}: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const { reduceVoiceState, VOICE_STATES_REQUIRING_DRAFT_CLEAR } = loadTsModule(
  'services/voice/voiceStateMachine.ts',
);

const ALL_STATES = [
  'idle',
  'requesting_permission',
  'listening',
  'finalizing',
  'reviewing',
  'error',
  'unavailable',
  'cancelled',
];

test('MIC_TAPPED starts a session only from a terminal/idle-ish state', () => {
  for (const state of ['idle', 'error', 'cancelled', 'unavailable']) {
    assert.equal(reduceVoiceState(state, { type: 'MIC_TAPPED' }).state, 'requesting_permission');
  }
  for (const state of ['requesting_permission', 'listening', 'finalizing', 'reviewing']) {
    assert.equal(reduceVoiceState(state, { type: 'MIC_TAPPED' }).state, state, `must not restart from ${state}`);
  }
});

test('NOT_KPLUS / FLAG_DISABLED always resolve to unavailable with the right reason, from any state', () => {
  for (const state of ALL_STATES) {
    assert.deepEqual(
      { state: reduceVoiceState(state, { type: 'NOT_KPLUS' }).state, reason: reduceVoiceState(state, { type: 'NOT_KPLUS' }).unavailableReason },
      { state: 'unavailable', reason: 'not_kplus' },
    );
    assert.deepEqual(
      { state: reduceVoiceState(state, { type: 'FLAG_DISABLED' }).state, reason: reduceVoiceState(state, { type: 'FLAG_DISABLED' }).unavailableReason },
      { state: 'unavailable', reason: 'flag_disabled' },
    );
  }
});

test('PERMISSION_GRANTED only advances a pending permission request', () => {
  assert.equal(reduceVoiceState('requesting_permission', { type: 'PERMISSION_GRANTED' }).state, 'listening');
  for (const state of ALL_STATES.filter((s) => s !== 'requesting_permission')) {
    assert.equal(reduceVoiceState(state, { type: 'PERMISSION_GRANTED' }).state, state);
  }
});

test('PERMISSION_DENIED reports permanent vs non-permanent denial correctly, only while requesting', () => {
  const denied = reduceVoiceState('requesting_permission', { type: 'PERMISSION_DENIED', permanent: false });
  assert.equal(denied.state, 'unavailable');
  assert.equal(denied.unavailableReason, 'permission_denied');

  const deniedPermanent = reduceVoiceState('requesting_permission', { type: 'PERMISSION_DENIED', permanent: true });
  assert.equal(deniedPermanent.unavailableReason, 'permission_denied_permanently');

  assert.equal(reduceVoiceState('listening', { type: 'PERMISSION_DENIED', permanent: false }).state, 'listening');
});

test('ON_DEVICE_UNAVAILABLE is reachable from the pre-listening states, not from a terminal one', () => {
  for (const state of ['requesting_permission', 'listening']) {
    const result = reduceVoiceState(state, { type: 'ON_DEVICE_UNAVAILABLE' });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.unavailableReason, 'on_device_recognition_unavailable');
  }
  assert.equal(reduceVoiceState('idle', { type: 'ON_DEVICE_UNAVAILABLE' }).state, 'idle');
});

test('USER_STOP only moves a listening session to finalizing', () => {
  assert.equal(reduceVoiceState('listening', { type: 'USER_STOP' }).state, 'finalizing');
  for (const state of ALL_STATES.filter((s) => s !== 'listening')) {
    assert.equal(reduceVoiceState(state, { type: 'USER_STOP' }).state, state);
  }
});

test('USER_CANCEL is the universal escape hatch: accepted from every single state', () => {
  for (const state of ALL_STATES) {
    assert.equal(reduceVoiceState(state, { type: 'USER_CANCEL' }).state, 'cancelled');
  }
});

test('SESSION_ENDED_BY_NATIVE (15s cap / OS finalization) never auto-submits -- it only reaches finalizing, same as an explicit stop', () => {
  assert.equal(reduceVoiceState('listening', { type: 'SESSION_ENDED_BY_NATIVE' }).state, 'finalizing');
  // Must NEVER jump straight to reviewing.
  assert.notEqual(reduceVoiceState('listening', { type: 'SESSION_ENDED_BY_NATIVE' }).state, 'reviewing');
});

test('FINALIZED_WITH_TRANSCRIPT: reviewing is reachable ONLY from finalizing -- no direct listening -> reviewing path', () => {
  assert.equal(reduceVoiceState('finalizing', { type: 'FINALIZED_WITH_TRANSCRIPT' }).state, 'reviewing');
  // Excludes 'reviewing' itself: already being in that state and re-firing
  // the event is a no-op, not a new transition into it -- the property
  // under test is that nothing else can ENTER reviewing this way.
  for (const state of ALL_STATES.filter((s) => s !== 'finalizing' && s !== 'reviewing')) {
    assert.notEqual(
      reduceVoiceState(state, { type: 'FINALIZED_WITH_TRANSCRIPT' }).state,
      'reviewing',
      `state ${state} must not be able to reach reviewing directly`,
    );
  }
});

test('FINALIZED_EMPTY (no usable speech) surfaces an error rather than an empty review screen', () => {
  assert.equal(reduceVoiceState('finalizing', { type: 'FINALIZED_EMPTY' }).state, 'error');
});

test('RECOGNIZER_ERROR always resolves to the error state with a stable reason', () => {
  for (const state of ALL_STATES) {
    const result = reduceVoiceState(state, { type: 'RECOGNIZER_ERROR' });
    assert.equal(result.state, 'error');
    assert.equal(result.unavailableReason, 'recognizer_error');
  }
});

test('DISMISS returns to idle only from a resting error/unavailable/cancelled state', () => {
  for (const state of ['error', 'unavailable', 'cancelled']) {
    assert.equal(reduceVoiceState(state, { type: 'DISMISS' }).state, 'idle');
  }
  for (const state of ['listening', 'finalizing', 'reviewing', 'requesting_permission']) {
    assert.equal(reduceVoiceState(state, { type: 'DISMISS' }).state, state);
  }
});

test('an unhandled/malformed event type never throws and never mutates state', () => {
  for (const state of ALL_STATES) {
    assert.doesNotThrow(() => reduceVoiceState(state, { type: 'SOME_UNKNOWN_EVENT' }));
    assert.equal(reduceVoiceState(state, { type: 'SOME_UNKNOWN_EVENT' }).state, state);
  }
});

test('full reachability sweep: every (state, event) pair returns one of the eight known states', () => {
  const EVENTS = [
    { type: 'MIC_TAPPED' },
    { type: 'NOT_KPLUS' },
    { type: 'FLAG_DISABLED' },
    { type: 'PERMISSION_GRANTED' },
    { type: 'PERMISSION_DENIED', permanent: false },
    { type: 'PERMISSION_DENIED', permanent: true },
    { type: 'ON_DEVICE_UNAVAILABLE' },
    { type: 'LISTENING_STARTED' },
    { type: 'USER_STOP' },
    { type: 'USER_CANCEL' },
    { type: 'SESSION_ENDED_BY_NATIVE' },
    { type: 'FINALIZED_WITH_TRANSCRIPT' },
    { type: 'FINALIZED_EMPTY' },
    { type: 'RECOGNIZER_ERROR' },
    { type: 'DISMISS' },
  ];
  for (const state of ALL_STATES) {
    for (const event of EVENTS) {
      const result = reduceVoiceState(state, event);
      assert.ok(ALL_STATES.includes(result.state), `unknown state "${result.state}" from (${state}, ${event.type})`);
    }
  }
});

test('VOICE_STATES_REQUIRING_DRAFT_CLEAR names exactly the resting/terminal states, never listening/finalizing/reviewing', () => {
  assert.deepEqual([...VOICE_STATES_REQUIRING_DRAFT_CLEAR].sort(), ['cancelled', 'error', 'idle', 'unavailable'].sort());
  for (const active of ['listening', 'finalizing', 'reviewing', 'requesting_permission']) {
    assert.equal(VOICE_STATES_REQUIRING_DRAFT_CLEAR.includes(active), false);
  }
});

// NEGATIVE CONTROL: allow a mutant reducer to skip the mandatory review gate
// (listening -> reviewing directly, as an "auto-submit on stop" bug would
// produce) and prove the invariant check above actually catches it.
test('NEGATIVE CONTROL: a mutant reducer that lets listening jump straight to reviewing is caught', () => {
  function mutantReduce(current, event) {
    if (event.type === 'FINALIZED_WITH_TRANSCRIPT') {
      // Bug: accepts the transition from ANY state, not just 'finalizing'.
      return { state: 'reviewing', unavailableReason: null };
    }
    return reduceVoiceState(current, event);
  }

  function invariantHolds(reduce) {
    return ALL_STATES.filter((s) => s !== 'finalizing' && s !== 'reviewing').every(
      (s) => reduce(s, { type: 'FINALIZED_WITH_TRANSCRIPT' }).state !== 'reviewing',
    );
  }

  assert.equal(invariantHolds(reduceVoiceState), true, 'real reducer must satisfy the invariant');
  assert.equal(invariantHolds(mutantReduce), false, 'mutant must violate it, proving the check has detection power');
});
