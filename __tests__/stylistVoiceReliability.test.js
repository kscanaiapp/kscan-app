// Behavioral coverage for the Build 29 Elise voice reliability repair (IOS-01).
//
// These tests execute the real playback and speech-service modules against a
// mock of the *public* expo-audio surface actually consumed by
// stylistAudioPlayback.ts. Status objects conform to the pinned expo-audio
// 1.1.1 AudioStatus shape, and the two platforms are distinguished only by the
// public field values each one really produces:
//
//   iOS     - playbackState stays 'readyToPlay'; there is no 'idle' state, and
//             didJustFinish is a one-shot flag set separately from it.
//   Android - playbackState reports ExoPlayer states ('ready'/'buffering'/
//             'idle'/'ended'); an audio-focus pause flips `playing` to false
//             without changing playbackState.
//
// Timers are injected, so no test sleeps in real time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function createFakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();

  return {
    setTimeout(fn, ms) {
      sequence += 1;
      timers.set(sequence, { fn, at: now + (typeof ms === 'number' ? ms : 0) });
      return sequence;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.timer.at)) {
            due = { id, timer };
          }
        }
        if (!due) break;
        timers.delete(due.id);
        now = due.timer.at;
        due.timer.fn();
      }
      now = target;
    },
    pendingCount() {
      return timers.size;
    },
  };
}

function load(file, mocks, globals = {}) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    AbortController,
    Array,
    Boolean,
    console,
    Error,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    setTimeout,
    clearTimeout,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
    ...globals,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

/** A complete expo-audio 1.1.1 AudioStatus. */
function audioStatus(overrides = {}) {
  return {
    id: 1,
    currentTime: 0,
    playbackState: 'ready',
    timeControlStatus: 'playing',
    reasonForWaitingToPlay: '',
    mute: false,
    duration: 12,
    playing: false,
    loop: false,
    didJustFinish: false,
    isBuffering: false,
    isLoaded: true,
    playbackRate: 1,
    shouldCorrectPitch: false,
    ...overrides,
  };
}

/** Mocks the public expo-audio surface consumed by stylistAudioPlayback.ts. */
function createAudioEnvironment() {
  const players = [];
  const expoAudio = {
    setAudioModeAsync: async (mode) => {
      expoAudio.audioModes.push(mode);
    },
    audioModes: [],
    createAudioPlayer: (source, options) => {
      const player = {
        source,
        options,
        listeners: new Map(),
        played: false,
        paused: false,
        removed: false,
        addListener(event, handler) {
          const key = Symbol('listener');
          player.listeners.set(key, { event, handler });
          return { remove: () => player.listeners.delete(key) };
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
          for (const { event, handler } of [...player.listeners.values()]) {
            if (event === 'playbackStatusUpdate') handler(status);
          }
        },
        listenerCount() {
          return player.listeners.size;
        },
      };
      players.push(player);
      return player;
    },
  };
  return { expoAudio, players };
}

