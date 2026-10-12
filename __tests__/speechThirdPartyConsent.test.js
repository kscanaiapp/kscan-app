const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
function load(file, mocks, transform = (source) => source) {
  const module = { exports: {} };
  const output = ts.transpileModule(transform(fs.readFileSync(path.join(ROOT, file), 'utf8')),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, Date, Map, Set, console, AbortController,
    require: (id) => { assert.ok(id in mocks, `Unexpected import ${id}`); return mocks[id]; } });
  return module.exports;
}
function fixture(approved = true) {
  let actorId = 'actor-a'; let epoch = 1; let storageFailed = false;
  let beforeSet = async () => {};
  let beforeGet = async () => {};
  const records = new Map();
  const actor = { getActorContext: () => ({ actorId, epoch }) };
  const storage = {
    getItem: async (key) => { await beforeGet(); if (storageFailed) throw new Error('storage unavailable'); return records.get(key) ?? null; },
    setItem: async (key, value) => { await beforeSet(); if (storageFailed) throw new Error('storage unavailable'); records.set(key, value); },
    removeItem: async (key) => { if (storageFailed) throw new Error('storage unavailable'); records.delete(key); },
  };
  const shared = load('services/thirdPartyAiConsent.ts', {
    '@react-native-async-storage/async-storage': storage, './actorContext': actor,
  });
  const speech = load('services/avatars/speechConsent.ts', { '../actorContext': actor, '../thirdPartyAiConsent': shared },
    (source) => source.replace(/SPEECH_DISCLOSURE_APPROVED = (?:false|true)/,
      `SPEECH_DISCLOSURE_APPROVED = ${approved}`));
  return { speech, records, changeActor: (next) => { actorId = next; epoch++; },
    failStorage: () => { storageFailed = true; }, pauseWrites: (gate) => { beforeSet = () => gate; },
    pauseReads: (gate) => { beforeGet = () => gate; } };
}

function playbackFixture(f) {
  const effects = { requests: 0, files: 0, plays: 0, listeners: 0 };
  const store = load('stores/avatarSpeechStore.ts', { react: { useSyncExternalStore: () => {} } });
  const service = load('services/avatarSpeech.ts', {
    '../stores/avatarSpeechStore': store,
    './avatars/speechConsent': f.speech,
    '../constants/featureFlags': { STYLIST_SPEECH_ENABLED: true },
    './avatars/speechAppState': { ensureSpeechAppStateListener: () => { effects.listeners++; }, registerSpeechInterruptionHandler: () => {} },
    './avatars/stylistSpeechClient': { requestStylistSpeech: async () => { effects.requests++; return { audioBase64: 'YQ==', voiceProfile: 'feminine', alignment: null }; } },
    './avatars/stylistSpeechFiles': { createTemporaryStylistSpeechFile: async () => { effects.files++; return 'file:///speech.mp3'; }, deleteTemporaryStylistSpeechFile: async () => {} },
    './avatars/stylistAudioPlayback': { playStylistAudio: async () => { effects.plays++; return { stop: () => {} }; } },
  });
  const payload = { actorId: 'actor-a', sessionId: 'session', messageId: 'message', stylistId: 'elise_default', avatarId: 'elise_default', source: 'message' };
  return { service, effects, payload };
}

test('warm consent load rejects an A to signed-out to A epoch change', async () => {
  const f = fixture();
  assert.equal(await f.speech.grantSpeechConsent('actor-a'), true);
  let release; f.pauseReads(new Promise(resolve => { release = resolve; }));
  const loading = f.speech.loadSpeechConsent('actor-a');
  f.changeActor(null); f.changeActor('actor-a');
  release();
  assert.equal(await loading, false);
});

for (const interruption of ['same-account sign-in', 'matching scope stop']) {
  test(`consent read cannot restart old speech after ${interruption}`, async () => {
    const f = fixture();
    assert.equal(await f.speech.grantSpeechConsent('actor-a'), true);
    const { service, effects, payload } = playbackFixture(f);
    let release; f.pauseReads(new Promise(resolve => { release = resolve; }));
    const speaking = service.speakAvatarMessage(payload);
    if (interruption === 'same-account sign-in') {
      f.changeActor(null); await service.stopAvatarSpeechPlayback();
      f.changeActor('actor-a'); await service.stopAvatarSpeechPlayback();
    } else {
      await service.stopAvatarSpeechPlayback({ actorId: payload.actorId, sessionId: payload.sessionId });
    }
    release(); await speaking;
    assert.deepEqual(effects, { requests: 0, files: 0, plays: 0, listeners: 0 });
  });
}

test('withdrawal wins over an earlier in-flight grant in memory and durable storage', async () => {
  const f = fixture();
  let release;
  f.pauseWrites(new Promise((resolve) => { release = resolve; }));
  const grant = f.speech.grantSpeechConsent('actor-a');
  await Promise.resolve();
  const withdrawal = f.speech.withdrawSpeechConsent('actor-a');
  release();
  assert.equal(await grant, false);
  assert.equal(await withdrawal, true);
  assert.equal(f.speech.hasSpeechConsent('actor-a'), false);
  assert.equal(await f.speech.loadSpeechConsent('actor-a'), false);
  assert.equal(f.records.size, 0);
});

