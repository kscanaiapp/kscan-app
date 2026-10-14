'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '..');
function load(file, mocks = {}, extra = {}) {
  const mod = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(output, {
    exports: mod.exports, module: mod, console, AbortController, Set, Date, Error,
    process: { env: {} }, __DEV__: false, ...extra,
    require: (id) => {
      if (id === 'react/jsx-runtime') return { Fragment: 'fragment', jsx: (type, props) => ({ type, props, children: props.children }), jsxs: (type, props) => ({ type, props, children: props.children }) };
      if (id in mocks) return mocks[id];
      if (id.endsWith('/speechConsent')) return {
        loadSpeechConsent: () => { throw new Error('Held speech must not load consent'); },
        hasSpeechConsent: () => { throw new Error('Held speech must not check consent'); },
      };
      throw new Error(`Unexpected import: ${id}`);
    },
  }, { filename: file });
  return mod.exports;
}
test('speech stays fail-closed when no flag exists and only exact true enables approved opt-in UI', () => {
  const flags = load('constants/featureFlags.ts');
  assert.equal(flags.STYLIST_SPEECH_ENABLED, false);
  for (const value of [undefined, '', 'false', 'TRUE', ' true ', '1']) assert.equal(flags.resolveStylistSpeechEnabled(value), false);
  assert.equal(flags.resolveStylistSpeechEnabled('true'), true);
});
test('held auto and retry speech do not fetch, bind listeners, write files, or start playback; stop stays usable', async () => {
  const effects = [];
  const service = load('services/avatarSpeech.ts', {
    '../constants/featureFlags': { STYLIST_SPEECH_ENABLED: false },
    '../stores/avatarSpeechStore': {
      getAvatarSpeechState: () => ({ phase: 'idle', generation: 0 }),
      isAvatarSpeechScopeActive: () => false,
      finishAvatarSpeech: () => effects.push('finish'),
    },
    './avatars/stylistSpeechClient': { requestStylistSpeech: () => effects.push('request') },
    './avatars/stylistAudioPlayback': { playStylistAudio: () => effects.push('play') },
    './avatars/stylistSpeechFiles': {
      createTemporaryStylistSpeechFile: () => effects.push('file'),
      deleteTemporaryStylistSpeechFile: () => effects.push('cleanup'),
    },
    './avatars/speechAppState': {
      ensureSpeechAppStateListener: () => effects.push('listen'),
      registerSpeechInterruptionHandler: () => effects.push('bind'),
    },
  });
  const payload = { actorId: 'actor', sessionId: 'session', messageId: 'message', stylistId: 'stylist', avatarId: 'stylist', source: 'message' };
  await service.speakAvatarMessage(payload);
  await service.speakAvatarMessage({ ...payload, trigger: 'retry' });
  assert.deepEqual(effects, []);
  await service.stopAvatarSpeechPlayback();
  assert.deepEqual(effects, ['cleanup', 'finish']);
});
test('direct client callers cannot bypass a held speech service', async () => {
  let invoked = 0;
  const client = load('services/avatars/stylistSpeechClient.ts', {
    '../../constants/featureFlags': { STYLIST_SPEECH_ENABLED: false },
    '../supabaseClient': { supabase: { functions: { invoke: () => { invoked += 1; } } } },
  });
  await assert.rejects(client.requestStylistSpeech({ actorId: 'actor', sessionId: 'session', messageId: 'message', stylistId: 'stylist' }), /not enabled/);
  assert.equal(invoked, 0);
});

