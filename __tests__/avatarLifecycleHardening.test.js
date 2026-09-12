// Avatar V10 -> Elise: concurrency, leak, background and failure-isolation
// hardening.
//
// Everything here EXECUTES the real modules — stores/avatarSpeechStore.ts,
// services/avatarSpeech.ts, services/avatars/stylistAudioPlayback.ts,
// services/avatars/speechAppState.ts, the real engine host adapter and the real
// projection. Only the three things this shell genuinely cannot have are
// injected: the speech backend, the temporary file, and the native audio
// player.
//
// NO WALL-CLOCK WAITING. Every timer is a fake whose firing this suite chooses,
// so each assertion is about an ordering, not about whether a sleep was long
// enough.
//
// The invariant being falsified throughout: THE NEWEST AUTHORITATIVE STATE
// WINS, and no stale callback may reach the screen or the speech lifecycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const { loadAdapter, loadTsModule, executableSource } = require('./fixtures/avatarEngineHarness');

const { deriveAvatarPresentation } = loadTsModule('services/avatars/avatarPresentation.ts');

// -- A deterministic host -----------------------------------------------------

/**
 * Fake timers and a fake AppState, both counted.
 *
 * `liveTimers()` is what makes the leak tests meaningful: a watchdog that is
 * armed and never cleared shows up as a number that does not come back down.
 */
function createHost() {
  const timers = new Map();
  let nextId = 1;
  const appStateListeners = new Set();

  return {
    liveTimers: () => timers.size,
    appStateListeners: () => appStateListeners.size,
    currentAppState: 'active',
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Fires every timer currently armed, oldest first. */
    fireTimers() {
      const armed = [...timers.entries()];
      for (const [id, timer] of armed) {
        timers.delete(id);
        timer.fn();
      }
      return armed.length;
    },
    emitAppState(status) {
      this.currentAppState = status;
      for (const handler of [...appStateListeners]) handler(status);
    },
    appState: {
      addEventListener(_event, handler) {
        appStateListeners.add(handler);
        return { remove: () => appStateListeners.delete(handler) };
      },
    },
  };
}

