// `testflight-staging` — Build 34 staging-backed iOS TestFlight profile guard.
//
// Produces the Build 34 FEATURE-VALIDATION artifact: a store-distribution,
// Release-configuration iOS build INTENTIONALLY pointed at the STAGING backend,
// so the expanded Build 34 feature set can be exercised on real devices via
// internal TestFlight while production stays frozen behind Build 33's review.
//
// It is NOT the production submission artifact and NOT an IAP build — K+ is
// complimentary and no purchasing SDK is present (asserted below).
//
// WHY IT EXTENDS `staging-certification` RATHER THAN `staging`.
//
// An earlier version of this profile extended `staging` and re-declared the
// feature matrix itself. That is no longer correct, for two independent
// reasons that both post-date it:
//
//   1. Voice Scan needs a NATIVE selector, not just a product flag.
//      `KSCAN_VOICE_CERTIFICATION` is read by android/app/build.gradle to pick
//      the manifest that grants RECORD_AUDIO. A profile carrying
//      EXPO_PUBLIC_VOICESCAN_ENABLED without it renders a mic affordance that
//      can never obtain permission — the "looks enabled, cannot work" state.
//      easConfigIntegrity.test.js enforces that the two travel together in
//      EVERY profile; inheriting the pair is how this profile satisfies it.
//
//   2. The certification keys are contained to one profile by name.
//      easConfigIntegrity.test.js asserts no profile OTHER than
//      `staging-certification` may DECLARE a certification matrix key. That
//      check reads each profile's own `env`, so inheriting the matrix is
//      allowed and re-declaring it is not.
//
// So this profile owns exactly what is specific to the iOS TestFlight
// artifact — Today with Elise off, and production's free-tier gating — and
// inherits everything else. The owner's four binding rulings are still
// asserted on the EFFECTIVE profile below, wherever each value comes from.

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
  assert.equal(profile.android.buildType, 'app-bundle', 'store distribution must not pair with an APK');
});

test('the build number comes from the remote EAS counter, not app.json', () => {
  // autoIncrement only does the right thing when EAS owns the counter. With a
  // local source two machines can mint the same buildNumber and App Store
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
  assert.equal(profile.extends, 'staging-certification', 'must inherit the certification base');
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
    'the anon key must be the staging one, inherited unchanged through the extends chain',
  );
});

test('no localhost, emulator, or LAN endpoint leaks into the profile', () => {
  for (const [key, value] of Object.entries(resolved().env)) {
    if (typeof value !== 'string') continue;
    assert.doesNotMatch(value, /localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\./, `${key} points at a local endpoint`);
  }
});

test('no privileged secret is carried in the profile', () => {
  // EXPO_PUBLIC_* values ship inside the IPA in cleartext. A service-role JWT
  // or any private key here would be readable by anyone with the build.
  const env = resolved().env;
  const NATIVE_SELECTORS = ['KSCAN_VOICE_CERTIFICATION'];
  for (const [key, value] of Object.entries(env)) {
    if (!NATIVE_SELECTORS.includes(key)) {
      assert.match(key, /^EXPO_PUBLIC_/, `${key} is neither an EXPO_PUBLIC_ flag nor an approved native selector`);
    }
    assert.doesNotMatch(key, /SERVICE_ROLE|SECRET|PRIVATE_KEY|_TOKEN$/i, `${key} looks like a privileged credential`);
    if (typeof value !== 'string') continue;
    assert.doesNotMatch(value, /service_role/, `${key} carries a service-role credential`);
  }
  // The anon key is expected and permitted; prove it really is the anon role.
  const claims = JSON.parse(Buffer.from(env.EXPO_PUBLIC_SUPABASE_ANON_KEY.split('.')[1], 'base64').toString('utf8'));
  assert.equal(claims.role, 'anon');
  assert.equal(claims.ref, 'yzqjvdfgefveprobvvyw', 'the anon key must belong to the staging project');
});

