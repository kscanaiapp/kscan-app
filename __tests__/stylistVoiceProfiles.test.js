const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;

const {
  STYLIST_ABSTRACT_PRESETS,
  STYLIST_AVATAR_PRESETS,
  STYLIST_PORTRAIT_PRESETS,
  getStylistVoiceProfile,
} = require('../constants/stylistIdentity.ts');

const EXPECTED_REGISTRY_IDS = [
  'elise_default',
  'editorial_plum',
  'chrome_muse',
  'deep_space',
  'cream_gold',
  'obsidian_orchid',
  ...Array.from(
    { length: 10 },
    (_, index) => `stylist_portrait_${String(index + 1).padStart(2, '0')}`,
  ),
];

test('all approved portraits retain stable IDs, order, and explicit voice profiles', () => {
  assert.equal(STYLIST_PORTRAIT_PRESETS.length, 10);
  assert.deepEqual(
    STYLIST_AVATAR_PRESETS.map((preset) => preset.id),
    EXPECTED_REGISTRY_IDS,
  );

  STYLIST_PORTRAIT_PRESETS.forEach((preset, index) => {
    const ordinal = index + 1;
    assert.equal(
      preset.id,
      `stylist_portrait_${String(ordinal).padStart(2, '0')}`,
    );
    assert.ok(['feminine', 'masculine'].includes(preset.voiceProfile));
    assert.equal(
      preset.voiceProfile,
      ordinal % 2 === 1 ? 'feminine' : 'masculine',
    );
  });
});

test('default Elise speaks while intentionally silent and unsupported avatars stay silent', () => {
  assert.equal(STYLIST_ABSTRACT_PRESETS.length, 6);
  assert.equal(getStylistVoiceProfile('elise_default'), 'feminine');
  for (const preset of STYLIST_ABSTRACT_PRESETS.filter(({ id }) => id !== 'elise_default')) {
    assert.equal(preset.voiceProfile, 'silent');
  }
  assert.equal(getStylistVoiceProfile('stylist_portrait_11'), 'silent');
  assert.equal(getStylistVoiceProfile('future_placeholder'), 'silent');
  assert.equal(getStylistVoiceProfile(null), 'silent');
});

test('mobile source remains provider-neutral', () => {
  const roots = ['app', 'components', 'constants', 'contexts', 'hooks', 'services', 'stores'];
  const forbidden = /api\.elevenlabs\.io|xi-api-key|ELEVENLABS_(?:FEMININE|MASCULINE)_VOICE_ID/;

  for (const root of roots) {
    const pending = [path.join(ROOT, root)];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(target);
        } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
          assert.doesNotMatch(fs.readFileSync(target, 'utf8'), forbidden, target);
        }
      }
    }
  }
});

test('Home and StyleChat continue to consume the same identity preset', () => {
  const home = fs.readFileSync(
    path.join(ROOT, 'components', 'home', 'HomeLuxuryTechV1.tsx'),
    'utf8',
  );
  const header = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
    'utf8',
  );

  assert.match(home, /useStylistIdentity\(\)/);
  assert.match(home, /identity=\{identity\}/);
  assert.match(header, /useStylistIdentity\(\)/);
  assert.match(header, /avatarId=\{identity\.avatarId\}/);
  assert.doesNotMatch(home, /STYLIST_AVATAR_PRESET_BY_ID\.get/);
  assert.doesNotMatch(header, /STYLIST_AVATAR_PRESET_BY_ID\.get/);
});
