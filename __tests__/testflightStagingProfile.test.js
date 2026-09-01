// `testflight-staging` — Build 34 staging-backed iOS TestFlight profile guard.
//
// This profile produces the Build 34 FEATURE-VALIDATION artifact: a
// store-distribution, Release-configuration iOS build that is INTENTIONALLY
// pointed at the STAGING backend, so the expanded Build 34 feature set can be
// exercised on real devices via internal TestFlight while production stays
// frozen behind Build 33's Apple review.
//
// It is NOT the production submission artifact and NOT an IAP build — K+ is
// complimentary and no purchasing SDK is present (asserted below).
//
// Why a separate profile rather than reusing `staging` or
// `staging-certification`:
//   - `staging` is internal-distribution (APK/ad-hoc); it cannot produce a
//     TestFlight-eligible store build.
//   - `staging-certification` is the ANDROID Google Play certification artifact.
//     Its feature matrix is a different set of owner rulings (VTO / Packing /
//     Concierge on; K+ and Watchlist deliberately excluded), and it inherits
//     Today with Elise ON. Overloading it would silently retarget one of the
//     two certifications every time the other's rulings changed.
//   - `production` bakes the PRODUCTION Supabase project.
//
// The owner's binding feature rulings for THIS artifact are the four pinned
// below. If any of them changes, this test must change with it — deliberately,
// in the same commit, so a profile edit can never quietly redefine what the
// build is for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
const { resolveEasBuildProfile } = require('../scripts/resolve-eas-build-profiles');

const PROFILE = 'testflight-staging';

const STAGING_SUPABASE_URL = 'https://yzqjvdfgefveprobvvyw.supabase.co';
const PRODUCTION_SUPABASE_URL = 'https://wyyuqfdxucjksghsmhry.supabase.co';

const raw = () => {
  const profile = eas.build[PROFILE];
  assert.ok(profile, `eas.json must define the ${PROFILE} build profile`);
  return profile;
};
const resolved = () => resolveEasBuildProfile(eas, PROFILE);

// ── Artifact shape ───────────────────────────────────────────────────────────

test('testflight-staging produces a store-distribution Release artifact', () => {
  const profile = raw();
  assert.equal(profile.distribution, 'store', 'TestFlight requires store distribution, not internal');
  assert.equal(profile.ios.buildConfiguration, 'Release');
  assert.equal(profile.autoIncrement, true);
  // distribution:store with an APK would be an incoherent Android artifact if
  // anyone ran this profile for Android; keep the pair consistent.
  assert.equal(profile.android.buildType, 'app-bundle');
});

test('the build number comes from the remote EAS counter, not app.json', () => {
  // autoIncrement only does the right thing when EAS owns the counter. With a
  // local source, two machines can mint the same buildNumber and App Store
  // Connect rejects the second upload.
  assert.equal(eas.cli.appVersionSource, 'remote');
});

test('the marketing version is 1.0.1 and comes from app.json', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  assert.equal(appJson.expo.version, '1.0.1');
});

// ── Backend identity ─────────────────────────────────────────────────────────

test('testflight-staging inherits the staging backend and cannot redeclare it', () => {
  const profile = raw();
  assert.equal(profile.extends, 'staging', 'must inherit the staging env verbatim via extends');

  // Redeclaring the backend identity in this profile is what would let it drift
  // onto production later. Inheritance is the guarantee; assert it is intact.
  for (const key of [
    'EXPO_PUBLIC_SUPABASE_URL',
    'EXPO_PUBLIC_SUPABASE_ANON_KEY',
    'EXPO_PUBLIC_ENVIRONMENT',
  ]) {
    assert.ok(!(key in (profile.env ?? {})), `${PROFILE} must not redeclare backend identity key ${key}`);
  }
});

test('the effective backend is staging, and is not production', () => {
  const env = resolved().env;
  assert.equal(env.EXPO_PUBLIC_SUPABASE_URL, STAGING_SUPABASE_URL);
  assert.equal(env.EXPO_PUBLIC_ENVIRONMENT, 'staging');
  assert.notEqual(
    env.EXPO_PUBLIC_SUPABASE_URL,
    PRODUCTION_SUPABASE_URL,
    'testflight-staging must never point at the production Supabase project',
  );
  assert.equal(
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    eas.build.staging.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    'the anon key must be the staging one, inherited unchanged',
  );
});

test('no localhost, emulator, or LAN endpoint leaks into the profile', () => {
  for (const [key, value] of Object.entries(resolved().env)) {
    if (typeof value !== 'string') continue;
    assert.doesNotMatch(value, /localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\./, `${key} points at a local endpoint`);
  }
});