function loadPlayback(clock) {
  const { expoAudio, players } = createAudioEnvironment();
  const playback = load(
    'services/avatars/stylistAudioPlayback.ts',
    { 'expo-audio': expoAudio },
    { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  );
  return { playback, players, expoAudio };
}

function createCallbackRecorder() {
  const calls = { started: 0, progress: [], finished: 0, error: 0 };
  return {
    calls,
    callbacks: {
      onPlaybackStarted: () => {
        calls.started += 1;
      },
      onPlaybackProgress: (seconds) => {
        calls.progress.push(seconds);
      },
      onPlaybackFinished: () => {
        calls.finished += 1;
      },
      onPlaybackError: () => {
        calls.error += 1;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Playback layer: start, completion, and the stall watchdog
// ---------------------------------------------------------------------------

test('playback reports a confirmed native start and streams progress', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const recorder = createCallbackRecorder();

  await playback.playStylistAudio('file://speech.mp3', recorder.callbacks);
  const player = players[0];
  assert.equal(player.played, true, 'play() is issued immediately after creation');
  assert.equal(recorder.calls.started, 0, 'no start is reported before native playback');

  player.emit(audioStatus({ playing: true, currentTime: 0.1 }));
  assert.equal(recorder.calls.started, 1);
  assert.deepEqual(recorder.calls.progress, [0.1]);
});

test('normal completion finishes once, disposes the player, and cancels the watchdog', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const recorder = createCallbackRecorder();

  await playback.playStylistAudio('file://speech.mp3', recorder.callbacks);
  const player = players[0];
  player.emit(audioStatus({ playing: true, currentTime: 0.1 }));
  player.emit(audioStatus({ playing: false, didJustFinish: true, currentTime: 12 }));

  assert.equal(recorder.calls.finished, 1);
  assert.equal(recorder.calls.error, 0);
  assert.equal(player.removed, true, 'native player is released');
  assert.equal(player.listenerCount(), 0, 'status listener is removed');
  assert.equal(clock.pendingCount(), 0, 'no timer outlives completion');

  clock.advance(60_000);
  assert.equal(recorder.calls.error, 0, 'a retired watchdog cannot fire later');
  assert.equal(recorder.calls.finished, 1);
});

test('advancing playback never trips the stall watchdog', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const recorder = createCallbackRecorder();

  await playback.playStylistAudio('file://speech.mp3', recorder.callbacks, 10_000, 3_000);
  const player = players[0];

  player.emit(audioStatus({ playing: true, currentTime: 0.1 }));
  for (let step = 2; step <= 40; step += 1) {
    clock.advance(2_000);
    player.emit(audioStatus({ playing: true, currentTime: step * 0.1 }));
  }
  clock.advance(2_000);

  assert.equal(recorder.calls.error, 0, 'steady progress keeps re-arming the watchdog');
  assert.equal(recorder.calls.finished, 0);
});

test('a status gap shorter than the stall bound does not trip the watchdog', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const recorder = createCallbackRecorder();

  await playback.playStylistAudio('file://speech.mp3', recorder.callbacks, 10_000, 3_000);
  const player = players[0];

  player.emit(audioStatus({ playing: true, currentTime: 0.1 }));
  clock.advance(2_900);
  assert.equal(recorder.calls.error, 0);

  player.emit(audioStatus({ playing: true, currentTime: 0.2 }));
  clock.advance(2_900);
  assert.equal(recorder.calls.error, 0, 'progress resets the window');
});

test('iOS-style stall trips the watchdog exactly once without an idle state', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const recorder = createCallbackRecorder();

  await playback.playStylistAudio('file://speech.mp3', recorder.callbacks, 10_000, 3_000);
  const player = players[0];

  // iOS never reports 'idle'; an interrupted player simply stops advancing and
  // may stop emitting status callbacks altogether.
  player.emit(audioStatus({ playbackState: 'readyToPlay', playing: true, currentTime: 1.0 }));
  player.emit(audioStatus({ playbackState: 'readyToPlay', playing: true, currentTime: 1.0 }));
  assert.equal(recorder.calls.error, 0, 'a frozen position is not yet a stall');

  clock.advance(3_000);

  assert.equal(recorder.calls.error, 1, 'the independent timer detects the stall');
  assert.equal(recorder.calls.finished, 0);
  assert.equal(player.removed, true);

  clock.advance(60_000);
  assert.equal(recorder.calls.error, 1, 'the stall is reported exactly once');
});

test('iOS-style stall is detected even when status callbacks stop entirely', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const recorder = createCallbackRecorder();

  await playback.playStylistAudio('file://speech.mp3', recorder.callbacks, 10_000, 3_000);
  players[0].emit(audioStatus({ playbackState: 'readyToPlay', playing: true, currentTime: 0.5 }));

  // No further status events are delivered at all.
  clock.advance(3_000);
  assert.equal(recorder.calls.error, 1);
});

test('Android audio-focus pause trips the watchdog exactly once', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const recorder = createCallbackRecorder();

  await playback.playStylistAudio('file://speech.mp3', recorder.callbacks, 10_000, 3_000);
  const player = players[0];

  player.emit(audioStatus({ playbackState: 'ready', playing: true, currentTime: 1.0 }));
  // Audio-focus loss pauses ExoPlayer: `playing` goes false while playbackState
  // stays 'ready' and no completion is reported.
  player.emit(audioStatus({ playbackState: 'ready', playing: false, currentTime: 1.0 }));
  assert.equal(recorder.calls.error, 0);

  clock.advance(3_000);

  assert.equal(recorder.calls.error, 1);
  assert.equal(recorder.calls.finished, 0);
  clock.advance(60_000);
  assert.equal(recorder.calls.error, 1);
});

