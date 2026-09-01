// REG-KPLUS-003 — eas.json must have no duplicate keys, and the staging profile
// must be one deterministic object.
//
// JSON permits duplicate keys and silently resolves them last-wins. eas.json had
// TWO `build.staging` objects: a merge (3a7e563 "converge iOS B3 lineage")
// concatenated the iOS line's newer governed staging profile with the older
// Aug-4 profile instead of merging them. Because the newer one was written
// FIRST, last-wins made the OLDER one effective and silently discarded the newer
// one — including EXPO_PUBLIC_ENVIRONMENT="staging" itself.
//
// Nothing detected it: every JSON.parse in the repo, and EAS itself, sees only
// the survivor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EAS_PATH = path.join(ROOT, 'eas.json');
const RAW = fs.readFileSync(EAS_PATH, 'utf8');

/**
 * Collects every duplicated key in a JSON document.
 *
 * JSON.parse cannot report duplicates — it silently keeps the last value — and
 * Node has no object_pairs_hook, so this scans the raw text: track a Set of keys
 * per open object, and flag any key seen twice at the same level.
 */
function findDuplicateKeys(raw) {
  const duplicates = [];
  const objects = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < raw.length) {
        if (raw[j] === '\\') { text += raw[j + 1]; j += 2; continue; }
        if (raw[j] === '"') break;
        text += raw[j];
        j += 1;
      }
      // A string followed by ':' is a key, not a value.
      let k = j + 1;
      while (k < raw.length && /\s/.test(raw[k])) k += 1;
      if (raw[k] === ':' && objects.length > 0) {
        const level = objects[objects.length - 1];
        if (level.has(text)) duplicates.push({ key: text, depth: objects.length });
        level.add(text);
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') objects.push(new Set());
    else if (ch === '}') objects.pop();
    i += 1;
  }
  return duplicates;
}

test('eas.json contains no duplicate keys anywhere', () => {
  const duplicates = findDuplicateKeys(RAW);
  assert.deepEqual(
    duplicates,
    [],
    `duplicate JSON keys silently drop configuration: ${JSON.stringify(duplicates)}`,
  );
});

test('the duplicate detector actually detects a duplicate (self-check)', () => {
  // Without this, the test above would pass on a broken detector.
  const broken = '{"build":{"staging":{"a":1},"staging":{"a":2}}}';
  const found = findDuplicateKeys(broken);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'staging');
});

