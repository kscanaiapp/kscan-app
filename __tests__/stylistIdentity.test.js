// Stylist identity store, constants, validation, and persistence contract tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const stylistIdentityConstants = fs.readFileSync(path.join(ROOT, 'constants', 'stylistIdentity.ts'), 'utf8');
const stylistIdentityStore = fs.readFileSync(path.join(ROOT, 'stores', 'stylistIdentityStore.ts'), 'utf8');
const stylistIdentityHook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStylistIdentity.ts'), 'utf8');
const stylistIdentityService = fs.readFileSync(path.join(ROOT, 'services', 'stylistIdentityService.ts'), 'utf8');
const stylistAvatar = fs.readFileSync(path.join(ROOT, 'components', 'stylist', 'StylistAvatar.tsx'), 'utf8');
const personalizeModal = fs.readFileSync(path.join(ROOT, 'components', 'stylist', 'PersonalizeStylistModal.tsx'), 'utf8');
const homeStylistCard = fs.readFileSync(path.join(ROOT, 'components', 'home', 'HomeStylistCard.tsx'), 'utf8');
const homeV1 = fs.readFileSync(path.join(ROOT, 'components', 'home', 'HomeLuxuryTechV1.tsx'), 'utf8');
const userStylistPreferencesMigration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260713000001_user_stylist_preferences.sql'),
  'utf8',
);

const {
  DEFAULT_STYLIST_IDENTITY,
  STYLIST_AVATAR_PRESETS,
  sanitizeStylistName,
  normalizeStylistIdentity,
  resolveAvatarId,
  STYLIST_NAME_MAX_LENGTH,
  STYLIST_NAME_MIN_LENGTH,
} = require('../constants/stylistIdentity.ts');

// ── Constants / registry ─────────────────────────────────────────────────────

test('default stylist identity is stable and frozen', () => {
  assert.equal(DEFAULT_STYLIST_IDENTITY.displayName, 'Elise');
  assert.equal(DEFAULT_STYLIST_IDENTITY.avatarId, 'elise_default');
  assert.ok(Object.isFrozen(DEFAULT_STYLIST_IDENTITY));
});

test('avatar preset registry contains diverse local presets', () => {
  assert.ok(Array.isArray(STYLIST_AVATAR_PRESETS));
  assert.ok(STYLIST_AVATAR_PRESETS.length >= 4);
  const ids = STYLIST_AVATAR_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'avatar IDs must be unique');
  assert.ok(STYLIST_AVATAR_PRESETS.some((p) => p.id === 'elise_default'));
  for (const preset of STYLIST_AVATAR_PRESETS) {
    assert.ok(typeof preset.accessibilityLabel === 'string' && preset.accessibilityLabel.length > 0);
    assert.ok(typeof preset.backgroundColor === 'string');
    assert.ok(typeof preset.accentColor === 'string');
    assert.ok(typeof preset.symbol === 'string');
    assert.ok(typeof preset.symbolColor === 'string');
  }
});