test('a manual stop cancels the watchdog and reports nothing', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const recorder = createCallbackRecorder();

  const handle = await playback.playStylistAudio(
    'file://speech.mp3', recorder.callbacks, 10_000, 3_000,
  );
  players[0].emit(audioStatus({ playing: true, currentTime: 0.4 }));
  handle.stop();

  assert.equal(clock.pendingCount(), 0, 'stop clears every timer');
  clock.advance(60_000);
  assert.equal(recorder.calls.error, 0, 'a deliberate stop is not a failure');
  assert.equal(recorder.calls.finished, 0);
});

test('a superseded player watchdog cannot fail a newer playback generation', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const older = createCallbackRecorder();
  const newer = createCallbackRecorder();

  const oldHandle = await playback.playStylistAudio(
    'file://old.mp3', older.callbacks, 10_000, 3_000,
  );
  players[0].emit(audioStatus({ playing: true, currentTime: 0.4 }));

  // Replacement: the old handle is stopped, then a new player starts.
  oldHandle.stop();
  await playback.playStylistAudio('file://new.mp3', newer.callbacks, 10_000, 3_000);
  players[1].emit(audioStatus({ playing: true, currentTime: 0.2 }));

  clock.advance(2_000);
  players[1].emit(audioStatus({ playing: true, currentTime: 0.9 }));
  clock.advance(2_000);

  assert.equal(older.calls.error, 0, 'the retired watchdog never fires');
  assert.equal(newer.calls.error, 0, 'the live playback is unaffected');
});

test('a player that never starts fails through the bounded start timeout', async () => {
  const clock = createFakeClock();
  const { playback, players } = loadPlayback(clock);
  const recorder = createCallbackRecorder();

  await playback.playStylistAudio('file://speech.mp3', recorder.callbacks, 10_000, 3_000);
  clock.advance(10_000);

  assert.equal(recorder.calls.started, 0);
  assert.equal(recorder.calls.error, 1);
  assert.equal(players[0].removed, true);
  clock.advance(60_000);
  assert.equal(recorder.calls.error, 1, 'start failure is reported once');
});

test('playback stays playback-only and never enables recording or background audio', async () => {
  const clock = createFakeClock();
  const { playback, expoAudio } = loadPlayback(clock);
  await playback.playStylistAudio('file://speech.mp3', createCallbackRecorder().callbacks);

  const mode = expoAudio.audioModes[0];
  assert.equal(mode.allowsRecording, false);
  assert.equal(mode.allowsBackgroundRecording, false);
  assert.equal(mode.shouldPlayInBackground, false);
});

// ---------------------------------------------------------------------------
// Speech service: dedupe, retryability, and error state
// ---------------------------------------------------------------------------

// The store's only React dependency is the hook it exports for components.
const REACT_MOCK = { react: { useSyncExternalStore: () => undefined } };

