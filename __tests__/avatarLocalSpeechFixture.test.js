const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function transpileModule(file, mocks = {}, extraGlobals = {}, sourceTransform = (s) => s) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(sourceTransform(fs.readFileSync(sourcePath, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
    exports: mod.exports,
    module: mod,
    ...extraGlobals,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

function loadHarness({ devMode = true, flagEnabled = true } = {}) {
  const speechStore = transpileModule(
    'stores/avatarSpeechStore.ts',
    {},
    {},
    (source) => source.replace("import { useSyncExternalStore } from 'react';", ''),
  );
  const motion = transpileModule('services/avatarSpeechMotion.ts', {
    '../stores/avatarSpeechStore': speechStore,
  });
  const appState = {
    handlers: new Set(),
    addCalls: 0,
  };
  const lifecycle = transpileModule('services/avatarSpeechLifecycle.ts', {
    'react-native': {
      AppState: {
        addEventListener: (_event, handler) => {
          appState.addCalls += 1;
          appState.handlers.add(handler);
          return { remove: () => appState.handlers.delete(handler) };
        },
      },
    },
  });
  const calls = {
    providerRequests: 0,
    stopProductionSpeech: 0,
    filesCreated: [],
    filesDeleted: [],
    players: [],
  };
  const fixture = transpileModule(
    'services/avatars/localSpeechFixture.ts',
    {
      '../../constants/featureFlags': { AVATAR_SPEECH_FIXTURE_ENABLED: flagEnabled },
      '../../stores/avatarSpeechStore': speechStore,
      '../avatarSpeechLifecycle': lifecycle,
      '../avatarSpeech': {
        stopAvatarSpeechPlayback: async () => {
          calls.stopProductionSpeech += 1;
        },
      },
      './stylistAudioPlayback': {
        playStylistAudio: async (uri, callbacks) => {
          const player = { uri, callbacks, stopped: 0 };
          player.stop = () => {
            player.stopped += 1;
          };
          calls.players.push(player);
          return player;
        },
      },
      './stylistSpeechFiles': {
        createTemporaryStylistSpeechFile: async (input) => {
          calls.filesCreated.push(input);
          return `file://fixture-${calls.filesCreated.length}.wav`;
        },
        deleteTemporaryStylistSpeechFile: async (uri) => {
          if (uri) calls.filesDeleted.push(uri);
        },
      },
      './localSpeechFixtureAudio': require('../services/avatars/localSpeechFixtureAudio.ts'),
    },
    { __DEV__: devMode },
  );
  const fireBackground = () => {
    for (const handler of [...appState.handlers]) handler('background');
  };
  return { speechStore, motion, lifecycle, fixture, calls, appState, fireBackground };
}

test('fixture is inert outside the __DEV__ + env-flag gate', async () => {
  for (const gates of [
    { devMode: false, flagEnabled: true },
    { devMode: true, flagEnabled: false },
    { devMode: false, flagEnabled: false },
  ]) {
    const { fixture, calls, speechStore } = loadHarness(gates);
    assert.equal(fixture.isLocalSpeechFixtureEnabled(), false);
    assert.equal(await fixture.playLocalSpeechFixture(), false);
    assert.equal(calls.players.length, 0);
    assert.equal(calls.filesCreated.length, 0);
    assert.equal(speechStore.getAvatarSpeechState().phase, 'idle');
  }
});

test('audio ready does not mean speaking; native playing begins speaking', async () => {
  const { fixture, calls, speechStore } = loadHarness();
  assert.equal(await fixture.playLocalSpeechFixture(), true);
  const readyState = speechStore.getAvatarSpeechState();
  assert.equal(readyState.phase, 'ready', 'file written and player created, not yet speaking');
  assert.equal(readyState.alignment, fixture.LOCAL_SPEECH_FIXTURE_ALIGNMENT);

  calls.players[0].callbacks.onPlaybackStarted();
  assert.equal(speechStore.getAvatarSpeechState().phase, 'playing');
  calls.players[0].callbacks.onPlaybackProgress(0.18);
  assert.equal(speechStore.getAvatarSpeechState().playbackSeconds, 0.18);
});

test('the known fixture timeline drives known mouth states through production motion code', async () => {
  const { fixture, calls, speechStore, motion } = loadHarness();
  await fixture.playLocalSpeechFixture();
  calls.players[0].callbacks.onPlaybackStarted();

  // 'Hi Elise' at 120 ms per character: every interval survives unmerged.
  const expectations = [
    [0.05, 'halfOpen'],
    [0.18, 'open'],
    [0.30, 'closed'],
    [0.42, 'open'],
    [0.54, 'halfOpen'],
    [0.66, 'open'],
    [0.78, 'halfOpen'],
    [0.90, 'open'],
  ];
  for (const [seconds, expected] of expectations) {
    calls.players[0].callbacks.onPlaybackProgress(seconds);
    const state = speechStore.getAvatarSpeechState();
    const mouth = motion.deriveAvatarMouthState({
      phase: state.phase,
      playbackSeconds: state.playbackSeconds,
      alignment: state.alignment,
      reducedMotion: false,
    });
    assert.equal(mouth, expected, `mouth at ${seconds}s`);
  }
});

test('Reduce Motion keeps the fixture mouth closed without touching playback', async () => {
  const { fixture, calls, speechStore, motion } = loadHarness();
  await fixture.playLocalSpeechFixture();
  calls.players[0].callbacks.onPlaybackStarted();
  calls.players[0].callbacks.onPlaybackProgress(0.42);
  const state = speechStore.getAvatarSpeechState();
  assert.equal(state.phase, 'playing', 'audio continues under Reduce Motion');
  assert.equal(
    motion.deriveAvatarMouthState({
      phase: state.phase,
      playbackSeconds: state.playbackSeconds,
      alignment: state.alignment,
      reducedMotion: true,
    }),
    'closed',
  );
});

test('completion resets to neutral idle and releases the file', async () => {
  const { fixture, calls, speechStore } = loadHarness();
  await fixture.playLocalSpeechFixture();
  calls.players[0].callbacks.onPlaybackStarted();
  calls.players[0].callbacks.onPlaybackFinished();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(speechStore.getAvatarSpeechState().phase, 'idle');
  assert.equal(calls.filesDeleted.length, 1);
});

test('playback failure degrades to idle without a stuck mouth', async () => {
  const { fixture, calls, speechStore } = loadHarness();
  await fixture.playLocalSpeechFixture();
  calls.players[0].callbacks.onPlaybackStarted();
  calls.players[0].callbacks.onPlaybackError();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const state = speechStore.getAvatarSpeechState();
  assert.equal(state.phase, 'idle');
  assert.equal(state.playbackSeconds, 0);
});

test('backgrounding interrupts the fixture and stale callbacks stay inert', async () => {
  const { fixture, calls, speechStore, fireBackground } = loadHarness();
  await fixture.playLocalSpeechFixture();
  calls.players[0].callbacks.onPlaybackStarted();
  assert.equal(speechStore.getAvatarSpeechState().phase, 'playing');
  fireBackground();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(speechStore.getAvatarSpeechState().phase, 'idle');
  assert.ok(calls.players[0].stopped >= 1, 'player stopped on interruption');
  calls.players[0].callbacks.onPlaybackStarted();
  calls.players[0].callbacks.onPlaybackProgress(0.5);
  assert.equal(speechStore.getAvatarSpeechState().phase, 'idle');
});

test('a second fixture run supersedes the first deterministically', async () => {
  const { fixture, calls, speechStore } = loadHarness();
  await fixture.playLocalSpeechFixture();
  calls.players[0].callbacks.onPlaybackStarted();
  await fixture.playLocalSpeechFixture();
  assert.equal(calls.players.length, 2);
  assert.ok(calls.players[0].stopped >= 1, 'old player stopped before the new one is active');
  calls.players[1].callbacks.onPlaybackStarted();
  assert.equal(speechStore.getAvatarSpeechState().phase, 'playing');
  // Old generation callbacks cannot clear the new run.
  calls.players[0].callbacks.onPlaybackFinished();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(speechStore.getAvatarSpeechState().phase, 'playing');
});

test('no provider, quota, or secret is reachable from the fixture', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services', 'avatars', 'localSpeechFixture.ts'),
    'utf8',
  );
  const importLines = source
    .split('\n')
    .filter((line) => /^\s*(import|export)\b.*from|require\(/.test(line))
    .join('\n');
  assert.doesNotMatch(importLines, /supabase/i);
  assert.doesNotMatch(importLines, /stylistSpeechClient/);
  assert.doesNotMatch(importLines, /elevenlabs/i);
  assert.doesNotMatch(source, /requestStylistSpeech/);
  assert.doesNotMatch(source, /functions\.invoke/);
  const audio = fs.readFileSync(
    path.join(ROOT, 'services', 'avatars', 'localSpeechFixtureAudio.ts'),
    'utf8',
  );
  assert.match(audio, /LOCAL_SPEECH_FIXTURE_AUDIO_BASE64/);
  // The bundled audio is a valid RIFF/WAVE payload.
  const audioModule = require('../services/avatars/localSpeechFixtureAudio.ts');
  const bytes = Buffer.from(audioModule.LOCAL_SPEECH_FIXTURE_AUDIO_BASE64, 'base64');
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.ok(bytes.length > 4000);
});

test('the fixture is not reachable from production UI surfaces', () => {
  const surfaces = ['app', 'components', 'hooks', 'contexts', 'stores'];
  const offenders = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const source = fs.readFileSync(fullPath, 'utf8');
        if (/localSpeechFixture/.test(source)) offenders.push(fullPath);
      }
    }
  };
  for (const surface of surfaces) visit(path.join(ROOT, surface));
  assert.deepEqual(offenders, []);
});
