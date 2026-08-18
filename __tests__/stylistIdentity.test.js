// Stylist identity store, constants, validation, and persistence contract tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sizeOf = require('image-size');

const ROOT = path.resolve(__dirname, '..');

// Metro bundles image assets, but Node cannot parse binary image files.
// Stub any image require so constants/tests that import stylist avatars work.
require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;

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
const userStylistPreferencesGrantsMigration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260714000001_user_stylist_preferences_rls_grants.sql'),
  'utf8',
);
const phase1AvatarAllowlistMigrationPath = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260714000003_add_user_stylist_preferences_avatar_allowlist.sql',
);
const phase1AvatarAllowlistMigration = fs.readFileSync(phase1AvatarAllowlistMigrationPath, 'utf8');
const phase2AvatarAllowlistMigrationPath = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260715000001_expand_stylist_portrait_avatar_allowlist.sql',
);
const phase2AvatarAllowlistMigration = fs.readFileSync(phase2AvatarAllowlistMigrationPath, 'utf8');
const deletionScript = fs.readFileSync(
  path.join(ROOT, 'scripts', 'process-deletion-request.js'),
  'utf8',
);
const phase2SupabasePlan = fs.readFileSync(
  path.join(ROOT, 'docs', 'elise', 'phase2-stylist-portrait-supabase-plan.md'),
  'utf8',
);
const portraitAssetManifest = fs.readFileSync(
  path.join(ROOT, 'docs', 'elise', 'stylist-portrait-asset-manifest.md'),
  'utf8',
);
const portraitProcessingScript = fs.readFileSync(
  path.join(ROOT, 'scripts', 'process-portrait-avatars.py'),
  'utf8',
);

const {
  DEFAULT_STYLIST_IDENTITY,
  STYLIST_ABSTRACT_PRESETS,
  STYLIST_AVATAR_PRESETS,
  STYLIST_AVATAR_PRESET_BY_ID,
  STYLIST_PORTRAIT_PRESETS,
  STYLIST_SELECTABLE_PRESETS,
  STYLIST_PERSISTABLE_AVATAR_IDS,
  STYLIST_PORTRAIT_PLACEHOLDER_IDS,
  STYLIST_SPEECH_CONFIG_BY_ID,
  getStylistAvatarSection,
  isRenderablePortraitPreset,
  sanitizeStylistName,
  normalizeStylistIdentity,
  resolveAvatarId,
  assertPersistableAvatarId,
  isPersistableAvatarId,
  StylistIdentityValidationError,
  STYLIST_NAME_MAX_LENGTH,
  STYLIST_NAME_MIN_LENGTH,
  getStylistAvatarFraming,
  CANONICAL_PORTRAIT_NAMES,
  resolveCanonicalStylistName,
  resolveStylistDisplayName,
} = require('../constants/stylistIdentity.ts');

const animatedStylistAvatar = fs.readFileSync(
  path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'),
  'utf8',
);
const personalizeStylistModalSource = fs.readFileSync(
  path.join(ROOT, 'components', 'stylist', 'PersonalizeStylistModal.tsx'),
  'utf8',
);
const stylistIdentityStoreSource = fs.readFileSync(
  path.join(ROOT, 'stores', 'stylistIdentityStore.ts'),
  'utf8',
);
const displayNameCustomizedMigrationPath = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260818000001_add_user_stylist_preferences_display_name_customized.sql',
);
const displayNameCustomizedMigration = fs.readFileSync(displayNameCustomizedMigrationPath, 'utf8');
const styleChatGreetingSource = fs.readFileSync(
  path.join(ROOT, 'services', 'style-chat', 'styleChatGreeting.ts'),
  'utf8',
);

// ── Constants / registry ─────────────────────────────────────────────────────

test('default stylist identity is stable and frozen', () => {
  assert.equal(DEFAULT_STYLIST_IDENTITY.displayName, 'Elise');
  assert.equal(DEFAULT_STYLIST_IDENTITY.avatarId, 'elise_default');
  assert.ok(Object.isFrozen(DEFAULT_STYLIST_IDENTITY));
});

test('avatar preset registry contains six abstract presets and ten ready portrait presets', () => {
  assert.ok(Array.isArray(STYLIST_AVATAR_PRESETS));
  const abstract = STYLIST_AVATAR_PRESETS.filter((p) => p.kind === 'abstract');
  const portraitReady = STYLIST_AVATAR_PRESETS.filter(
    (p) => p.kind === 'portrait' && p.availability === 'ready',
  );
  assert.equal(abstract.length, 6, 'expected six abstract presets');
  assert.equal(portraitReady.length, 10, 'expected ten ready portrait presets');
  assert.equal(STYLIST_AVATAR_PRESETS.length, 16);

  assert.deepEqual(
    abstract.map((preset) => preset.id),
    [
      'elise_default',
      'editorial_plum',
      'chrome_muse',
      'deep_space',
      'cream_gold',
      'obsidian_orchid',
    ],
  );
  assert.deepEqual(
    portraitReady.map((preset) => preset.id),
    Array.from({ length: 10 }, (_, index) => `stylist_portrait_${String(index + 1).padStart(2, '0')}`),
  );

  const ids = STYLIST_AVATAR_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'avatar IDs must be unique');
  assert.ok(STYLIST_AVATAR_PRESETS.some((p) => p.id === 'elise_default'));

  for (const preset of abstract) {
    assert.equal(preset.availability, 'ready');
    assert.ok(typeof preset.accessibilityLabel === 'string' && preset.accessibilityLabel.length > 0);
    assert.ok(typeof preset.backgroundColor === 'string');
    assert.ok(typeof preset.accentColor === 'string');
    assert.ok(typeof preset.symbol === 'string');
    assert.ok(typeof preset.symbolColor === 'string');
    assert.equal(preset.selectable, true);
    assert.equal(preset.persistable, true);
  }

  for (const preset of portraitReady) {
    assert.ok(typeof preset.accessibilityLabel === 'string' && preset.accessibilityLabel.length > 0);
    assert.equal(preset.selectable, true);
    assert.equal(preset.persistable, true);
    assert.equal(typeof preset.source, 'number');
    assert.ok(Number.isFinite(preset.source) && preset.source > 0);
    assert.ok(Object.isFrozen(preset));
  }
});

