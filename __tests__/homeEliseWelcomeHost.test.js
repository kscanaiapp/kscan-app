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

function hostVisual({ focused = true, foreground = true, reducedMotion = false, speech = {} } = {}) {
  let frames = 0;
  let epochs = 0;
  let idleEnabled;
  let input;
  const react = {
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (compute) => compute(),
    useRef: (initial) => ({ current: initial }),
  };
  const { useStylistAvatarVisual } = load('hooks/useStylistAvatarVisual.ts', {
    react,
    'react-native': { AppState: { currentState: foreground ? 'active' : 'background' } },
    '@react-navigation/native': { useIsFocused: () => focused },
    './useReducedMotion': { useReducedMotion: () => reducedMotion },
    './useAvatarIdlePresence': { useAvatarIdlePresence: ({ enabled }) => { idleEnabled = enabled; return 0; } },
    '../stores/avatarSpeechStore': { useAvatarSpeechState: () => speech },
    '../constants/stylistIdentity': { resolveStylistVisualAvatarId: (id) => id === 'elise_default' ? 'stylist_portrait_01' : id },
    '../services/avatars/avatarEngineAdapter': { getAvatarEngineAdapter: () => ({
      computeFrame: (value) => { frames += 1; input = value; return {
        mouthState: value.scopeMatches ? 'open' : 'closed',
        frame: { headMotion: { rotateDeg: 0.4 }, breathing: { scale: 1.002 } },
      }; },
    }) },
    '../services/avatars/avatarMotionEpoch': { resolveAvatarMotionEpoch: () => { epochs += 1; return 3; } },
  });
  const result = useStylistAvatarVisual({
    actorId: 'actor-A', sessionId: 'welcome-session', messageId: 'welcome-message', avatarId: 'elise_default',
  });
  return { result, frames, epochs, input, idleEnabled };
}

test('unfocused/background Home or Chat host cannot touch the singleton engine/epoch', () => {
  for (const props of [{ focused: false }, { foreground: false }]) {
    const h = hostVisual(props);
    assert.equal(h.frames, 0);
    assert.equal(h.epochs, 0);
    assert.deepEqual(h.result.visual, { mouthState: 'closed', motion: { headRotateDeg: 0, breathingScale: 1 } });
    assert.equal(h.result.isSpeaking, false);
  }
});

const welcomeSpeech = {
  actorId: 'actor-A', sessionId: 'welcome-session', messageId: 'welcome-message',
  stylistId: 'elise_default', avatarId: 'elise_default', phase: 'playing', playbackSeconds: 0.38,
};
test('visible Home uses exact owned utterance and portrait alias; engine supplies both mouth and motion', () => {
  const h = hostVisual({ speech: welcomeSpeech });
  assert.equal(h.frames, 1);
  assert.equal(h.epochs, 1);
  assert.equal(h.result.visualAvatarId, 'stylist_portrait_01');
  assert.equal(h.input.avatarId, 'stylist_portrait_01');
  assert.equal(h.input.speech, welcomeSpeech);
  assert.equal(h.input.scopeMatches, true);
  assert.equal(h.result.isSpeaking, true);
  assert.equal(h.idleEnabled, false, 'native playback is the only advancing clock during speech');
  assert.equal(h.result.visual.mouthState, 'open');
  assert.deepEqual(h.result.visual.motion, { headRotateDeg: 0.4, breathingScale: 1.002 });
});

test('different actor/session/message/stylist/avatar cannot animate Home from another utterance', () => {
  for (const key of ['actorId', 'sessionId', 'messageId', 'stylistId', 'avatarId']) {
    const h = hostVisual({ speech: { ...welcomeSpeech, [key]: 'other' } });
    assert.equal(h.input.scopeMatches, false, key);
    assert.equal(h.result.isSpeaking, false, key);
    assert.equal(h.result.visual.mouthState, 'closed', key);
  }
  const reduced = hostVisual({ speech: welcomeSpeech, reducedMotion: true });
  assert.equal(reduced.input.reduceMotion, true);
  assert.equal(reduced.idleEnabled, false);
});