test('failed withdrawal cannot reopen consent by loading the surviving record', async () => {
  const f = fixture();
  assert.equal(await f.speech.grantSpeechConsent('actor-a'), true);
  f.failStorage();
  assert.equal(await f.speech.withdrawSpeechConsent('actor-a'), false);
  assert.equal(f.records.size, 1);
  assert.equal(await f.speech.loadSpeechConsent('actor-a'), false);
  assert.equal(f.speech.hasSpeechConsent('actor-a'), false);
});

test('A to signed-out to A cannot apply an old session grant', async () => {
  const f = fixture();
  let release;
  f.pauseWrites(new Promise((resolve) => { release = resolve; }));
  const grant = f.speech.grantSpeechConsent('actor-a');
  f.changeActor(null); f.changeActor('actor-a');
  release();
  assert.equal(await grant, false);
  assert.equal(f.speech.hasSpeechConsent('actor-a'), false);
});
test('unapproved owner disclosure cannot grant or load speech consent even with a prior record', async () => {
  const f = fixture(false);
  assert.equal(await f.speech.grantSpeechConsent('actor-a'), false);
  assert.equal(await f.speech.loadSpeechConsent('actor-a'), false);
  assert.equal(f.records.size, 0);
});

test('speech disclosure version and exact owner-review copy have a pinned digest', () => {
  const { speech } = fixture(false);
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    version: speech.SPEECH_CONSENT_VERSION, copy: speech.SPEECH_CONSENT_COPY,
  })).digest('hex');
  assert.equal(digest, 'c5ff566470b2ed7f070f88bc986004993108ac9cac8700afaebc1fcbd83f80f5');
});
test('accepted speech is device/account/version scoped and withdrawal closes gate immediately', async () => {
  const f = fixture();
  assert.equal(f.speech.hasSpeechConsent('actor-a'), false);
  assert.equal(await f.speech.grantSpeechConsent('actor-a'), true);
  assert.equal(f.speech.hasSpeechConsent('actor-a'), true);
  f.changeActor('actor-b');
  assert.equal(await f.speech.loadSpeechConsent('actor-b'), false);
  assert.equal(f.speech.hasSpeechConsent('actor-a'), false);
  assert.equal(await f.speech.grantSpeechConsent('actor-a'), false);
  f.changeActor('actor-a');
  assert.equal(await f.speech.loadSpeechConsent('actor-a'), true);
  const withdrawing = f.speech.withdrawSpeechConsent('actor-a');
  assert.equal(f.speech.hasSpeechConsent('actor-a'), false);
  assert.equal(await withdrawing, true);
  assert.equal(await f.speech.loadSpeechConsent('actor-a'), false);
});
test('storage failure and obsolete disclosure cannot authorize transmission', async () => {
  const f = fixture();
  f.records.set('kscan.thirdPartyAiConsent.v1:elise_speech:actor-a', JSON.stringify({ version: 'old', grantedAt: new Date().toISOString() }));
  assert.equal(await f.speech.loadSpeechConsent('actor-a'), false);
  f.failStorage();
  assert.equal(await f.speech.grantSpeechConsent('actor-a'), false);
  assert.equal(f.speech.hasSpeechConsent('actor-a'), false);
});
test('direct speech client refuses absent consent before transport, but consenting actor can use same contract', async () => {
  let consent = false; let calls = 0;
  const reply = { messageId: 'message', stylistId: 'elise_default', voiceProfile: 'feminine', mimeType: 'audio/mpeg', audioBase64: 'YQ==', alignment: null };
  const client = load('services/avatars/stylistSpeechClient.ts', {
    '../../constants/featureFlags': { STYLIST_SPEECH_ENABLED: true },
    './speechConsent': { hasSpeechConsent: () => consent },
    '../supabaseClient': { supabase: { functions: { invoke: async () => { calls++; return { data: reply, error: null }; } } } },
  });
  const request = { actorId: 'actor-a', sessionId: 'session', messageId: 'message', stylistId: 'elise_default' };
  await assert.rejects(client.requestStylistSpeech(request), /Privacy settings/);
  assert.equal(calls, 0);
  consent = true;
  assert.equal((await client.requestStylistSpeech(request)).messageId, 'message');
  assert.equal(calls, 1);
});
test('speech opt-in and withdrawal are wired through canonical privacy and speech paths', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'components/settings/SpeechSettingsSection.tsx'), 'utf8');
  const service = fs.readFileSync(path.join(ROOT, 'services/avatarSpeech.ts'), 'utf8');
  assert.match(settings, /Alert\.alert\(SPEECH_CONSENT_COPY\.title/);
  assert.match(settings, /withdrawSpeechConsent\(actorId\)/);
  assert.match(settings, /await stopAvatarSpeechPlayback\(\)/);
  assert.ok(service.indexOf('await loadSpeechConsent(payload.actorId)') < service.indexOf('const key = operationKey(payload)'));
  assert.match(fs.readFileSync(path.join(ROOT, 'app/privacy.tsx'), 'utf8'), /<SpeechSettingsSection actorId=\{user\?\.id \?\? null\}/);
});