test('no privileged secret is carried in the profile', () => {
  // Everything here is EXPO_PUBLIC_* and ships inside the IPA in cleartext.
  // A service-role JWT, or any *_SECRET / *_SERVICE_ROLE / private API key,
  // would be readable by anyone who downloads the build.
  const env = resolved().env;
  for (const [key, value] of Object.entries(env)) {
    assert.match(key, /^EXPO_PUBLIC_/, `${key} is not an EXPO_PUBLIC_ key and must not be set in a build profile`);
    assert.doesNotMatch(key, /SERVICE_ROLE|SECRET|PRIVATE_KEY/i, `${key} looks like a privileged credential`);
    if (typeof value !== 'string') continue;
    assert.doesNotMatch(value, /service_role/, `${key} carries a service-role credential`);
  }
  // The anon key is expected and permitted; prove it really is the anon role.
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const claims = JSON.parse(Buffer.from(anon.split('.')[1], 'base64').toString('utf8'));
  assert.equal(claims.role, 'anon');
  assert.equal(claims.ref, 'yzqjvdfgefveprobvvyw', 'the anon key must belong to the staging project');
});

test('testflight-staging configures no auto-submit', () => {
  assert.ok(
    !(PROFILE in (eas.submit ?? {})),
    'this pass must not wire an auto-submit path; the owner submits deliberately',
  );
  assert.ok(!('autoSubmit' in raw()), 'autoSubmit must not be set on the build profile');
});

// ── Owner feature rulings ────────────────────────────────────────────────────

const OWNER_RULINGS = Object.freeze({
  EXPO_PUBLIC_TODAY_WITH_ELISE_V1: 'false',
  EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'true',
  EXPO_PUBLIC_SMART_WATCHLIST_V1: 'true',
  EXPO_PUBLIC_VOICESCAN_ENABLED: 'true',
});

test('the four owner feature rulings are pinned in the effective profile', () => {
  const env = resolved().env;
  for (const [key, expected] of Object.entries(OWNER_RULINGS)) {
    assert.equal(env[key], expected, `${key} must be "${expected}" in the effective testflight-staging matrix`);
  }
});

test('the owner rulings are pinned EXPLICITLY, not inherited by accident', () => {
  // Inheriting a ruling from `staging` would mean a later edit to `staging`
  // could silently flip what this artifact is testing.
  const env = raw().env ?? {};
  for (const key of Object.keys(OWNER_RULINGS)) {
    assert.ok(key in env, `${key} must be declared in testflight-staging itself, not inherited`);
  }
});

test('Today with Elise is off here even though the staging profile turns it on', () => {
  // Guards the override specifically: staging has the parent flag ON, so this
  // profile is only correct because it overrides it.
  assert.equal(eas.build.staging.env.EXPO_PUBLIC_TODAY_WITH_ELISE_V1, 'true');
  assert.equal(resolved().env.EXPO_PUBLIC_TODAY_WITH_ELISE_V1, 'false');
});

// ── Free-tier gating parity with production ──────────────────────────────────
//
// Physical QA should exercise the gating we actually intend to ship. Production
// enables exactly three free-tier flags; the rest are off there. Mirroring that
// set is what makes a TestFlight finding transferable to the release build.

const PRODUCTION_FREE_TIER_ENABLED = Object.freeze([
  'EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED',
  'EXPO_PUBLIC_FREE_TIER_WISHLIST_INTENT_ENABLED',
  'EXPO_PUBLIC_FREE_TIER_OUTFIT_GENERATOR_ENABLED',
]);

test('the production free-tier gating set is exactly the three known flags', () => {
  const enabled = Object.keys(eas.build.production.env)
    .filter((key) => key.startsWith('EXPO_PUBLIC_FREE_TIER_'))
    .sort();
  assert.deepEqual(
    enabled,
    [...PRODUCTION_FREE_TIER_ENABLED].sort(),
    'production free-tier gating changed — re-derive the testflight-staging mirror deliberately',
  );
});

test('testflight-staging mirrors the production free-tier gating state', () => {
  const env = resolved().env;
  for (const key of PRODUCTION_FREE_TIER_ENABLED) {
    assert.equal(env[key], 'true', `${key} must mirror production`);
  }
  // And nothing beyond that set may be on, or QA validates gating we do not ship.
  const enabled = Object.keys(env).filter(
    (key) => key.startsWith('EXPO_PUBLIC_FREE_TIER_') && env[key] === 'true',
  );
  assert.deepEqual(enabled.sort(), [...PRODUCTION_FREE_TIER_ENABLED].sort());
});

