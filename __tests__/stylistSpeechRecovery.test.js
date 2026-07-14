const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;

const {
  STYLIST_ABSTRACT_PRESETS,
  STYLIST_PORTRAIT_PRESETS,
  STYLIST_AVATAR_PRESETS,
  STYLIST_SPEECH_CONFIG_BY_ID,
  isSpeechEnabledAvatar,
  getStylistSpeechConfig,
} = require('../constants/stylistIdentity.ts');

const { buildStylistGreeting } = require('../services/stylistGreeting.ts');
const { resolveUserFirstName } = require('../services/userFirstName.ts');

// ── Architecture ─────────────────────────────────────────────────────────────

test('authoritative registry is preserved and no parallel registry exists', () => {
  assert.equal(STYLIST_ABSTRACT_PRESETS.length, 6);
  assert.equal(STYLIST_PORTRAIT_PRESETS.length, 10);
  assert.equal(STYLIST_AVATAR_PRESETS.length, 16);
  assert.equal(fs.existsSync(path.join(ROOT, 'services', 'avatars', 'registry.ts')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'services', 'avatars', 'types.ts')), false);
});

test('speech configuration is keyed by existing preset IDs and does not duplicate the registry', () => {
  for (const id of STYLIST_SPEECH_CONFIG_BY_ID.keys()) {
    assert.ok(
      STYLIST_AVATAR_PRESETS.some((preset) => preset.id === id),
      `speech config key ${id} must be an existing preset ID`,
    );
  }
});

test('abstract avatars and unconfigured portraits are not speech-enabled', () => {
  for (const preset of STYLIST_ABSTRACT_PRESETS) {
    assert.equal(isSpeechEnabledAvatar(preset.id), false);
  }
  for (const preset of STYLIST_PORTRAIT_PRESETS) {
    const config = getStylistSpeechConfig(preset.id);
    if (!config || config.speechEnabled !== true) {
      assert.equal(isSpeechEnabledAvatar(preset.id), false);
    }
  }
});

test('configured proof portraits are speech-enabled and have mouth regions', () => {
  for (const id of ['stylist_portrait_02', 'stylist_portrait_05', 'stylist_portrait_08']) {
    const config = getStylistSpeechConfig(id);
    assert.ok(config, `${id} must have speech config`);
    assert.equal(config.speechEnabled, true);
    assert.ok(config.voiceProfile === 'female' || config.voiceProfile === 'male');
    assert.equal(config.speakingMotionMode, 'mouth_overlay');
    assert.ok(config.mouthRegion);
    assert.ok(config.mouthRegion.x >= 0 && config.mouthRegion.x <= 1);
    assert.ok(config.mouthRegion.y >= 0 && config.mouthRegion.y <= 1);
    assert.ok(config.mouthRegion.width > 0 && config.mouthRegion.width <= 1);
    assert.ok(config.mouthRegion.height > 0 && config.mouthRegion.height <= 1);
  }
});

// ── Greeting ─────────────────────────────────────────────────────────────────

test('buildStylistGreeting uses first name and selected stylist name', () => {
  const result = buildStylistGreeting({ userFirstName: 'Kathleen', stylistName: 'Elise' });
  assert.equal(result.text, 'Hi, Kathleen. I am Elise. How can I help style you today?');
  assert.equal(result.userFirstName, 'Kathleen');
  assert.equal(result.stylistName, 'Elise');
  assert.equal(result.genericFallback, false);
});

test('buildStylistGreeting uses custom stylist name', () => {
  const result = buildStylistGreeting({ userFirstName: 'Kathleen', stylistName: 'Ava' });
  assert.equal(result.text, 'Hi, Kathleen. I am Ava. How can I help style you today?');
});

test('buildStylistGreeting falls back when first name is missing', () => {
  const result = buildStylistGreeting({ userFirstName: null, stylistName: 'Elise' });
  assert.equal(result.text, 'Hi, I’m Elise. How can I style you today?');
  assert.equal(result.userFirstName, null);
  assert.equal(result.genericFallback, true);
});