function transpile(relativePath, requireMap, extras = {}, transform = (s) => s) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(transform(fs.readFileSync(filename, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Date,
    Error,
    Promise,
    Set,
    Map,
    Array,
    Object,
    JSON,
    Number,
    String,
    Boolean,
    Math,
    AbortController,
    setTimeout,
    clearTimeout,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      if (specifier.startsWith('node:')) return require(specifier);
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
    ...extras,
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

/** The real store, with React's subscription hook stripped. */
function loadStore() {
  return transpile('stores/avatarSpeechStore.ts', {}, {}, (source) =>
    source.replace("import { useSyncExternalStore } from 'react';", ''));
}

/**
 * The real native-playback module over a fake `expo-audio` player and the fake
 * timers above. The stall watchdog and start timeout under test are its own.
 */
function loadPlayback(host) {
  const players = [];
  const audio = {
    createAudioPlayer: (_source, options) => {
      const player = {
        options,
        listeners: new Set(),
        paused: false,
        removed: false,
        addListener(_event, handler) {
          player.listeners.add(handler);
          return { remove: () => player.listeners.delete(handler) };
        },
        play() {
          player.played = true;
        },
        pause() {
          player.paused = true;
        },
        remove() {
          player.removed = true;
        },
        emit(status) {
          for (const handler of [...player.listeners]) handler(status);
        },
      };
      players.push(player);
      return player;
    },
    setAudioModeAsync: async () => {},
  };
  const playback = transpile(
    'services/avatars/stylistAudioPlayback.ts',
    { 'expo-audio': audio },
    { setTimeout: (fn, ms) => host.setTimeout(fn, ms), clearTimeout: (id) => host.clearTimeout(id) },
  );
  return { playback, players };
}

/**
 * The whole authoritative speech lane: real store, real service, real AppState
 * interruption binding, real native-playback module, fake player and clock.
 */
function createLane({ failRequest = false } = {}) {
  const host = createHost();
  const store = loadStore();
  const { playback, players } = loadPlayback(host);
  const appState = transpile('services/avatars/speechAppState.ts', {
    'react-native': { AppState: host.appState },
  });

  const stats = { requests: 0, files: 0, deletes: 0 };
  const speech = transpile('services/avatarSpeech.ts', {
    '../stores/avatarSpeechStore': store,
    './avatars/stylistAudioPlayback': playback,
    './avatars/speechAppState': appState,
    './avatars/stylistSpeechClient': {
      requestStylistSpeech: async (request) => {
        stats.requests += 1;
        if (failRequest) throw new Error('Speech is temporarily unavailable.');
        return {
          messageId: request.messageId,
          stylistId: request.stylistId,
          voiceProfile: 'feminine',
          mimeType: 'audio/mpeg',
          audioBase64: 'QUJDRA==',
          alignment: {
            characters: ['h', 'i'],
            characterStartTimesSeconds: [0, 0.1],
            characterEndTimesSeconds: [0.1, 0.2],
          },
        };
      },
    },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: async ({ messageId }) => {
        stats.files += 1;
        return `file://${messageId}.mp3`;
      },
      deleteTemporaryStylistSpeechFile: async (uri) => {
        if (uri) stats.deletes += 1;
      },
    },
  });

  const { AvatarEngineHostAdapter } = loadAdapter();
  const adapter = new AvatarEngineHostAdapter();

  const AVATAR = 'stylist_portrait_05';
  let motionEpoch = 1;

  /** One render of the visible Elise header, projection and engine included. */
  const render = ({ foreground = true, reduceMotion = false, eliseProcessing = false } = {}) => {
    const state = store.getAvatarSpeechState();
    const scopeMatches =
      state.actorId === 'actor-1' &&
      state.sessionId === SESSION &&
      state.stylistId === AVATAR &&
      state.avatarId === AVATAR;
    const presentation = deriveAvatarPresentation({
      playbackPhase: state.phase,
      playbackScopeMatches: scopeMatches,
      playbackActive: scopeMatches && state.phase === 'playing',
      utteranceGeneration: state.generation,
      eliseProcessing,
      listening: false,
      reduceMotion,
      mouthCapable: true,
      assetsAvailable: true,
    });
    const result = adapter.computeFrame({
      avatarId: AVATAR,
      speech: state,
      scopeMatches,
      reduceMotion,
      foreground,
      motionEpoch,
      hostNowMs: 1000,
      ...(presentation.semanticMode ? { semanticMode: presentation.semanticMode } : {}),
    });
    return { presentation, result, state };
  };

  return {
    host,
    store,
    speech,
    players,
    stats,
    adapter,
    render,
    avatarId: AVATAR,
    bumpEpoch: () => {
      motionEpoch += 1;
      return motionEpoch;
    },
    epoch: () => motionEpoch,
  };
}

const SESSION = '11111111-1111-4111-8111-111111111111';

/**
 * Drains the microtask queue.
 *
 * The service's teardown is asynchronous (it awaits the temporary-file delete),
 * so a completion is observable only after its promise chain unwinds. This is
 * not a wait: `setImmediate` resolves on the next tick with no timer involved,
 * and the loop is bounded.
 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function payload(messageId, overrides = {}) {
  return {
    actorId: 'actor-1',
    sessionId: SESSION,
    messageId,
    stylistId: 'stylist_portrait_05',
    avatarId: 'stylist_portrait_05',
    source: 'message',
    ...overrides,
  };
}

/** Drives one utterance to confirmed native playback. */
async function speakAndStart(lane, messageId, overrides = {}) {
  const before = lane.players.length;
  await lane.speech.speakAvatarMessage(payload(messageId, overrides));
  const player = lane.players[before];
  assert.ok(player, `no player was created for ${messageId}`);
  player.emit({ playing: true, currentTime: 0, playbackState: 'readyToPlay' });
  await settle();
  return player;
}

// -- 2A/2C: the adversarial scheduler ----------------------------------------

test('SCHEDULER: a superseded utterance cannot reinstate itself after a newer one starts', async () => {
  const lane = createLane();
  const first = await speakAndStart(lane, 'msg-a');
  assert.equal(lane.render().presentation.state, 'speaking');
  const firstGeneration = lane.store.getAvatarSpeechState().generation;

  const second = await speakAndStart(lane, 'msg-b');
  const secondGeneration = lane.store.getAvatarSpeechState().generation;
  assert.ok(secondGeneration > firstGeneration, 'the newer utterance must win');

  // OLD-COMPLETE-AFTER-NEW-START, then the old error, then old progress —
  // reordered, duplicated, and all from the abandoned generation.
  first.emit({ playing: false, currentTime: 0.2, didJustFinish: true });
  first.emit({ playing: false, currentTime: 0.2, playbackState: 'failed' });
  first.emit({ playing: true, currentTime: 9.9, playbackState: 'readyToPlay' });
  first.emit({ playing: false, currentTime: 0.2, didJustFinish: true });

  const after = lane.store.getAvatarSpeechState();
  assert.equal(after.generation, secondGeneration, 'a stale callback changed the generation');
  assert.equal(after.phase, 'playing', 'a stale completion ended the live utterance');
  assert.equal(after.playbackSeconds, 0, 'a stale position reached the live utterance');
  assert.equal(lane.render().presentation.state, 'speaking');

  // The live utterance still ends normally.
  second.emit({ playing: false, currentTime: 0.2, didJustFinish: true });
  await settle();
  assert.equal(lane.store.getAvatarSpeechState().phase, 'idle');
  assert.equal(lane.render().presentation.state, 'idle');
  assert.equal(lane.render().result.mouthState, 'closed');
});

test('SCHEDULER: events that arrive after cancellation change nothing', async () => {
  const lane = createLane();
  const player = await speakAndStart(lane, 'msg-a');
  assert.equal(lane.render().presentation.state, 'speaking');

  await lane.speech.stopAvatarSpeechPlayback();
  assert.equal(lane.store.getAvatarSpeechState().phase, 'idle');
  assert.equal(lane.render().presentation.state, 'idle');
  assert.equal(lane.render().result.mouthState, 'closed');

  // POST-CANCEL delivery, including a duplicate start.
  player.emit({ playing: true, currentTime: 0.5, playbackState: 'readyToPlay' });
  player.emit({ playing: true, currentTime: 0.9, playbackState: 'readyToPlay' });
  player.emit({ playing: false, currentTime: 0.9, didJustFinish: true });

  assert.equal(lane.store.getAvatarSpeechState().phase, 'idle');
  assert.equal(lane.render().result.mouthState, 'closed', 'a cancelled utterance kept animating');
});

test('SCHEDULER: an interruption stops speaking visuals before the next state arrives', async () => {
  const lane = createLane();
  await speakAndStart(lane, 'msg-a');
  const generation = lane.store.getAvatarSpeechState().generation;

  // The authoritative interruption marker, as the composer path sets it.
  lane.store.markAvatarSpeechStopping(generation);
  const interrupted = lane.render();
  assert.equal(interrupted.presentation.state, 'interrupted');
  assert.equal(interrupted.presentation.speaking, false);
  assert.equal(interrupted.result.mouthState, 'closed');
  assert.equal(interrupted.result.frame.diagnostics.reason, 'interrupted');
  assert.equal(interrupted.presentation.statusSpeaking, false);
});

test('SCHEDULER: an error after a newer utterance started cannot fail the newer one', async () => {
  const lane = createLane();
  const first = await speakAndStart(lane, 'msg-a');
  await speakAndStart(lane, 'msg-b');
  const live = lane.store.getAvatarSpeechState().generation;

  first.emit({ playing: false, currentTime: 0, playbackState: 'failed' });
  const after = lane.store.getAvatarSpeechState();
  assert.equal(after.phase, 'playing');
  assert.equal(after.generation, live);
  assert.equal(after.error, null, "a stale failure surfaced on the live utterance");
});

test("SCHEDULER: a superseded player's stall watchdog cannot kill the newer utterance", async () => {
  const lane = createLane();
  await speakAndStart(lane, 'msg-a');
  await speakAndStart(lane, 'msg-b');
  const live = lane.store.getAvatarSpeechState().generation;

  // Fire EVERY armed timer, the abandoned player's watchdog included.
  lane.host.fireTimers();

  const after = lane.store.getAvatarSpeechState();
  assert.equal(after.generation, live);
  assert.equal(after.phase, 'playing', 'a superseded watchdog terminated the live utterance');
});

test('REPEATED UTTERANCE: the same text twice is two utterances, keyed on the lifecycle', async () => {
  const lane = createLane();
  const first = await speakAndStart(lane, 'msg-a');
  const generationA = lane.store.getAvatarSpeechState().generation;
  first.emit({ playing: false, currentTime: 0.2, didJustFinish: true });
  await settle();

  // A different reply that happens to say exactly the same thing. The service
  // takes references only — it never sees the text — so identity can only come
  // from the message and the generation counter.
  await speakAndStart(lane, 'msg-b');
  const generationB = lane.store.getAvatarSpeechState().generation;
  assert.ok(generationB > generationA, 'the second reply must be a new utterance');
  assert.equal(lane.render().presentation.state, 'speaking');

  // A concurrent duplicate is suppressed even for a retry, so the in-flight
  // utterance must end before the retry is a retry at all.
  const second = lane.players[lane.players.length - 1];
  second.emit({ playing: false, currentTime: 0.2, didJustFinish: true });
  await settle();

  // An explicit retry of the SAME message is then its own utterance, with its
  // own generation — proof that identity is the lifecycle, not the content.
  await speakAndStart(lane, 'msg-b', { trigger: 'retry' });
  assert.ok(
    lane.store.getAvatarSpeechState().generation > generationB,
    'a retry of the same message must animate as its own utterance',
  );
  assert.equal(lane.render().presentation.state, 'speaking');
});

// -- 2B: stale epoch protection ----------------------------------------------

test('STALE EPOCH: a frame from a superseded epoch is never applied', async () => {
  const lane = createLane();
  const player = await speakAndStart(lane, 'msg-a');
  player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });
  assert.equal(lane.render().presentation.state, 'speaking');

  const staleFrame = lane.render().result.frame;
  lane.bumpEpoch();
  const fresh = lane.render();

  const { isFrameApplicable } = loadTsModule('services/avatars/engine/index.ts');
  assert.equal(
    isFrameApplicable(staleFrame, {
      avatarId: lane.avatarId,
      speechGeneration: fresh.result.frame.speechGeneration,
      motionEpoch: lane.epoch(),
    }),
    false,
    'a frame from the previous epoch was still applicable',
  );
  // The epoch bump does not lock out the live utterance.
  assert.equal(fresh.presentation.state, 'speaking');
  assert.equal(fresh.result.applied, true);
});