test('registry uses static preset references and no dynamic require', () => {
  assert.doesNotMatch(stylistAvatar, /require\s*\(\s*`/);
  assert.doesNotMatch(stylistAvatar, /require\s*\(\s*['"]\.\.\/assets\/stylist\//);
  assert.match(stylistAvatar, /STYLIST_AVATAR_PRESETS\.find/);
});

test('avatar resolution falls back to default for unknown or missing IDs', () => {
  assert.equal(resolveAvatarId('elise_default'), 'elise_default');
  assert.equal(resolveAvatarId('unknown_avatar'), 'elise_default');
  assert.equal(resolveAvatarId(null), 'elise_default');
  assert.equal(resolveAvatarId(''), 'elise_default');
});

// ── Name validation ──────────────────────────────────────────────────────────

test('sanitizeStylistName trims whitespace and rejects control characters', () => {
  assert.equal(sanitizeStylistName('  Elise  ').value, 'Elise');
  assert.equal(sanitizeStylistName('Elise').valid, true);
  assert.equal(sanitizeStylistName('E').valid, false);
  assert.equal(sanitizeStylistName('').valid, false);
  assert.equal(sanitizeStylistName('   ').valid, false);
  assert.equal(sanitizeStylistName('A\x00B').value, 'AB');
  assert.equal(sanitizeStylistName('A\x7fB').value, 'AB');
});

test('sanitizeStylistName enforces min and max length', () => {
  const maxName = 'A'.repeat(STYLIST_NAME_MAX_LENGTH);
  assert.equal(sanitizeStylistName(maxName).valid, true);
  assert.equal(sanitizeStylistName(maxName + 'B').valid, false);
  assert.equal(sanitizeStylistName('A'.repeat(STYLIST_NAME_MIN_LENGTH - 1)).valid, false);
});

test('normalizeStylistIdentity returns default for invalid or missing data', () => {
  assert.equal(normalizeStylistIdentity(null), DEFAULT_STYLIST_IDENTITY);
  assert.equal(normalizeStylistIdentity({}), DEFAULT_STYLIST_IDENTITY);
  assert.equal(normalizeStylistIdentity({ display_name: 'A' }), DEFAULT_STYLIST_IDENTITY);
  assert.equal(normalizeStylistIdentity({ avatar_id: 'unknown' }), DEFAULT_STYLIST_IDENTITY);
  assert.equal(normalizeStylistIdentity({ display_name: '', avatar_id: '' }), DEFAULT_STYLIST_IDENTITY);
});

test('normalizeStylistIdentity returns default reference for default values', () => {
  const first = normalizeStylistIdentity({ display_name: 'Elise', avatar_id: 'elise_default' });
  const second = normalizeStylistIdentity({ display_name: 'Elise', avatar_id: 'elise_default' });
  assert.equal(first, second);
  assert.equal(first, DEFAULT_STYLIST_IDENTITY);

  const custom = normalizeStylistIdentity({ display_name: 'Sofia', avatar_id: 'editorial_plum' });
  assert.equal(custom.displayName, 'Sofia');
  assert.equal(custom.avatarId, 'editorial_plum');
  assert.ok(Object.isFrozen(custom));
});

// ── Persistence / migration contract ─────────────────────────────────────────

test('migration creates user_stylist_preferences with RLS and constraints', () => {
  assert.match(userStylistPreferencesMigration, /create table if not exists public\.user_stylist_preferences/);
  assert.match(userStylistPreferencesMigration, /user_id\s+uuid primary key references auth\.users\(id\) on delete cascade/);
  assert.match(userStylistPreferencesMigration, /display_name\s+text not null default 'Elise'/);
  assert.match(userStylistPreferencesMigration, /avatar_id\s+text not null default 'elise_default'/);
  assert.match(userStylistPreferencesMigration, /constraint display_name_length/);
  assert.match(userStylistPreferencesMigration, /constraint no_control_chars/);
  assert.match(userStylistPreferencesMigration, /alter table public\.user_stylist_preferences enable row level security/);
  assert.match(userStylistPreferencesMigration, /create policy "Users can select own stylist preferences"/);
  assert.match(userStylistPreferencesMigration, /create policy "Users can insert own stylist preferences"/);
  assert.match(userStylistPreferencesMigration, /create policy "Users can update own stylist preferences"/);
});

test('migration policies restrict access to the authenticated owner', () => {
  const selectPolicy = userStylistPreferencesMigration.match(
    /create policy "Users can select own stylist preferences"[\s\S]*?;/,
  )?.[0];
  assert.ok(selectPolicy);
  assert.match(selectPolicy, /auth\.uid\(\)\s*=\s*user_id/);

  const updatePolicy = userStylistPreferencesMigration.match(
    /create policy "Users can update own stylist preferences"[\s\S]*?;/,
  )?.[0];
  assert.ok(updatePolicy);
  assert.match(updatePolicy, /using \(auth\.uid\(\) = user_id\)/);
  assert.match(updatePolicy, /with check \(auth\.uid\(\) = user_id\)/);
});

test('service derives user from session and normalizes identity', () => {
  assert.match(stylistIdentityService, /import\s*\{\s*supabase\s*\}\s*from/);
  assert.match(stylistIdentityService, /from ['"]\.\/supabaseClient['"]/);
  assert.match(stylistIdentityService, /async function requireUserId/);
  assert.match(stylistIdentityService, /export async function fetchStylistIdentity/);
  assert.match(stylistIdentityService, /export async function saveStylistIdentity/);
  assert.match(stylistIdentityService, /normalizeStylistIdentity\(data\)/);
});

// ── Store reference stability ────────────────────────────────────────────────

test('store snapshot reference is stable when identity data is unchanged', async () => {
  const storeModulePath = path.join(ROOT, 'stores', 'stylistIdentityStore.ts');

  // Mock the service layer so the store can run in Node without React Native deps.
  const fetchMock = () => Promise.resolve(DEFAULT_STYLIST_IDENTITY);
  const saveMock = () => Promise.resolve(DEFAULT_STYLIST_IDENTITY);

  const module = {
    mock: {
      '../services/stylistIdentityService': {
        fetchStylistIdentity: fetchMock,
        saveStylistIdentity: saveMock,
      },
    },
  };

  const ts = require('typescript');
  const source = fs.readFileSync(storeModulePath, 'utf8')
    .replace("import { fetchStylistIdentity, saveStylistIdentity } from '../services/stylistIdentityService';", '')
    .replace(/fetchStylistIdentity/g, 'fetchMock')
    .replace(/saveStylistIdentity/g, 'saveMock');

  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const mod = { exports: {} };
  const vm = require('node:vm');
  const constantsModule = require('../constants/stylistIdentity.ts');
  const sandbox = {
    __DEV__: false, console, Date, exports: mod.exports, module: mod,
    fetchMock,
    saveMock,
    require: (spec) => {
      if (spec === '../constants/stylistIdentity') return constantsModule;
      if (spec === '../services/stylistIdentityService') return { fetchStylistIdentity: fetchMock, saveStylistIdentity: saveMock };
      throw new Error(`Unexpected import in store test: ${spec}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: storeModulePath }).runInContext(sandbox);
  const store = mod.exports;

  const snap1 = store.getStylistIdentitySnapshot();
  const snap2 = store.getStylistIdentitySnapshot();
  assert.equal(snap1, snap2);

  // Setting the same identity reference should be a no-op.
  let emissions = 0;
  const unsubscribe = store.subscribeToStylistIdentity(() => { emissions += 1; });
  store.setStylistIdentityState({ identity: snap1 });
  assert.equal(emissions, 0);

  // Setting a new identity with different data should emit and change reference.
  const custom = Object.freeze({ displayName: 'Sofia', avatarId: 'editorial_plum' });
  store.setStylistIdentityState({ identity: custom });
  assert.equal(emissions, 1);
  assert.equal(store.getStylistIdentitySnapshot(), custom);

  // Re-setting the same custom reference should not emit again.
  store.setStylistIdentityState({ identity: custom });
  assert.equal(emissions, 1);

  // Resetting restores the stable default reference.
  store.resetStylistIdentityStore();
  assert.equal(store.getStylistIdentitySnapshot(), DEFAULT_STYLIST_IDENTITY);

  unsubscribe();
});