/** Lets a terminal speech transition settle; teardown releases resources first. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Builds the speech service against controllable request and playback layers. */
function loadSpeechService(options = {}) {
  const store = load('stores/avatarSpeechStore.ts', REACT_MOCK, {});
  const state = {
    requests: 0,
    requestOutcomes: options.requestOutcomes ?? [],
    playbackOutcomes: options.playbackOutcomes ?? [],
    playbackStops: 0,
    deletedFiles: [],
    controls: [],
  };

  const speech = load('services/avatarSpeech.ts', {
    './avatarSpeechLifecycle': {
      // Inert: this suite exercises request/retry/error behavior, not the
      // AppState interruption path (see avatarSpeechLifecycle.test.js).
      ensureAvatarSpeechLifecycleListener: () => {},
      registerAvatarInterruptionHandler: () => () => {},
    },
    '../stores/avatarSpeechStore': store,
    './avatars/stylistSpeechClient': {
      requestStylistSpeech: async (request) => {
        const outcome = state.requestOutcomes[state.requests] ?? 'ok';
        state.requests += 1;
        if (outcome === 'fail') throw new Error('Speech is temporarily unavailable.');
        return {
          messageId: request.messageId,
          stylistId: request.stylistId,
          voiceProfile: 'feminine',
          mimeType: 'audio/mpeg',
          audioBase64: 'YQ==',
          alignment: null,
        };
      },
    },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: async () => 'file://speech.mp3',
      deleteTemporaryStylistSpeechFile: async (uri) => {
        if (uri) state.deletedFiles.push(uri);
      },
    },
    './avatars/stylistAudioPlayback': {
      playStylistAudio: async (uri, callbacks) => {
        const index = state.controls.length;
        const outcome = state.playbackOutcomes[index] ?? 'start';
        const control = { callbacks, stopped: false };
        state.controls.push(control);
        if (outcome === 'start') callbacks.onPlaybackStarted();
        if (outcome === 'error') callbacks.onPlaybackError();
        if (outcome === 'throw') throw new Error('Speech playback could not start.');
        return {
          stop: () => {
            control.stopped = true;
            state.playbackStops += 1;
          },
        };
      },
    },
  });

  return { speech, store, state };
}

const PAYLOAD = {
  actorId: 'actor-1',
  sessionId: 'session-1',
  messageId: 'message-1',
  stylistId: 'stylist_portrait_05',
  avatarId: 'stylist_portrait_05',
  source: 'message',
};

test('a confirmed spoken message is not spoken again automatically', async () => {
  const { speech, state } = loadSpeechService();

  await speech.speakAvatarMessage(PAYLOAD);
  state.controls[0].callbacks.onPlaybackFinished();
  await flush();
  await speech.speakAvatarMessage(PAYLOAD);

  assert.equal(state.requests, 1, 'a successful message is retired from auto-speech');
});

test('a request failure leaves the message retryable and reports a visible error', async () => {
  const { speech, store, state } = loadSpeechService({ requestOutcomes: ['fail'] });

  await speech.speakAvatarMessage(PAYLOAD);

  assert.equal(store.getAvatarSpeechState().phase, 'error');
  assert.equal(
    store.getAvatarSpeechState().error,
    'Speech is temporarily unavailable.',
    'the store carries user-facing copy, never a provider detail',
  );

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(state.requests, 2, 'the failed message is attempted again');
});

test('a player-start failure leaves the message retryable', async () => {
  const { speech, store, state } = loadSpeechService({ playbackOutcomes: ['error'] });

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(store.getAvatarSpeechState().phase, 'error');

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(state.requests, 2);
});

test('a stall after playback started leaves the message retryable by explicit retry', async () => {
  const { speech, store, state } = loadSpeechService();

  await speech.speakAvatarMessage(PAYLOAD);
  // Confirmed start, then the watchdog reports a stall.
  state.controls[0].callbacks.onPlaybackError();
  await flush();
  assert.equal(store.getAvatarSpeechState().phase, 'error');

  // Automatic speech is retired because playback genuinely started once.
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(state.requests, 1, 'auto-speech does not repeat a message that began playing');

  await speech.speakAvatarMessage({ ...PAYLOAD, trigger: 'retry' });
  assert.equal(state.requests, 2, 'an explicit retry is still honoured');
});

test('an explicit retry clears the error once playback is confirmed', async () => {
  const { speech, store, state } = loadSpeechService({ playbackOutcomes: ['error', 'start'] });

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(store.getAvatarSpeechState().phase, 'error');

  await speech.speakAvatarMessage({ ...PAYLOAD, trigger: 'retry' });
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
  assert.equal(store.getAvatarSpeechState().error, null);
  assert.equal(state.requests, 2);
});

test('a duplicate retry while one is already in flight is suppressed', async () => {
  const { speech, state } = loadSpeechService({ playbackOutcomes: ['none', 'none'] });

  await speech.speakAvatarMessage({ ...PAYLOAD, trigger: 'retry' });
  await speech.speakAvatarMessage({ ...PAYLOAD, trigger: 'retry' });

  assert.equal(state.requests, 1, 'the in-flight attempt owns the message');
});

