const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function transpileModule(file, mocks = {}, sourceTransform = (source) => source) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(sourceTransform(fs.readFileSync(sourcePath, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
    Set,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

function loadStack() {
  const speechStore = transpileModule(
    'stores/avatarSpeechStore.ts',
    {},
    (source) => source.replace("import { useSyncExternalStore } from 'react';", ''),
  );
  const motion = transpileModule('services/avatarSpeechMotion.ts', {
    '../stores/avatarSpeechStore': speechStore,
  });
  const controller = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': transpileModule('services/avatarMotionState.ts', {}),
  });
  const motionStore = transpileModule('stores/avatarMotionStore.ts', {
    './avatarSpeechStore': speechStore,
    '../services/avatarSpeechMotion': motion,
    '../services/avatarMotionController': controller,
  });
  return { speechStore, motion, motionStore, controller };
}

function beginPlayingSpeech(speechStore, alignment, generation = 1) {
  speechStore.beginAvatarSpeech({
    actorId: 'actor-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    stylistId: 'stylist_portrait_01',
    avatarId: 'stylist_portrait_01',
    generation,
    source: 'message',
  });
  speechStore.markAvatarSpeechReady(generation, alignment);
  speechStore.markAvatarSpeechPlaying(generation);
}

// One long 'aaaa' run: a single open interval spanning 0..2s.
const SINGLE_INTERVAL_ALIGNMENT = {
  characters: ['a', 'a', 'a', 'a'],
  characterStartTimesSeconds: [0, 0.5, 1.0, 1.5],
  characterEndTimesSeconds: [0.5, 1.0, 1.5, 2.0],
};

// Alternating vowel/pause structure that produces several discrete states.
const MULTI_STATE_ALIGNMENT = {
  characters: ['a', 'a', 'm', 'm', 'o', 'o'],
  characterStartTimesSeconds: [0, 0.25, 0.5, 0.75, 1.0, 1.25],
  characterEndTimesSeconds: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5],
};

test('playback-position ticks inside one mouth interval produce zero discrete emissions', () => {
  const { speechStore, motionStore } = loadStack();
  beginPlayingSpeech(speechStore, SINGLE_INTERVAL_ALIGNMENT);
  // Advance past the anti-pop attack window so the entry frame has settled.
  speechStore.updateAvatarSpeechPlayback(1, 0.1);
  let emissions = 0;
  const unsubscribe = motionStore.subscribeToAvatarMotion(() => {
    emissions += 1;
  });
  const before = motionStore.getAvatarMotionSnapshot();
  assert.equal(before.mouth, 'open');
  // ~22 raw ticks land inside the same interval: the header-visible
  // projection must not emit once.
  for (let seconds = 0.14; seconds < 1.9; seconds += 0.08) {
    speechStore.updateAvatarSpeechPlayback(1, seconds);
  }
  assert.equal(emissions, 0);
  assert.equal(motionStore.getAvatarMotionSnapshot(), before, 'snapshot object stays stable');
  unsubscribe();
});

test('speech entry anti-pop softens an immediate open first frame to half-open', () => {
  const { speechStore, motionStore } = loadStack();
  beginPlayingSpeech(speechStore, SINGLE_INTERVAL_ALIGNMENT);
  // At the very start of playback the target is open, but the visible entry
  // frame passes through half-open (deterministic from playback position).
  assert.equal(motionStore.getAvatarMotionSnapshot().mouth, 'halfOpen');
  speechStore.updateAvatarSpeechPlayback(1, 0.02);
  assert.equal(motionStore.getAvatarMotionSnapshot().mouth, 'halfOpen');
  speechStore.updateAvatarSpeechPlayback(1, 0.06);
  assert.equal(motionStore.getAvatarMotionSnapshot().mouth, 'open');
});