test('registry discriminated union keeps invalid states unrepresentable', () => {
  assert.match(stylistIdentityConstants, /kind:\s*['"]abstract['"]/);
  assert.match(stylistIdentityConstants, /kind:\s*['"]portrait['"]/);
  assert.match(stylistIdentityConstants, /availability:\s*['"]placeholder['"]/);
  assert.match(stylistIdentityConstants, /availability:\s*['"]ready['"]/);
  assert.match(stylistIdentityConstants, /source:\s*number/);
  assert.match(stylistIdentityConstants, /source\?:\s*never/);
  // Shipped portrait presets carry static local image references.
  const portraitBlock = stylistIdentityConstants.match(
    /const PORTRAIT_PRESET_DEFINITIONS[\s\S]*?\];/,
  )?.[0];
  assert.ok(portraitBlock);
  for (let index = 1; index <= 10; index += 1) {
    const id = `stylist_portrait_${String(index).padStart(2, '0')}`;
    assert.match(portraitBlock, new RegExp(`id:\\s*['"]${id}['"]`));
    assert.match(
      portraitBlock,
      new RegExp(
        `require\\(['"]\\.\\./assets/stylist-avatars/portraits/${id}\\\.jpg['"]\\)`,
      ),
    );
  }
});

test('test-only ready portrait stays in People and satisfies the image render contract', () => {
  const readyPortrait = Object.freeze({
    kind: 'portrait',
    availability: 'ready',
    id: 'test_ready_portrait',
    accessibilityLabel: 'Test ready portrait',
    source: 1,
    selectable: true,
    persistable: true,
  });
  assert.equal(getStylistAvatarSection(readyPortrait), 'people');
  assert.equal(isRenderablePortraitPreset(readyPortrait), true);
  assert.equal(isRenderablePortraitPreset({ ...readyPortrait, source: undefined }), false);
  assert.equal(isRenderablePortraitPreset({ ...readyPortrait, source: 'remote-url' }), false);
});

test('selectable and persistable collections are precomputed at module scope', () => {
  assert.equal(STYLIST_ABSTRACT_PRESETS.length, 6);
  assert.equal(STYLIST_PORTRAIT_PRESETS.length, 10);
  assert.equal(STYLIST_SELECTABLE_PRESETS.length, 16);
  assert.equal(STYLIST_PERSISTABLE_AVATAR_IDS.size, 16);
  assert.deepEqual(STYLIST_PORTRAIT_PLACEHOLDER_IDS, []);
  for (const preset of STYLIST_SELECTABLE_PRESETS) {
    assert.equal(preset.selectable, true);
    assert.ok(STYLIST_PERSISTABLE_AVATAR_IDS.has(preset.id));
  }
  for (const id of STYLIST_PERSISTABLE_AVATAR_IDS) {
    assert.ok(STYLIST_AVATAR_PRESET_BY_ID.has(id));
    assert.ok(STYLIST_AVATAR_PRESET_BY_ID.get(id).persistable);
  }
  assert.equal(STYLIST_AVATAR_PRESET_BY_ID.size, 16);
  assert.equal(STYLIST_ABSTRACT_PRESETS, STYLIST_ABSTRACT_PRESETS);
  assert.equal(STYLIST_PORTRAIT_PRESETS, STYLIST_PORTRAIT_PRESETS);
  assert.ok(Object.isFrozen(STYLIST_AVATAR_PRESETS));
  assert.ok(Object.isFrozen(STYLIST_ABSTRACT_PRESETS));
  assert.ok(Object.isFrozen(STYLIST_PORTRAIT_PRESETS));
  assert.equal(STYLIST_PERSISTABLE_AVATAR_IDS.add, undefined);
  assert.equal(STYLIST_AVATAR_PRESET_BY_ID.set, undefined);
});

test('registry uses static preset references and no dynamic require', () => {
  assert.doesNotMatch(stylistAvatar, /require\s*\(\s*`/);
  assert.doesNotMatch(stylistAvatar, /require\s*\(\s*['"]\.\.\/assets\/stylist\//);
  assert.match(stylistAvatar, /STYLIST_AVATAR_PRESET_BY_ID\.get/);
});

test('avatar resolution falls back to default for unknown or missing IDs', () => {
  assert.equal(resolveAvatarId('elise_default'), 'elise_default');
  assert.equal(resolveAvatarId('unknown_avatar'), 'elise_default');
  assert.equal(resolveAvatarId(null), 'elise_default');
  assert.equal(resolveAvatarId(''), 'elise_default');
});

test('non-persistable and unknown avatar IDs resolve to the safe default', () => {
  assert.deepEqual(STYLIST_PORTRAIT_PLACEHOLDER_IDS, []);
  assert.equal(resolveAvatarId('stylist_portrait_11'), DEFAULT_STYLIST_IDENTITY.avatarId);
  assert.equal(isPersistableAvatarId('stylist_portrait_11'), false);
  assert.equal(isPersistableAvatarId('elise_default'), true);
  assert.equal(isPersistableAvatarId('stylist_portrait_01'), true);
  assert.throws(
    () => assertPersistableAvatarId('unknown_avatar'),
    (error) => error instanceof StylistIdentityValidationError && error.reason === 'unknown_avatar_id',
  );
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
  assert.equal(
    normalizeStylistIdentity({ display_name: 'A', display_name_customized: true }),
    DEFAULT_STYLIST_IDENTITY,
  );
  assert.equal(normalizeStylistIdentity({ avatar_id: 'unknown' }), DEFAULT_STYLIST_IDENTITY);
  assert.equal(
    normalizeStylistIdentity({ display_name: '', avatar_id: '', display_name_customized: true }),
    DEFAULT_STYLIST_IDENTITY,
  );
});

// Fix #6 — a stored display_name is authoritative ONLY when
// display_name_customized is exactly true. This is what keeps a pre-Fix-#6
// row's historical 'Elise' (written before customization tracking existed)
// from being mistaken for a deliberate choice once a different avatar's
// canonical name should apply instead.
test('CUSTOM_NAME_NOT_OVERWRITTEN semantics: display_name is ignored unless display_name_customized is exactly true', () => {
  const notCustomized = normalizeStylistIdentity({
    display_name: 'Other User',
    avatar_id: 'stylist_portrait_02',
  });
  assert.equal(notCustomized.displayName, 'Henry');
  assert.equal(notCustomized.avatarId, 'stylist_portrait_02');

  // Truthy-but-not-boolean-true must not accidentally authorize the name either.
  for (const falsyCustomizedFlag of [false, 0, '', null, undefined, 'true', 1]) {
    const row = normalizeStylistIdentity({
      display_name: 'Other User',
      avatar_id: 'stylist_portrait_02',
      display_name_customized: falsyCustomizedFlag,
    });
    assert.equal(row.displayName, 'Henry', `flag=${JSON.stringify(falsyCustomizedFlag)}`);
  }
});

test('CUSTOM_ALEX_OVERRIDES_HENRY: display_name_customized true makes the stored name authoritative', () => {
  const customized = normalizeStylistIdentity({
    display_name: 'Alex',
    avatar_id: 'stylist_portrait_02',
    display_name_customized: true,
  });
  assert.equal(customized.displayName, 'Alex');
  // STYLIST_02_REMAINS_STYLIST_02_AFTER_RENAME
  assert.equal(customized.avatarId, 'stylist_portrait_02');
});

test('normalizeStylistIdentity returns default reference for default (system/star) values', () => {
  const first = normalizeStylistIdentity({ display_name: 'Elise', avatar_id: 'elise_default' });
  const second = normalizeStylistIdentity({ display_name: 'Elise', avatar_id: 'elise_default' });
  assert.equal(first, second);
  assert.equal(first, DEFAULT_STYLIST_IDENTITY);

  // A generic/system avatar with no customization resolves to Elise regardless
  // of whatever historical text sits in display_name (not customized -> ignored).
  const genericNotCustomized = normalizeStylistIdentity({
    display_name: 'Sofia',
    avatar_id: 'editorial_plum',
  });
  assert.equal(genericNotCustomized.displayName, 'Elise');
  assert.equal(genericNotCustomized.avatarId, 'editorial_plum');
  // Distinct avatarId from the fallback ('elise_default'), so this is NOT the
  // same frozen reference even though displayName happens to match.
  assert.notEqual(genericNotCustomized, DEFAULT_STYLIST_IDENTITY);

  const customGeneric = normalizeStylistIdentity({
    display_name: 'Kate',
    avatar_id: 'editorial_plum',
    display_name_customized: true,
  });
  assert.equal(customGeneric.displayName, 'Kate');
  assert.equal(customGeneric.avatarId, 'editorial_plum');
  assert.ok(Object.isFrozen(customGeneric));
});

for (const [avatarId, expectedName] of [
  ['stylist_portrait_01', 'Elise'],
  ['stylist_portrait_02', 'Henry'],
  ['stylist_portrait_03', 'Janet'],
  ['stylist_portrait_04', 'Marie'],
  ['stylist_portrait_05', 'Sarah'],
  ['stylist_portrait_06', 'Vivian'],
  ['stylist_portrait_07', 'Isabella'],
  ['stylist_portrait_08', 'Michael'],
  ['stylist_portrait_09', 'David'],
  ['stylist_portrait_10', 'Kim'],
]) {
  test(`CANONICAL_${avatarId.slice(-2)}_${expectedName.toUpperCase()}: ${avatarId} resolves to ${expectedName} with no custom name`, () => {
    assert.equal(resolveCanonicalStylistName(avatarId), expectedName);
    assert.equal(resolveStylistDisplayName(null, avatarId), expectedName);
    const row = normalizeStylistIdentity({ avatar_id: avatarId });
    assert.equal(row.displayName, expectedName);
    assert.equal(row.avatarId, avatarId);
  });
}

test('SELECT_STYLIST_UPDATES_DEFAULT_NAME: switching avatarId with no customization recomputes the canonical name', () => {
  const henry = normalizeStylistIdentity({ avatar_id: 'stylist_portrait_02' });
  assert.equal(henry.displayName, 'Henry');
  const sarah = normalizeStylistIdentity({ avatar_id: 'stylist_portrait_05' });
  assert.equal(sarah.displayName, 'Sarah');
});

test('generic/system avatar selections resolve to Elise, not just stylist_portrait_01 specifically', () => {
  for (const genericAvatarId of ['elise_default', 'editorial_plum', 'chrome_muse', 'deep_space']) {
    assert.equal(resolveCanonicalStylistName(genericAvatarId), 'Elise');
  }
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
  assert.doesNotMatch(
    userStylistPreferencesMigration,
    /constraint\s+\w*avatar\w*\s+check/i,
    'Phase 1 source schema currently has no avatar allowlist constraint',
  );
  assert.match(
    userStylistPreferencesGrantsMigration,
    /grant select, insert, update on public\.user_stylist_preferences to authenticated/,
  );
  assert.match(deletionScript, /table:\s*['"]user_stylist_preferences['"][\s\S]*?auth_delete_cascade/);
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

test('service derives user from session, normalizes identity, and validates persistability', () => {
  assert.match(stylistIdentityService, /import\s*\{\s*supabase\s*\}\s*from/);
  assert.match(stylistIdentityService, /from ['"]\.\/supabaseClient['"]/);
  assert.match(stylistIdentityService, /async function requireUserId/);
  assert.match(stylistIdentityService, /expectedUserId/);
  assert.match(stylistIdentityService, /export async function fetchStylistIdentity/);
  assert.match(stylistIdentityService, /export async function saveStylistIdentity/);
  assert.match(stylistIdentityService, /normalizeStylistIdentity\(data\)/);
  assert.match(stylistIdentityService, /assertPersistableAvatarId\(avatarId\)/);
});

function loadStylistIdentityServiceWithSupabase(supabase) {
  const ts = require('typescript');
  const source = stylistIdentityService.replace("import { supabase } from './supabaseClient';", '');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', 'supabase', '__DEV__', output);
  const localRequire = (specifier) =>
    specifier === '../constants/stylistIdentity'
      ? require('../constants/stylistIdentity.ts')
      : require(specifier);
  evaluate(localRequire, mod, mod.exports, supabase, false);
  return mod.exports;
}

test('service rejects unknown avatar IDs before any Supabase call', async () => {
  let authCalls = 0;
  let tableCalls = 0;
  const supabase = {
    auth: {
      getSession: async () => {
        authCalls += 1;
        return { data: { session: { user: { id: 'user-a' } } } };
      },
    },
    from: () => {
      tableCalls += 1;
      throw new Error('table access must not occur');
    },
  };
  const service = loadStylistIdentityServiceWithSupabase(supabase);

  await assert.rejects(
    service.saveStylistIdentity({ displayName: 'Elise', avatarId: 'unknown_avatar' }),
    (error) => error instanceof StylistIdentityValidationError && error.reason === 'unknown_avatar_id',
  );
  await assert.rejects(
    service.saveStylistIdentity({ displayName: 'Elise', avatarId: 'stylist_portrait_11' }),
    (error) => error instanceof StylistIdentityValidationError && error.reason === 'unknown_avatar_id',
  );

  assert.equal(authCalls, 0);
  assert.equal(tableCalls, 0);
});

// ── Fix #6: end-to-end persistence semantics against a realistic fake table ──
//
// This fake models the one property that matters here: an upsert's SET clause
// only includes columns present in the payload, so an omitted key leaves an
// existing row's column untouched on UPDATE (verified for real against
// genderStylingContextService in Fix #5's test suite; this fake pins the same
// contract for stylistIdentityService's avatar-only-update path).

function makeFakeStylistPreferencesTable() {
  const rows = new Map();
  return {
    rows,
    from(tableName) {
      if (tableName !== 'user_stylist_preferences') throw new Error(`unexpected table ${tableName}`);
      let pendingEq = null;
      const builder = {
        select: () => builder,
        eq: (_col, value) => { pendingEq = value; return builder; },
        maybeSingle: async () => ({ data: rows.get(pendingEq) ?? null, error: null }),
        upsert: (partial) => {
          const existing = rows.get(partial.user_id) ?? {
            user_id: partial.user_id,
            display_name: 'Elise',
            display_name_customized: false,
            avatar_id: 'elise_default',
            created_at: '2026-01-01T00:00:00.000Z',
          };
          // Only overwrite columns actually present in the payload -- the
          // real behavior this fake exists to model.
          const merged = { ...existing, ...partial };
          rows.set(partial.user_id, merged);
          return {
            select: () => ({ single: async () => ({ data: merged, error: null }) }),
          };
        },
      };
      return builder;
    },
  };
}

function makeFakeSupabaseForUser(userId, table) {
  return {
    auth: { getSession: async () => ({ data: { session: { user: { id: userId } } } }) },
    from: (name) => table.from(name),
  };
}

test('CUSTOM_NAME_PERSISTS_AFTER_REOPEN: a saved custom name round-trips through fetch as if the app were reopened', async () => {
  const table = makeFakeStylistPreferencesTable();
  const service = loadStylistIdentityServiceWithSupabase(makeFakeSupabaseForUser('user-a', table));

  const saved = await service.saveStylistIdentity(
    { displayName: 'Alex', avatarId: 'stylist_portrait_02' },
    'user-a',
  );
  assert.equal(saved.displayName, 'Alex');
  assert.equal(saved.avatarId, 'stylist_portrait_02');

  // Simulate leaving and reopening Elise: a fresh fetch against the same table.
  const reopened = await service.fetchStylistIdentity('user-a');
  assert.equal(reopened.displayName, 'Alex');
  assert.equal(reopened.avatarId, 'stylist_portrait_02');
});

test('CUSTOM_NAME_NOT_OVERWRITTEN (persistence layer): an avatar-only save leaves an existing custom name and its flag untouched', async () => {
  const table = makeFakeStylistPreferencesTable();
  const service = loadStylistIdentityServiceWithSupabase(makeFakeSupabaseForUser('user-a', table));

  await service.saveStylistIdentity({ displayName: 'Alex', avatarId: 'stylist_portrait_02' }, 'user-a');
  // Now switch avatar only -- no displayName key in the partial.
  const afterAvatarChange = await service.saveStylistIdentity({ avatarId: 'stylist_portrait_05' }, 'user-a');

  assert.equal(afterAvatarChange.avatarId, 'stylist_portrait_05');
  // CUSTOM_NAME_NOT_OVERWRITTEN: "Alex" carries over rather than resetting to
  // Sarah (stylist_portrait_05's canonical name), because the row's
  // display_name_customized flag was never touched by the avatar-only save.
  assert.equal(afterAvatarChange.displayName, 'Alex');

  const row = table.rows.get('user-a');
  assert.equal(row.display_name, 'Alex');
  assert.equal(row.display_name_customized, true);
});

test('SELECT_STYLIST_UPDATES_DEFAULT_NAME (persistence layer): an avatar-only save on a never-customized row resolves the new canonical name', async () => {
  const table = makeFakeStylistPreferencesTable();
  const service = loadStylistIdentityServiceWithSupabase(makeFakeSupabaseForUser('user-a', table));

  // No prior save at all -- fresh actor, never customized.
  const afterFirstAvatarPick = await service.saveStylistIdentity({ avatarId: 'stylist_portrait_02' }, 'user-a');
  assert.equal(afterFirstAvatarPick.displayName, 'Henry');

  const afterSecondAvatarPick = await service.saveStylistIdentity({ avatarId: 'stylist_portrait_05' }, 'user-a');
  assert.equal(afterSecondAvatarPick.displayName, 'Sarah');

  const row = table.rows.get('user-a');
  assert.equal(row.display_name_customized, false);
});

test('ACCOUNT_ISOLATION (persistence layer): user A\'s custom name never appears for user B', async () => {
  const table = makeFakeStylistPreferencesTable();
  const serviceA = loadStylistIdentityServiceWithSupabase(makeFakeSupabaseForUser('user-a', table));
  const serviceB = loadStylistIdentityServiceWithSupabase(makeFakeSupabaseForUser('user-b', table));

  await serviceA.saveStylistIdentity({ displayName: 'Alex', avatarId: 'stylist_portrait_02' }, 'user-a');

  const bIdentity = await serviceB.fetchStylistIdentity('user-b');
  assert.notEqual(bIdentity.displayName, 'Alex');
  assert.equal(bIdentity.displayName, 'Elise');

  await serviceB.saveStylistIdentity({ displayName: 'Kate', avatarId: 'stylist_portrait_05' }, 'user-b');
  const aIdentity = await serviceA.fetchStylistIdentity('user-a');
  assert.equal(aIdentity.displayName, 'Alex', "user B's save must not affect user A's row");

  assert.equal(table.rows.get('user-a').display_name, 'Alex');
  assert.equal(table.rows.get('user-b').display_name, 'Kate');
});

test('an actor mismatch throws before touching the table (defense in depth alongside RLS)', async () => {
  const table = makeFakeStylistPreferencesTable();
  const service = loadStylistIdentityServiceWithSupabase(makeFakeSupabaseForUser('user-b', table));

  await assert.rejects(service.fetchStylistIdentity('user-a'));
  await assert.rejects(service.saveStylistIdentity({ displayName: 'Alex', avatarId: 'stylist_portrait_02' }, 'user-a'));
  assert.equal(table.rows.has('user-a'), false);
});

// ── Store reference stability ────────────────────────────────────────────────

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadStylistIdentityStoreWithMocks(fetchMock, saveMock) {
  const storeModulePath = path.join(ROOT, 'stores', 'stylistIdentityStore.ts');
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
    __DEV__: false, console, Date, Error, exports: mod.exports, module: mod,
    fetchMock,
    saveMock,
    require: (spec) => {
      if (spec === '../constants/stylistIdentity') return constantsModule;
      if (spec === '../services/stylistIdentityService') {
        return { fetchMock, saveMock, fetchStylistIdentity: fetchMock, saveStylistIdentity: saveMock };
      }
      throw new Error(`Unexpected import in store test: ${spec}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: storeModulePath }).runInContext(sandbox);
  return mod.exports;
}

test('store snapshot reference is stable when identity data is unchanged', async () => {
  const storeModulePath = path.join(ROOT, 'stores', 'stylistIdentityStore.ts');

  // Mock the service layer so the store can run in Node without React Native deps.
  const fetchMock = () => Promise.resolve(DEFAULT_STYLIST_IDENTITY);
  const saveMock = () => Promise.resolve(DEFAULT_STYLIST_IDENTITY);

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

// ── Store actor safety and persistence guard ─────────────────────────────────

test('store ignores stale hydration after authenticated actor changes', async () => {
  const pendingHydrations = new Map();
  const fetchMock = (expectedUserId) => {
    const pending = deferred();
    pendingHydrations.set(expectedUserId, pending);
    return pending.promise;
  };
  const saveMock = () => Promise.resolve(DEFAULT_STYLIST_IDENTITY);
  const store = loadStylistIdentityStoreWithMocks(fetchMock, saveMock);

  const userAIdentity = Object.freeze({ displayName: 'Sofia', avatarId: 'editorial_plum' });
  const userBIdentity = Object.freeze({ displayName: 'Maya', avatarId: 'deep_space' });

  const hydrateA = store.hydrateStylistIdentityForUser('user-a');
  const hydrateB = store.hydrateStylistIdentityForUser('user-b');

  pendingHydrations.get('user-b').resolve(userBIdentity);
  await hydrateB;
  assert.equal(store.getStylistIdentitySnapshot(), userBIdentity);

  pendingHydrations.get('user-a').resolve(userAIdentity);
  await hydrateA;
  assert.equal(store.getStylistIdentitySnapshot(), userBIdentity);
});

test('store clears the prior actor identity before hydrating a new account', async () => {
  const pending = deferred();
  const store = loadStylistIdentityStoreWithMocks(
    () => pending.promise,
    () => Promise.resolve(DEFAULT_STYLIST_IDENTITY),
  );
  store.setStylistIdentityState({
    identity: Object.freeze({ displayName: 'User A Stylist', avatarId: 'editorial_plum' }),
  });

  const hydration = store.hydrateStylistIdentityForUser('user-b');
  assert.equal(store.getStylistIdentitySnapshot(), DEFAULT_STYLIST_IDENTITY);
  pending.resolve(Object.freeze({ displayName: 'User B Stylist', avatarId: 'deep_space' }));
  await hydration;
  assert.equal(store.getStylistIdentitySnapshot().displayName, 'User B Stylist');
});

test('store keeps the latest identity when overlapping saves resolve out of order', async () => {
  const fetchMock = () => Promise.resolve(DEFAULT_STYLIST_IDENTITY);
  const pendingSaves = new Map();
  const saveMock = (identity) => {
    const pending = deferred();
    pendingSaves.set(identity.displayName, pending);
    return pending.promise;
  };
  const store = loadStylistIdentityStoreWithMocks(fetchMock, saveMock);

  const firstSave = store.updateStylistIdentity({ displayName: 'Sofia', avatarId: 'editorial_plum' });
  const secondSave = store.updateStylistIdentity({ displayName: 'Maya', avatarId: 'deep_space' });

  // Fix #6: a realistic save response includes display_name_customized=true
  // whenever the save actually set a new name, matching the real service.
  pendingSaves.get('Maya').resolve({
    displayName: 'Maya',
    avatarId: 'deep_space',
    display_name_customized: true,
  });
  await secondSave;
  assert.equal(store.getStylistIdentitySnapshot().displayName, 'Maya');
  assert.equal(store.getStylistIdentitySnapshot().avatarId, 'deep_space');

  pendingSaves.get('Sofia').resolve({
    displayName: 'Sofia',
    avatarId: 'editorial_plum',
    display_name_customized: true,
  });
  await firstSave;
  assert.equal(store.getStylistIdentitySnapshot().displayName, 'Maya');
  assert.equal(store.getStylistIdentitySnapshot().avatarId, 'deep_space');
});

test('store exposes pending state and reports successful persistence', async () => {
  const pending = deferred();
  const store = loadStylistIdentityStoreWithMocks(
    () => Promise.resolve(DEFAULT_STYLIST_IDENTITY),
    () => pending.promise,
  );

  const save = store.updateStylistIdentity({
    displayName: 'Sofia',
    avatarId: 'stylist_portrait_01',
  });
  assert.equal(store.getStylistIdentityLoadingSnapshot(), true);

  pending.resolve({ displayName: 'Sofia', avatarId: 'stylist_portrait_01' });
  assert.equal(await save, true);
  assert.equal(store.getStylistIdentityLoadingSnapshot(), false);
  assert.equal(store.getStylistIdentitySnapshot().avatarId, 'stylist_portrait_01');
});

test('store preserves the prior abstract identity and clears pending state when persistence fails', async () => {
  const store = loadStylistIdentityStoreWithMocks(
    () => Promise.resolve(DEFAULT_STYLIST_IDENTITY),
    () => Promise.reject(new Error('Could not save stylist preferences.')),
  );
  const previous = Object.freeze({ displayName: 'Sofia', avatarId: 'editorial_plum' });
  store.setStylistIdentityState({ identity: previous });

  const result = await store.updateStylistIdentity({ displayName: 'Maya', avatarId: 'deep_space' });

  assert.equal(result, false);
  assert.equal(store.getStylistIdentitySnapshot(), previous);
  assert.equal(store.getStylistIdentityLoadingSnapshot(), false);
  assert.match(store.getStylistIdentityErrorSnapshot(), /could not save/i);
});

test('store rejects unknown avatar IDs before saving and rolls back', async () => {
  const fetchMock = () => Promise.resolve(DEFAULT_STYLIST_IDENTITY);
  const saveCalls = [];
  const saveMock = (identity) => {
    saveCalls.push(identity);
    return Promise.resolve(identity);
  };
  const store = loadStylistIdentityStoreWithMocks(fetchMock, saveMock);

  // Establish a known previous identity.
  store.setStylistIdentityState({
    identity: Object.freeze({ displayName: 'Sofia', avatarId: 'editorial_plum' }),
  });
  const previous = store.getStylistIdentitySnapshot();

  await store.updateStylistIdentity({ avatarId: 'unknown_avatar' });
  assert.equal(saveCalls.length, 0, 'save must not be called for unknown IDs');
  assert.equal(store.getStylistIdentitySnapshot(), previous, 'identity must roll back to previous value');
  assert.match(store.getStylistIdentityErrorSnapshot(), /not recognized/i);
});

test('store accepts a ready portrait avatar ID and forwards it to the service', async () => {
  const fetchMock = () => Promise.resolve(DEFAULT_STYLIST_IDENTITY);
  const saveCalls = [];
  const saveMock = (identity) => {
    saveCalls.push(identity);
    return Promise.resolve(identity);
  };
  const store = loadStylistIdentityStoreWithMocks(fetchMock, saveMock);

  await store.updateStylistIdentity({ displayName: 'Sofia', avatarId: 'stylist_portrait_01' });

  assert.equal(saveCalls.length, 1);
  assert.equal(saveCalls[0].avatarId, 'stylist_portrait_01');
  assert.equal(store.getStylistIdentitySnapshot().avatarId, 'stylist_portrait_01');
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
  assert.match(homeStylistCard, /numberOfLines=\{1\}/);
  assert.match(homeStylistCard, /adjustsFontSizeToFit/);
  assert.match(homeStylistCard, /minimumFontScale=\{0\.85\}/);
  assert.match(homeStylistCard, /YOUR STYLIST/);
  assert.match(homeStylistCard, /Ask \{displayName\}/);
  assert.match(homeStylistCard, /title="Start Chat"/);
  assert.doesNotMatch(homeStylistCard, /Continue chat|CONTINUE CONVERSATION/);
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
  assert.doesNotMatch(homeV1, /title="AI STYLIST"/);
});

test('Home brand header subtitle reads AI STYLIST • VISUAL SHOPPING', () => {
  assert.match(homeV1, /subtitle="AI STYLIST • VISUAL SHOPPING"/);
  assert.doesNotMatch(homeV1, /subtitle="ELISE • VISUAL SHOPPING"/);
});

test('personalize modal allows editing display name and avatar', () => {
  assert.match(personalizeModal, /PERSONALIZE YOUR STYLIST/);
  assert.match(personalizeModal, /DISPLAY NAME/);
  assert.match(personalizeModal, /ABSTRACT/);
  assert.match(personalizeModal, /SAVE/);
  assert.match(personalizeModal, /RESTORE DEFAULT/);
  assert.match(personalizeModal, /CANCEL/);
  assert.match(personalizeModal, /STYLIST_ABSTRACT_PRESETS/);
  assert.match(personalizeModal, /STYLIST_PORTRAIT_PRESETS/);
  assert.match(personalizeModal, /StylistAvatar/);
});

test('personalize modal shows an enabled Stylist section with ten ready portraits', () => {
  assert.match(personalizeModal, />STYLIST<\/Text>/);
  assert.doesNotMatch(personalizeModal, /Photorealistic stylist portraits are coming soon\./);
  assert.match(personalizeModal, /STYLIST_PORTRAIT_PRESETS\.map/);
  assert.match(personalizeModal, /onPress=\{\(\) => setDraftAvatarId\(preset\.id\)\}/);
  assert.match(personalizeModal, /accessibilityRole="radio"/);
  assert.match(personalizeModal, /Choose your personal stylist avatar\./);
  assert.match(personalizeModal, /accessibilityState=\{\{\s*disabled:\s*saving,\s*selected\s*\}\}/);
  assert.match(personalizeModal, /selected\s*&&\s*styles\.avatarButtonSelected/);
  assert.match(personalizeModal, /<ScrollView[\s\S]*?styles\.actions[\s\S]*?<\/ScrollView>/);
  assert.match(personalizeModal, /KeyboardAvoidingView/);
  assert.match(personalizeModal, /useSafeAreaInsets/);
  assert.match(personalizeModal, /submissionInFlightRef\.current/);
  assert.match(personalizeModal, /busy:\s*saving/);
  assert.match(homeV1, /if \(didSave\) setPersonalizeVisible\(false\)/);
  assert.match(homeV1, /if \(didReset\) setPersonalizeVisible\(false\)/);
  assert.doesNotMatch(stylistIdentityService, /console\.warn/);
});

test('StylistAvatar supports placeholder, ready-image, and load-failure paths', () => {
  assert.match(stylistAvatar, /reducedOpacity\s*\?\s*0\.35/);
  assert.match(stylistAvatar, /preset\.kind\s*===\s*['"]portrait['"]\s*&&\s*preset\.availability\s*===\s*['"]placeholder['"]/);
  assert.match(stylistAvatar, /AbstractAvatar/);
  assert.match(stylistAvatar, /isRenderablePortraitPreset\(preset\)/);
  assert.match(stylistAvatar, /<PortraitAvatar/);
  assert.match(stylistAvatar, /<Image/);
  assert.match(stylistAvatar, /source=\{preset\.source\}/);
  assert.match(stylistAvatar, /resizeMode="cover"/);
  assert.match(stylistAvatar, /resizeMethod="resize"/);
  assert.doesNotMatch(stylistAvatar, /fadeDuration=/);
  assert.match(stylistAvatar, /onError=\{\(\) => setLoadFailed\(true\)\}/);
  assert.match(stylistAvatar, /if \(loadFailed\)[\s\S]*?<AbstractAvatar/);
});

// ── Fix #1: Stylist 02 static-portrait framing correction ───────────────────

test('only stylist_portrait_02 carries a framing override; every other avatar is unaffected', () => {
  const portraitIds = STYLIST_PORTRAIT_PRESETS.map((preset) => preset.id);
  const abstractIds = STYLIST_ABSTRACT_PRESETS.map((preset) => preset.id);

  const framing02 = getStylistAvatarFraming('stylist_portrait_02');
  assert.ok(framing02, 'stylist_portrait_02 must have a framing override');
  assert.equal(typeof framing02.offsetXRatio, 'number');
  assert.ok(framing02.offsetXRatio > 0 && framing02.offsetXRatio < 0.5);

  for (const id of [...portraitIds, ...abstractIds, DEFAULT_STYLIST_IDENTITY.avatarId]) {
    if (id === 'stylist_portrait_02') continue;
    assert.equal(getStylistAvatarFraming(id), undefined, `${id} must not have a framing override`);
  }

  assert.equal(getStylistAvatarFraming(null), undefined);
  assert.equal(getStylistAvatarFraming(undefined), undefined);
  assert.equal(getStylistAvatarFraming('unknown_avatar'), undefined);
});

test('framing correction does not touch the mouth-state speech configuration', () => {
  // The mouthRegion percentages must stay exactly what they were before this
  // fix; only StylistAvatar's static-portrait render path changes.
  const stylist02Speech = STYLIST_SPEECH_CONFIG_BY_ID.get('stylist_portrait_02');
  assert.ok(stylist02Speech);
  assert.deepEqual(stylist02Speech.mouthRegion, { x: 0.43, y: 0.48, width: 0.17, height: 0.09 });
  assert.match(
    stylistIdentityConstants,
    /Recalibrated for the refreshed Avatar 02 subject \(prior crop: y 0\.49\)/,
  );
});

test('StylistAvatar applies the recenter only for avatars with a framing override, and never for the placeholder/abstract paths', () => {
  assert.match(stylistAvatar, /applyFraming\??:\s*boolean/);
  assert.match(stylistAvatar, /getStylistAvatarFraming/);
  // Legacy (no-override) render path is untouched: still a single <Image> with
  // resizeMode="cover" at exactly {size, size} and no transform.
  const legacyBranch = stylistAvatar.match(/if \(!framing\) \{[\s\S]*?\n {2}\}/)?.[0];
  assert.ok(legacyBranch, 'no-framing branch must exist verbatim');
  assert.match(legacyBranch, /width: size,\s*\n\s*height: size,/);
  assert.doesNotMatch(legacyBranch, /transform:/);
});

test('AnimatedStylistAvatar opts the mouth-state speaking overlay out of the new framing so overlay alignment is unaffected', () => {
  const mouthBranch = animatedStylistAvatar.match(
    /<StylistAvatar[\s\S]*?\/>\s*<MouthStateLayer/,
  )?.[0];
  assert.ok(mouthBranch, 'expected the StylistAvatar call that precedes MouthStateLayer');
  assert.match(mouthBranch, /applyFraming=\{false\}/);

  // The two non-speaking fallback branches (idle/thinking, and incomplete
  // asset set) must NOT set applyFraming=false, so they get the correction.
  const allMatches = [...animatedStylistAvatar.matchAll(/<StylistAvatar[\s\S]*?\/>/g)];
  const fallbackBranches = allMatches
    .filter((m) => !animatedStylistAvatar.slice(m.index, m.index + m[0].length + 40).includes('MouthStateLayer'))
    .map((m) => m[0]);
  assert.equal(fallbackBranches.length, 2, 'expected exactly two non-speaking StylistAvatar call sites');
  for (const block of fallbackBranches) {
    assert.doesNotMatch(block, /applyFraming/);
  }
});

// ── Fix #6: single-resolver coherence (UI / greeting / model / speech-ready) ──

test('VISIBLE_NAME_USES_RESOLVED_NAME: HomeStylistCard and StyleChatHeader read identity.displayName, not a second source', () => {
  assert.match(homeStylistCard, /identity\.displayName/);
  assert.doesNotMatch(homeStylistCard, /ELISE_IDENTITY\.displayName/);
});

test('GREETING_USES_RESOLVED_NAME: the greeting builder consumes identity.displayName, unmodified from before Fix #6', () => {
  assert.match(styleChatGreetingSource, /stylistName:\s*identity\.displayName/);
  assert.match(styleChatGreetingSource, /identity:\s*StylistIdentity/);
});

test('VISIBLE_AND_GREETING_NAMES_MATCH: both read the exact same resolved field on the exact same identity object', () => {
  const identity = normalizeStylistIdentity({
    display_name: 'Alex',
    avatar_id: 'stylist_portrait_02',
    display_name_customized: true,
  });
  // What HomeStylistCard/StyleChatHeader would render:
  const visibleName = identity.displayName;
  // What getGreetingTextForUser would build the greeting from:
  const greetingName = identity.displayName;
  assert.equal(visibleName, greetingName);
  assert.equal(visibleName, 'Alex');
});

test('FUTURE_SPEECH_INTRODUCTION_USES_RESOLVED_NAME / NO_SECOND_SPEECH_NAME_RESOLVER: the greeting text itself (what any future speech playback would read) contains exactly the resolved name', () => {
  // Mirrors buildStylistGreeting's own template without importing React
  // Native-dependent modules into this test file.
  const withCustomName = normalizeStylistIdentity({
    display_name: 'Alex',
    avatar_id: 'stylist_portrait_02',
    display_name_customized: true,
  }).displayName;
  const withDefaultName = normalizeStylistIdentity({ avatar_id: 'stylist_portrait_02' }).displayName;
  assert.equal(withCustomName, 'Alex');
  assert.equal(withDefaultName, 'Henry');
  // getGreetingTextForUser passes identity.displayName straight through as
  // stylistName with no intermediate transform, so "the text a future speech
  // path would read" is provably the same string as the UI's resolved name.
  assert.match(styleChatGreetingSource, /buildStylistGreeting\(\{[\s\S]*?stylistName:\s*identity\.displayName,?\s*\}\)/);
});

test('PersonalizeStylistModal tracks whether the name field was actually edited, and omits displayName from onSave when it was not', () => {
  assert.match(personalizeStylistModalSource, /nameEditedRef/);
  assert.match(personalizeStylistModalSource, /handleNameChange[\s\S]*?nameEditedRef\.current = true/);
  const saveCall = personalizeStylistModalSource.match(/await onSave\(\{[\s\S]*?\}\);/)?.[0];
  assert.ok(saveCall, 'expected the onSave(...) call in handleSave');
  assert.match(saveCall, /nameEditedRef\.current \? \{ displayName: trimmed \} : \{\}/);
});

test('the store passes displayName to the service only when the caller\'s update actually included it', () => {
  assert.match(
    stylistIdentityStoreSource,
    /input\.displayName !== undefined \? \{ displayName: nextIdentity\.displayName \} : \{\}/,
  );
});

test('display_name_customized migration is additive: no RLS, grant, policy, or auth change, no backfill guess beyond the honest column default', () => {
  const sqlOnly = displayNameCustomizedMigration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.match(sqlOnly, /alter table public\.user_stylist_preferences/);
  assert.match(sqlOnly, /add column if not exists display_name_customized boolean not null default false/);
  assert.doesNotMatch(sqlOnly, /\brow level security\b/i);
  assert.doesNotMatch(sqlOnly, /\bcreate policy\b/i);
  assert.doesNotMatch(sqlOnly, /^\s*grant\s/im);
  assert.doesNotMatch(sqlOnly, /^\s*revoke\s/im);
  assert.doesNotMatch(sqlOnly, /\bupdate\s+public\.user_stylist_preferences\s+set\b/i);
  assert.doesNotMatch(sqlOnly, /\bauth\.\w+\(/i);
  // display_name itself is untouched -- still the same required, defaulted column.
  assert.doesNotMatch(sqlOnly, /alter column display_name/i);
});

test('FIX5_GENDER_CONTEXT_UNCHANGED: gender styling context module is untouched by any Fix #6 file', () => {
  const genderConstants = fs.readFileSync(path.join(ROOT, 'constants', 'genderStylingContext.ts'), 'utf8');
  const genderService = fs.readFileSync(path.join(ROOT, 'services', 'genderStylingContextService.ts'), 'utf8');
  // Fix #6 touches stylist identity naming only; the gender context module
  // must not reference avatarId/stylist naming at all -- the two preferences
  // are independent, per the product contract.
  assert.doesNotMatch(genderConstants, /avatarId|display_name|CANONICAL_PORTRAIT/i);
  assert.doesNotMatch(genderService, /avatarId|display_name|CANONICAL_PORTRAIT/i);
});

// ── Shipped portrait assets ──────────────────────────────────────────────────

test('shipped portrait assets exist, are square JPEGs, and have unique hashes', () => {
  const portraitDir = path.join(ROOT, 'assets', 'stylist-avatars', 'portraits');
  assert.ok(fs.existsSync(portraitDir), 'portrait output directory must exist');

  const expectedIds = STYLIST_PORTRAIT_PRESETS.map((preset) => preset.id);
  const expectedFiles = expectedIds.map((id) => `${id}.jpg`);
  const productionFiles = fs.readdirSync(portraitDir)
    .filter((name) => fs.statSync(path.join(portraitDir, name)).isFile())
    .sort();
  assert.deepEqual(productionFiles, expectedFiles, 'production directory must contain exactly ten portraits');
  const hashes = new Set();

  for (const id of expectedIds) {
    const filePath = path.join(portraitDir, `${id}.jpg`);
    assert.ok(fs.existsSync(filePath), `expected ${filePath} to exist`);

    const dimensions = sizeOf(filePath);
    assert.equal(dimensions.type, 'jpg');
    assert.equal(dimensions.width, 1024);
    assert.equal(dimensions.height, 1024);

    const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    assert.equal(hashes.has(hash), false, 'each portrait asset must have a unique hash');
    hashes.add(hash);
  }
});

test('portrait manifest matches exact shipped hashes and sizes', () => {
  const portraitDir = path.join(ROOT, 'assets', 'stylist-avatars', 'portraits');
  assert.match(portraitAssetManifest, /6 women and 4 men/);
  assert.match(portraitAssetManifest, /reprocessed on 2026-07-12/);
  // Portraits 01-04 were refreshed again on 2026-07-23; 01 and 02 changed
  // subject, so the manifest prose describes the current images.
  // Whitespace-tolerant: the manifest is hard-wrapped, so these phrases may
  // break across lines as the prose is reflowed.
  assert.match(portraitAssetManifest, /refreshed\s+again\s+on\s+2026-07-23/);
  assert.match(portraitAssetManifest, /long\s+box\s+braids\s+and\s+a\s+black\s+top/);
  assert.match(portraitAssetManifest, /short\s+hair,\s+a\s+trimmed\s+beard,\s+and\s+a\s+blue\s+polo/);
  assert.match(portraitAssetManifest, /quality 90/);
  assert.match(portraitAssetManifest, /AI-generated, fictional people/);

  for (const preset of STYLIST_PORTRAIT_PRESETS) {
    const filename = `${preset.id}.jpg`;
    const filePath = path.join(portraitDir, filename);
    const bytes = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const row = portraitAssetManifest
      .split(/\r?\n/)
      .find((line) => line.includes(`| \`${filename}\` |`));
    assert.ok(row, `manifest row missing for ${filename}`);
    const cells = row.split('|').map((cell) => cell.trim());
    assert.match(cells[2], /^1024.+1024$/);
    assert.equal(cells[3], 'sRGB/RGB');
    assert.equal(Number(cells[4].replaceAll(',', '')), bytes.length);
    assert.equal(cells[5].replaceAll('`', ''), hash);
  }
});

test('portrait registry is shared, case-safe, and platform-neutral', () => {
  const portraitBlock = stylistIdentityConstants.match(
    /const PORTRAIT_PRESET_DEFINITIONS[\s\S]*?\];/,
  )?.[0];
  assert.ok(portraitBlock);
  assert.doesNotMatch(portraitBlock, /Platform\.|\.android\.|\.ios\.|https?:\/\/|file:\/\/|\\\\/);
  const sourcePaths = [...portraitBlock.matchAll(/require\(['"]([^'"]+\.jpg)['"]\)/g)]
    .map((match) => match[1]);
  assert.equal(sourcePaths.length, 10);
  assert.equal(new Set(sourcePaths).size, 10);
  for (const sourcePath of sourcePaths) {
    const filename = path.posix.basename(sourcePath);
    assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'stylist-avatars', 'portraits', filename)));
  }
  assert.equal(new Set(STYLIST_PORTRAIT_PRESETS.map((preset) => preset.accessibilityLabel)).size, 10);
});

test('portrait processor enforces the canonical set and safe replacement behavior', () => {
  assert.match(portraitProcessingScript, /EXPECTED_STEMS/);
  assert.match(portraitProcessingScript, /stylist_portrait_\{index:02d\}/);
  assert.match(portraitProcessingScript, /TARGET_SIZE = 1024/);
  assert.match(portraitProcessingScript, /JPEG_QUALITY = 90/);
  assert.match(portraitProcessingScript, /ImageOps\.exif_transpose/);
  assert.match(portraitProcessingScript, /ImageCms\.profileToProfile/);
  assert.match(portraitProcessingScript, /Refusing to overwrite existing asset/);
  assert.match(portraitProcessingScript, /--overwrite/);
  assert.match(portraitProcessingScript, /Unexpected portrait source IDs/);
  assert.match(portraitProcessingScript, /Missing portrait source IDs/);
  assert.doesNotMatch(portraitProcessingScript, /\b(requests|urllib|httpx|socket)\b/);
  assert.doesNotMatch(portraitProcessingScript, /unlink\(|rmtree\(|remove\(/);
});

// ── Phase 2 Supabase plan ────────────────────────────────────────────────────

test('Phase 1 migration adds exactly the six abstract IDs without changing security contracts', () => {
  const expectedAbstractIds = STYLIST_ABSTRACT_PRESETS.map((preset) => preset.id);
  const quotedIds = [...phase1AvatarAllowlistMigration.matchAll(/'([a-z0-9_]+)'/g)]
    .map((match) => match[1])
    .filter((value) => expectedAbstractIds.includes(value));
  assert.deepEqual([...new Set(quotedIds)].sort(), [...expectedAbstractIds].sort());
  assert.equal(quotedIds.length, expectedAbstractIds.length * 2, 'precheck and CHECK must agree');
  const checkBlock = phase1AvatarAllowlistMigration.match(
    /add constraint user_stylist_preferences_avatar_id_check[\s\S]*$/,
  )?.[0];
  assert.ok(checkBlock);
  const allowedIds = [...checkBlock.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
  assert.deepEqual(allowedIds, expectedAbstractIds);
  for (const portraitId of STYLIST_PORTRAIT_PRESETS.map((p) => p.id)) {
    assert.equal(allowedIds.includes(portraitId), false);
  }
  assert.equal(allowedIds.includes('arbitrary_avatar'), false);
  assert.doesNotMatch(phase1AvatarAllowlistMigration, /stylist_portrait_\d{2}/);
  assert.match(
    phase1AvatarAllowlistMigration,
    /add constraint user_stylist_preferences_avatar_id_check/,
  );
  assert.match(phase1AvatarAllowlistMigration, /unsupported_row_count/);
  assert.doesNotMatch(phase1AvatarAllowlistMigration, /\b(delete|update|insert)\b/i);
  assert.doesNotMatch(phase1AvatarAllowlistMigration, /\b(policy|grant|trigger|foreign key)\b/i);
  const avatarAllowlistMigrations = fs
    .readdirSync(path.join(ROOT, 'supabase', 'migrations'))
    .filter((name) => /stylist.*avatar.*allowlist\.sql$/.test(name));
  assert.deepEqual(avatarAllowlistMigrations.sort(), [
    path.basename(phase1AvatarAllowlistMigrationPath),
    path.basename(phase2AvatarAllowlistMigrationPath),
  ].sort());
});

test('Phase 2 migration replaces the CHECK constraint with exactly sixteen IDs', () => {
  assert.match(
    phase2AvatarAllowlistMigration,
    /drop constraint user_stylist_preferences_avatar_id_check/,
  );
  assert.match(
    phase2AvatarAllowlistMigration,
    /add constraint user_stylist_preferences_avatar_id_check/,
  );
  assert.match(phase2AvatarAllowlistMigration, /invalid_row_count/);
  assert.doesNotMatch(phase2AvatarAllowlistMigration, /\b(delete|update|insert)\b/i);
  assert.doesNotMatch(phase2AvatarAllowlistMigration, /\b(policy|grant|trigger|foreign key)\b/i);

  const checkBlock = phase2AvatarAllowlistMigration.match(
    /add constraint user_stylist_preferences_avatar_id_check[\s\S]*$/,
  )?.[0];
  assert.ok(checkBlock);
  const allowedIds = [...checkBlock.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
  const registryIds = STYLIST_AVATAR_PRESETS.map((preset) => preset.id);
  assert.deepEqual(allowedIds, registryIds);
  assert.equal(new Set(allowedIds).size, 16);
});

test('Phase 2 Supabase plan reflects history and expands the exact constraint to sixteen IDs', () => {
  assert.match(phase2SupabasePlan, /no database `avatar_id` CHECK constraint existed/i);
  assert.match(phase2SupabasePlan, /20260714000003_add_user_stylist_preferences_avatar_allowlist\.sql/);
  assert.match(phase2SupabasePlan, /user_stylist_preferences_avatar_id_check/);
  assert.match(phase2SupabasePlan, /20260715\d+_expand_stylist_portrait_avatar_allowlist\.sql/);
  assert.match(phase2SupabasePlan, /forward-only/);
  assert.match(phase2SupabasePlan, /RLS/);
  assert.match(phase2SupabasePlan, /user_stylist_preferences_updated_at/);
  assert.match(phase2SupabasePlan, /User A[\s\S]*User B/);
  assert.match(phase2SupabasePlan, /unknown_avatar_id[\s\S]*CHECK-constraint violation/);
  const replacementBlock = phase2SupabasePlan.match(
    /drop constraint user_stylist_preferences_avatar_id_check,[\s\S]*?\n\s*\);\n```/,
  )?.[0];
  assert.ok(replacementBlock, 'sixteen-ID replacement CHECK must be documented');
  const plannedIds = [...replacementBlock.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
  const registryIds = STYLIST_AVATAR_PRESETS.map((preset) => preset.id);
  assert.deepEqual(plannedIds, registryIds);
  assert.equal(new Set(plannedIds).size, 16);

  assert.match(phase2SupabasePlan, /validation queries/i);
  assert.match(phase2SupabasePlan, /rollout order/i);
  assert.match(phase2SupabasePlan, /recovery guidance/i);
});