test('two retries dispatched in the same tick still produce one attempt', async () => {
  const { speech, state } = loadSpeechService({ playbackOutcomes: ['none', 'none'] });

  // A genuine double tap: neither call has awaited the other.
  await Promise.all([
    speech.speakAvatarMessage({ ...PAYLOAD, trigger: 'retry' }),
    speech.speakAvatarMessage({ ...PAYLOAD, trigger: 'retry' }),
  ]);

  assert.equal(state.requests, 1, 'the superseded attempt aborts before requesting');
  assert.equal(state.controls.length, 1, 'only one player is ever created');
});

test('a playback layer that throws still leaves the message retryable', async () => {
  const { speech, store, state } = loadSpeechService({ playbackOutcomes: ['throw'] });

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(store.getAvatarSpeechState().phase, 'error');

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(state.requests, 2);
});

test('a failed greeting does not poison a later message and may be attempted again', async () => {
  const greeting = { ...PAYLOAD, messageId: 'greeting-1', source: 'greeting' };
  const { speech, state } = loadSpeechService({ requestOutcomes: ['fail'] });

  await speech.speakAvatarMessage(greeting);
  assert.equal(state.requests, 1);

  // A later assistant message still speaks normally.
  await speech.speakAvatarMessage({ ...PAYLOAD, messageId: 'message-2' });
  assert.equal(state.requests, 2);
  assert.equal(state.controls.length, 1, 'only the successful attempt reached playback');

  // The greeting itself remains eligible on a later entry.
  await speech.speakAvatarMessage(greeting);
  assert.equal(state.requests, 3);
});

test('a newer message replaces active audio and supersedes the older generation', async () => {
  const { speech, store, state } = loadSpeechService();

  await speech.speakAvatarMessage(PAYLOAD);
  const first = state.controls[0];
  await speech.speakAvatarMessage({ ...PAYLOAD, messageId: 'message-2' });

  assert.equal(first.stopped, true, 'the previous player is stopped');
  assert.ok(state.deletedFiles.length >= 1, 'the previous temporary file is deleted');
  assert.equal(store.getAvatarSpeechState().messageId, 'message-2');

  // Stale callbacks from the replaced generation cannot corrupt current state.
  first.callbacks.onPlaybackError();
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
  assert.equal(store.getAvatarSpeechState().messageId, 'message-2');
});

test('stopping speech releases the in-flight claim so the message can speak later', async () => {
  const { speech, store, state } = loadSpeechService({ playbackOutcomes: ['none'] });

  await speech.speakAvatarMessage(PAYLOAD);
  await speech.stopAvatarSpeechPlayback({ actorId: PAYLOAD.actorId });

  assert.equal(store.getAvatarSpeechState().phase, 'idle');
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(state.requests, 2, 'a stopped attempt never confirmed playback, so it may retry');
});

test('speech never reaches the network for an incomplete or mismatched identity', async () => {
  const { speech, state } = loadSpeechService();

  await speech.speakAvatarMessage({ ...PAYLOAD, actorId: '' });
  await speech.speakAvatarMessage({ ...PAYLOAD, messageId: '' });
  await speech.speakAvatarMessage({ ...PAYLOAD, stylistId: 'stylist_portrait_02' });

  assert.equal(state.requests, 0);
});

// ---------------------------------------------------------------------------
// Retry presentation rules
// ---------------------------------------------------------------------------

function loadRetryPresentation() {
  return load('services/avatars/voiceRetryPresentation.ts', {}, {});
}

function speechState(overrides = {}) {
  return {
    actorId: 'actor-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    stylistId: 'stylist_portrait_05',
    avatarId: 'stylist_portrait_05',
    generation: 1,
    phase: 'error',
    playbackSeconds: 0,
    alignment: null,
    source: 'message',
    error: null,
    ...overrides,
  };
}

const SCOPE = {
  actorId: 'actor-1',
  sessionId: 'session-1',
  messageId: 'message-1',
  avatarId: 'stylist_portrait_05',
};