test('discrete mouth changes emit exactly once per visible state change', () => {
  const { speechStore, motionStore } = loadStack();
  beginPlayingSpeech(speechStore, MULTI_STATE_ALIGNMENT);
  const seen = [];
  const unsubscribe = motionStore.subscribeToAvatarMotion(() => {
    seen.push(motionStore.getAvatarMotionSnapshot().mouth);
  });
  let raw = 0;
  for (let seconds = 0.01; seconds < 1.5; seconds += 0.04) {
    speechStore.updateAvatarSpeechPlayback(1, seconds);
    raw += 1;
  }
  assert.ok(raw > 30, 'meaningful tick volume');
  assert.ok(seen.length >= 2, 'visible states actually changed');
  assert.ok(seen.length <= 6, `only discrete changes may emit, saw ${seen.length}`);
  for (let index = 1; index < seen.length; index += 1) {
    assert.notEqual(seen[index], seen[index - 1], 'no duplicate consecutive emissions');
  }
  unsubscribe();
});

test('the timeline is not rebuilt by discrete projection ticks', () => {
  const { speechStore, motion, motionStore } = loadStack();
  motion.resetMouthTimelineBuildCountForTests();
  beginPlayingSpeech(speechStore, MULTI_STATE_ALIGNMENT);
  const unsubscribe = motionStore.subscribeToAvatarMotion(() => {});
  for (let seconds = 0.01; seconds < 1.5; seconds += 0.03) {
    speechStore.updateAvatarSpeechPlayback(1, seconds);
  }
  motionStore.getAvatarMotionSnapshot();
  assert.equal(motion.getMouthTimelineBuildCountForTests(), 1);
  unsubscribe();
});

test('upstream speech subscription exists only while subscribers are registered', () => {
  const { motionStore } = loadStack();
  assert.equal(motionStore.isAvatarMotionUpstreamSubscribedForTests(), false);
  const unsubscribeA = motionStore.subscribeToAvatarMotion(() => {});
  const unsubscribeB = motionStore.subscribeToAvatarMotion(() => {});
  assert.equal(motionStore.isAvatarMotionUpstreamSubscribedForTests(), true);
  unsubscribeA();
  assert.equal(motionStore.isAvatarMotionUpstreamSubscribedForTests(), true);
  unsubscribeB();
  assert.equal(
    motionStore.isAvatarMotionUpstreamSubscribedForTests(),
    false,
    'no dangling full-store subscription after teardown',
  );
});

test('phase transitions and scope changes remain visible discrete emissions', () => {
  const { speechStore, motionStore } = loadStack();
  let emissions = 0;
  const unsubscribe = motionStore.subscribeToAvatarMotion(() => {
    emissions += 1;
  });
  beginPlayingSpeech(speechStore, SINGLE_INTERVAL_ALIGNMENT);
  assert.ok(emissions >= 1, 'entering playback emits');
  const snapshot = motionStore.getAvatarMotionSnapshot();
  assert.equal(snapshot.phase, 'playing');
  assert.equal(snapshot.speaking, true);
  assert.equal(snapshot.sessionId, 'session-1');
  speechStore.finishAvatarSpeech(1);
  const finished = motionStore.getAvatarMotionSnapshot();
  assert.equal(finished.phase, 'idle');
  assert.equal(finished.speaking, false);
  assert.equal(finished.mouth, 'closed');
  unsubscribe();
});

test('StyleChatHeader consumes the discrete hook and never touches playback ticks', () => {
  const header = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
    'utf8',
  );
  assert.match(header, /useAvatarMotionState/);
  assert.doesNotMatch(header, /useAvatarSpeechState/);
  assert.doesNotMatch(header, /playbackSeconds/);
  assert.doesNotMatch(header, /deriveAvatarMouthState/);
  // Existing StyleChat gating is unchanged: playing phase plus full scope match.
  assert.match(header, /speechState\.phase === 'playing'/);
  assert.match(header, /speechState\.actorId === actorId/);
  assert.match(header, /speechState\.sessionId === sessionId/);
  assert.match(header, /speechState\.stylistId === identity\.avatarId/);
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useAvatarMotionState.ts'), 'utf8');
  assert.match(hook, /useSyncExternalStore/);
  const store = fs.readFileSync(path.join(ROOT, 'stores', 'avatarMotionStore.ts'), 'utf8');
  assert.doesNotMatch(store, /from 'react'/, 'projection store is React-free');
});
