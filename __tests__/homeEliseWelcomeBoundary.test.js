const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file, modules) {
  const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    if (name in modules) return modules[name];
    throw new Error(`Unexpected import: ${name}`);
  }, mod, mod.exports);
  return mod.exports;
}

test('Home session creation rejects a changed actor before writing any session row', async () => {
  let writes = 0;
  const repository = load('services/style-chat/styleChatRepository.ts', {
    '../supabaseClient': { supabase: {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'actor-B' } } } }) },
      from: () => { writes += 1; throw new Error('must not write'); },
    } },
  });
  await assert.rejects(repository.createStyleChatSession({}, 'actor-A'), /Authenticated user changed/);
  assert.equal(writes, 0);
});

function speechHarness({ deferFirstConsent = false, pauseReleaseAt = 0 } = {}) {
  const store = load('stores/avatarSpeechStore.ts', { react: { useSyncExternalStore() {} } });
  let consentCount = 0;
  let allowOldConsent;
  let stops = 0;
  let requests = 0;
  let releases = 0;
  let resumeRelease;
  const speech = load('services/avatarSpeech.ts', {
    '../stores/avatarSpeechStore': store,
    '../constants/featureFlags': { STYLIST_SPEECH_ENABLED: true },
    './avatars/speechConsent': { loadSpeechConsent: async () => {
      consentCount += 1;
      if (deferFirstConsent && consentCount === 1) return new Promise((resolve) => { allowOldConsent = resolve; });
      return true;
    } },
    './avatars/speechAppState': { ensureSpeechAppStateListener() {}, registerSpeechInterruptionHandler() {} },
    './avatars/stylistSpeechClient': { requestStylistSpeech: async () => {
      requests += 1;
      return { voiceProfile: 'feminine', audioBase64: 'synthetic', alignment: null };
    }, isRetriableSpeechFailure: () => false },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: async () => 'synthetic-file',
      deleteTemporaryStylistSpeechFile: async () => {
        releases += 1;
        if (releases === pauseReleaseAt) await new Promise((resolve) => { resumeRelease = resolve; });
      },
    },
    './avatars/stylistAudioPlayback': { playStylistAudio: async (_uri, callbacks) => {
      callbacks.onPlaybackStarted();
      return { stop: () => { stops += 1; } };
    } },
  });
  const base = { actorId: 'actor-A', sessionId: 'session', stylistId: 'elise_default', avatarId: 'elise_default', source: 'greeting' };
  return { store, speech, base, stops: () => stops, requests: () => requests,
    resolveConsent: () => allowOldConsent(true), resumeRelease: () => resumeRelease(),
    releaseIsPending: () => typeof resumeRelease === 'function',
  };
}

test('Home exact-message cleanup cannot stop newer Chat audio in the same session', async () => {
  const h = speechHarness();
  await h.speech.speakAvatarMessage({ ...h.base, messageId: 'chat-reply', source: 'message' });
  await h.speech.stopAvatarSpeechPlayback({ ...h.base, messageId: 'home-greeting' });
  assert.equal(h.stops(), 0);
  assert.equal(h.store.getAvatarSpeechState().phase, 'playing');
  assert.equal(h.store.getAvatarSpeechState().messageId, 'chat-reply');
  await h.speech.stopAvatarSpeechPlayback({ ...h.base, messageId: 'chat-reply' });
  assert.equal(h.stops(), 1);
  assert.equal(h.store.getAvatarSpeechState().phase, 'idle');
});

test('stale Home consent wait cancellation preserves a newer differently scoped player', async () => {
  const h = speechHarness({ deferFirstConsent: true });
  const home = h.speech.speakAvatarMessage({ ...h.base, messageId: 'home-greeting' });
  await h.speech.speakAvatarMessage({ ...h.base, messageId: 'chat-reply', source: 'message' });
  await h.speech.stopAvatarSpeechPlayback({ ...h.base, messageId: 'home-greeting' });
  assert.equal(h.stops(), 0, 'old consent waiter must not authorize releasing the newer player');
  assert.equal(h.store.getAvatarSpeechState().messageId, 'chat-reply');
  h.resolveConsent();
  await home;
  assert.equal(h.requests(), 1);
  assert.equal(h.store.getAvatarSpeechState().phase, 'playing');
});

test('Home scoped cancellation before consent resolves prevents all provider/player work', async () => {
  const h = speechHarness({ deferFirstConsent: true });
  const home = h.speech.speakAvatarMessage({ ...h.base, messageId: 'home-greeting' });
  await h.speech.stopAvatarSpeechPlayback({ ...h.base, messageId: 'home-greeting' });
  h.resolveConsent();
  await home;
  assert.equal(h.requests(), 0);
  assert.equal(h.store.getAvatarSpeechState().phase, 'idle');
});

test('Home cancellation during prior resource teardown cannot start delayed welcome audio', async () => {
  const h = speechHarness({ pauseReleaseAt: 1 });
  const home = h.speech.speakAvatarMessage({ ...h.base, messageId: 'home-greeting' });
  for (let i = 0; i < 6 && !h.releaseIsPending(); i += 1) await Promise.resolve();
  assert.equal(h.releaseIsPending(), true);
  await h.speech.stopAvatarSpeechPlayback({ ...h.base, messageId: 'home-greeting' });
  h.resumeRelease();
  await home;
  assert.equal(h.requests(), 0);
  assert.equal(h.store.getAvatarSpeechState().phase, 'idle');
});

test('old Home store identifiers cannot cancel a newer Chat request replacing the player', async () => {
  const h = speechHarness({ pauseReleaseAt: 2 });
  await h.speech.speakAvatarMessage({ ...h.base, messageId: 'home-greeting' });
  const chat = h.speech.speakAvatarMessage({ ...h.base, messageId: 'chat-reply', source: 'message' });
  for (let i = 0; i < 6 && !h.releaseIsPending(); i += 1) await Promise.resolve();
  assert.equal(h.releaseIsPending(), true);
  await h.speech.stopAvatarSpeechPlayback({ ...h.base, messageId: 'home-greeting' });
  h.resumeRelease();
  await chat;
  assert.equal(h.requests(), 2);
  assert.equal(h.store.getAvatarSpeechState().messageId, 'chat-reply');
  assert.equal(h.store.getAvatarSpeechState().phase, 'playing');
});