test('retry state is owned only by the exact actor, session, message, and avatar', () => {
  const presentation = loadRetryPresentation();

  assert.equal(presentation.ownsAvatarSpeechScope(speechState(), SCOPE), true);
  assert.equal(
    presentation.ownsAvatarSpeechScope(speechState({ actorId: 'actor-2' }), SCOPE), false,
  );
  assert.equal(
    presentation.ownsAvatarSpeechScope(speechState({ sessionId: 'session-2' }), SCOPE), false,
  );
  assert.equal(
    presentation.ownsAvatarSpeechScope(speechState({ messageId: 'message-2' }), SCOPE), false,
  );
  assert.equal(
    presentation.ownsAvatarSpeechScope(
      speechState({ avatarId: 'stylist_portrait_02', stylistId: 'stylist_portrait_02' }),
      SCOPE,
    ),
    false,
  );
  assert.equal(
    presentation.ownsAvatarSpeechScope(speechState(), { ...SCOPE, actorId: null }), false,
  );
});

test('the retry control appears on failure and retires after confirmed playback', () => {
  const presentation = loadRetryPresentation();

  const failed = presentation.nextVoiceRetryFailedState(
    false, { ownsSpeechState: true, phase: 'error' },
  );
  assert.equal(failed, true);

  const stillFailedWhileRetrying = presentation.nextVoiceRetryFailedState(
    failed, { ownsSpeechState: true, phase: 'requesting' },
  );
  assert.equal(stillFailedWhileRetrying, true, 'the control stays put while a retry runs');

  const recovered = presentation.nextVoiceRetryFailedState(
    stillFailedWhileRetrying, { ownsSpeechState: true, phase: 'playing' },
  );
  assert.equal(recovered, false, 'confirmed playback retires the control');
});

test('a newer speech attempt supersedes an older message error', () => {
  const presentation = loadRetryPresentation();

  const superseded = presentation.nextVoiceRetryFailedState(
    true, { ownsSpeechState: false, phase: 'playing' },
  );
  assert.equal(superseded, false);

  const afterReset = presentation.nextVoiceRetryFailedState(
    true, { ownsSpeechState: false, phase: 'idle' },
  );
  assert.equal(afterReset, false);
});

test('retry is disabled only while this message has speech in progress', () => {
  const presentation = loadRetryPresentation();

  for (const phase of ['requesting', 'ready', 'stopping']) {
    assert.equal(
      presentation.isVoiceRetryInFlight({ ownsSpeechState: true, phase }), true, phase,
    );
  }
  assert.equal(presentation.isVoiceRetryInFlight({ ownsSpeechState: true, phase: 'error' }), false);
  assert.equal(
    presentation.isVoiceRetryInFlight({ ownsSpeechState: false, phase: 'requesting' }), false,
  );
});

// ---------------------------------------------------------------------------
// Spoken length contract and text-first guarantees
// ---------------------------------------------------------------------------

test('the spoken bound covers the longest reply StyleChat can show', () => {
  const speechSource = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/stylist-speech/speechText.ts'), 'utf8',
  );
  const generateSource = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/stylechat-generate/index.ts'), 'utf8',
  );

  const speechMax = Number(/MAX_SPEECH_CHARACTERS\s*=\s*(\d+)/.exec(speechSource)?.[1]);
  const replyMax = Number(/MAX_RESPONSE_CHARS\s*=\s*(\d+)/.exec(generateSource)?.[1]);

  assert.ok(Number.isFinite(speechMax) && Number.isFinite(replyMax));
  assert.ok(
    speechMax >= replyMax,
    `spoken bound ${speechMax} must cover the ${replyMax} character reply bound`,
  );
});

test('a maximum-length reply is spoken in full rather than silently truncated', () => {
  const speechText = load(
    'supabase/functions/stylist-speech/speechText.ts', {}, {},
  );
  const sentence = 'Pair the navy blazer with the ivory silk shell and tailored trousers. ';
  let reply = '';
  while ((reply + sentence).length <= 1000) reply += sentence;
  reply = reply.trim();

  assert.ok(reply.length > 700, 'the fixture exceeds the previous spoken bound');
  assert.equal(speechText.buildSpeechText(reply), reply);
});