const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (value) => [value, () => {}], useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn, useMemo: (fn) => fn(), useEffect: () => {},
};
const native = { StyleSheet: { create: (styles) => styles }, Platform: { OS: 'ios' }, useWindowDimensions: () => ({ width: 390 }) };
for (const type of ['View', 'Text', 'Pressable', 'Modal', 'TextInput', 'KeyboardAvoidingView', 'ScrollView', 'Switch']) native[type] = type;
const theme = { LUXURY: { colors: {}, typography: {} }, RADIUS: {}, SPACING: {} };
function hasTestId(tree, id) {
  if (Array.isArray(tree)) return tree.some((item) => hasTestId(item, id));
  return !!tree && typeof tree === 'object' && (tree.props?.testID === id || hasTestId(tree.children, id));
}
test('held personalization hides voice preferences even when a previous preference is ON', () => {
  function render(enabled) {
    const component = load('components/stylist/PersonalizeStylistModal.tsx', {
      react, 'react-native': native,
      'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
      '../../constants/theme': theme,
      '../../constants/featureFlags': { STYLIST_SPEECH_ENABLED: enabled },
      '../../constants/stylistIdentity': { DEFAULT_STYLIST_IDENTITY: { displayName: 'Elise', avatarId: 'avatar' }, isPersistableAvatarId: () => true, STYLIST_ABSTRACT_PRESETS: [], STYLIST_PORTRAIT_PRESETS: [], STYLIST_NAME_MIN_LENGTH: 2, STYLIST_NAME_MAX_LENGTH: 24 },
      './StylistAvatar': { StylistAvatar: 'avatar' },
      '../../hooks/useVoiceResponsesPreference': { useVoiceResponsesPreference: () => ({ enabled: true, loading: false }) },
    });
    return component.PersonalizeStylistModal({ visible: true, identity: { displayName: 'Elise', avatarId: 'avatar' } });
  }
  assert.equal(hasTestId(render(false), 'voice-responses-switch'), false);
  assert.equal(hasTestId(render(true), 'voice-responses-switch'), true);
});
test('held message recovery hides retry even when a previous speech error exists', () => {
  function render(enabled) {
    const component = load('components/style-chat/StyleChatVoiceRetry.tsx', {
      react: { ...react, useState: () => [true, () => {}] }, 'react-native': native,
      '../../constants/theme': theme,
      '../../constants/featureFlags': { STYLIST_SPEECH_ENABLED: enabled },
      '../../constants/styleChat': { STYLE_CHAT_COPY: {} },
      '../../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: 'actor' } }) },
      '../../hooks/useStylistIdentity': { useStylistIdentity: () => ({ identity: { avatarId: 'avatar' } }) },
      '../../stores/avatarSpeechStore': { useAvatarSpeechSelection: () => false },
      '../../services/avatarSpeech': { speakAvatarMessage: () => {} },
      '../../services/avatars/voiceRetryPresentation': { isVoiceRetryInFlight: () => false },
    });
    return component.StyleChatVoiceRetry({ sessionId: 'session', messageId: 'message' });
  }
  assert.equal(render(false), null);
  assert.equal(hasTestId(render(true), 'style-chat-voice-retry-button-message'), true);
});

test('Production and release iOS/Android builds compile opt-in Elise Speech while server billing remains independently held', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  for (const profile of ['staging', 'production', 'build35-release', 'production-certification']) {
    assert.equal(eas.build[profile].env.EXPO_PUBLIC_ELISE_SPEECH, 'true', profile);
  }
  const speech = fs.readFileSync(path.join(ROOT, 'services/avatars/stylistSpeechClient.ts'), 'utf8');
  const consent = fs.readFileSync(path.join(ROOT, 'services/avatars/speechConsent.ts'), 'utf8');
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261011222213_build35_speech_operational_cost_controls.sql'), 'utf8');
  assert.match(speech, /hasSpeechConsent\(request\.actorId\)/);
  assert.match(consent, /SPEECH_DISCLOSURE_APPROVED = true/);
  assert.match(sql, /enabled boolean not null default false/);
  assert.match(sql, /daily_character_limit integer not null default 0/);
  const releaseGuard = fs.readFileSync(path.join(ROOT, 'scripts/check-build35-release-profile.js'), 'utf8');
  assert.match(releaseGuard, /'EXPO_PUBLIC_ELISE_SPEECH', \/\/ speech UI and consent/);
  assert.doesNotMatch(releaseGuard.slice(releaseGuard.indexOf('const REQUIRED_OFF'), releaseGuard.indexOf('const REQUIRED_ON')), /'EXPO_PUBLIC_ELISE_SPEECH'/);
});