test('testflight-staging configures no auto-submit', () => {
  assert.ok(!(PROFILE in (eas.submit ?? {})), 'this pass must not wire an auto-submit path');
  assert.ok(!('autoSubmit' in raw()), 'autoSubmit must not be set on the build profile');
});

// ── Owner feature rulings ────────────────────────────────────────────────────

const OWNER_RULINGS = Object.freeze({
  EXPO_PUBLIC_TODAY_WITH_ELISE_V1: 'false',
  EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'true',
  EXPO_PUBLIC_SMART_WATCHLIST_V1: 'true',
  EXPO_PUBLIC_VOICESCAN_ENABLED: 'true',
});

test('the four owner feature rulings hold in the effective profile', () => {
  const env = resolved().env;
  for (const [key, expected] of Object.entries(OWNER_RULINGS)) {
    assert.equal(env[key], expected, `${key} must be "${expected}" in the effective testflight-staging matrix`);
  }
});

test('Today with Elise is overridden here, not inherited', () => {
  // The whole extends chain turns it ON (staging: true, staging-certification:
  // inherits). This profile is only correct because it overrides that, so the
  // override must be declared locally rather than depending on a parent.
  assert.equal(eas.build.staging.env.EXPO_PUBLIC_TODAY_WITH_ELISE_V1, 'true');
  assert.equal(resolveEasBuildProfile(eas, 'staging-certification').env.EXPO_PUBLIC_TODAY_WITH_ELISE_V1, 'true');
  assert.equal(raw().env.EXPO_PUBLIC_TODAY_WITH_ELISE_V1, 'false', 'must be declared in this profile');
  assert.equal(resolved().env.EXPO_PUBLIC_TODAY_WITH_ELISE_V1, 'false');
});

// ── Voice Scan: flag state is NOT sufficient evidence ────────────────────────
//
// The Build 34 Voice Scan loss was invisible precisely because a flag can be
// "on" while the feature cannot run. These assert the three things that must
// ALL hold, so this profile can never again claim Voice Scan it cannot deliver.

test('Voice Scan travels with its native selector in this profile', () => {
  const env = resolved().env;
  assert.equal(env.EXPO_PUBLIC_VOICESCAN_ENABLED, 'true');
  assert.equal(
    env.KSCAN_VOICE_CERTIFICATION,
    'true',
    'the flag without the native selector yields a mic affordance that can never obtain permission',
  );
});

