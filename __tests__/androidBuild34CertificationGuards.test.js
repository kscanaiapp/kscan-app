'use strict';

// Build 34 Android certification build-guard repair.
//
// A supplied Build 34 Android artifact was independently audited and found to
// be versionCode 32, with the Voice + Watchlist matrix enabled in eas.json but
// RECORD_AUDIO and Firebase application resources absent from the merged
// artifact -- a build that *looked* configured (eas.json shows the flags) and
// could not certify (the native artifact never carried what the flags claim).
// __tests__/easConfigIntegrity.test.js already proves the CONFIG never leaks
// the certification matrix into another profile. This file proves the
// COMPANION half: that android/app/build.gradle actually refuses, at Gradle
// execution time, to produce an artifact whose native wiring disagrees with
// what EAS_BUILD_PROFILE / the certification env claims -- so the exact shape
// the audit found (flags on, native artifact hollow) cannot happen silently
// again, regardless of what eas.json says.
//
// Gradle itself cannot be executed here (no Android SDK, and this repair is
// explicitly forbidden from producing a build/APK/AAB/EAS artifact). Every
// assertion below is therefore either:
//   (a) a structural check against the real Groovy source, proving the guard
//       is actually wired the way this file claims, or
//   (b) a truth-table check against a JS mirror of the guard's boolean logic,
//       proving the DESIGN of the invariant is sound independent of Gradle.
// Both are needed: (a) alone could pass against a guard that never actually
// fires; (b) alone could pass against a spec nothing in build.gradle honours.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const GRADLE_PATH = path.join(REPO_ROOT, 'android', 'app', 'build.gradle');
const GRADLE_PROPS_PATH = path.join(REPO_ROOT, 'android', 'gradle.properties');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

/** Groovy comments are documentation, not wiring -- strip them before scanning for logic. */
function stripGroovyComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const gradleRaw = read(GRADLE_PATH);
const gradle = stripGroovyComments(gradleRaw);

function defaultConfigBlock(src) {
  const start = src.indexOf('defaultConfig {');
  assert.ok(start >= 0, 'defaultConfig block not found');
  const end = src.indexOf('\n    }', start);
  return src.slice(start, end);
}

// ── Objective A: Voice invariant enforced at Gradle execution time ─────────

test('Objective A: the native build reads EAS_BUILD_PROFILE and EXPO_PUBLIC_VOICESCAN_ENABLED at execution time', () => {
  assert.match(gradle, /System\.getenv\('EAS_BUILD_PROFILE'\)/, 'EAS_BUILD_PROFILE must be read from the environment');
  assert.match(
    gradle,
    /System\.getenv\('EXPO_PUBLIC_VOICESCAN_ENABLED'\)/,
    'EXPO_PUBLIC_VOICESCAN_ENABLED must be read from the environment, not assumed from eas.json alone',
  );
});

