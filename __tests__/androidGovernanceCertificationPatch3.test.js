/**
 * Build 34 Android — Patch 3. Governance / certification matrix.
 *
 * Two repairs, each with the invariant that lets it be re-broken:
 *
 *   P2-MIG-001  The migration provenance gate failed on two undeclared
 *               duplicate logical migrations (dr3/dr4). They are declared in
 *               config/migration-provenance-manifest.json now. No migration
 *               file was renamed, squashed or deleted -- the manifest is the
 *               only thing that changed. The gate itself already carries its
 *               own negative controls (__tests__/migrationProvenanceGate),
 *               so what is asserted here is the *shape* of the declaration:
 *               that both pairs stay declared, and that the declaration keeps
 *               naming a real, applied ledger version rather than becoming a
 *               blanket "ignore duplicates" escape hatch.
 *
 *   P3-AND-010  AndroidManifest declared no <queries> entry for mailto, so
 *               Linking.canOpenURL('mailto:...') returns false on every
 *               Android 11+ device (API 30 package visibility filtering).
 *               The Dressing Room UGC report fallback therefore silently did
 *               nothing while telling the user the report "can also be sent
 *               to K Scan AI support".
 *
 * Also re-pins the certification matrix itself, which nothing else asserts
 * end to end: the client flags eas.json turns on for `staging-certification`,
 * the staging-only backend, and the production negative control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
const readJson = (...segments) => JSON.parse(read(...segments));

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const CERTIFICATION_PROFILE = 'staging-certification';

/** Resolve a build profile's effective config through its `extends` chain. */
function resolveProfile(easJson, name, seen = new Set()) {
  assert.ok(!seen.has(name), `cyclic extends at ${name}`);
  seen.add(name);

  const profile = easJson.build[name];
  assert.ok(profile, `eas.json has no build profile "${name}"`);

  const base = profile.extends ? resolveProfile(easJson, profile.extends, seen) : {};
  const env = { ...(base.env ?? {}), ...(profile.env ?? {}) };
  const resolved = { ...base, ...profile, env };
  delete resolved.extends;
  return resolved;
}

/* ------------------------------------------------------------------ *
 * P2-MIG-001 — migration provenance declarations
 * ------------------------------------------------------------------ */

/**
 * The two pairs Patch 3 declared. Each names the ledger version that both
 * staging and production actually applied (confirmed 2026-09-02 via
 * list_migrations on both projects) and the sibling filename that is applied
 * in neither.
 */
const DECLARED_DUPLICATE_PAIRS = [
  {
    logicalId: 'dr3_collaborative_interactions',
    appliedLedgerVersion: '20260721201218',
    unappliedFilename: '20260721170559_dr3_collaborative_interactions.sql',
    appliedFilename: '20260721201218_dr3_collaborative_interactions.sql',
  },
  {
    logicalId: 'dr4_collab_idempotency_room_scope',
    appliedLedgerVersion: '20260721201347',
    unappliedFilename: '20260721183308_dr4_collab_idempotency_room_scope.sql',
    appliedFilename: '20260721201347_dr4_collab_idempotency_room_scope.sql',
  },
];