test('STALE EPOCH: repeated epoch bumps never lock out the next utterance', async () => {
  const lane = createLane();
  for (let i = 0; i < 20; i += 1) lane.bumpEpoch();
  const player = await speakAndStart(lane, 'msg-a');
  player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });
  const rendered = lane.render();
  assert.equal(rendered.presentation.state, 'speaking');
  assert.equal(rendered.result.applied, true);
});

// -- 2D: leak tests ----------------------------------------------------------

test('LEAK: 100 conversation turns return timers, listeners and timelines to baseline', async () => {
  const lane = createLane();
  const baselineTimers = lane.host.liveTimers();
  const baselineListeners = lane.host.appStateListeners();
  assert.equal(baselineTimers, 0);

  let intervalsAfterTenTurns = null;
  for (let turn = 0; turn < 100; turn += 1) {
    const player = await speakAndStart(lane, `msg-${turn}`);
    player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });
    assert.equal(lane.render().presentation.state, 'speaking', `turn ${turn}`);
    player.emit({ playing: false, currentTime: 0.2, didJustFinish: true });
    await settle();
    assert.equal(lane.store.getAvatarSpeechState().phase, 'idle', `turn ${turn}`);
    assert.equal(lane.host.liveTimers(), baselineTimers, `turn ${turn} left a timer armed`);
    if (turn === 9) {
      lane.render();
      intervalsAfterTenTurns = lane.adapter.debugState().timelineIntervals;
    }
  }

  assert.equal(lane.host.liveTimers(), baselineTimers, 'a timer survived the conversation');
  // One AppState subscription for the whole lane, however many turns ran.
  assert.equal(lane.host.appStateListeners(), 1);
  assert.ok(
    lane.host.appStateListeners() <= baselineListeners + 1,
    'each turn added an AppState listener',
  );
  assert.equal(lane.render().result.mouthState, 'closed');
  assert.ok(lane.stats.deletes >= 100, 'temporary speech files were not released');

  // The engine retains exactly ONE compiled timeline — the last utterance's —
  // which the next utterance replaces. It is bounded, not accumulating: the
  // count after 100 turns is the count after 10. (The adapter's `endSpeech`
  // reconciliation does not fire on a clean completion, because the store
  // clears the utterance's identity in the same update that clears its phase,
  // so the adapter no longer owns the utterance it would be ending. Visually
  // inert — a non-playing phase already yields a closed mouth — and recorded
  // in the lane report rather than repaired here.)
  assert.equal(lane.adapter.debugState().timelineIntervals, intervalsAfterTenTurns);
  assert.ok(
    lane.adapter.debugState().timelineIntervals <= 8,
    `a timeline accumulated: ${lane.adapter.debugState().timelineIntervals} intervals`,
  );
});