// ── Hook integration ─────────────────────────────────────────────────────────

test('identity hook uses useSyncExternalStore for stable snapshots', () => {
  assert.match(stylistIdentityHook, /useSyncExternalStore/);
  assert.match(stylistIdentityHook, /getStylistIdentitySnapshot/);
  assert.match(stylistIdentityHook, /subscribeToStylistIdentity/);
  assert.match(stylistIdentityHook, /updateIdentity: update/);
  assert.match(stylistIdentityHook, /resetIdentity: reset/);
  assert.match(stylistIdentityHook, /resetStylistIdentityStore\(\)/);
});

// ── UI wiring ────────────────────────────────────────────────────────────────

test('Home stylist card receives identity props and supports personalization', () => {
  assert.match(homeStylistCard, /interface HomeStylistCardProps/);
  assert.match(homeStylistCard, /identity: StylistIdentity/);
  assert.match(homeStylistCard, /identity\.displayName/);
  assert.match(homeStylistCard, /identity\.avatarId/);
  assert.match(homeStylistCard, /onPersonalize/);
  assert.match(homeStylistCard, /Personalize/);
  assert.match(homeStylistCard, /YOUR STYLIST/);
  assert.match(homeStylistCard, /Ask \{displayName\}/);
  assert.match(homeStylistCard, /START A CONVERSATION/);
  assert.match(homeStylistCard, /CONTINUE CONVERSATION/);
});

test('Home integrates stylist card, Recent Scans tile, and no carousel', () => {
  const heroIndex = homeV1.indexOf('<View style={styles.heroCard}>');
  const stylistIndex = homeV1.indexOf('<HomeStylistCard');
  const stylePicksIndex = homeV1.indexOf('STYLE PICKS FOR YOU');
  const featureGridIndex = homeV1.indexOf('featuresRow');

  assert.ok(heroIndex > 0);
  assert.ok(stylistIndex > heroIndex, 'stylist card must follow scan hero');
  assert.ok(stylePicksIndex > stylistIndex, 'style picks must follow stylist card');
  assert.ok(featureGridIndex > stylePicksIndex, 'feature grid must follow style picks');
  assert.doesNotMatch(homeV1, /<SavedLookCard/, 'full Recent Scans carousel must be absent from Home');

  assert.match(homeV1, /home-luxury-feature-recent-scans/);
  assert.doesNotMatch(homeV1, /title="ASK ELISE"/);
  assert.doesNotMatch(homeV1, /AI STYLIST/);
});

test('personalize modal allows editing display name and avatar', () => {
  assert.match(personalizeModal, /PERSONALIZE YOUR STYLIST/);
  assert.match(personalizeModal, /DISPLAY NAME/);
  assert.match(personalizeModal, /AVATAR/);
  assert.match(personalizeModal, /SAVE/);
  assert.match(personalizeModal, /RESTORE DEFAULT/);
  assert.match(personalizeModal, /CANCEL/);
  assert.match(personalizeModal, /STYLIST_AVATAR_PRESETS/);
  assert.match(personalizeModal, /StylistAvatar/);
});
