const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;

const {
  STYLIST_PORTRAIT_PRESETS,
  STYLIST_SPEECH_CONFIG_BY_ID,
  getStylistVoiceProfile,
} = require('../constants/stylistIdentity.ts');

test('female and male animation-ready portraits keep approved voice profiles', () => {
  assert.equal(getStylistVoiceProfile('stylist_portrait_01'), 'feminine');
  assert.equal(getStylistVoiceProfile('stylist_portrait_02'), 'masculine');
  assert.equal(getStylistVoiceProfile('stylist_portrait_03'), 'feminine');
  assert.equal(getStylistVoiceProfile('stylist_portrait_04'), 'masculine');
  assert.equal(getStylistVoiceProfile('stylist_portrait_05'), 'feminine');
  assert.equal(getStylistVoiceProfile('stylist_portrait_08'), 'masculine');
  for (const id of [
    'stylist_portrait_01',
    'stylist_portrait_02',
    'stylist_portrait_03',
    'stylist_portrait_04',
    'stylist_portrait_05',
    'stylist_portrait_08',
  ]) {
    assert.ok(STYLIST_SPEECH_CONFIG_BY_ID.has(id), id);
  }
});

test('mouth-state assets exist with case-stable filenames for animation-ready portraits', () => {
  const animatedDir = path.join(ROOT, 'assets', 'stylist-avatars', 'portraits', 'animated');
  for (const id of ['01', '02', '03', '04', '05', '08']) {
    for (const state of ['closed', 'half_open', 'open']) {
      const filePath = path.join(animatedDir, `avatar_stylist_${id}_mouth_${state}.png`);
      assert.ok(fs.existsSync(filePath), filePath);
      assert.ok(fs.statSync(filePath).size > 1000, `${filePath} should not be an empty placeholder`);
    }
  }
});

test('approved female and male voice IDs remain the Edge secret contract', () => {
  const client = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'stylist-speech', 'elevenLabsClient.ts'),
    'utf8',
  );
  const secretTest = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'stylist-speech', 'secretConfig.test.ts'),
    'utf8',
  );
  assert.match(client, /ELEVENLABS_FEMININE_VOICE_ID/);
  assert.match(client, /ELEVENLABS_MASCULINE_VOICE_ID/);
  assert.match(secretTest, /NQMJRVvPew6HsaebYnZj/);
  assert.match(secretTest, /guZ5txGiatiDmC3jrjOO/);
});

test('welcome speech path has no Android/iOS platform forks', () => {
  const roots = [
    'hooks/useStyleChat.ts',
    'services/style-chat/styleChatGreeting.ts',
    'services/avatarSpeech.ts',
    'services/avatarSpeechMotion.ts',
    'components/stylist/AnimatedStylistAvatar.tsx',
    'components/style-chat/StyleChatHeader.tsx',
    'constants/stylistIdentity.ts',
  ];
  for (const relative of roots) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /Platform\.(?:OS|select)/, relative);
    assert.ok(!fs.existsSync(path.join(ROOT, relative.replace(/\.tsx?$/, '.android.ts'))));
    assert.ok(!fs.existsSync(path.join(ROOT, relative.replace(/\.tsx?$/, '.ios.ts'))));
  }
});

test('playback-only speech permissions remain microphone-free', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  assert.ok(appJson.expo.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));
  assert.equal('NSMicrophoneUsageDescription' in (appJson.expo.ios.infoPlist || {}), false);
});

test('mouth timing policy remains in the 70–100 ms / ~8–12 Hz target band', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarSpeechMotion.ts'), 'utf8');
  assert.match(source, /minStateDurationSeconds:\s*0\.1/);
  assert.match(source, /maxUpdateRatePerSecond:\s*10/);
});

test('odd portraits remain feminine and even portraits remain masculine', () => {
  STYLIST_PORTRAIT_PRESETS.forEach((preset, index) => {
    const expected = (index + 1) % 2 === 1 ? 'feminine' : 'masculine';
    assert.equal(preset.voiceProfile, expected, preset.id);
  });
});