for (const pair of DECLARED_DUPLICATE_PAIRS) {
  test(`provenance: ${pair.logicalId} stays declared as one logical migration`, () => {
    const manifest = readJson('config', 'migration-provenance-manifest.json');
    const entry = manifest.logicalMigrations.find((m) => m.logicalId === pair.logicalId);

    assert.ok(entry, `${pair.logicalId} is no longer declared -- the provenance gate will fail again`);
    assert.equal(entry.appliedLedgerVersion, pair.appliedLedgerVersion);

    const filenames = entry.aliases.map((alias) => alias.filename).sort();
    assert.deepEqual(filenames, [pair.unappliedFilename, pair.appliedFilename].sort());
  });

  test(`provenance: ${pair.logicalId} keeps both files on disk (no history rewrite)`, () => {
    // The repair is declarative. If a future change "fixes" the gate by
    // deleting the duplicate instead, that rewrites applied migration history
    // and this fails.
    for (const filename of [pair.unappliedFilename, pair.appliedFilename]) {
      assert.ok(
        fs.existsSync(path.join(ROOT, 'supabase', 'migrations', filename)),
        `${filename} was removed -- migration history must never be rewritten to satisfy the gate`,
      );
    }
  });

  test(`provenance: ${pair.logicalId} records per-alias applied evidence`, () => {
    const manifest = readJson('config', 'migration-provenance-manifest.json');
    const entry = manifest.logicalMigrations.find((m) => m.logicalId === pair.logicalId);

    const applied = entry.aliases.find((a) => a.filename === pair.appliedFilename);
    const unapplied = entry.aliases.find((a) => a.filename === pair.unappliedFilename);

    assert.equal(applied.status, 'applied');
    assert.equal(unapplied.status, 'unapplied-in-either-environment');

    // Evidence is what stops this manifest from degrading into a list of
    // duplicates someone waved through.
    for (const alias of entry.aliases) {
      assert.ok(
        typeof alias.evidence === 'string' && alias.evidence.trim().length > 40,
        `${alias.filename} must carry substantive applied/unapplied evidence`,
      );
    }
  });
}

