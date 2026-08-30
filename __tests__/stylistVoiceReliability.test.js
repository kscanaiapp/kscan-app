// Fix #3 — live speech repair.
//
// These lock the behaviours that separate "the speech code exists" from "a reply
// actually speaks": a transient failure must stay retryable, only confirmed
// native playback may retire a message, a native stall must be detected on both
// platforms, and the spoken bound must cover the longest reply a user can see.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SPEECH_FN = path.join(ROOT, 'supabase', 'functions', 'stylist-speech');

function transpileModule(file, mocks, sourceTransform = (source) => source) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(sourceTransform(fs.readFileSync(sourcePath, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    AbortController, console, Date, Error, Promise, Set, Map, setTimeout, clearTimeout,
    exports: mod.exports, module: mod,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

const INERT_APP_STATE = {
  ensureSpeechAppStateListener: () => {},
  registerSpeechInterruptionHandler: () => {},
};

function loadStore() {
  return transpileModule('stores/avatarSpeechStore.ts', {},
    (source) => source.replace("import { useSyncExternalStore } from 'react';", ''));
}

/** Builds a speech service whose backend fails for the first `failures` calls. */
function loadSpeech({ failures = 0, autoStart = true } = {}) {
  const store = loadStore();
  const stats = { requests: 0, plays: 0, starts: 0, stops: 0, deletes: 0, callbacks: [] };
  const speech = transpileModule('services/avatarSpeech.ts', {
    '../stores/avatarSpeechStore': store,
    './avatars/speechAppState': INERT_APP_STATE,
    './avatars/stylistSpeechClient': {
      requestStylistSpeech: async (request) => {
        stats.requests += 1;
        if (stats.requests <= failures) throw new Error('Speech is temporarily unavailable.');
        return {
          messageId: request.messageId, stylistId: request.stylistId,
          voiceProfile: 'masculine', mimeType: 'audio/mpeg',
          audioBase64: 'QUJDRA==', alignment: null,
        };
      },
    },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: async ({ messageId }) => `file://${messageId}.mp3`,
      deleteTemporaryStylistSpeechFile: async (uri) => { if (uri) stats.deletes += 1; },
    },
    './avatars/stylistAudioPlayback': {
      playStylistAudio: async (_uri, cb) => {
        stats.plays += 1;
        stats.callbacks.push(cb);
        if (autoStart) { stats.starts += 1; cb.onPlaybackStarted(); }
        return { stop: () => { stats.stops += 1; } };
      },
    },
  });
  return { speech, store, stats };
}

const PAYLOAD = {
  actorId: 'actor-1',
  sessionId: '11111111-1111-4111-8111-111111111111',
  messageId: '22222222-2222-4222-8222-222222222222',
  stylistId: 'stylist_portrait_02',
  avatarId: 'stylist_portrait_02',
  source: 'message',
};

test('a transient backend failure leaves the message retryable and it can still speak', async () => {
  const { speech, store, stats } = loadSpeech({ failures: 1 });

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.requests, 1);
  assert.equal(stats.plays, 0);
  assert.equal(store.getAvatarSpeechState().phase, 'error',
    'the failure must be visible rather than silent');

  // The regression this locks: recording the attempt before the request retired
  // the message permanently, so this second call never reached the backend.
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.requests, 2, 'a failed attempt must not consume the message');
  assert.equal(stats.starts, 1);
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
});

test('confirmed native playback — not a play() call — retires a message from automatic speech', async () => {
  const { speech, stats } = loadSpeech();
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.starts, 1);

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.requests, 1, 'automatic speech must never repeat a spoken message');
});

test('a player that is created but never starts leaves the message retryable', async () => {
  const { speech, store, stats } = loadSpeech({ autoStart: false });
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.plays, 1);
  assert.equal(stats.starts, 0);

  // What the start-timeout watchdog does when a player never begins.
  stats.callbacks[0].onPlaybackError();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getAvatarSpeechState().phase, 'error');

  // play() was called, so an attempt-based record would have retired the
  // message here even though nothing was ever audible.
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.requests, 2);
});

test('an explicit retry passes the success record; automatic speech does not', async () => {
  const { speech, stats } = loadSpeech();
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.starts, 1);
  stats.callbacks[0].onPlaybackFinished();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Automatic speech stays retired by the confirmed success.
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.requests, 1);

  // The same reference set, asked for explicitly, is allowed through.
  await speech.speakAvatarMessage({ ...PAYLOAD, trigger: 'retry' });
  assert.equal(stats.requests, 2, 'retry is the user asking for this message again');
  assert.equal(stats.plays, 2);
});

