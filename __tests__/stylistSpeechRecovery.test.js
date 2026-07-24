const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;

const {
  STYLIST_ABSTRACT_PRESETS,
  STYLIST_PORTRAIT_PRESETS,
  STYLIST_AVATAR_PRESETS,
  STYLIST_SPEECH_CONFIG_BY_ID,
  getStylistVoiceProfile,
} = require('../constants/stylistIdentity.ts');
const { buildStylistGreeting } = require('../services/stylistGreeting.ts');
const { resolveUserFirstName } = require('../services/userFirstName.ts');

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

function loadAvatarSpeechStore() {
  return transpileModule(
    'stores/avatarSpeechStore.ts',
    {},
    (source) => source.replace("import { useSyncExternalStore } from 'react';", ''),
  );
}

test('authoritative registry is preserved and no parallel identity registry exists', () => {
  assert.equal(STYLIST_ABSTRACT_PRESETS.length, 6);
  assert.equal(STYLIST_PORTRAIT_PRESETS.length, 10);
  assert.equal(STYLIST_AVATAR_PRESETS.length, 16);
  assert.equal(fs.existsSync(path.join(ROOT, 'services', 'avatars', 'registry.ts')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'services', 'avatars', 'types.ts')), false);
});

test('abstract avatars are silent and approved portraits have explicit profiles', () => {
  for (const preset of STYLIST_ABSTRACT_PRESETS) {
    assert.equal(getStylistVoiceProfile(preset.id), 'silent');
  }
  STYLIST_PORTRAIT_PRESETS.forEach((preset, index) => {
    assert.equal(getStylistVoiceProfile(preset.id), index % 2 === 0 ? 'feminine' : 'masculine');
  });
});

test('priority portraits have explicit mouth-state configuration and fallback wiring', () => {
  assert.equal(STYLIST_SPEECH_CONFIG_BY_ID.size, 3);
  const regionY = new Set();
  for (const id of ['stylist_portrait_02', 'stylist_portrait_05', 'stylist_portrait_08']) {
    const config = STYLIST_SPEECH_CONFIG_BY_ID.get(id);
    assert.ok(config, `${id} must have speech config`);
    assert.equal(config.speakingMotionMode, 'mouth_states');
    assert.ok(config.mouthRegion);
    assert.ok(config.mouthRegion.y < 0.6, `${id} crop must cover the mouth, not the chin`);
    regionY.add(config.mouthRegion.y);
    assert.ok(config.mouthStateSources);
    assert.equal(typeof config.mouthStateSources.closed, 'number');
    assert.equal(typeof config.mouthStateSources.halfOpen, 'number');
    assert.equal(typeof config.mouthStateSources.open, 'number');
  }
  assert.equal(regionY.size, 3, 'priority portraits require individually calibrated crops');
  const source = fs.readFileSync(
    path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'),
    'utf8',
  );
  assert.doesNotMatch(source, /mouth_overlay|scaleY|translateY/);
  assert.match(source, /mouthStateSources/);
  assert.match(source, /resolveMouthStateSource/);
  assert.doesNotMatch(source, /portraitPreset\.source/);
  assert.match(source, /<StylistAvatar[\s\S]*<MouthStateLayer/);
  assert.match(source, /importantForAccessibility="no-hide-descendants"/);
  assert.match(source, /resizeMethod="resize"/);
});

test('priority mouth-state asset manifest contains static square PNG frames', () => {
  const animatedDir = path.join(ROOT, 'assets', 'stylist-avatars', 'portraits', 'animated');
  for (const stylist of ['02', '05', '08']) {
    for (const state of ['closed', 'half_open', 'open']) {
      const filename = path.join(animatedDir, `avatar_stylist_${stylist}_mouth_${state}.png`);
      const bytes = fs.readFileSync(filename);
      assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47]);
      assert.equal(bytes.readUInt32BE(16), 1024);
      assert.equal(bytes.readUInt32BE(20), 1024);
    }
  }
});

