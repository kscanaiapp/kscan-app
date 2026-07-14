const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function load(file, mocks, transform = (source) => source) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(transform(fs.readFileSync(sourcePath, 'utf8')), {
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
    RegExp,
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

function speechResponse(overrides = {}) {
  return {
    messageId: 'message-1',
    stylistId: 'stylist_portrait_05',
    voiceProfile: 'feminine',
    mimeType: 'audio/mpeg',
    audioBase64: 'YXVkaW8=',
    alignment: {
      characters: ['H', 'i'],
      characterStartTimesSeconds: [0, 0.1],
      characterEndTimesSeconds: [0.1, 0.2],
    },
    ...overrides,
  };
}

function loadSpeechStore() {
  return load(
    'stores/avatarSpeechStore.ts',
    {},
    (source) => source.replace("import { useSyncExternalStore } from 'react';", ''),
  );
}

test('authenticated client invokes stylist-speech with references only', async () => {
  let invocation;
  const client = load('services/avatars/stylistSpeechClient.ts', {
    '../supabaseClient': {
      supabase: {
        functions: {
          invoke: async (name, options) => {
            invocation = { name, options };
            return { data: speechResponse(), error: null };
          },
        },
      },
    },
  });
  const result = await client.requestStylistSpeech({
    actorId: 'actor-secret-scope',
    sessionId: 'session-1',
    messageId: 'message-1',
    stylistId: 'stylist_portrait_05',
    signal: new AbortController().signal,
  });
  assert.equal(invocation.name, 'stylist-speech');
  assert.deepEqual(
    JSON.parse(JSON.stringify(invocation.options.body)),
    { sessionId: 'session-1', messageId: 'message-1', stylistId: 'stylist_portrait_05' },
  );
  assert.equal('actorId' in invocation.options.body, false);
  assert.equal('text' in invocation.options.body, false);
  assert.equal('voiceProfile' in invocation.options.body, false);
  assert.equal(result.alignment.characters.join(''), 'Hi');
});

test('client rejects mismatched identities, malformed timing, and function errors', async () => {
  for (const returned of [
    speechResponse({ messageId: 'another-message' }),
    speechResponse({ alignment: {
      characters: ['H', 'i'],
      characterStartTimesSeconds: [0.2, 0.1],
      characterEndTimesSeconds: [0.3, 0.2],
    } }),
  ]) {
    const client = load('services/avatars/stylistSpeechClient.ts', {
      '../supabaseClient': { supabase: { functions: { invoke: async () => ({ data: returned, error: null }) } } },
    });
    await assert.rejects(client.requestStylistSpeech({
      actorId: 'actor', sessionId: 'session-1', messageId: 'message-1', stylistId: 'stylist_portrait_05',
    }), /invalid/i);
  }
  const failedClient = load('services/avatars/stylistSpeechClient.ts', {
    '../supabaseClient': {
      supabase: { functions: { invoke: async () => ({ data: null, error: new Error('secret provider body') }) } },
    },
  });
  await assert.rejects(
    failedClient.requestStylistSpeech({
      actorId: 'actor', sessionId: 'session-1', messageId: 'message-1', stylistId: 'stylist_portrait_05',
    }),
    (error) => !/secret provider body/.test(error.message),
  );
});

test('temporary audio uses a hashed cache filename, atomic move, validation, and deletion', async () => {
  const calls = [];
  const files = load('services/avatars/stylistSpeechFiles.ts', {
    'expo-crypto': {
      CryptoDigestAlgorithm: { SHA256: 'SHA256' },
      digestStringAsync: async (_algorithm, input) => {
        calls.push(['hash-input', input]);
        return 'opaque-hash';
      },
    },
    'expo-file-system/legacy': {
      cacheDirectory: 'file://cache/',
      EncodingType: { Base64: 'base64' },
      makeDirectoryAsync: async (...args) => calls.push(['mkdir', ...args]),
      deleteAsync: async (...args) => calls.push(['delete', ...args]),
      writeAsStringAsync: async (...args) => calls.push(['write', ...args]),
      getInfoAsync: async (uri) => ({ exists: true, uri, isDirectory: false, size: 5, modificationTime: 1 }),
      moveAsync: async (...args) => calls.push(['move', ...args]),
      readDirectoryAsync: async () => [],
    },
  });
  const uri = await files.createTemporaryStylistSpeechFile({
    actorId: 'raw-actor-id', sessionId: 'raw-session-id', messageId: 'raw-message-id',
    stylistId: 'stylist_portrait_05', voiceProfile: 'feminine', audioBase64: 'YQ==',
  });
  assert.equal(uri, 'file://cache/kscan-stylist-speech/speech-opaque-hash.mp3');
  assert.doesNotMatch(uri, /raw-actor|raw-session|raw-message/);
  assert.ok(calls.some((entry) => entry[0] === 'write' && String(entry[1]).endsWith('.pending')));
  assert.ok(calls.some((entry) => entry[0] === 'move'));
  await files.deleteTemporaryStylistSpeechFile(uri);
  assert.ok(calls.some((entry) => entry[0] === 'delete' && entry[1] === uri));
});

test('startup orphan cleanup is bounded to fifty speech files', async () => {
  const deleted = [];
  const files = load('services/avatars/stylistSpeechFiles.ts', {
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async () => 'hash' },
    'expo-file-system/legacy': {
      cacheDirectory: 'file://cache/',
      EncodingType: { Base64: 'base64' },
      getInfoAsync: async (uri) => ({ exists: true, uri, isDirectory: true, size: 0, modificationTime: 1 }),
      readDirectoryAsync: async () => [
        ...Array.from({ length: 60 }, (_, index) => `speech-${String(index).padStart(2, '0')}.mp3`),
        'unrelated.txt',
      ],
      deleteAsync: async (uri) => deleted.push(uri),
      makeDirectoryAsync: async () => {}, writeAsStringAsync: async () => {}, moveAsync: async () => {},
    },
  });
  await files.cleanupOrphanedStylistSpeechFiles();
  assert.equal(deleted.length, 50);
  assert.ok(deleted.every((uri) => uri.includes('/speech-')));
});

test('timing-driven mouth state closes for idle and meaningful pauses', () => {
  const motion = load('services/avatarSpeechMotion.ts', {});
  const alignment = {
    characters: ['H', 'i', '.', 'N'],
    characterStartTimesSeconds: [0, 0.1, 0.2, 0.6],
    characterEndTimesSeconds: [0.1, 0.2, 0.25, 0.7],
  };
  assert.equal(motion.deriveAvatarMouthState({ phase: 'idle', playbackSeconds: 0.05, alignment }), 'closed');
  assert.notEqual(motion.deriveAvatarMouthState({ phase: 'playing', playbackSeconds: 0.05, alignment }), 'closed');
  // Short punctuation gaps are merged into surrounding speech; the authoritative pause is the 350 ms gap.
  assert.notEqual(motion.deriveAvatarMouthState({ phase: 'playing', playbackSeconds: 0.22, alignment }), 'closed');
  assert.equal(motion.deriveAvatarMouthState({ phase: 'playing', playbackSeconds: 0.4, alignment }), 'closed');
  assert.notEqual(motion.deriveAvatarMouthState({ phase: 'playing', playbackSeconds: 0.65, alignment }), 'closed');
});

test('native playback start timeout releases a player that never begins', async () => {
  let removes = 0;
  let errors = 0;
  const player = {
    addListener: () => ({ remove: () => {} }),
    play: () => {},
    pause: () => {},
    remove: () => { removes += 1; },
  };
  const playback = load('services/avatars/stylistAudioPlayback.ts', {
    'expo-audio': {
      setAudioModeAsync: async () => {},
      createAudioPlayer: () => player,
    },
  });
  await playback.playStylistAudio('file://speech.mp3', {
    onPlaybackStarted: () => {},
    onPlaybackProgress: () => {},
    onPlaybackFinished: () => {},
    onPlaybackError: () => { errors += 1; },
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(errors, 1);
  assert.equal(removes, 1);
});

test('terminal native playback failures release the player and close speech once', async () => {
  for (const terminalStatus of [
    { playbackState: 'failed', playing: false, didJustFinish: false, currentTime: 0 },
    { playbackState: 'idle', playing: false, didJustFinish: false, currentTime: 0.2 },
  ]) {
    let listener;
    let removes = 0;
    let errors = 0;
    const player = {
      addListener: (_event, callback) => {
        listener = callback;
        return { remove: () => {} };
      },
      play: () => {},
      pause: () => {},
      remove: () => { removes += 1; },
    };
    const playback = load('services/avatars/stylistAudioPlayback.ts', {
      'expo-audio': {
        setAudioModeAsync: async () => {},
        createAudioPlayer: () => player,
      },
    });
    await playback.playStylistAudio('file://speech.mp3', {
      onPlaybackStarted: () => {},
      onPlaybackProgress: () => {},
      onPlaybackFinished: () => {},
      onPlaybackError: () => { errors += 1; },
    }, 1_000);

    if (terminalStatus.playbackState === 'idle') {
      listener({
        playbackState: 'ready', playing: true, didJustFinish: false, currentTime: 0.1,
      });
    }
    listener(terminalStatus);
    listener(terminalStatus);

    assert.equal(errors, 1);
    assert.equal(removes, 1);
  }
});

test('assistive settings fail closed before native hydration resolves', () => {
  const react = {
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const accessibilityInfo = {
    addEventListener: () => ({ remove: () => {} }),
    isScreenReaderEnabled: () => new Promise(() => {}),
    isReduceMotionEnabled: () => new Promise(() => {}),
  };
  const screenReader = load('hooks/useScreenReaderEnabled.ts', {
    react,
    'react-native': { AccessibilityInfo: accessibilityInfo },
  });
  const reducedMotion = load('hooks/useReducedMotion.ts', {
    react,
    'react-native': { AccessibilityInfo: accessibilityInfo },
  });

  assert.equal(screenReader.useScreenReaderEnabled(), true);
  assert.equal(reducedMotion.useReducedMotion(), true);
});

test('voice preference defaults off and fails closed during actor switches', async () => {
  const values = new Map([['@kscan/stylist-voice/v1/hash-actor-a', 'on']]);
  const preference = load('stores/stylistVoicePreferenceStore.ts', {
    '@react-native-async-storage/async-storage': { default: {
      getItem: async (key) => key.endsWith('hash-actor-a') ? 'on' : (values.get(key) ?? null),
      setItem: async (key, value) => { values.set(key, value); },
    } },
    'expo-crypto': {
      CryptoDigestAlgorithm: { SHA256: 'SHA256' },
      digestStringAsync: async (_algorithm, actorId) => `hash-${actorId}`,
    },
    react: { useSyncExternalStore: () => {} },
  });
  assert.equal(preference.getStylistVoicePreferenceState().enabled, false);
  await preference.hydrateStylistVoicePreference('actor-a');
  assert.equal(preference.getStylistVoicePreferenceState().enabled, true);
  const switchPromise = preference.hydrateStylistVoicePreference('actor-b');
  assert.deepEqual(
    JSON.parse(JSON.stringify(preference.getStylistVoicePreferenceState())),
    { actorId: 'actor-b', enabled: false, loading: true },
  );
  await switchPromise;
  assert.equal(preference.getStylistVoicePreferenceState().enabled, false);
  await preference.setStylistVoicePreference('actor-b', true);
  assert.equal(values.get('@kscan/stylist-voice/v1/hash-actor-b'), 'on');
});

test('a newer utterance stops the old player and stale callbacks cannot clear it', async () => {
  const store = loadSpeechStore();
  const callbacks = [];
  let stops = 0;
  let deletes = 0;
  const speech = load('services/avatarSpeech.ts', {
    '../stores/avatarSpeechStore': store,
    './avatars/stylistSpeechClient': {
      requestStylistSpeech: async (request) => ({
        ...speechResponse(),
        messageId: request.messageId,
        stylistId: request.stylistId,
      }),
    },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: async ({ messageId }) => `file://${messageId}.mp3`,
      deleteTemporaryStylistSpeechFile: async (uri) => { if (uri) deletes += 1; },
    },
    './avatars/stylistAudioPlayback': {
      playStylistAudio: async (_uri, value) => {
        callbacks.push(value);
        return { stop: () => { stops += 1; } };
      },
    },
  });
  const common = {
    actorId: 'actor', stylistId: 'stylist_portrait_05',
    avatarId: 'stylist_portrait_05', source: 'message',
  };
  await speech.speakAvatarMessage({ ...common, sessionId: 'session-1', messageId: 'message-1' });
  await speech.speakAvatarMessage({ ...common, sessionId: 'session-2', messageId: 'message-2' });
  assert.equal(stops, 1);
  assert.ok(deletes >= 1);
  assert.equal(store.getAvatarSpeechState().sessionId, 'session-2');
  callbacks[0].onPlaybackFinished();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getAvatarSpeechState().sessionId, 'session-2');
  await speech.stopAvatarSpeechPlayback({
    actorId: 'actor', sessionId: 'session-1', avatarId: 'stylist_portrait_05',
  });
  assert.equal(stops, 1, 'cleanup for an old session must not stop the newer player');
  callbacks[1].onPlaybackStarted();
  await speech.stopAvatarSpeechPlayback({
    actorId: 'actor', sessionId: 'session-2', avatarId: 'stylist_portrait_05',
  });
  assert.equal(stops, 2);
  assert.equal(store.getAvatarSpeechState().phase, 'idle');
});

test('typing, send, navigation, avatar, preference, actor, and sign-out interruptions are wired', () => {
  const screen = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'), 'utf8');
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  const preference = fs.readFileSync(path.join(ROOT, 'hooks', 'useVoiceResponsesPreference.ts'), 'utf8');
  const auth = fs.readFileSync(path.join(ROOT, 'contexts', 'AuthSessionContext.tsx'), 'utf8');
  assert.match(screen, /next\.trim\(\)\.length > 0[\s\S]*stopAvatarSpeechPlayback/);
  assert.match(hook, /isSendingRef\.current = true[\s\S]*stopAvatarSpeechPlayback/);
  assert.match(hook, /return \(\) => \{[\s\S]*stopAvatarSpeechPlayback\(speechScope\)/);
  assert.match(hook, /identity\.avatarId[\s\S]*stopAvatarSpeechPlayback/);
  assert.match(preference, /if \(!enabled\)[\s\S]*stopAvatarSpeechPlayback/);
  assert.match(preference, /const persistence = setStylistVoicePreference[\s\S]*stopAvatarSpeechPlayback[\s\S]*await persistence/);
  assert.match(auth, /onAuthStateChange[\s\S]*stopAvatarSpeechPlayback/);
  assert.match(auth, /const signOut[\s\S]*await stopAvatarSpeechPlayback/);
});