function welcomeHook(overrides = {}) {
  const effects = [];
  const calls = [];
  const flags = {
    actorId: 'actor-A', authLoading: false, authenticated: true, recovering: false, refreshing: false,
    bootStatus: 'ready', remoteFailed: false, accountStatus: 'active', locked: null,
    voiceEnabled: true, voiceLoading: false, reader: false, readerReady: true,
    focused: true, foreground: true, featureEnabled: true, voiceProfile: 'feminine',
    ...overrides,
  };
  const { useHomeEliseWelcome } = load('hooks/useHomeEliseWelcome.ts', {
    react: {
      useEffect: (fn) => effects.push(fn),
      useState: (initial) => [initial, () => {}],
      useRef: (initial) => ({ current: initial }),
    },
    'react-native': { AppState: {
      currentState: flags.foreground ? 'active' : 'background',
      addEventListener: () => ({ remove() {} }),
    } },
    '@react-navigation/native': { useIsFocused: () => flags.focused },
    '../constants/stylistIdentity': { getStylistVoiceProfile: () => flags.voiceProfile },
    '../constants/featureFlags': { STYLIST_SPEECH_ENABLED: flags.featureEnabled },
    '../contexts/AuthSessionContext': { useAuthSession: () => ({
      user: flags.actorId ? { id: flags.actorId, user_metadata: { first_name: 'Morgan' } } : null,
      loading: flags.authLoading, isAuthenticated: flags.authenticated, isRecoveringSession: flags.recovering,
      isRefreshing: flags.refreshing,
    }) },
    '../contexts/PrivacyPreferencesContext': { usePrivacyPreferences: () => ({
      bootStatus: flags.bootStatus, remoteFetchFailed: flags.remoteFailed,
      profile: { account_status: flags.accountStatus, account_locked_at: flags.locked },
    }) },
    '../services/actorScope': {
      captureActorScope: () => ({ actorId: flags.actorId, epoch: 2 }),
      isActorScopeCurrent: () => true,
    },
    '../services/style-chat/styleChatGreeting': { getGreetingTextForUser: (user, identity) =>
      `Hi, ${user?.user_metadata.first_name ?? 'there'}. I’m ${identity.displayName}.` },
    '../services/homeEliseWelcomeRuntime': { startHomeEliseWelcome: (input) => {
      calls.push(input); return { cancel() {}, done: Promise.resolve() };
    } },
    './useVoiceResponsesPreference': { useVoiceResponsesPreference: () => ({ enabled: flags.voiceEnabled, loading: flags.voiceLoading }) },
    './useScreenReaderEnabled': { useScreenReaderEnabled: () => flags.reader, useScreenReaderReady: () => flags.readerReady },
  });
  const result = useHomeEliseWelcome({ identity: { avatarId: 'elise_default', displayName: 'Elise' }, ready: true, entitlement: flags.entitlement ?? 'active' });
  for (const effect of effects) effect();
  return { result, calls };
}

test('Home welcome waits for auth/profile/identity/entitlement/accessibility bootstrap and visible foreground', () => {
  for (const props of [
    { actorId: null }, { authLoading: true }, { recovering: true }, { refreshing: true }, { bootStatus: 'loading' },
    { voiceLoading: true }, { readerReady: false }, { entitlement: 'loading' },
    { focused: false }, { foreground: false },
  ]) assert.equal(welcomeHook(props).calls.length, 0, JSON.stringify(props));
});

test('resolved Free/no voice/no screen-reader permission/locked states show canonical text and retire launch without audio eligibility', () => {
  for (const props of [
    { entitlement: 'eligible' }, { entitlement: 'error' }, { entitlement: 'expired' },
    { authenticated: false }, { voiceEnabled: false }, { reader: true },
    { accountStatus: 'suspended' }, { locked: 'locked' }, { remoteFailed: true },
    { featureEnabled: false }, { voiceProfile: 'silent' },
  ]) {
    const h = welcomeHook(props);
    assert.equal(h.result.text, 'Hi, Morgan. I’m Elise.');
    assert.equal(h.calls.length, 1, JSON.stringify(props));
    assert.equal(h.calls[0].eligible, false, JSON.stringify(props));
    assert.equal(h.calls[0].isCurrent(), true, 'text-only launch still retires this process attempt');
  }
  assert.equal(welcomeHook().calls[0].eligible, true);
});

test('device record schema rejects corrupt markers and strips anything except envelope IDs/dates', () => {
  const modules = {
    '@react-native-async-storage/async-storage': {}, 'expo-crypto': {},
    './homeEliseWelcome': { createHomeEliseWelcome: () => () => {} },
    './avatars/speechConsent': {}, './onboardingCompletion': {},
    './style-chat/styleChatRepository': {}, './style-chat/styleChatGreeting': {},
    './avatarSpeech': {}, '../stores/avatarSpeechStore': {},
  };
  const { parseHomeWelcomeRecord } = load('services/homeEliseWelcomeRuntime.ts', modules);
  assert.deepEqual(parseHomeWelcomeRecord(null), { version: 1 });
  for (const raw of ['broken', 'null', '{}', '{"version":2}', '{"version":1,"sessionId":42}', '{"version":1,"playedDay":true}']) {
    assert.throws(() => parseHomeWelcomeRecord(raw));
  }
  assert.deepEqual(parseHomeWelcomeRecord(JSON.stringify({
    version: 1, sessionId: '00000000-0000-4000-8000-000000000001', attemptDay: '2026-10-15',
    unexpectedText: 'must not retain transcript',
  })), { version: 1, sessionId: '00000000-0000-4000-8000-000000000001', attemptDay: '2026-10-15' });
});