test('buildStylistGreeting preserves the accepted personalized and fallback copy', () => {
  const personalized = buildStylistGreeting({ userFirstName: 'Kathleen', stylistName: 'Ava' });
  assert.match(personalized.text, /Kathleen/);
  assert.match(personalized.text, /Ava/);
  assert.equal(personalized.genericFallback, false);
  const fallback = buildStylistGreeting({ userFirstName: null, stylistName: 'Elise' });
  assert.match(fallback.text, /Elise/);
  assert.equal(fallback.genericFallback, true);
});

test('buildStylistGreeting handles control characters and Unicode names', () => {
  assert.equal(
    buildStylistGreeting({ userFirstName: '\x00Jane', stylistName: 'Elise' }).userFirstName,
    'Jane',
  );
  assert.match(
    buildStylistGreeting({ userFirstName: 'Saoirse', stylistName: 'Elise' }).text,
    /Saoirse/,
  );
});

test('resolveUserFirstName uses established metadata fields and never derives from email', () => {
  assert.equal(resolveUserFirstName({ id: 'u', user_metadata: { first_name: 'Alice' } }).firstName, 'Alice');
  assert.equal(resolveUserFirstName({ id: 'u', user_metadata: { full_name: 'Carol Ann' } }).firstName, 'Carol');
  assert.equal(resolveUserFirstName({ id: 'u', user_metadata: { email: 'eve@example.com' } }).firstName, null);
});

test('avatar speech store exposes stable snapshots and emits only real changes', () => {
  const store = loadAvatarSpeechStore();
  assert.equal(store.getAvatarSpeechState(), store.getAvatarSpeechState());
  let emissions = 0;
  store.subscribeToAvatarSpeech(() => { emissions += 1; });
  store.beginAvatarSpeech({
    actorId: 'actor-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    stylistId: 'stylist_portrait_05',
    avatarId: 'stylist_portrait_05',
    generation: 1,
    source: 'greeting',
  });
  assert.equal(store.getAvatarSpeechState().phase, 'requesting');
  assert.equal(emissions, 1);
  store.markAvatarSpeechReady(1, null);
  store.markAvatarSpeechPlaying(1);
  store.markAvatarSpeechPlaying(1);
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
  assert.equal(emissions, 3);
});

test('avatar speech store ignores every stale-generation callback', () => {
  const store = loadAvatarSpeechStore();
  const base = {
    actorId: 'actor-1', sessionId: 'session-1', messageId: 'message-1',
    stylistId: 'stylist_portrait_05', avatarId: 'stylist_portrait_05', source: 'message',
  };
  store.beginAvatarSpeech({ ...base, generation: 1 });
  store.beginAvatarSpeech({ ...base, messageId: 'message-2', generation: 2 });
  assert.equal(store.markAvatarSpeechReady(1, null), false);
  assert.equal(store.markAvatarSpeechPlaying(1), false);
  assert.equal(store.updateAvatarSpeechPlayback(1, 1), false);
  assert.equal(store.setAvatarSpeechError(1, 'stale'), false);
  assert.equal(store.finishAvatarSpeech(1), false);
  assert.equal(store.getAvatarSpeechState().messageId, 'message-2');
  assert.equal(store.getAvatarSpeechState().phase, 'requesting');
});

test('visible speaking state begins only after native playback reports playing', async () => {
  const store = loadAvatarSpeechStore();
  let callbacks;
  let clientRequest;
  const speech = transpileModule('services/avatarSpeech.ts', {
    '../stores/avatarSpeechStore': store,
    './avatars/stylistSpeechClient': {
      requestStylistSpeech: async (request) => {
        clientRequest = request;
        return {
          messageId: request.messageId,
          stylistId: request.stylistId,
          voiceProfile: 'feminine',
          mimeType: 'audio/mpeg',
          audioBase64: 'YXVkaW8=',
          alignment: null,
        };
      },
    },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: async () => 'file://speech.mp3',
      deleteTemporaryStylistSpeechFile: async () => {},
    },
    './avatars/stylistAudioPlayback': {
      playStylistAudio: async (_uri, value) => {
        callbacks = value;
        return { stop: () => {} };
      },
    },
  });

  await speech.speakAvatarMessage({
    actorId: 'actor-1', sessionId: 'session-1', messageId: 'message-1',
    stylistId: 'stylist_portrait_05', avatarId: 'stylist_portrait_05', source: 'message',
  });
  assert.deepEqual(
    { sessionId: clientRequest.sessionId, messageId: clientRequest.messageId, stylistId: clientRequest.stylistId },
    { sessionId: 'session-1', messageId: 'message-1', stylistId: 'stylist_portrait_05' },
  );
  assert.equal(store.getAvatarSpeechState().phase, 'ready');
  callbacks.onPlaybackStarted();
  callbacks.onPlaybackProgress(0.24);
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
  assert.equal(store.getAvatarSpeechState().playbackSeconds, 0.24);
});