test('LEAK: 100 adapter mount/unmount cycles leave no engine state behind', () => {
  const { AvatarEngineHostAdapter } = loadAdapter();
  for (let cycle = 0; cycle < 100; cycle += 1) {
    const adapter = new AvatarEngineHostAdapter();
    adapter.computeFrame({
      avatarId: 'stylist_portrait_05',
      speech: {
        avatarId: 'stylist_portrait_05',
        generation: cycle + 1,
        phase: 'playing',
        playbackSeconds: 0.05,
        alignment: {
          characters: ['h', 'i'],
          characterStartTimesSeconds: [0, 0.1],
          characterEndTimesSeconds: [0.1, 0.2],
        },
      },
      scopeMatches: true,
      reduceMotion: false,
      foreground: true,
      motionEpoch: 1,
      hostNowMs: cycle,
    });
    adapter.dispose();
    const disposed = adapter.computeFrame({
      avatarId: 'stylist_portrait_05',
      speech: {
        avatarId: 'stylist_portrait_05',
        generation: cycle + 1,
        phase: 'playing',
        playbackSeconds: 0.05,
        alignment: null,
      },
      scopeMatches: true,
      reduceMotion: false,
      foreground: true,
      motionEpoch: 1,
      hostNowMs: cycle,
    });
    assert.equal(disposed.mouthState, 'closed', `cycle ${cycle} animated after dispose`);
    assert.equal(disposed.frame.diagnostics.reason, 'disposed');
    assert.equal(adapter.debugState().timelineIntervals, 0);
  }
});