test('the Voice implementation this profile enables actually exists', () => {
  // Guards against the exact regression that produced the recovery: a flag
  // enabled against absent code. Deliberately checks the load-bearing pieces
  // rather than a directory listing.
  for (const rel of [
    'components/text-scan/VoiceScanButton.tsx',
    'components/text-scan/VoiceListeningSheet.tsx',
    'hooks/useVoiceScan.ts',
    'services/voice/voiceStateMachine.ts',
    'services/voice/voiceTranscript.ts',
    'services/voice/voiceSubmission.ts',
    'modules/kscan-voice-native/ios/KScanVoiceNativeModule.swift',
    'modules/kscan-voice-native/expo-module.config.json',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} must exist for Voice Scan to be enable-able`);
  }
});

test('the Voice native module is linked, so an enabled flag can actually run', () => {
  // The full autolinking proof lives in __tests__/voiceScanNativeWiring.test.js.
  // This is the profile-side half: a build profile must never enable Voice
  // while the native module is absent from the dependency graph.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.dependencies?.['kscan-voice-native'],
    'file:./modules/kscan-voice-native',
    'without this dependency Expo autolinking never compiles the native Voice module',
  );
});

test('iOS declares the Voice Scan permission strings this profile depends on', () => {
  // iOS is CNG-authoritative: app.json IS the Info.plist. Enabling Voice
  // without these terminates the app on the first Voice tap.
  const infoPlist = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo.ios.infoPlist;
  assert.equal(typeof infoPlist.NSMicrophoneUsageDescription, 'string');
  assert.equal(typeof infoPlist.NSSpeechRecognitionUsageDescription, 'string');
  assert.ok(
    !(infoPlist.UIBackgroundModes ?? []).includes('audio'),
    'Voice Scan is foreground push-to-talk; background audio must stay off',
  );
});

// ── Free-tier gating parity with production ──────────────────────────────────
//
// Physical QA should exercise the gating we actually intend to ship. Production
// enables exactly three free-tier flags; mirroring that set is what makes a
// TestFlight finding transferable to the release build.

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

test('testflight-staging mirrors the production free-tier gating state exactly', () => {
  const env = resolved().env;
  for (const key of PRODUCTION_FREE_TIER_ENABLED) {
    assert.equal(env[key], 'true', `${key} must mirror production`);
  }
  const enabled = Object.keys(env).filter(
    (key) => key.startsWith('EXPO_PUBLIC_FREE_TIER_') && env[key] === 'true',
  );
  assert.deepEqual(enabled.sort(), [...PRODUCTION_FREE_TIER_ENABLED].sort());
});

// ── Production containment ───────────────────────────────────────────────────

test('production enables neither Voice Scan nor its native selector', () => {
  const production = resolveEasBuildProfile(eas, 'production').env;
  assert.notEqual(production.EXPO_PUBLIC_VOICESCAN_ENABLED, 'true');
  assert.notEqual(production.KSCAN_VOICE_CERTIFICATION, 'true');
  assert.equal(production.EXPO_PUBLIC_TODAY_WITH_ELISE_V1, 'false');
});

test('this profile declares only what is specific to it', () => {
  // Everything else must come from the extends chain. Re-declaring a
  // certification key here would break the containment easConfigIntegrity
  // enforces; re-declaring the backend would let this profile drift.
  assert.deepEqual(
    Object.keys(raw().env).sort(),
    ['EXPO_PUBLIC_TODAY_WITH_ELISE_V1', ...PRODUCTION_FREE_TIER_ENABLED].sort(),
  );
});

// ── Flag resolution: profile env → actual client behaviour ───────────────────

const flagsSource = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');

function loadFlags(env) {
  const source = ts.transpileModule(flagsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
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
  assert.equal(flags.VOICESCAN_ENABLED, true, 'Voice Scan must be ON');
  assert.equal(flags.TODAY_WITH_ELISE_V1, false, 'Today with Elise must be OFF');
});

test('Today with Elise subordinates cannot surface while the parent is off', () => {
  const env = resolved().env;
  // The subordinate env values are still inherited as "true" — exactly as
  // production carries them — so this proves the AND-gate, not merely that the
  // subordinate env happens to be absent.
  assert.equal(env.EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1, 'true');
  assert.equal(env.EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1, 'true');

  const flags = loadFlags(env);
  assert.equal(flags.TODAY_WITH_ELISE_ACTIVE, false);
  assert.equal(flags.TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE, false, 'generated greeting must not surface');
  assert.equal(flags.TODAY_WITH_ELISE_WEATHER_ACTIVE, false, 'Today weather must not surface');
});

test('the production profile resolves Voice Scan OFF', () => {
  assert.equal(loadFlags(resolveEasBuildProfile(eas, 'production').env).VOICESCAN_ENABLED, false);
});

test('Voice Scan resolves ON in exactly the two certification-shaped profiles', () => {
  // Deliberately NOT "off everywhere except testflight-staging": the Android
  // `staging-certification` artifact legitimately carries Voice too. Naming
  // both makes adding a third profile a reviewed change.
  const on = Object.keys(eas.build).filter(
    (name) => loadFlags(resolveEasBuildProfile(eas, name).env).VOICESCAN_ENABLED === true,
  );
  assert.deepEqual(on.sort(), ['staging-certification', 'testflight-staging']);
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
});