// ── Production containment ───────────────────────────────────────────────────

test('production keeps Voice Scan and the staging-only rulings off', () => {
  const production = eas.build.production.env;
  // Voice Scan has no implementation; an App Review build must not advertise it.
  assert.notEqual(production.EXPO_PUBLIC_VOICESCAN_ENABLED, 'true');
  // Today with Elise is off in production too (independently owner-decided).
  assert.equal(production.EXPO_PUBLIC_TODAY_WITH_ELISE_V1, 'false');
});

test('the testflight-staging matrix does not leak into staging or production', () => {
  for (const key of Object.keys(raw().env)) {
    assert.ok(
      !(key in eas.build.production.env) || key.startsWith('EXPO_PUBLIC_FREE_TIER_') ||
        key === 'EXPO_PUBLIC_TODAY_WITH_ELISE_V1',
      `${key} must not be introduced into the production profile by this pass`,
    );
  }
  // The ordinary staging profile must not acquire the K+/Watchlist/Voice rulings.
  for (const key of ['EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED', 'EXPO_PUBLIC_SMART_WATCHLIST_V1', 'EXPO_PUBLIC_VOICESCAN_ENABLED']) {
    assert.ok(!(key in eas.build.staging.env), `${key} must not leak into the ordinary staging profile`);
    assert.ok(!(key in eas.build.production.env), `${key} must not leak into the production profile`);
  }
});

// ── Flag resolution: profile env → actual client behaviour ───────────────────
//
// The assertions above prove what the PROFILE says. These prove what the CLIENT
// does with it — the two are only connected through constants/featureFlags.ts,
// and a profile key that no resolver reads would be a silent no-op.

const flagsSource = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');

function loadFlags(env) {
  const source = ts.transpileModule(flagsSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const sandbox = { module: { exports: {} }, exports: {}, require: () => ({}), process: { env }, __DEV__: false, console };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(source, sandbox, { filename: 'constants/featureFlags.ts' });
  return sandbox.module.exports;
}

test('the testflight-staging env resolves to the owner-intended client flag state', () => {
  const flags = loadFlags(resolved().env);
  assert.equal(flags.KPLUS_EARLY_ACCESS_ENABLED, true, 'K+ Early Access must be ON');
  assert.equal(flags.SMART_WATCHLIST_V1, true, 'Smart Watchlist must be ON');
  assert.equal(flags.VOICESCAN_ENABLED, true, 'Voice Scan flag must be ON');
  assert.equal(flags.TODAY_WITH_ELISE_V1, false, 'Today with Elise must be OFF');
});

test('Today with Elise subordinates cannot surface while the parent is off', () => {
  const env = resolved().env;
  // The subordinate env values are still inherited as "true" from staging —
  // exactly as production carries them — so this proves the AND-gate, not just
  // that the subordinate env happens to be absent.
  assert.equal(env.EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1, 'true');
  assert.equal(env.EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1, 'true');

  const flags = loadFlags(env);
  assert.equal(flags.TODAY_WITH_ELISE_ACTIVE, false);
  assert.equal(flags.TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE, false, 'generated greeting must not surface');
  assert.equal(flags.TODAY_WITH_ELISE_WEATHER_ACTIVE, false, 'Today weather must not surface');
});

test('the production profile resolves Voice Scan OFF', () => {
  assert.equal(loadFlags(eas.build.production.env).VOICESCAN_ENABLED, false);
});

test('every other profile resolves Voice Scan OFF', () => {
  for (const name of Object.keys(eas.build)) {
    if (name === PROFILE) continue;
    const env = resolveEasBuildProfile(eas, name).env ?? {};
    assert.equal(loadFlags(env).VOICESCAN_ENABLED, false, `${name} must not enable Voice Scan`);
  }
});

// ── K+ is complimentary: no purchasing anywhere in this artifact ─────────────

test('no Apple IAP or RevenueCat purchasing SDK ships in this build', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    assert.doesNotMatch(
      name,
      /react-native-purchases|expo-in-app-purchases|react-native-iap|StoreKit/i,
      `${name} is a purchasing SDK; K+ Early Access is complimentary`,
    );
  }
  // RevenueCat is reconciled SERVER-side only (supabase/functions/_shared/
  // revenuecat), which never reaches the client or the App Store.
  assert.ok(!('react-native-purchases' in deps));
});