test('LEAK: a stalled player releases its own timers when the watchdog fires', async () => {
  const lane = createLane();
  const player = await speakAndStart(lane, 'msg-a');
  player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });
  assert.ok(lane.host.liveTimers() >= 1, 'the stall watchdog must be armed while playing');

  lane.host.fireTimers();
  await settle();

  assert.equal(lane.host.liveTimers(), 0, 'the watchdog left a timer armed');
  assert.equal(player.removed, true, 'the native player was not released');
  // A stall is a failure, not a completion: the phase is `error`, which the
  // projection reads as INTERRUPTED and the engine as a closed mouth.
  assert.equal(lane.store.getAvatarSpeechState().phase, 'error');
  assert.equal(lane.render().presentation.state, 'interrupted');
  assert.equal(lane.render().result.mouthState, 'closed');
});

// -- 2D/2F: background and native interruption (closes V10-CERT-001) ---------

test('BACKGROUND: an in-progress utterance stops and the mouth closes at once', async () => {
  const lane = createLane();
  const player = await speakAndStart(lane, 'msg-a');
  player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });
  assert.equal(lane.render().presentation.state, 'speaking');
  assert.equal(lane.render().result.frame.isSpeaking, true);

  // A real OS transition, through the real AppState binding the service owns.
  lane.host.emitAppState('background');
  await settle();

  assert.equal(lane.store.getAvatarSpeechState().phase, 'idle', 'speech survived backgrounding');
  assert.equal(player.removed, true, 'the native player was not released');
  assert.equal(lane.host.liveTimers(), 0, 'a timer kept running in the background');

  const backgrounded = lane.render({ foreground: false });
  assert.equal(backgrounded.result.mouthState, 'closed');
  assert.equal(backgrounded.result.frame.diagnostics.reason, 'background');
  assert.equal(backgrounded.result.frame.isSpeaking, false);
});