test('buildStylistGreeting rejects empty or control-character names', () => {
  assert.equal(buildStylistGreeting({ userFirstName: '', stylistName: 'Elise' }).genericFallback, true);
  assert.equal(
    buildStylistGreeting({ userFirstName: '   ', stylistName: 'Elise' }).genericFallback,
    true,
  );
  assert.equal(
    buildStylistGreeting({ userFirstName: '\x00Jane', stylistName: 'Elise' }).userFirstName,
    'Jane',
  );
});

test('buildStylistGreeting preserves Unicode names', () => {
  const result = buildStylistGreeting({ userFirstName: 'Sãoirse', stylistName: 'Elise' });
  assert.ok(result.text.includes('Sãoirse'));
});

// ── User name resolution ─────────────────────────────────────────────────────

test('resolveUserFirstName reads established metadata fields and rejects email', () => {
  const user = {
    id: 'user-1',
    user_metadata: {
      first_name: 'Alice',
      full_name: 'Alice Smith',
      email: 'alice@example.com',
    },
  };
  const resolved = resolveUserFirstName(user);
  assert.equal(resolved.firstName, 'Alice');
  assert.equal(resolved.source, 'first_name');
});

test('resolveUserFirstName falls back through metadata fields', () => {
  assert.equal(resolveUserFirstName({ id: 'u', user_metadata: { given_name: 'Bob' } }).firstName, 'Bob');
  assert.equal(resolveUserFirstName({ id: 'u', user_metadata: { full_name: 'Carol Ann' } }).firstName, 'Carol');
  assert.equal(resolveUserFirstName({ id: 'u', user_metadata: { name: 'Dan Doe' } }).firstName, 'Dan');
  assert.equal(resolveUserFirstName({ id: 'u', user_metadata: { display_name: 'Eve Last' } }).firstName, 'Eve');
  assert.equal(resolveUserFirstName({ id: 'u', user_metadata: { email: 'eve@example.com' } }).firstName, null);
});

// ── Speech store ─────────────────────────────────────────────────────────────

