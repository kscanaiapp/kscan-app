const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function transpileModule(file, mocks, sourceTransform = (source) => source) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(sourceTransform(fs.readFileSync(sourcePath, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    AbortController,
    console,
    Date,
    Error,
    Promise,
    Set,
    setTimeout,
    clearTimeout,
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

function createAppStateMock() {
  const record = {
    addCalls: 0,
    removeCalls: 0,
    activeHandlers: new Set(),
  };
  record.AppState = {
    addEventListener: (eventName, handler) => {
      assert.equal(eventName, 'change');
      record.addCalls += 1;
      record.activeHandlers.add(handler);
      return {
        remove: () => {
          record.removeCalls += 1;
          record.activeHandlers.delete(handler);
        },
      };
    },
  };
  record.fire = (state) => {
    for (const handler of [...record.activeHandlers]) handler(state);
  };
  return record;
}

function loadLifecycle(appState) {
  return transpileModule('services/avatarSpeechLifecycle.ts', {
    'react-native': { AppState: appState.AppState },
  });
}

function loadSpeechStore() {
  return transpileModule(
    'stores/avatarSpeechStore.ts',
    {},
    (source) => source.replace("import { useSyncExternalStore } from 'react';", ''),
  );
}

function loadSpeechService({ store, lifecycle, playback }) {
  return transpileModule('services/avatarSpeech.ts', {
    '../stores/avatarSpeechStore': store,
    './avatarSpeechLifecycle': lifecycle,
    './avatars/stylistSpeechClient': {
      requestStylistSpeech: async (request) => ({
        messageId: request.messageId,
        stylistId: request.stylistId,
        voiceProfile: 'feminine',
        mimeType: 'audio/mpeg',
        audioBase64: 'YXVkaW8=',
        alignment: null,
      }),
    },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: async ({ messageId }) => `file://${messageId}.mp3`,
      deleteTemporaryStylistSpeechFile: async () => {},
    },
    './avatars/stylistAudioPlayback': playback,
  });
}

const PAYLOAD = {
  actorId: 'actor-1',
  sessionId: 'session-1',
  messageId: 'message-1',
  stylistId: 'stylist_portrait_05',
  avatarId: 'stylist_portrait_05',
  source: 'message',
};

test('repeated initialization installs exactly one AppState subscription', () => {
  const appState = createAppStateMock();
  const lifecycle = loadLifecycle(appState);
  lifecycle.ensureAvatarSpeechLifecycleListener();
  lifecycle.ensureAvatarSpeechLifecycleListener();
  lifecycle.ensureAvatarSpeechLifecycleListener();
  assert.equal(appState.addCalls, 1);
  assert.equal(lifecycle.isAvatarSpeechLifecycleListenerActive(), true);
});

test('teardown removes the subscription, clears the handle, and re-init installs one new subscription', () => {
  const appState = createAppStateMock();
  const lifecycle = loadLifecycle(appState);
  lifecycle.ensureAvatarSpeechLifecycleListener();
  lifecycle.teardownAvatarSpeechLifecycleListener();
  assert.equal(appState.removeCalls, 1);
  assert.equal(lifecycle.isAvatarSpeechLifecycleListenerActive(), false);
  // Teardown is idempotent: no double-remove of a cleared handle.
  lifecycle.teardownAvatarSpeechLifecycleListener();
  assert.equal(appState.removeCalls, 1);
  lifecycle.ensureAvatarSpeechLifecycleListener();
  lifecycle.ensureAvatarSpeechLifecycleListener();
  assert.equal(appState.addCalls, 2);
  assert.equal(appState.activeHandlers.size, 1);
});

test('a failing interruption handler cannot block the remaining handlers', () => {
  const appState = createAppStateMock();
  const lifecycle = loadLifecycle(appState);
  const seen = [];
  lifecycle.registerAvatarInterruptionHandler(() => {
    throw new Error('broken subscriber');
  });
  lifecycle.registerAvatarInterruptionHandler((reason) => seen.push(reason));
  lifecycle.ensureAvatarSpeechLifecycleListener();
  appState.fire('background');
  assert.deepEqual(seen, ['app-background']);
  appState.fire('inactive');
  assert.deepEqual(seen, ['app-background', 'app-inactive']);
});

test('unregistering an interruption handler stops its delivery', () => {
  const appState = createAppStateMock();
  const lifecycle = loadLifecycle(appState);
  let calls = 0;
  const unregister = lifecycle.registerAvatarInterruptionHandler(() => {
    calls += 1;
  });
  lifecycle.ensureAvatarSpeechLifecycleListener();
  appState.fire('background');
  unregister();
  appState.fire('background');
  assert.equal(calls, 1);
  assert.equal(lifecycle.getAvatarInterruptionHandlerCountForTests(), 0);
});

test('foreground transitions are not interruptions', () => {
  const appState = createAppStateMock();
  const lifecycle = loadLifecycle(appState);
  let calls = 0;
  lifecycle.registerAvatarInterruptionHandler(() => {
    calls += 1;
  });
  lifecycle.ensureAvatarSpeechLifecycleListener();
  appState.fire('active');
  assert.equal(calls, 0);
});

test('backgrounding during playback leaves the playing state immediately and stops the player', async () => {
  const appState = createAppStateMock();
  const lifecycle = loadLifecycle(appState);
  const store = loadSpeechStore();
  let stops = 0;
  let capturedCallbacks;
  const speech = loadSpeechService({
    store,
    lifecycle,
    playback: {
      playStylistAudio: async (_uri, callbacks) => {
        capturedCallbacks = callbacks;
        return { stop: () => { stops += 1; } };
      },
    },
  });

  await speech.speakAvatarMessage(PAYLOAD);
  capturedCallbacks.onPlaybackStarted();
  capturedCallbacks.onPlaybackProgress(0.4);
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
  assert.equal(appState.addCalls, 1, 'speech request lazily installs the lifecycle listener');

  appState.fire('background');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = store.getAvatarSpeechState();
  assert.equal(state.phase, 'idle');
  assert.equal(state.playbackSeconds, 0);
  assert.equal(state.alignment, null);
  assert.equal(stops, 1);
});

test('stale playback callbacks after a background interruption remain inert', async () => {
  const appState = createAppStateMock();
  const lifecycle = loadLifecycle(appState);
  const store = loadSpeechStore();
  let capturedCallbacks;
  const speech = loadSpeechService({
    store,
    lifecycle,
    playback: {
      playStylistAudio: async (_uri, callbacks) => {
        capturedCallbacks = callbacks;
        return { stop: () => {} };
      },
    },
  });

  await speech.speakAvatarMessage(PAYLOAD);
  capturedCallbacks.onPlaybackStarted();
  appState.fire('background');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getAvatarSpeechState().phase, 'idle');

  // Late native callbacks from the interrupted generation must not restart
  // any visible state.
  capturedCallbacks.onPlaybackStarted();
  capturedCallbacks.onPlaybackProgress(1.2);
  capturedCallbacks.onPlaybackFinished();
  capturedCallbacks.onPlaybackError();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getAvatarSpeechState().phase, 'idle');
  assert.equal(store.getAvatarSpeechState().playbackSeconds, 0);
});