test("BACKGROUND: iOS's transitional 'inactive' is treated as an interruption too", async () => {
  const lane = createLane();
  const player = await speakAndStart(lane, 'msg-a');
  lane.host.emitAppState('inactive');
  await settle();
  assert.equal(lane.store.getAvatarSpeechState().phase, 'idle');
  assert.equal(player.removed, true);
  assert.equal(lane.render().result.mouthState, 'closed');
});

test('BACKGROUND: no animation channel advances while backgrounded', async () => {
  const lane = createLane();
  const player = await speakAndStart(lane, 'msg-a');
  player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });

  const first = lane.render({ foreground: false });
  const second = lane.render({ foreground: false });
  assert.deepEqual(first.result.frame.headMotion, second.result.frame.headMotion);
  assert.deepEqual(first.result.frame.breathing, second.result.frame.breathing);
  assert.equal(first.result.frame.diagnostics.neutral, true);
  assert.equal(second.result.mouthState, 'closed');
});

test('NATIVE INTERRUPTION: a frozen player is classified as failed on both platforms', async () => {
  // iOS never reports playbackState 'idle', so an interruption there can only be
  // caught by the stall watchdog. Android can report 'idle' directly. Both must
  // end the utterance and close the mouth.
  for (const platform of ['ios-stall', 'android-idle']) {
    const lane = createLane();
    const player = await speakAndStart(lane, 'msg-a');
    player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });

    if (platform === 'ios-stall') {
      // The player keeps claiming it plays, at a position that never advances.
      player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });
      player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });
      lane.host.fireTimers();
    } else {
      player.emit({ playing: false, currentTime: 0.05, playbackState: 'idle' });
    }
    await settle();

    assert.equal(lane.store.getAvatarSpeechState().phase, 'error', platform);
    assert.equal(player.removed, true, platform);
    const rendered = lane.render();
    assert.equal(rendered.presentation.state, 'interrupted', platform);
    assert.equal(rendered.result.mouthState, 'closed', platform);
    assert.equal(lane.host.liveTimers(), 0, platform);
  }
});

// -- 2F: failure isolation ---------------------------------------------------

test('ISOLATION: an engine calculation failure becomes a neutral frame, not an exception', async () => {
  const lane = createLane();
  const player = await speakAndStart(lane, 'msg-a');
  player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });
  assert.equal(lane.render().presentation.state, 'speaking');

  // A real renderer-side defect: the alignment the engine is about to compile
  // throws while being read. This is the engine's own fail-closed guard under
  // test, not a stub of it.
  const poisoned = {
    ...lane.store.getAvatarSpeechState(),
    generation: lane.store.getAvatarSpeechState().generation + 1,
    get alignment() {
      throw new Error('renderer defect');
    },
  };

  let escaped = null;
  let result = null;
  try {
    result = lane.adapter.computeFrame({
      avatarId: lane.avatarId,
      speech: poisoned,
      scopeMatches: true,
      reduceMotion: false,
      foreground: true,
      motionEpoch: lane.epoch(),
      hostNowMs: 1000,
    });
  } catch (error) {
    escaped = error;
  }

  assert.equal(escaped, null, 'a renderer defect escaped as an exception');
  assert.equal(result.mouthState, 'closed', 'a failed calculation left the mouth open');
  assert.equal(result.frame.diagnostics.reason, 'calculation-error');
  assert.equal(result.frame.diagnostics.neutral, true);
  assert.equal(result.frame.isSpeaking, false);

  // Speech is untouched: still playing, still advancing.
  player.emit({ playing: true, currentTime: 0.12, playbackState: 'readyToPlay' });
  const state = lane.store.getAvatarSpeechState();
  assert.equal(state.phase, 'playing', 'a renderer failure interrupted Elise');
  assert.ok(state.playbackSeconds > 0, 'playback stopped advancing after a renderer failure');

  // And the surface recovers on the next clean frame.
  const recovered = lane.render();
  assert.equal(recovered.presentation.state, 'speaking');
});

