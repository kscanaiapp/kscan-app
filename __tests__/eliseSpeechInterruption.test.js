// Elise speech interruption from the composer (UX addendum 1).
//
// Two things must both hold, and they pull in opposite directions:
//   - reaching for the composer silences Elise promptly, including while the
//     audio is still being fetched;
//   - the acknowledgement fires ONLY for an interruption that really silenced
//     audible speech — never per keystroke, never for another actor's or
//     another session's playback, and never as a way of reporting a failure.
//
// The decision module is executed here; the stop itself remains
// avatarSpeech.stopAvatarSpeechPlayback, which the speech suites already cover.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * Field-wise. The plan object is built inside the VM realm, so its prototype is
 * not this realm's Object.prototype and deepStrictEqual would reject it for a
 * reason that has nothing to do with the contract under test.
 */
function assertPlan(plan, expected, message) {
  assert.equal(plan.interrupt, expected.interrupt, (message ? message + ' — ' : '') + 'interrupt');
  assert.equal(plan.confirm, expected.confirm, (message ? message + ' — ' : '') + 'confirm');
}

function loadTsModule(relativePath, requireMap = {}, transform = (x) => x) {
  const filename = path.join(ROOT, relativePath);
  const source = transform(fs.readFileSync(filename, 'utf8'));
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      exports: module.exports,
      module,
      console,
      Set,
      Object,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

const interruption = loadTsModule('services/style-chat/eliseSpeechInterruption.ts');

// The REAL store, so the phases under test are the ones the app actually sets.
const store = loadTsModule('stores/avatarSpeechStore.ts', {}, (source) =>
  source.replace("import { useSyncExternalStore } from 'react';", ''),
);

const ACTOR_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_B = '22222222-2222-2222-2222-222222222222';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AVATAR = 'elise_default';

const SCOPE_A = { actorId: ACTOR_A, sessionId: SESSION_A, avatarId: AVATAR };

/** Drive the real store into a speaking state for the given scope. */
function beginSpeech(scope, { play = true } = {}) {
  const state = store.beginAvatarSpeech({
    actorId: scope.actorId,
    sessionId: scope.sessionId,
    messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    stylistId: scope.avatarId,
    avatarId: scope.avatarId,
    source: 'message',
    generation: (store.getAvatarSpeechState().generation ?? 0) + 1,
  });
  const generation = store.getAvatarSpeechState().generation;
  if (play) {
    store.markAvatarSpeechReady(generation, null);
    store.markAvatarSpeechPlaying(generation);
  }
  return state;
}

test('typing while Elise is speaking interrupts her and acknowledges it once', () => {
  beginSpeech(SCOPE_A);
  assert.equal(store.getAvatarSpeechState().phase, 'playing');

  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'typing',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
    isComposerEmpty: false,
  });

  assertPlan(plan, { interrupt: true, confirm: true });
});

test('focusing the composer while Elise is speaking interrupts her', () => {
  beginSpeech(SCOPE_A);
  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'focus',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
  });
  assertPlan(plan, { interrupt: true, confirm: true });
});

test('speech still being fetched is interruptible, so it cannot start a moment later', () => {
  beginSpeech(SCOPE_A, { play: false });
  assert.equal(store.getAvatarSpeechState().phase, 'requesting');

  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'typing',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
    isComposerEmpty: false,
  });
  assert.equal(plan.interrupt, true);
});

test('typing into a silent composer produces no interruption and no phantom feedback', () => {
  store.resetAvatarSpeechStore();
  assert.equal(store.getAvatarSpeechState().phase, 'idle');

  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'typing',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
    isComposerEmpty: false,
  });
  assertPlan(plan, { interrupt: false, confirm: false });
});

test('backspacing to an empty composer is not a reach for the composer', () => {
  beginSpeech(SCOPE_A);
  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'typing',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
    isComposerEmpty: true,
  });
  assertPlan(plan, { interrupt: false, confirm: false });
});

test('another actor’s playback is never interrupted or acknowledged from this composer', () => {
  beginSpeech({ actorId: ACTOR_B, sessionId: SESSION_A, avatarId: AVATAR });

  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'typing',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
    isComposerEmpty: false,
  });
  assertPlan(plan, { interrupt: false, confirm: false });
});

test('another session’s playback is never interrupted or acknowledged from this composer', () => {
  beginSpeech({ actorId: ACTOR_A, sessionId: SESSION_B, avatarId: AVATAR });

  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'typing',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
    isComposerEmpty: false,
  });
  assertPlan(plan, { interrupt: false, confirm: false });
});

test('a signed-out composer never interrupts anything', () => {
  beginSpeech(SCOPE_A);
  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'typing',
    state: store.getAvatarSpeechState(),
    scope: { actorId: null, sessionId: SESSION_A, avatarId: AVATAR },
    isComposerEmpty: false,
  });
  assertPlan(plan, { interrupt: false, confirm: false });
});

test('an errored speech attempt is not "interrupted": failure must not be reported as a user action', () => {
  beginSpeech(SCOPE_A, { play: false });
  store.setAvatarSpeechError(store.getAvatarSpeechState().generation, 'Speech is unavailable.');
  assert.equal(store.getAvatarSpeechState().phase, 'error');

  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'typing',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
    isComposerEmpty: false,
  });
  assertPlan(
    plan,
    { interrupt: false, confirm: false },
    'a failure the user did not cause must not be acknowledged as their interruption',
  );
});

test('a stop already under way is not interrupted a second time', () => {
  beginSpeech(SCOPE_A);
  store.markAvatarSpeechStopping(store.getAvatarSpeechState().generation);

  const plan = interruption.planEliseSpeechInterruption({
    trigger: 'focus',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
  });
  assertPlan(plan, { interrupt: false, confirm: false });
});

test('sending always clears the way but is not itself an interruption acknowledgement', () => {
  store.resetAvatarSpeechStore();
  const silent = interruption.planEliseSpeechInterruption({
    trigger: 'send',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
  });
  assertPlan(silent, { interrupt: true, confirm: false });

  beginSpeech(SCOPE_A);
  const speaking = interruption.planEliseSpeechInterruption({
    trigger: 'send',
    state: store.getAvatarSpeechState(),
    scope: SCOPE_A,
  });
  assertPlan(speaking, { interrupt: true, confirm: false });
});