function loadAvatarSpeechStore() {
  const ts = require('typescript');
  const storePath = path.join(ROOT, 'stores', 'avatarSpeechStore.ts');
  const source = fs
    .readFileSync(storePath, 'utf8')
    .replace("import { useSyncExternalStore } from 'react';", '');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const vm = require('node:vm');
  const sandbox = {
    __DEV__: false,
    console,
    Date,
    Error,
    exports: mod.exports,
    module: mod,
    require: (spec) => {
      throw new Error(`Unexpected import in speech store test: ${spec}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: storePath }).runInContext(sandbox);
  return mod.exports;
}

test('avatar speech store reference is stable when unchanged', () => {
  const store = loadAvatarSpeechStore();
  const snap1 = store.getAvatarSpeechState();
  const snap2 = store.getAvatarSpeechState();
  assert.equal(snap1, snap2);
});

test('avatar speech store emits only on real changes', () => {
  const store = loadAvatarSpeechStore();
  let emissions = 0;
  const unsubscribe = store.subscribeToAvatarSpeech(() => {
    emissions += 1;
  });
  store.startAvatarSpeech({
    actorKey: 'actor-1',
    avatarId: 'stylist_portrait_05',
    utteranceKey: 'greeting:1',
    source: 'greeting',
  });
  assert.equal(emissions, 1);
  assert.equal(store.getAvatarSpeechState().status, 'starting');
  store.markAvatarSpeechSpeaking();
  assert.equal(emissions, 2);
  store.markAvatarSpeechSpeaking(); // no-op
  assert.equal(emissions, 2);
  store.stopAvatarSpeech();
  assert.equal(emissions, 3);
  unsubscribe();
});

test('avatar speech store resets on actor and avatar change', () => {
  const store = loadAvatarSpeechStore();
  store.startAvatarSpeech({
    actorKey: 'actor-1',
    avatarId: 'stylist_portrait_05',
    utteranceKey: 'greeting:1',
    source: 'greeting',
  });
  store.markAvatarSpeechSpeaking();
  assert.equal(store.getAvatarSpeechState().actorKey, 'actor-1');

  store.resetAvatarSpeechForActor('actor-2');
  assert.equal(store.getAvatarSpeechState().actorKey, 'actor-1');

  store.resetAvatarSpeechForActor('actor-1');
  assert.equal(store.getAvatarSpeechState().status, 'idle');

  store.startAvatarSpeech({
    actorKey: 'actor-2',
    avatarId: 'stylist_portrait_02',
    utteranceKey: 'greeting:2',
    source: 'greeting',
  });
  store.resetAvatarSpeechForAvatar('stylist_portrait_08');
  assert.equal(store.getAvatarSpeechState().actorKey, 'actor-2');
  store.resetAvatarSpeechForAvatar('stylist_portrait_02');
  assert.equal(store.getAvatarSpeechState().status, 'idle');
});

// ── Voice resolver ───────────────────────────────────────────────────────────

function loadVoiceResolver() {
  const ts = require('typescript');
  const sourcePath = path.join(ROOT, 'services', 'avatarSpeechVoice.ts');
  const source = fs.readFileSync(sourcePath, 'utf8').replace("import * as Speech from 'expo-speech';", '');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const vm = require('node:vm');
  const sandbox = {
    __DEV__: false,
    console,
    Date,
    Error,
    exports: mod.exports,
    module: mod,
    process: { env: {} },
    require: (spec) => {
      if (spec === '../constants/stylistIdentity') return require('../constants/stylistIdentity.ts');
      throw new Error(`Unexpected import in voice resolver test: ${spec}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

test('voice resolver fails closed when no approved voice is configured', async () => {
  const resolver = loadVoiceResolver();
  const result = await resolver.resolveAvatarSpeechVoice('female');
  assert.equal(result.voice, null);
  assert.equal(result.reason, 'owner_review_required');
});

// ── Permissions ──────────────────────────────────────────────────────────────

test('app.json does not introduce microphone permission or VoiceScan enablement', () => {
  const appJson = fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8');
  // RECORD_AUDIO may appear in blockedPermissions; ensure it is not in the
  // allowed permissions list and no iOS microphone usage string is present.
  const allowedMatch = appJson.match(/"permissions"\s*:\s*\[[\s\S]*?\]/);
  const allowedBlock = allowedMatch ? allowedMatch[0] : '';
  assert.doesNotMatch(allowedBlock, /RECORD_AUDIO/);
  assert.doesNotMatch(appJson, /NSMicrophoneUsageDescription/);

  const featureFlags = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');
  assert.match(featureFlags, /VOICESCAN_ENABLED\s*=\s*false/);
});

// ── Component wiring ─────────────────────────────────────────────────────────

test('AnimatedStylistAvatar delegates to StylistAvatar and does not read a parallel registry', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'), 'utf8');
  assert.match(source, /from ['"]\.\/StylistAvatar['"]/);
  assert.match(source, /STYLIST_AVATAR_PRESET_BY_ID/);
  assert.doesNotMatch(source, /services\/avatars\/registry/);
  assert.doesNotMatch(source, /elise-placeholder/);
});

test('StyleChatHeader consumes useStylistIdentity, AnimatedStylistAvatar, and avatar speech state', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'), 'utf8');
  assert.match(source, /useStylistIdentity/);
  assert.match(source, /AnimatedStylistAvatar/);
  assert.match(source, /useAvatarSpeechState/);
  assert.doesNotMatch(source, /useStylistGreeting/);
});

test('HomeStylistCard consumes AnimatedStylistAvatar and the shared greeting builder', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components', 'home', 'HomeStylistCard.tsx'), 'utf8');
  assert.match(source, /AnimatedStylistAvatar/);
  assert.match(source, /getGreetingTextForUser/);
  assert.doesNotMatch(source, /useStylistGreeting/);
  assert.doesNotMatch(source, /services\/avatars\/registry/);
});

test('useStyleChat delegates greeting lifecycle to the style-chat greeting service', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  assert.match(source, /ensureSessionGreeting/);
  assert.match(source, /getGreetingTextForUser/);
  assert.match(source, /markSessionGreeted/);
  assert.match(source, /isSessionGreeted/);
  assert.match(source, /stopAvatarSpeechPlayback/);
});

test('StyleChatBubble skips rendering the internal greeting uiBlocks marker', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components', 'style-chat', 'StyleChatBubble.tsx'), 'utf8');
  assert.match(source, /type === 'greeting'/);
});