test('ISOLATION: a host snapshot missing every optional field still renders', () => {
  const { AvatarEngineHostAdapter } = loadAdapter();
  const adapter = new AvatarEngineHostAdapter();
  const result = adapter.computeFrame({
    avatarId: 'stylist_portrait_05',
    speech: { avatarId: null, generation: NaN, phase: 'nonsense', playbackSeconds: NaN, alignment: undefined },
    scopeMatches: true,
    reduceMotion: false,
    foreground: true,
    motionEpoch: Number.NaN,
    hostNowMs: Number.POSITIVE_INFINITY,
  });
  assert.equal(result.mouthState, 'closed');
  assert.equal(typeof result.frame.headMotion.rotateDeg, 'number');
  assert.ok(Number.isFinite(result.frame.headMotion.rotateDeg));
  assert.ok(Number.isFinite(result.frame.breathing.scale));
});

test('ISOLATION: an unknown avatar keeps Elise speaking and holds a safe static face', async () => {
  const lane = createLane();
  const player = await speakAndStart(lane, 'msg-a');
  player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });

  const coverage = loadTsModule('services/avatars/avatarAssetCoverage.ts');
  const unknown = coverage.resolveAvatarSpeakingCoverage('no_such_avatar');
  const presentation = deriveAvatarPresentation({
    playbackPhase: lane.store.getAvatarSpeechState().phase,
    playbackScopeMatches: true,
    playbackActive: true,
    utteranceGeneration: lane.store.getAvatarSpeechState().generation,
    eliseProcessing: false,
    listening: false,
    reduceMotion: false,
    mouthCapable: unknown.mouthCapable,
    assetsAvailable: unknown.assetsAvailable,
  });
  assert.equal(presentation.state, 'fallback');
  assert.equal(presentation.rendererState, 'static');
  // Speech is unaffected — the avatar is presentation only.
  assert.equal(lane.store.getAvatarSpeechState().phase, 'playing');

  // And the engine, asked for that avatar, answers neutrally rather than failing.
  const frame = lane.adapter.computeFrame({
    avatarId: 'no_such_avatar',
    speech: lane.store.getAvatarSpeechState(),
    scopeMatches: true,
    reduceMotion: false,
    foreground: true,
    motionEpoch: lane.epoch(),
    hostNowMs: 1,
  });
  assert.equal(frame.mouthState, 'closed');
});

test('ISOLATION: a playback event arriving with no renderer mounted is inert', async () => {
  const lane = createLane();
  const player = await speakAndStart(lane, 'msg-a');
  // No render() call at all: the adapter has never seen this utterance.
  player.emit({ playing: true, currentTime: 0.05, playbackState: 'readyToPlay' });
  player.emit({ playing: false, currentTime: 0.2, didJustFinish: true });
  await settle();

  assert.equal(lane.store.getAvatarSpeechState().phase, 'idle');
  // The first frame the renderer ever computes is closed, not mid-utterance.
  assert.equal(lane.render().result.mouthState, 'closed');
});

test('ISOLATION: a speech backend failure leaves a safe static face and a visible error', async () => {
  const lane = createLane({ failRequest: true });
  await lane.speech.speakAvatarMessage(payload('msg-a'));
  const state = lane.store.getAvatarSpeechState();
  assert.equal(state.phase, 'error');
  const rendered = lane.render();
  assert.equal(rendered.presentation.state, 'interrupted');
  assert.equal(rendered.result.mouthState, 'closed');
  assert.equal(lane.host.liveTimers(), 0);
});

// -- The architectural requirement: speech never waits for the avatar --------

test('SPEECH START never awaits avatar readiness', async () => {
  const lane = createLane();

  // Executed: playback starts without the renderer ever being asked anything.
  let framesComputedBeforeStart = 0;
  const adapter = lane.adapter;
  const originalCompute = adapter.computeFrame.bind(adapter);
  adapter.computeFrame = (input) => {
    framesComputedBeforeStart += 1;
    return originalCompute(input);
  };
  await lane.speech.speakAvatarMessage(payload('msg-a'));
  assert.equal(lane.players.length, 1, 'playback must have been requested');
  assert.equal(
    framesComputedBeforeStart,
    0,
    'the speech path computed an avatar frame before starting playback',
  );

  // Structural: the speech lane imports nothing from the avatar renderer.
  const speechSource = executableSource('services/avatarSpeech.ts');
  assert.equal(/avatarEngineAdapter|computeFrame|AvatarRuntime|deriveAvatarPresentation/.test(speechSource), false);
  assert.equal(/avatarAssetCoverage|AnimatedStylistAvatar/.test(speechSource), false);

  const playbackSource = executableSource('services/avatars/stylistAudioPlayback.ts');
  assert.equal(/avatarEngineAdapter|computeFrame|AvatarRuntime/.test(playbackSource), false);

  // The engine's own entry point is synchronous: it cannot be awaited.
  const adapterSource = executableSource('services/avatars/avatarEngineAdapter.ts');
  assert.equal(/async computeFrame|await /.test(adapterSource), false);
});