test('a duplicate concurrent attempt is suppressed for both triggers', async () => {
  const { speech, stats } = loadSpeech();
  const first = speech.speakAvatarMessage(PAYLOAD);
  const concurrentAuto = speech.speakAvatarMessage(PAYLOAD);
  const concurrentRetry = speech.speakAvatarMessage({ ...PAYLOAD, trigger: 'retry' });
  await Promise.all([first, concurrentAuto, concurrentRetry]);
  assert.equal(stats.plays, 1, 'overlapping players must remain impossible');
});

test('speech failure never removes the reply and never blocks the next message', async () => {
  const { speech, store, stats } = loadSpeech({ failures: 1 });
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(store.getAvatarSpeechState().phase, 'error');

  const next = { ...PAYLOAD, messageId: '33333333-3333-4333-8333-333333333333' };
  await speech.speakAvatarMessage(next);
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
  assert.equal(store.getAvatarSpeechState().messageId, next.messageId);
  assert.equal(stats.starts, 1);
});

test('the stall watchdog fails a player whose position stops advancing', async () => {
  let errors = 0;
  let listener = null;
  const playback = transpileModule('services/avatars/stylistAudioPlayback.ts', {
    'expo-audio': {
      setAudioModeAsync: async () => {},
      createAudioPlayer: () => ({
        addListener: (_event, fn) => { listener = fn; return { remove: () => {} }; },
        play: () => {}, pause: () => {}, remove: () => {},
      }),
    },
  });

  const handle = await playback.playStylistAudio('file://a.mp3', {
    onPlaybackStarted: () => {}, onPlaybackProgress: () => {},
    onPlaybackFinished: () => {}, onPlaybackError: () => { errors += 1; },
  }, 10_000, 20);

  listener({ playing: true, currentTime: 1, playbackState: 'playing', didJustFinish: false });
  // A native stall can stop status callbacks entirely, so nothing else arrives.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(errors, 1, 'a frozen player must be classified as failed, not left playing');
  handle.stop();
});