test('client duplicate suppression prevents a second generation request for one message', async () => {
  const store = loadAvatarSpeechStore();
  let requests = 0;
  const speech = transpileModule('services/avatarSpeech.ts', {
    '../stores/avatarSpeechStore': store,
    './avatars/stylistSpeechClient': {
      requestStylistSpeech: async (request) => {
        requests += 1;
        return {
          messageId: request.messageId, stylistId: request.stylistId,
          voiceProfile: 'feminine', mimeType: 'audio/mpeg', audioBase64: 'YQ==', alignment: null,
        };
      },
    },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: async () => 'file://speech.mp3',
      deleteTemporaryStylistSpeechFile: async () => {},
    },
    './avatars/stylistAudioPlayback': {
      playStylistAudio: async () => ({ stop: () => {} }),
    },
  });
  const payload = {
    actorId: 'a', sessionId: 's', messageId: 'm', stylistId: 'stylist_portrait_05',
    avatarId: 'stylist_portrait_05', source: 'message',
  };
  await speech.speakAvatarMessage(payload);
  await speech.speakAvatarMessage(payload);
  assert.equal(requests, 1);
});

test('permissions remain playback-only and device TTS is absent from production source', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  assert.ok(appJson.expo.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));
  assert.ok(!appJson.expo.android.permissions.includes('android.permission.RECORD_AUDIO'));
  assert.equal('NSMicrophoneUsageDescription' in appJson.expo.ios.infoPlist, false);
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies['expo-audio'], '~1.1.1');
  assert.equal(packageJson.dependencies['expo-speech'], undefined);
  assert.equal(fs.existsSync(path.join(ROOT, 'services', 'avatarSpeechVoice.ts')), false);
});

test('StyleChat wiring speaks only persisted new messages and scopes the header to playing', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  const header = fs.readFileSync(path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'), 'utf8');
  // Greeting speech stays gated on a real persisted insert. The guard also
  // requires result.message before recording its id for the retained attempt,
  // so the eligibility clause is asserted with that operand in between.
  assert.match(hook, /result\.inserted && result\.message && canSpeakNewMessages/);
  assert.match(hook, /messageId: savedAssistant\.id/);
  assert.match(hook, /voicePreference\.enabled/);
  assert.match(header, /speechState\.phase === 'playing'/);
  assert.match(header, /speechState\.actorId === actorId/);
  assert.match(header, /speechState\.sessionId === sessionId/);
  assert.match(header, /speechState\.stylistId === identity\.avatarId/);
});

test('accepted Home and greeting architecture remains delegated and replay-free', () => {
  const home = fs.readFileSync(path.join(ROOT, 'components', 'home', 'HomeStylistCard.tsx'), 'utf8');
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  assert.match(home, /AnimatedStylistAvatar/);
  assert.match(home, /title="Start Chat"/);
  assert.doesNotMatch(home, /getGreetingTextForUser/);
  assert.match(hook, /ensureSessionGreeting/);
  assert.match(hook, /isSessionGreeted/);
  const hydrationBlock = hook.match(/async function loadMessages\(\)[\s\S]*?async function loadDailyUsage/)?.[0] ?? '';
  assert.doesNotMatch(hydrationBlock, /speakAvatarMessage/);
});