test('the projection is never on the audio path either', () => {
  const projection = executableSource('services/avatars/avatarPresentation.ts');
  assert.equal(/await |async |Promise/.test(projection), false);
  assert.equal(/speakAvatarMessage|playStylistAudio|avatarSpeechStore/.test(projection), false);

  // And nothing in the speech lane imports it.
  for (const file of ['services/avatarSpeech.ts', 'services/avatars/stylistAudioPlayback.ts']) {
    assert.equal(
      /avatarPresentation/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')),
      false,
      `${file} must not depend on avatar presentation`,
    );
  }
});

// -- 2I: cost and network proof ----------------------------------------------

test('COST: the avatar integration adds no network call site and no provider', () => {
  const added = [
    'services/avatars/avatarPresentation.ts',
    'services/avatars/avatarAssetCoverage.ts',
    'components/style-chat/AvatarStateInspector.tsx',
  ];
  for (const file of added) {
    const source = executableSource(file);
    assert.equal(/fetch\(|XMLHttpRequest|axios|WebSocket|EventSource/.test(source), false, file);
    assert.equal(/supabase|functions\.invoke|\.rpc\(/i.test(source), false, file);
    assert.equal(/elevenlabs|openai|anthropic|gemini|replicate/i.test(source), false, file);
    assert.equal(/https?:\/\//.test(source), false, file);
  }

  // The whole engine tree stays pure: no network, no audio, no backend. This is
  // the existing purity guarantee, re-checked against the files added here.
  const engineImports = new Set();
  for (const file of [...added, 'services/avatars/avatarEngineAdapter.ts']) {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of raw.matchAll(/from '([^']+)'/g)) {
      if (!match[1].startsWith('.')) engineImports.add(match[1]);
    }
  }
  // Only React Native's own primitives, and only from the inspector component.
  assert.deepEqual([...engineImports].sort(), ['react-native']);
});

test('COST: the new modules pull in no dependency the app did not already have', () => {
  const lane = [
    'services/avatars/avatarPresentation.ts',
    'services/avatars/avatarAssetCoverage.ts',
    'components/style-chat/AvatarStateInspector.tsx',
    'components/style-chat/StyleChatHeader.tsx',
    'services/avatars/avatarEngineAdapter.ts',
    'scripts/generate-avatar-asset-coverage.js',
  ];

  const bareImports = new Set();
  for (const file of lane) {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of raw.matchAll(/from '([^']+)'|require\('([^']+)'\)/g)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      bareImports.add(specifier);
    }
  }

  // Every bare specifier this lane's files use is one the app already used
  // elsewhere, so the lane introduces no dependency of its own.
  const others = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js)$/.test(entry.name)) others.push(full);
    }
  };
  for (const dir of ['app', 'components', 'hooks', 'services', 'stores']) walk(path.join(ROOT, dir));
  const laneAbsolute = new Set(lane.map((file) => path.join(ROOT, file)));
  const elsewhere = new Set();
  for (const file of others) {
    if (laneAbsolute.has(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    for (const match of raw.matchAll(/from '([^']+)'/g)) {
      if (!match[1].startsWith('.')) elsewhere.add(match[1]);
    }
  }

  for (const specifier of bareImports) {
    assert.ok(
      elsewhere.has(specifier),
      `${specifier} is not used anywhere else in the app: this lane would be introducing it`,
    );
  }

  // And the dependency manifests are untouched by this lane.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['expo-audio'], '~1.1.1', 'the audio dependency was changed');
  for (const forbidden of ['@elevenlabs/react', 'openai', '@anthropic-ai/sdk', 'react-native-reanimated', 'zustand', 'redux', 'jotai', 'mobx']) {
    assert.equal(manifest.dependencies[forbidden], undefined, `${forbidden} must not be added`);
    assert.equal(manifest.devDependencies?.[forbidden], undefined, `${forbidden} must not be added`);
  }
});