test('a status event at a frozen position does not re-arm the stall watchdog', async () => {
  let errors = 0;
  let listener = null;
  const playback = transpileModule('services/avatars/stylistAudioPlayback.ts', {
    'expo-audio': {
      setAudioModeAsync: async () => {},
      createAudioPlayer: () => ({
        addListener: (_event, fn) => { listener = fn; return { remove: () => {} }; },
        play: () => {}, pause: () => {}, remove: () => {},
      }),
    },
  });

  await playback.playStylistAudio('file://a.mp3', {
    onPlaybackStarted: () => {}, onPlaybackProgress: () => {},
    onPlaybackFinished: () => {}, onPlaybackError: () => { errors += 1; },
  }, 10_000, 40);

  listener({ playing: true, currentTime: 1, playbackState: 'playing', didJustFinish: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  listener({ playing: true, currentTime: 1, playbackState: 'playing', didJustFinish: false });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(errors, 1, 'only an advancing position counts as progress');
});

test('AppState interruption delegates to the one authoritative teardown path', () => {
  const service = fs.readFileSync(path.join(ROOT, 'services', 'avatarSpeech.ts'), 'utf8');
  const binding = fs.readFileSync(
    path.join(ROOT, 'services', 'avatars', 'speechAppState.ts'), 'utf8');

  assert.match(service, /registerSpeechInterruptionHandler\(\(\) => \{\s*void stopAvatarSpeechPlayback\(\);/);
  assert.match(service, /ensureSpeechLifecycleBound\(\);/);
  // The binding is a subscription only: it must not reimplement teardown.
  // Comments are stripped first so prose describing the delegated teardown is
  // not mistaken for an implementation of it.
  const bindingCode = binding
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(bindingCode, /deleteTemporary|createAudioPlayer|generation|player/i);
  assert.match(bindingCode, /AppState\.addEventListener/);
  // Lifecycle ownership stays in the service layer, never in a UI component.
  const avatar = fs.readFileSync(
    path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'), 'utf8');
  assert.doesNotMatch(avatar, /AppState/);
});

test('the spoken bound covers the longest reply StyleChat can show', () => {
  const speechText = fs.readFileSync(path.join(SPEECH_FN, 'speechText.ts'), 'utf8');
  const generate = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'stylechat-generate', 'index.ts'), 'utf8');

  const spoken = Number(/MAX_SPEECH_CHARACTERS\s*=\s*(\d+)/.exec(speechText)[1]);
  const reply = Number(/MAX_RESPONSE_CHARS\s*=\s*(\d+)/.exec(generate)[1]);
  assert.equal(spoken, 1000);
  assert.ok(spoken >= reply,
    `spoken bound ${spoken} must cover the ${reply}-character reply bound`);
});

test('per-stylist voice authority stays server-side and holds secret names only', () => {
  const registry = fs.readFileSync(path.join(SPEECH_FN, 'voiceProfiles.ts'), 'utf8');
  for (let index = 1; index <= 10; index += 1) {
    const id = String(index).padStart(2, '0');
    assert.match(registry, new RegExp(`stylist_portrait_${id}`));
    assert.match(registry, new RegExp(`ELEVENLABS_STYLIST_${id}_VOICE_ID`));
  }
  // A voice ID literal would be a 16-40 char opaque token; the registry must
  // never hold one, only the name of the secret that stores it.
  assert.doesNotMatch(registry, /['"][A-Za-z0-9]{16,40}['"]/);
});

test('no ElevenLabs voice id or provider secret reaches the mobile client', () => {
  const clientDirs = ['services', 'stores', 'hooks', 'components', 'constants', 'app'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/ELEVENLABS_[A-Z0-9_]*VOICE_ID|xi-api-key|ELEVENLABS_API_KEY/.test(source)) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  for (const dir of clientDirs) walk(path.join(ROOT, dir));
  assert.deepEqual(offenders, []);
});

test('the client sends references only and never arbitrary speech text', () => {
  const client = fs.readFileSync(
    path.join(ROOT, 'services', 'avatars', 'stylistSpeechClient.ts'), 'utf8');
  const body = /body:\s*\{([\s\S]*?)\}/.exec(client)[1];
  assert.match(body, /sessionId/);
  assert.match(body, /messageId/);
  assert.match(body, /stylistId/);
  assert.doesNotMatch(body, /\btext\b|\bcontent\b|speechText/);

  // The server rejects any unknown key, so a future client cannot smuggle text.
  const handler = fs.readFileSync(path.join(SPEECH_FN, 'handler.ts'), 'utf8');
  assert.match(handler, /MESSAGE_REQUEST_KEYS = new Set\(\['sessionId', 'messageId', 'stylistId'\]\)/);
  assert.match(handler, /unsupported fields/);
});

test('a custom stylist name never changes the voice route', () => {
  const retry = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatVoiceRetry.tsx'), 'utf8');
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  // Every dispatch routes by avatarId. displayName — the only field a custom
  // name changes — must never appear in a speech payload.
  for (const source of [retry, hook]) {
    const payloads = source.match(/speakAvatarMessage\(\{[\s\S]*?\}\)/g) ?? [];
    assert.ok(payloads.length > 0);
    for (const payload of payloads) {
      assert.match(payload, /stylistId: identity\.avatarId/);
      assert.match(payload, /avatarId: identity\.avatarId/);
      assert.doesNotMatch(payload, /displayName/);
    }
  }
});

test('voice recovery is scoped so a stale failure cannot appear on another reply', () => {
  const presentation = transpileModule('services/avatars/voiceRetryPresentation.ts', {});
  const scope = {
    actorId: 'actor-1', sessionId: 'session-1',
    messageId: 'message-1', avatarId: 'stylist_portrait_02',
  };
  const owned = {
    actorId: 'actor-1', sessionId: 'session-1', messageId: 'message-1',
    avatarId: 'stylist_portrait_02', stylistId: 'stylist_portrait_02',
  };
  assert.equal(presentation.ownsAvatarSpeechScope(owned, scope), true);
  assert.equal(presentation.ownsAvatarSpeechScope({ ...owned, actorId: 'actor-2' }, scope), false);
  assert.equal(presentation.ownsAvatarSpeechScope({ ...owned, messageId: 'other' }, scope), false);
  assert.equal(presentation.ownsAvatarSpeechScope(owned, { ...scope, actorId: null }), false);

  // A failure is remembered locally; confirmed playback and supersession clear it.
  assert.equal(presentation.nextVoiceRetryFailedState(false, { ownsSpeechState: true, phase: 'error' }), true);
  assert.equal(presentation.nextVoiceRetryFailedState(true, { ownsSpeechState: true, phase: 'playing' }), false);
  assert.equal(presentation.nextVoiceRetryFailedState(true, { ownsSpeechState: false, phase: 'error' }), false);
  assert.equal(presentation.nextVoiceRetryFailedState(true, { ownsSpeechState: true, phase: 'requesting' }), true);

  assert.equal(presentation.isVoiceRetryInFlight({ ownsSpeechState: true, phase: 'requesting' }), true);
  assert.equal(presentation.isVoiceRetryInFlight({ ownsSpeechState: true, phase: 'error' }), false);
  assert.equal(presentation.isVoiceRetryInFlight({ ownsSpeechState: false, phase: 'requesting' }), false);
});

test('speech remains output-only and adds no microphone capability', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const plugins = appJson.expo.plugins;
  const audio = plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-audio');
  // "Output-only" is about RECORDING, not about the plist key. Voice Scan owns
  // the app-wide NSMicrophoneUsageDescription, and Expo deletes that key when a
  // permission plugin prop is `false` -- so asserting false here used to strip
  // Voice Scan's usage string from the built plist. The output-only invariant
  // is carried by recordAudioAndroid and the allowsRecording assertions below.
  assert.equal(audio[1].microphonePermission, appJson.expo.ios.infoPlist.NSMicrophoneUsageDescription);
  assert.equal(audio[1].recordAudioAndroid, false);
  assert.ok(appJson.expo.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));

  const playback = fs.readFileSync(
    path.join(ROOT, 'services', 'avatars', 'stylistAudioPlayback.ts'), 'utf8');
  assert.match(playback, /allowsRecording: false/);
  assert.match(playback, /allowsBackgroundRecording: false/);
});

test('the ElevenLabs provider contract is unchanged', () => {
  const client = fs.readFileSync(path.join(SPEECH_FN, 'elevenLabsClient.ts'), 'utf8');
  assert.match(client, /api\.elevenlabs\.io\/v1\/text-to-speech/);
  assert.match(client, /with-timestamps/);
  // Model and output format stay owner-configured secrets, never literals.
  assert.match(client, /readRequiredSecret\(input\.env, 'ELEVENLABS_MODEL_ID', 'model'\)/);
  assert.match(client, /readRequiredSecret\(input\.env, 'ELEVENLABS_OUTPUT_FORMAT', 'outputFormat'\)/);
  // Alignment must survive for Fix #4 to consume later.
  assert.match(client, /alignment/);
  assert.match(client, /normalized_alignment/);
});

test('a burst-limit 429 fails soft: text chat stays usable and a later retry can succeed', async () => {
  // Shapes the mocked backend error exactly like the real client contract:
  // stylistSpeechClient.ts converts every function error, burst-limit included,
  // to this one sanitized message — the client never branches on HTTP status.
  const { speech, store, stats } = loadSpeech({ failures: 1 });

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(store.getAvatarSpeechState().phase, 'error',
    'a 429 must surface as the same recoverable error phase as any other failure');
  assert.equal(stats.plays, 0);

  // The written reply is never touched by a speech failure; only the store's
  // speech phase changes. No test asserts message removal because avatarSpeech
  // never receives or replaces the persisted message list.

  // No automatic retry timer exists in the client — a second dispatch only
  // happens because the caller (a retry tap, or the next real message) asked
  // for it explicitly.
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.requests, 2, 'a later attempt after the window must be able to succeed');
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
});

test('a rate-limited message does not block the next unrelated message from speaking', async () => {
  const { speech, store, stats } = loadSpeech({ failures: 1 });
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(store.getAvatarSpeechState().phase, 'error');

  const next = { ...PAYLOAD, messageId: '44444444-4444-4444-8444-444444444444' };
  await speech.speakAvatarMessage(next);
  assert.equal(store.getAvatarSpeechState().phase, 'playing');
  assert.equal(store.getAvatarSpeechState().messageId, next.messageId);
  assert.equal(stats.starts, 1);
});

test('no automatic retry storm: the client issues exactly one request per explicit call', async () => {
  const { speech, stats } = loadSpeech({ failures: 3 });
  // Three consecutive failures, each requiring its own explicit call — never a
  // loop inside speakAvatarMessage itself.
  await speech.speakAvatarMessage(PAYLOAD);
  await speech.speakAvatarMessage(PAYLOAD);
  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.requests, 3, 'each failure must correspond to exactly one caller-issued attempt');
  assert.equal(stats.plays, 0);

  await speech.speakAvatarMessage(PAYLOAD);
  assert.equal(stats.requests, 4);
  assert.equal(stats.plays, 1, 'recovery still produces exactly one player, never a duplicate');
});

test('the conversational burst ceiling is a usability policy, not a design change', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'stylist-speech', 'rateLimit.ts'), 'utf8');
  assert.match(source, /SPEECH_BURST_LIMIT\s*=\s*10/);
  assert.match(source, /SPEECH_BURST_WINDOW_MS\s*=\s*60_000/);
  // The daily ceiling, response contract, and per-actor keying are untouched.
  assert.match(source, /SPEECH_DAILY_LIMIT\s*=\s*50/);
  assert.match(source, /'BURST_LIMIT'/);
  assert.match(source, /429/);
  assert.match(source, /burstByActor/);
});

test('Fix #3 touches no avatar-animation or commerce source', () => {
  const speechFiles = [
    'services/avatarSpeech.ts',
    'services/avatars/speechAppState.ts',
    'services/avatars/stylistAudioPlayback.ts',
    'services/avatars/voiceRetryPresentation.ts',
  ];
  for (const file of speechFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /viseme|mouthState|blink|brow|gaze|facialOverlay/i);
    assert.doesNotMatch(source, /serper|farfetch|kickscrew|commerce/i);
  }
});