test('foreground return does not revive obsolete speech', async () => {
  const appState = createAppStateMock();
  const lifecycle = loadLifecycle(appState);
  const store = loadSpeechStore();
  let plays = 0;
  let capturedCallbacks;
  const speech = loadSpeechService({
    store,
    lifecycle,
    playback: {
      playStylistAudio: async (_uri, callbacks) => {
        plays += 1;
        capturedCallbacks = callbacks;
        return { stop: () => {} };
      },
    },
  });

  await speech.speakAvatarMessage(PAYLOAD);
  capturedCallbacks.onPlaybackStarted();
  appState.fire('background');
  await new Promise((resolve) => setTimeout(resolve, 0));
  appState.fire('active');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(plays, 1, 'no automatic mid-sentence resume');
  assert.equal(store.getAvatarSpeechState().phase, 'idle');
});

test('the speech service registers its interruption handler exactly once across requests', async () => {
  const appState = createAppStateMock();
  const lifecycle = loadLifecycle(appState);
  const store = loadSpeechStore();
  const speech = loadSpeechService({
    store,
    lifecycle,
    playback: {
      playStylistAudio: async () => ({ stop: () => {} }),
    },
  });

  await speech.speakAvatarMessage(PAYLOAD);
  await speech.speakAvatarMessage({ ...PAYLOAD, messageId: 'message-2' });
  await speech.speakAvatarMessage({ ...PAYLOAD, messageId: 'message-3' });
  assert.equal(lifecycle.getAvatarInterruptionHandlerCountForTests(), 1);
  assert.equal(appState.addCalls, 1);
});

test('lifecycle ownership stays in the service layer, not in UI components', () => {
  const speechSource = fs.readFileSync(path.join(ROOT, 'services', 'avatarSpeech.ts'), 'utf8');
  assert.match(speechSource, /ensureAvatarSpeechLifecycleListener/);
  for (const componentFile of [
    path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'),
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
  ]) {
    const source = fs.readFileSync(componentFile, 'utf8');
    assert.doesNotMatch(source, /AppState/, componentFile);
  }
});