test('provenance: every declared alias set is a real duplicate, not a blanket exemption', () => {
  const manifest = readJson('config', 'migration-provenance-manifest.json');

  for (const entry of manifest.logicalMigrations) {
    assert.ok(
      entry.aliases.length >= 2,
      `${entry.logicalId} declares fewer than two aliases -- nothing to reconcile`,
    );
    assert.ok(
      /^[0-9a-f]{64}$/.test(entry.canonicalNormalizedHash),
      `${entry.logicalId} must pin a full SHA-256`,
    );
    assert.equal(
      entry.aliases.filter((alias) => alias.status === 'applied').length,
      1,
      `${entry.logicalId} must name exactly one applied alias`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * P3-AND-010 — Android package-visibility declarations
 * ------------------------------------------------------------------ */

test('AND-010: the manifest declares the mailto intent the report fallback needs', () => {
  const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const queries = manifest.match(/<queries>[\s\S]*?<\/queries>/);

  assert.ok(queries, 'AndroidManifest has no <queries> block');
  assert.match(
    queries[0],
    /android\.intent\.action\.SENDTO/,
    'ACTION_SENDTO must be declared or Linking.canOpenURL("mailto:") returns false on Android 11+',
  );
  assert.match(queries[0], /android:scheme="mailto"/, 'the mailto scheme must be declared');
});

test('AND-010: the https browse intent stays declared', () => {
  // Every legal/privacy/support link in the app goes through Linking.openURL
  // with an https URL; removing this would break all of them the same way.
  const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const queries = manifest.match(/<queries>[\s\S]*?<\/queries>/)[0];

  assert.match(queries, /android\.intent\.action\.VIEW/);
  assert.match(queries, /android:scheme="https"/);
});

test('AND-010: generative-AI output reporting stays in-app and server-backed', () => {
  // Play requires reporting AI output without leaving the app. This is the
  // regression that P1-GENAI-001 closed; a return to mailto here is a
  // policy failure, not a cosmetic one.
  const reportAiOutput = read('services', 'reportAiOutput.ts');

  assert.ok(
    !reportAiOutput.includes('mailto:'),
    'reportAiOutput.ts must not open an external mail client',
  );
  assert.match(
    reportAiOutput,
    /submitContentReport/,
    'AI-output reports must go through the server-persisted content-report path',
  );
});

/* ------------------------------------------------------------------ *
 * Certification matrix
 * ------------------------------------------------------------------ */

/** Client flags the certification artifact must carry. */
const CERTIFICATION_REQUIRED_FLAGS = [
  'EXPO_PUBLIC_VOICESCAN_ENABLED',
  'KSCAN_VOICE_CERTIFICATION',
  'EXPO_PUBLIC_SMART_WATCHLIST_V1',
  'EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED',
  'EXPO_PUBLIC_PACKING_INTELLIGENCE_V1',
  'EXPO_PUBLIC_ELISE_CONCIERGE_V1',
  'EXPO_PUBLIC_VTO_UI_ENABLED',
];

test('certification: the profile is a store-shaped Android app bundle', () => {
  const easJson = readJson('eas.json');
  const certification = resolveProfile(easJson, CERTIFICATION_PROFILE);

  assert.equal(certification.distribution, 'store');
  assert.equal(certification.android.buildType, 'app-bundle');
});

test('certification: the full Build 34 feature matrix resolves on', () => {
  const easJson = readJson('eas.json');
  const { env } = resolveProfile(easJson, CERTIFICATION_PROFILE);

  for (const flag of CERTIFICATION_REQUIRED_FLAGS) {
    assert.equal(env[flag], 'true', `${flag} must resolve true for ${CERTIFICATION_PROFILE}`);
  }
});

test('certification: the backend resolves to staging, never production', () => {
  const easJson = readJson('eas.json');
  const { env } = resolveProfile(easJson, CERTIFICATION_PROFILE);

  assert.match(env.EXPO_PUBLIC_SUPABASE_URL, new RegExp(STAGING_PROJECT_REF));
  assert.ok(
    !env.EXPO_PUBLIC_SUPABASE_URL.includes(PRODUCTION_PROJECT_REF),
    'a certification artifact must never resolve to the production Supabase project',
  );
  assert.ok(
    !env.EXPO_PUBLIC_SUPABASE_ANON_KEY.includes(PRODUCTION_PROJECT_REF),
    'the certification anon key must not be the production key',
  );
});

test('certification: production does not inherit certification-only flags', () => {
  const easJson = readJson('eas.json');
  const { env } = resolveProfile(easJson, 'production');

  for (const flag of CERTIFICATION_REQUIRED_FLAGS) {
    assert.equal(
      env[flag],
      undefined,
      `${flag} leaked into the production profile -- certification-only surfaces must not ship to production unreviewed`,
    );
  }
  assert.match(env.EXPO_PUBLIC_SUPABASE_URL, new RegExp(PRODUCTION_PROJECT_REF));
});

test('certification: the Voice pair is set together and nowhere else', () => {
  const easJson = readJson('eas.json');

  for (const name of Object.keys(easJson.build)) {
    const { env } = resolveProfile(easJson, name);
    const client = env.EXPO_PUBLIC_VOICESCAN_ENABLED;
    const native = env.KSCAN_VOICE_CERTIFICATION;

    assert.equal(
      client,
      native,
      `profile "${name}" resolves EXPO_PUBLIC_VOICESCAN_ENABLED=${client} but ` +
        `KSCAN_VOICE_CERTIFICATION=${native}; the pair is governed and must move together`,
    );

    if (name !== CERTIFICATION_PROFILE) {
      assert.notEqual(
        native,
        'true',
        `profile "${name}" enables the certification-only Voice native selector`,
      );
    }
  }
});

test('certification: R8 stays authoritative for release builds', () => {
  const gradleProperties = read('android', 'gradle.properties');

  assert.match(
    gradleProperties,
    /^android\.enableMinifyInReleaseBuilds=true$/m,
    'R8 must not be disabled to work around an unrelated build problem',
  );
});

test('certification: build provenance stays artifact-readable', () => {
  const buildGradle = read('android', 'app', 'build.gradle');

  // resValue entries land in the resource table, so provenance is readable
  // from the AAB itself -- not only from a decompiled BuildConfig.
  assert.match(buildGradle, /resValue\s+"string",\s*"kscan_build_profile"/);
  assert.match(buildGradle, /resValue\s+"string",\s*"kscan_source_commit"/);
});

test('certification: Expo Updates stays disabled in the native manifest', () => {
  const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');

  assert.match(
    manifest,
    /expo\.modules\.updates\.ENABLED"\s+android:value="false"/,
    'a certification artifact must not be able to swap its own JS bundle',
  );
});