test('there is exactly ONE build.staging profile', () => {
  const occurrences = RAW.match(/^\s{4}"staging":\s*\{/gm) ?? [];
  assert.equal(occurrences.length, 1, 'a second staging profile silently wins over the first');
});

// ── Effective staging values (snapshot) ──────────────────────────────────────

const eas = JSON.parse(RAW);
const staging = eas.build.staging;

test('the staging profile keeps its release-style artifact shape', () => {
  // Unchanged from what builds actually produced before the de-duplication, so
  // the merge cannot alter the artifact.
  assert.equal(staging.distribution, 'internal');
  assert.equal(staging.autoIncrement, true);
  assert.equal(staging.android.buildType, 'apk');
  assert.equal(staging.ios.buildConfiguration, 'Release');
});

test('staging declares itself as staging and targets the staging project', () => {
  // EXPO_PUBLIC_ENVIRONMENT lived only in the discarded block, so the effective
  // staging profile did not know it was staging.
  assert.equal(staging.env.EXPO_PUBLIC_ENVIRONMENT, 'staging');
  assert.equal(
    staging.env.EXPO_PUBLIC_SUPABASE_URL,
    'https://yzqjvdfgefveprobvvyw.supabase.co',
    'staging must never point at the production project',
  );
});

test('the six flags the bad merge discarded are restored', () => {
  for (const flag of [
    'EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED',
    'EXPO_PUBLIC_ENVIRONMENT',
    'EXPO_PUBLIC_AVATAR_MOTION_V1',
    'EXPO_PUBLIC_ELISE_V10',
    'EXPO_PUBLIC_ELISE_SPEECH',
    'EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED',
  ]) {
    assert.ok(flag in staging.env, `${flag} must be present in the merged staging profile`);
  }
});

test('no secret-shaped value is introduced, and the anon key stays an anon key', () => {
  const anon = staging.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  assert.ok(typeof anon === 'string' && anon.length > 0);
  const payload = JSON.parse(Buffer.from(anon.split('.')[1], 'base64').toString('utf8'));
  assert.equal(payload.role, 'anon', 'a service_role key must never appear in eas.json');
  assert.equal(payload.ref, 'yzqjvdfgefveprobvvyw');
  // Nothing in any profile may look like a service-role or provider secret.
  assert.doesNotMatch(RAW, /service_role/);
  assert.doesNotMatch(RAW, /RAPIDAPI_KEY"\s*:\s*"[^"]+"/);
});

test('the production profile is untouched by the staging de-duplication', () => {
  assert.ok(eas.build.production, 'production profile must still exist');
  assert.notEqual(
    eas.build.production.env?.EXPO_PUBLIC_SUPABASE_URL,
    staging.env.EXPO_PUBLIC_SUPABASE_URL,
    'production and staging must not share a backend target',
  );
});

test('every build profile is a plain object with an env map', () => {
  for (const [name, profile] of Object.entries(eas.build)) {
    assert.equal(typeof profile, 'object', `${name} must be an object`);
    assert.ok(!Array.isArray(profile), `${name} must not be an array`);
  }
});

// ── Staging-certification artifact profile (Build 34 Android certification) ──
//
// The Build 34 staging certification requires a RELEASE-SHAPED AAB that is
// INTENTIONALLY connected to the staging backend. Neither original profile can
// produce it: `production` bakes the production Supabase project, and `staging`
// produces an internal-distribution APK. This profile is the one governed way
// to build that artifact. It must never define its own env: inheriting the
// staging env verbatim (via `extends`) is what guarantees it can never drift
// onto the production backend.

test('staging-certification produces a store-shaped bundle on the staging backend', () => {
  const cert = eas.build['staging-certification'];
  assert.ok(cert, 'staging-certification profile must exist');
  assert.equal(cert.extends, 'staging', 'must inherit the staging env verbatim');
  assert.equal(cert.distribution, 'store');
  assert.equal(cert.autoIncrement, true);
  assert.equal(cert.android.buildType, 'app-bundle');
  assert.equal(cert.ios.buildConfiguration, 'Release');
});

// ── Build 34 certification feature matrix (owner rulings) ───────────────────
//
// P2-EAS-FLAGS (first pass) enabled VTO, Packing Intelligence, and Wardrobe
// Concierge, and deliberately EXCLUDED K+ Early Access, Smart Watchlist, and
// Voice Scan. All three exclusions have since been resolved, so all three
// move into the enabled matrix for the Build 34 Android certification AAB:
//
//   K+ Early Access — the exclusion was that staging's deployed
//     `kplus-activate` predated the SEC-KPLUS-008 canonical
//     active-entitlement repair. Staging now runs kplus-activate v13
//     (ACTIVE, verify_jwt true), whose deployed bundle was compared
//     byte-for-byte against this repository's source for index.ts,
//     _shared/deletion/common.ts and _shared/revenuecat/revenueCatClient.ts.
//     The repair is live. (Provenance caveat: v13 was deployed through the
//     connected staging control plane rather than the governed deploy
//     workflow — recorded in docs/build34-android-certification-handoff.md.)
//
//   Smart Watchlist — the exclusion was zero end-to-end evidence. It is
//     enabled here as a FIRST LIVE EXECUTION, not as a passed feature: the
//     staging `watchlist_worker_enabled` flag is on, but
//     user_commerce_watches / _watch_events / user_device_push_tokens are
//     all empty. Device certification IS the first real run.
//
//   Voice Scan — the exclusion was that VOICESCAN_ENABLED was a hardcoded
//     `false` constant with no implementation behind it on this lineage.
//     The accepted implementation (PR #218,
//     feature/android-build34-voice-commerce-v1) has now been converged onto
//     this authority and the constant is an env-driven resolver, so the flag
//     has something real to switch on. Voice is additionally K+-gated at
//     runtime: this flag ON without an active entitlement grants nothing.
//
// `staging-certification` may define its OWN `env`, but only as a narrow
// additive override on top of the inherited staging env (via `extends`) — it
// must never redeclare the backend identity (Supabase URL / anon key /
// EXPO_PUBLIC_ENVIRONMENT), and it must contain exactly the approved matrix
// keys plus the approved native selectors, nothing else.

const { resolveEasBuildProfile } = require('../scripts/resolve-eas-build-profiles');

const CERT_MATRIX_ENABLED = Object.freeze([
  'EXPO_PUBLIC_VTO_UI_ENABLED',
  'EXPO_PUBLIC_PACKING_INTELLIGENCE_V1',
  'EXPO_PUBLIC_ELISE_CONCIERGE_V1',
  'EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED',
  'EXPO_PUBLIC_SMART_WATCHLIST_V1',
  'EXPO_PUBLIC_VOICESCAN_ENABLED',
]);

// Nothing is excluded from the certification matrix any more: every feature
// in the Build 34 target matrix is enabled. The list is kept (empty) rather
// than deleted so that re-excluding a feature is a one-line, reviewed change
// and the assertion machinery for it never has to be rebuilt.
const CERT_MATRIX_EXCLUDED = Object.freeze([]);

// NOT an EXPO_PUBLIC product flag: a native build selector read by
// android/app/build.gradle to choose the certification manifest that grants
// RECORD_AUDIO (see config/native-config-authority.json
// buildProfileManifestExceptions). It is allowed in this profile's env, and
// check-native-config-parity.js separately enforces that no OTHER profile
// sets it.
const CERT_NATIVE_SELECTORS = Object.freeze(['KSCAN_VOICE_CERTIFICATION']);

const BACKEND_IDENTITY_KEYS = Object.freeze([
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_ENVIRONMENT',
]);

test('staging-certification defines an env, but only the approved matrix override keys', () => {
  const cert = eas.build['staging-certification'];
  assert.ok(cert.env && typeof cert.env === 'object', 'staging-certification must define its matrix overrides');
  assert.deepEqual(
    Object.keys(cert.env).sort(),
    [...CERT_MATRIX_ENABLED, ...CERT_NATIVE_SELECTORS].sort(),
    'staging-certification env must contain exactly the approved enabled-flag overrides and native selectors, nothing else',
  );
  for (const key of BACKEND_IDENTITY_KEYS) {
    assert.ok(!(key in cert.env), `staging-certification must not redeclare backend identity key ${key}`);
  }
});

test('staging-certification cannot drift onto its own backend target', () => {
  const resolved = resolveEasBuildProfile(eas, 'staging-certification');
  assert.equal(
    resolved.env.EXPO_PUBLIC_SUPABASE_URL,
    staging.env.EXPO_PUBLIC_SUPABASE_URL,
    'staging-certification must inherit the staging backend verbatim, unchanged by its matrix overrides',
  );
  assert.equal(resolved.env.EXPO_PUBLIC_ENVIRONMENT, 'staging');
});

test('the effective (extends-resolved) staging-certification matrix equals the approved rulings exactly', () => {
  const resolved = resolveEasBuildProfile(eas, 'staging-certification');
  for (const key of CERT_MATRIX_ENABLED) {
    assert.equal(resolved.env[key], 'true', `${key} must be enabled in the effective staging-certification matrix`);
  }
  for (const key of CERT_MATRIX_EXCLUDED) {
    assert.notEqual(
      resolved.env[key],
      'true',
      `${key} must NOT be enabled in the effective staging-certification matrix (not closed server-side)`,
    );
  }
  // The exclusion list is empty by design right now, which would make the
  // loop above silently vacuous. State the intended matrix size explicitly so
  // a flag disappearing from CERT_MATRIX_ENABLED cannot pass unnoticed.
  assert.equal(
    CERT_MATRIX_ENABLED.length,
    6,
    'the Build 34 certification matrix is six client features; changing it is an owner ruling',
  );
});

test('the ordinary staging profile is not broadened by the certification matrix', () => {
  for (const key of [...CERT_MATRIX_ENABLED, ...CERT_NATIVE_SELECTORS]) {
    assert.ok(!(key in staging.env), `${key} must not leak into the ordinary staging profile`);
  }
});

test('the production profile is not broadened by the certification matrix', () => {
  const production = eas.build.production;
  for (const key of [...CERT_MATRIX_ENABLED, ...CERT_NATIVE_SELECTORS]) {
    assert.ok(!(production.env && key in production.env), `${key} must not leak into the production profile`);
  }
});

test('NEGATIVE CONTROL: no profile other than staging-certification enables any certification feature', () => {
  // The leak controls above name two profiles. This one is exhaustive, so a
  // profile added later (a second certification lane, a hotfix profile) is
  // covered the day it appears rather than the day someone remembers to add
  // it to a list.
  for (const [name, profile] of Object.entries(eas.build)) {
    if (name === 'staging-certification') continue;
    for (const key of [...CERT_MATRIX_ENABLED, ...CERT_NATIVE_SELECTORS]) {
      assert.ok(
        !(profile.env && key in profile.env),
        `profile "${name}" must not declare certification-only key ${key}`,
      );
    }
  }
});

test('NEGATIVE CONTROL: the leak assertions actually bite', () => {
  // Without this, the three controls above would pass against an empty
  // CERT_MATRIX_ENABLED or a profile map that failed to load.
  assert.ok(CERT_MATRIX_ENABLED.length > 0 && Object.keys(eas.build).length > 1);
  const fixture = { env: { EXPO_PUBLIC_VOICESCAN_ENABLED: 'true' } };
  assert.throws(() =>
    assert.ok(!('EXPO_PUBLIC_VOICESCAN_ENABLED' in fixture.env), 'must reject a leaked flag'),
  );
});

test('Voice Scan is enabled ONLY through the flag, and only where the native selector is also set', () => {
  // A Voice flag without the native RECORD_AUDIO selector produces a build
  // whose mic affordance renders and can never obtain permission -- the
  // "looks enabled, cannot work" state. The two must travel together.
  for (const [name, profile] of Object.entries(eas.build)) {
    const resolved = resolveEasBuildProfile(eas, name);
    const voiceOn = resolved.env?.EXPO_PUBLIC_VOICESCAN_ENABLED === 'true';
    const selectorOn = resolved.env?.KSCAN_VOICE_CERTIFICATION === 'true';
    assert.equal(
      voiceOn,
      selectorOn,
      `profile "${name}": EXPO_PUBLIC_VOICESCAN_ENABLED and KSCAN_VOICE_CERTIFICATION must be set together`,
    );
  }
});