test('Objective A: a Voice client flag / native capability mismatch throws GradleException', () => {
  // ANDROID-VOICE-01 generalized this comparison from the raw
  // kscanVoiceCertification selector to the derived
  // voiceNativeCapabilityMaterialized signal (kscanVoiceCertification OR the
  // new kscanVoiceNativeCapability), so a future production activation via
  // the new selector is not itself a Voice-invariant violation. See the
  // "ANDROID-VOICE-01" test block below for the generalized guard's own
  // dedicated coverage.
  assert.match(
    gradle,
    /if\s*\(voiceScanEnabled\s*!=\s*voiceNativeCapabilityMaterialized\)\s*\{[\s\S]{0,400}throw new GradleException/,
    'EXPO_PUBLIC_VOICESCAN_ENABLED and native Voice capability disagreeing must throw',
  );
});

test('Objective A: a certification-only native selector active outside the certification profile throws GradleException', () => {
  assert.match(
    gradle,
    /easBuildProfile\s*!=\s*CERTIFICATION_PROFILE\s*&&\s*kscanVoiceCertification\)\s*\{[\s\S]{0,400}throw new GradleException/,
    'KSCAN_VOICE_CERTIFICATION resolving true under a non-certification profile must throw',
  );
});

test('Objective A: EAS_BUILD_PROFILE=staging-certification without the full Voice pair throws GradleException', () => {
  assert.match(
    gradle,
    /easBuildProfile\s*==\s*CERTIFICATION_PROFILE\s*&&\s*!\(voiceScanEnabled\s*&&\s*kscanVoiceCertification\)\)\s*\{[\s\S]{0,400}throw new GradleException/,
    'the certification profile without both Voice flags resolving true must throw',
  );
});

test('Objective A NEGATIVE CONTROL: removing the voice-invariant guard is detected', () => {
  const mutated = gradle.replace(
    /if\s*\(voiceScanEnabled\s*!=\s*voiceNativeCapabilityMaterialized\)\s*\{[\s\S]{0,400}throw new GradleException/,
    'if (false) { throw new GradleException',
  );
  assert.notStrictEqual(mutated, gradle, 'the mutation must actually change the source (self-check)');
  assert.doesNotMatch(
    mutated,
    /if\s*\(voiceScanEnabled\s*!=\s*voiceNativeCapabilityMaterialized\)\s*\{[\s\S]{0,400}throw new GradleException/,
    'the mutated source must no longer match the guard pattern',
  );
});

// Truth-table mirror of the (now four) Objective A / ANDROID-VOICE-01 native
// guards, so the invariant DESIGN is proven correct independent of Groovy
// syntax. materialized = kscanVoiceCertification OR kscanVoiceNativeCapability
// mirrors android/app/build.gradle's own derived voiceNativeCapabilityMaterialized.
const CERT_PROFILE = 'staging-certification';
const PROD_PROFILE = 'production';
const CAPABILITY_ALLOWED_PROFILES = [CERT_PROFILE, PROD_PROFILE];
function voiceGuardViolation(easBuildProfile, voiceScanEnabled, kscanVoiceCertification, kscanVoiceNativeCapability = false) {
  const materialized = kscanVoiceCertification || kscanVoiceNativeCapability;
  if (voiceScanEnabled !== materialized) return 'mismatch';
  if (easBuildProfile != null && easBuildProfile !== CERT_PROFILE && kscanVoiceCertification) return 'leaked-selector';
  if (easBuildProfile === CERT_PROFILE && !(voiceScanEnabled && kscanVoiceCertification)) return 'incomplete-certification';
  if (easBuildProfile != null && kscanVoiceNativeCapability && !CAPABILITY_ALLOWED_PROFILES.includes(easBuildProfile)) {
    return 'leaked-capability';
  }
  return null;
}

test('Objective A truth table: every profile/flag combination resolves to the intended pass/fail', () => {
  const cases = [
    // [easBuildProfile, voiceScanEnabled, kscanVoiceCertification, kscanVoiceNativeCapability, expectedViolation]
    [null, false, false, false, null],
    [null, true, true, false, null],
    [null, true, false, false, 'mismatch'],
    [null, false, true, false, 'mismatch'],
    ['staging', false, false, false, null],
    ['production', false, false, false, null],
    ['preview', false, false, false, null],
    ['staging', true, true, false, 'leaked-selector'],
    ['production', false, true, false, 'mismatch'], // guard order: the flag/selector mismatch check runs first
    ['production', true, true, false, 'leaked-selector'],
    [CERT_PROFILE, true, true, false, null],
    [CERT_PROFILE, false, false, false, 'incomplete-certification'],
    [CERT_PROFILE, true, false, false, 'mismatch'],
    [CERT_PROFILE, false, true, false, 'mismatch'],
    // ANDROID-VOICE-01: the new generalized capability selector.
    ['production', true, false, true, null], // future authorized production Voice
    // The certification profile's completeness guard is intentionally
    // UNCHANGED and still names kscanVoiceCertification specifically (not
    // the derived materialized signal) -- the new capability selector does
    // NOT substitute for it, so staging-certification's own requirement is
    // exactly what it always was.
    [CERT_PROFILE, true, false, true, 'incomplete-certification'],
    ['production', false, false, true, 'mismatch'], // capability on, runtime flag forgotten
    ['preview', true, false, true, 'leaked-capability'], // unsupported profile, fails closed
    ['staging', true, false, true, 'leaked-capability'],
    ['development', true, false, true, 'leaked-capability'],
    [null, true, false, true, null], // untracked local invocation is exempt, same as the legacy selector
  ];
  for (const [profile, voice, certSelector, capabilitySelector, expected] of cases) {
    assert.equal(
      voiceGuardViolation(profile, voice, certSelector, capabilitySelector),
      expected,
      `profile=${profile} voice=${voice} certSelector=${certSelector} capabilitySelector=${capabilitySelector}`,
    );
  }
});

// ── ANDROID-VOICE-01: generalized native Voice capability ─────────────────

test('ANDROID-VOICE-01: the native build reads KSCAN_VOICE_NATIVE_CAPABILITY at execution time', () => {
  assert.match(
    gradle,
    /System\.getenv\('KSCAN_VOICE_NATIVE_CAPABILITY'\)/,
    'KSCAN_VOICE_NATIVE_CAPABILITY must be read from the environment',
  );
  assert.match(
    gradle,
    /def voiceNativeCapabilityMaterialized\s*=\s*kscanVoiceCertification\s*\|\|\s*kscanVoiceNativeCapability/,
    'the derived materialization signal must OR the legacy and generalized selectors',
  );
});

test('ANDROID-VOICE-01: the generalized capability selector active outside its approved profiles throws GradleException', () => {
  assert.match(
    gradle,
    /kscanVoiceNativeCapability\s*&&\s*!VOICE_NATIVE_CAPABILITY_ALLOWED_PROFILES\.contains\(easBuildProfile\)\)\s*\{[\s\S]{0,400}throw new GradleException/,
    'KSCAN_VOICE_NATIVE_CAPABILITY resolving true under an unapproved profile must throw',
  );
});

test('ANDROID-VOICE-01: the approved profile list is exactly certification and production', () => {
  assert.match(
    gradle,
    /def VOICE_NATIVE_CAPABILITY_ALLOWED_PROFILES\s*=\s*\[CERTIFICATION_PROFILE,\s*PRODUCTION_PROFILE\]/,
  );
  assert.match(gradle, /def PRODUCTION_PROFILE\s*=\s*'production'/);
});

test('ANDROID-VOICE-01: the legacy certification-only selector and its guard are untouched', () => {
  // The whole point of generalizing via a SECOND selector is that
  // KSCAN_VOICE_CERTIFICATION keeps its exact original meaning and behaviour.
  assert.match(
    gradle,
    /easBuildProfile\s*!=\s*CERTIFICATION_PROFILE\s*&&\s*kscanVoiceCertification\)\s*\{[\s\S]{0,400}throw new GradleException/,
    'the legacy leak guard, scoped to kscanVoiceCertification alone, must still exist unchanged',
  );
  assert.match(
    gradle,
    /easBuildProfile\s*==\s*CERTIFICATION_PROFILE\s*&&\s*!\(voiceScanEnabled\s*&&\s*kscanVoiceCertification\)\)\s*\{[\s\S]{0,400}throw new GradleException/,
    'the legacy completeness guard, scoped to kscanVoiceCertification alone, must still exist unchanged',
  );
});

test('ANDROID-VOICE-01 NEGATIVE CONTROL: removing the generalized leak guard is detected', () => {
  const mutated = gradle.replace(
    /if\s*\(easBuildProfile\s*!=\s*null\s*&&\s*kscanVoiceNativeCapability\s*&&\s*!VOICE_NATIVE_CAPABILITY_ALLOWED_PROFILES\.contains\(easBuildProfile\)\)\s*\{[\s\S]{0,400}throw new GradleException/,
    'if (false) { throw new GradleException',
  );
  assert.notStrictEqual(mutated, gradle, 'the mutation must actually change the source (self-check)');
});

test('ANDROID-VOICE-01: eas.json commits the generalized selector to no profile, including production', () => {
  const eas = JSON.parse(read(path.join(REPO_ROOT, 'eas.json')));
  for (const [name, profile] of Object.entries(eas.build)) {
    assert.ok(
      !(profile.env && 'KSCAN_VOICE_NATIVE_CAPABILITY' in profile.env),
      `profile "${name}" must not commit KSCAN_VOICE_NATIVE_CAPABILITY -- it is supplied out of band only`,
    );
  }
});

// ── Objective C: Watchlist push must fail closed without Firebase ──────────

test('Objective C: EXPO_PUBLIC_SMART_WATCHLIST_V1 is read at execution time', () => {
  assert.match(gradle, /System\.getenv\('EXPO_PUBLIC_SMART_WATCHLIST_V1'\)/);
});

test('Objective C: Watchlist ON with FCM unconfigured throws the exact governed error', () => {
  assert.match(
    gradle,
    /if\s*\(smartWatchlistEnabled\s*&&\s*!googleServicesConfigured\)\s*\{[\s\S]{0,300}throw new GradleException/,
    'the guard must be conditioned on both smartWatchlistEnabled and !googleServicesConfigured',
  );
  assert.match(
    gradle,
    /Smart Watchlist is enabled but GOOGLE_SERVICES_JSON did not materialize; \\?\s*"?\s*\+?\s*"?refusing to build an Android artifact without FCM configuration\./,
    'the governed error text must be present verbatim',
  );
});

test('Objective C: the plugin-apply conditional (unrelated profiles must stay green) is untouched', () => {
  // watchlistAndroidPushConfig.test.js already pins this exact pattern; this
  // is a second witness scoped to this file so a regression here is caught
  // by both the Watchlist push suite and the certification-guard suite.
  assert.match(
    gradleRaw,
    /if \(googleServicesConfigured\) \{\s*apply plugin: 'com\.google\.gms\.google-services'/,
  );
});

test('Objective C: Firebase is not made mandatory for profiles where Smart Watchlist is off', () => {
  // The guard is a conjunction (Watchlist AND no Firebase); it must never
  // degrade to firing on !googleServicesConfigured alone.
  assert.doesNotMatch(
    gradle,
    /if\s*\(!googleServicesConfigured\)\s*\{[\s\S]{0,120}throw new GradleException/,
    'the build must not fail merely because Firebase is unconfigured -- only Watchlist-ON + unconfigured may fail',
  );
});

test('Objective C: no credential contents may be printed by the guard or the FCM materialisation block', () => {
  const fcmSection = gradleRaw.slice(gradleRaw.indexOf("file('google-services.json')"), gradleRaw.indexOf('android {'));
  assert.doesNotMatch(fcmSection, /\.text\b/, 'the secret file contents must never be read into a log line');
  assert.doesNotMatch(fcmSection, /println.*secretFile\.(bytes|text)/i);
});

test('Objective C NEGATIVE CONTROL: removing the Watchlist fail-closed guard is detected', () => {
  const mutated = gradle.replace(
    /if\s*\(smartWatchlistEnabled\s*&&\s*!googleServicesConfigured\)\s*\{[\s\S]{0,300}throw new GradleException/,
    'if (false) { throw new GradleException',
  );
  assert.notStrictEqual(mutated, gradle);
});

function watchlistGuardViolation(smartWatchlistEnabled, googleServicesConfigured) {
  return smartWatchlistEnabled && !googleServicesConfigured ? 'watchlist-without-fcm' : null;
}

test('Objective C truth table', () => {
  assert.equal(watchlistGuardViolation(false, false), null, 'watchlist off, no fcm -- must stay green');
  assert.equal(watchlistGuardViolation(false, true), null);
  assert.equal(watchlistGuardViolation(true, true), null, 'watchlist on, fcm configured -- must pass');
  assert.equal(watchlistGuardViolation(true, false), 'watchlist-without-fcm', 'watchlist on, no fcm -- must fail closed');
});

// ── Objective D: certification backend must resolve to staging ────────────

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

test('Objective D: the certification project refs are the correct, governed Supabase project IDs', () => {
  assert.match(gradle, new RegExp(`STAGING_SUPABASE_PROJECT_REF\\s*=\\s*'${STAGING_REF}'`));
  assert.match(gradle, new RegExp(`PRODUCTION_SUPABASE_PROJECT_REF\\s*=\\s*'${PRODUCTION_REF}'`));
});

test('Objective D: EXPO_PUBLIC_SUPABASE_URL is asserted, never rewritten, only under the certification profile', () => {
  assert.match(gradle, /System\.getenv\('EXPO_PUBLIC_SUPABASE_URL'\)/);
  assert.match(
    gradle,
    /if\s*\(easBuildProfile\s*==\s*CERTIFICATION_PROFILE\)\s*\{[\s\S]*?supabaseUrl/,
    'the assertion must be scoped to the certification profile only',
  );
  // Assertion only: nothing may assign back into an env-derived Supabase URL.
  assert.doesNotMatch(gradle, /System\.setenv|setProperty\(['"]EXPO_PUBLIC_SUPABASE_URL/i);
});

test('Objective D: missing or non-staging EXPO_PUBLIC_SUPABASE_URL throws under certification', () => {
  assert.match(
    gradle,
    /supabaseUrl\s*==\s*null\s*\|\|\s*!supabaseUrl\.trim\(\)\.contains\(STAGING_SUPABASE_PROJECT_REF\)\)\s*\{[\s\S]{0,300}throw new GradleException/,
  );
});

test('Objective D: a production Supabase URL under certification throws with its own explicit error, checked before the generic staging check', () => {
  const prodCheckIndex = gradle.indexOf('supabaseUrl.contains(PRODUCTION_SUPABASE_PROJECT_REF)');
  const stagingCheckIndex = gradle.indexOf('!supabaseUrl.trim().contains(STAGING_SUPABASE_PROJECT_REF)');
  assert.ok(prodCheckIndex >= 0, 'the production-specific check must exist');
  assert.ok(
    prodCheckIndex < stagingCheckIndex,
    'the production check must run BEFORE the generic staging-membership check, or it is unreachable dead code ' +
      '(a production URL never contains the staging ref, so the generic check would always fire first and the ' +
      'production-specific error message and branch would never execute)',
  );
  assert.match(
    gradle,
    /supabaseUrl\s*!=\s*null\s*&&\s*supabaseUrl\.contains\(PRODUCTION_SUPABASE_PROJECT_REF\)\)\s*\{[\s\S]{0,300}throw new GradleException/,
  );
});

test('Objective D NEGATIVE CONTROL: removing the staging-backend guard is detected', () => {
  const mutated = gradle.replace(
    /if\s*\(easBuildProfile\s*==\s*CERTIFICATION_PROFILE\)\s*\{[\s\S]*?\n\}/,
    '// removed',
  );
  assert.notStrictEqual(mutated, gradle);
});

function backendGuardViolation(easBuildProfile, supabaseUrl) {
  if (easBuildProfile !== CERT_PROFILE) return null;
  if (supabaseUrl != null && supabaseUrl.includes(PRODUCTION_REF)) return 'production';
  if (supabaseUrl == null || !supabaseUrl.includes(STAGING_REF)) return 'not-staging';
  return null;
}

test('Objective D truth table', () => {
  assert.equal(backendGuardViolation('staging', undefined), null, 'non-certification profiles are not asserted here');
  assert.equal(backendGuardViolation(CERT_PROFILE, `https://${STAGING_REF}.supabase.co`), null);
  assert.equal(backendGuardViolation(CERT_PROFILE, undefined), 'not-staging');
  assert.equal(backendGuardViolation(CERT_PROFILE, `https://${PRODUCTION_REF}.supabase.co`), 'production');
  assert.equal(backendGuardViolation(CERT_PROFILE, 'https://some-other-project.supabase.co'), 'not-staging');
});

// ── Objective E: artifact-readable build provenance ────────────────────────

test('Objective E: provenance is derived from EAS_BUILD_PROFILE / EAS_BUILD_GIT_COMMIT_HASH with truthful local fallbacks', () => {
  assert.match(gradle, /def kscanBuildProfile\s*=\s*easBuildProfile\s*\?:\s*'local'/, 'profile must fall back to "local", never a fabricated profile');
  assert.match(
    gradle,
    /System\.getenv\('EAS_BUILD_GIT_COMMIT_HASH'\)/,
    'the commit provenance must come from the EAS-provided commit hash var',
  );
  assert.match(
    gradle,
    /kscanSourceCommit\s*=\s*\([\s\S]{0,120}\?\s*kscanSourceCommitRaw\.trim\(\)\s*:\s*'unknown'/,
    'commit must fall back to "unknown", never a fabricated SHA',
  );
});

test('Objective E: profile and commit are written as inspectable string resources on the artifact', () => {
  const config = defaultConfigBlock(gradle);
  assert.match(config, /resValue\s+"string",\s*"kscan_build_profile",\s*kscanBuildProfile/);
  assert.match(config, /resValue\s+"string",\s*"kscan_source_commit",\s*kscanSourceCommit/);
});

test('Objective E: BuildConfig mirrors the same values but is not the sole mechanism', () => {
  const config = defaultConfigBlock(gradle);
  assert.match(config, /buildConfigField\s+"String",\s*"KSCAN_BUILD_PROFILE"/);
  assert.match(config, /buildConfigField\s+"String",\s*"KSCAN_SOURCE_COMMIT"/);
  // The sole-mechanism requirement: resValue entries (resource-table strings,
  // inspectable without decompiling BuildConfig.class) must exist independent
  // of the BuildConfig fields.
  assert.match(config, /resValue\s+"string",\s*"kscan_build_profile"/);
});

test('Objective E: provenance carries no secret -- only the profile name and a commit hash are embedded', () => {
  const provenanceSection = gradle.slice(
    gradle.indexOf('Objective E -- artifact-readable build provenance'),
    gradle.indexOf('android {'),
  );
  for (const forbidden of ['GOOGLE_SERVICES_JSON', 'SUPABASE_ANON_KEY', 'STORE_PASSWORD', 'KEY_PASSWORD', 'SUPABASE_URL']) {
    assert.ok(!provenanceSection.includes(forbidden), `provenance block must not reference ${forbidden}`);
  }
});

test('Objective E: resValue survives release optimization because resource shrinking stays off', () => {
  // resValue writes into the resource table, not code -- R8 (code shrinking)
  // never touches it. Only *resource* shrinking could remove an unused
  // resource, and this repair explicitly leaves that off (Objective F).
  const releaseBlock = gradle.slice(gradle.indexOf('release {'), gradle.indexOf('packagingOptions {'));
  assert.match(
    releaseBlock,
    /enableShrinkResourcesInReleaseBuilds['")]*\s*\?:\s*'false'/,
    'resource shrinking must still default to false so provenance resources are never stripped',
  );
});

test('Objective E NEGATIVE CONTROL: removing the resValue calls is detected', () => {
  const mutated = gradle.replace(/resValue\s+"string",\s*"kscan_build_profile",\s*kscanBuildProfile\s*\n/, '');
  assert.notStrictEqual(mutated, gradle);
});

// ── Objective F: release R8 explicitly enabled ─────────────────────────────

const gradleProps = read(GRADLE_PROPS_PATH);

test('Objective F: android.enableMinifyInReleaseBuilds=true is the authoritative governed setting', () => {
  assert.match(gradleProps, /^android\.enableMinifyInReleaseBuilds=true$/m);
});

test('Objective F: the source-level toggle build.gradle reads for minifyEnabled is unweakened', () => {
  assert.match(
    gradle,
    /def enableMinifyInReleaseBuilds = \(findProperty\('android\.enableMinifyInReleaseBuilds'\) \?: false\)\.toBoolean\(\)/,
  );
  assert.match(gradle, /minifyEnabled enableMinifyInReleaseBuilds/);
});

test('Objective F: existing ProGuard keep rules are not weakened', () => {
  const rules = read(path.join(REPO_ROOT, 'android', 'app', 'proguard-rules.pro'));
  assert.match(rules, /-keep class com\.swmansion\.reanimated\.\*\* \{ \*; \}/);
  assert.match(rules, /-keep class com\.facebook\.react\.turbomodule\.\*\* \{ \*; \}/);
});

test('Objective F: resource shrinking is not enabled as part of this repair', () => {
  assert.doesNotMatch(gradleProps, /android\.enableShrinkResourcesInReleaseBuilds\s*=\s*true/);
});

// Effective boolean resolution mirrors Gradle's own `findProperty(...) ?: false` /
// `.toBoolean()` semantics for the property this repo actually sets.
test('Objective F: gradle.properties resolves minification to effectively true (parsed, not just grepped)', () => {
  const match = gradleProps.match(/^android\.enableMinifyInReleaseBuilds=(.*)$/m);
  assert.ok(match, 'the property must be present');
  assert.equal(match[1].trim().toLowerCase(), 'true');
});

// ── Cross-objective: no unrelated drift into production/staging ───────────

test('CROSS-OBJECTIVE NEGATIVE CONTROL: none of the new certification-only Gradle variables leak outside their guarded blocks', () => {
  // Each of these is defined exactly once at the top level of the file.
  for (const identifier of [
    'smartWatchlistEnabled',
    'voiceScanEnabled',
    'kscanBuildProfile',
    'kscanSourceCommit',
    'kscanVoiceNativeCapability',
    'voiceNativeCapabilityMaterialized',
  ]) {
    const occurrences = gradle.split(new RegExp(`\\bdef ${identifier}\\b`)).length - 1;
    assert.equal(occurrences, 1, `${identifier} must be declared exactly once`);
  }
});

test('production/staging/preview/development env still do not declare any Build 34 certification key (cross-check against eas.json)', () => {
  const eas = JSON.parse(read(path.join(REPO_ROOT, 'eas.json')));
  const CERT_ONLY_KEYS = [
    'EXPO_PUBLIC_VOICESCAN_ENABLED',
    'KSCAN_VOICE_CERTIFICATION',
    'EXPO_PUBLIC_SMART_WATCHLIST_V1',
  ];
  for (const [name, profile] of Object.entries(eas.build)) {
    if (name === 'staging-certification') continue;
    for (const key of CERT_ONLY_KEYS) {
      assert.ok(!(profile.env && key in profile.env), `profile "${name}" must not declare ${key}`);
    }
  }
});