test('speech failure cannot touch StyleChat text, quota, or persistence', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/avatarSpeech.ts'), 'utf8');

  for (const forbidden of [
    'saveStyleChatMessage',
    'setMessages',
    'messagesUsed',
    'messagesLimit',
    'listStyleChatMessages',
    'styleChatAttachment',
  ]) {
    assert.equal(
      source.includes(forbidden), false,
      `the speech service must not reach into ${forbidden}`,
    );
  }

  // Every speech call in StyleChat is fire-and-forget so a rejected promise can
  // never fail the surrounding send.
  const hook = fs.readFileSync(path.join(ROOT, 'hooks/useStyleChat.ts'), 'utf8');
  const speechCalls = hook.match(/[^\s]*\s*speakAvatarMessage\(/g) ?? [];
  assert.ok(speechCalls.length >= 2);
  for (const call of speechCalls) {
    assert.match(call, /void\s*speakAvatarMessage\(/);
  }
});

test('the retry control reuses the authenticated speech path and sends references only', () => {
  const component = fs.readFileSync(
    path.join(ROOT, 'components/style-chat/StyleChatVoiceRetry.tsx'), 'utf8',
  );

  assert.match(component, /speakAvatarMessage\(/, 'retry reuses the one speech entry point');
  assert.match(component, /trigger:\s*'retry'/);
  assert.equal(
    /content|message\.content|speechText/.test(component), false,
    'the client never sends assistant text for speech',
  );
  assert.equal(
    /requestStylistSpeech|functions\.invoke/.test(component), false,
    'the control must not open a second TTS path',
  );
});

test('per-message recovery subscribes to derived values, not the whole speech state', () => {
  const store = load('stores/avatarSpeechStore.ts', REACT_MOCK, {});
  assert.equal(typeof store.useAvatarSpeechSelection, 'function');

  const component = fs.readFileSync(
    path.join(ROOT, 'components/style-chat/StyleChatVoiceRetry.tsx'), 'utf8',
  );
  // Subscribing to the whole state would re-render every assistant reply on
  // screen each time the playback position advances.
  assert.equal(
    /useAvatarSpeechState\s*\(/.test(component), false,
    'recovery UI must not subscribe to the full speech state',
  );
  assert.match(component, /useAvatarSpeechSelection\(/);
});

test('a selector subscription only reports a change when its own value changes', () => {
  const store = load('stores/avatarSpeechStore.ts', REACT_MOCK, {});
  const seen = [];
  const unsubscribe = store.subscribeToAvatarSpeech(() => {
    seen.push(store.getAvatarSpeechState().phase);
  });

  store.beginAvatarSpeech({
    actorId: 'actor-1', sessionId: 'session-1', messageId: 'message-1',
    stylistId: 'stylist_portrait_05', avatarId: 'stylist_portrait_05',
    generation: 1, source: 'message',
  });
  store.markAvatarSpeechReady(1, null);
  store.markAvatarSpeechPlaying(1);

  const phasesBeforeProgress = seen.length;
  store.updateAvatarSpeechPlayback(1, 0.2);
  store.updateAvatarSpeechPlayback(1, 0.4);
  store.updateAvatarSpeechPlayback(1, 0.6);

  // The store still notifies on progress, which is why the phase selector - not
  // the whole state - is what keeps message rows from re-rendering.
  assert.ok(seen.length > phasesBeforeProgress);
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
  assert.deepEqual(seen.slice(phasesBeforeProgress), ['playing', 'playing', 'playing']);

  unsubscribe();
});

test('voice recovery is rendered per message and stays separate from Report Response', () => {
  const bubble = fs.readFileSync(
    path.join(ROOT, 'components/style-chat/StyleChatBubble.tsx'), 'utf8',
  );

  assert.match(bubble, /<StyleChatVoiceRetry\s+sessionId=\{message\.sessionId\}/);
  assert.match(bubble, /messageId=\{message\.id\}/);
  // Report Response remains its own independent control.
  assert.match(bubble, /openAiOutputReport\(\{/);
  assert.match(bubble, /Report Response/);

  const header = fs.readFileSync(
    path.join(ROOT, 'components/style-chat/StyleChatHeader.tsx'), 'utf8',
  );
  assert.equal(
    header.includes('StyleChatVoiceRetry'), false,
    'recovery belongs to the failed message, not the header',
  );
});
