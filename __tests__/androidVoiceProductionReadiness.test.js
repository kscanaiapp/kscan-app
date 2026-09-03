'use strict';

// ANDROID-VOICE-01 — Android Voice production-readiness repair.
//
// Goal: after this repair, a future explicitly authorized production Voice
// Scan build must require release CONFIGURATION and artifact CERTIFICATION
// only -- never another source-code repair -- while today's production
// default (Voice dark, no microphone permission) stays exactly what it is.
//
// This file pins the full required state matrix as one executable set:
//   VOICE-PROD-001  real production default
//   VOICE-PROD-002  real staging-certification
//   VOICE-PROD-003  minimal-delta future-production fixture
//   VOICE-PROD-NC-001  invalid pairing (runtime ON, native capability OFF)
//   VOICE-PROD-NC-002  unsupported environment (fails closed)
//   VOICE-PROD-NC-003  permission mismatch (native config parity fail)
//
// Gradle itself cannot be executed here (no Android SDK, and this repair is
// explicitly forbidden from producing a build/APK/AAB/EAS artifact). Every
// assertion below is therefore either a structural check against real
// source/config, or a truth-table check against a JS mirror of the guard
// logic in android/app/build.gradle -- same convention as
// __tests__/androidBuild34CertificationGuards.test.js, whose truth table
// this one deliberately does not re-derive from scratch (see the shared
// mirror comment there); this file focuses on END-TO-END state, not the
// guard's internal wiring.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(REPO_ROOT, ...segments), 'utf8');
const readJson = (...segments) => JSON.parse(read(...segments));

const { resolveEasBuildProfile } = require('../scripts/resolve-eas-build-profiles');

const CERT_PROFILE = 'staging-certification';
const PROD_PROFILE = 'production';
const CAPABILITY_ALLOWED_PROFILES = [CERT_PROFILE, PROD_PROFILE];

/**
 * JS mirror of android/app/build.gradle's full native Voice guard chain,
 * in the same order Gradle evaluates them. Returns the violation reason, or
 * null if the combination is a valid, buildable state.
 */
function voiceGuardViolation(easBuildProfile, voiceScanEnabled, kscanVoiceCertification, kscanVoiceNativeCapability) {
  const materialized = kscanVoiceCertification || kscanVoiceNativeCapability;
  if (voiceScanEnabled !== materialized) return 'mismatch';
  if (easBuildProfile != null && easBuildProfile !== CERT_PROFILE && kscanVoiceCertification) return 'leaked-selector';
  if (easBuildProfile === CERT_PROFILE && !(voiceScanEnabled && kscanVoiceCertification)) return 'incomplete-certification';
  if (easBuildProfile != null && kscanVoiceNativeCapability && !CAPABILITY_ALLOWED_PROFILES.includes(easBuildProfile)) {
    return 'leaked-capability';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * VOICE-PROD-001 — real production default
 * ------------------------------------------------------------------ */

test('VOICE-PROD-001: real production default resolves to no violation and no Voice capability', () => {
  const eas = readJson('eas.json');
  const production = resolveEasBuildProfile(eas, PROD_PROFILE);
  const voiceScanEnabled = production.env?.EXPO_PUBLIC_VOICESCAN_ENABLED === 'true';
  const kscanVoiceCertification = production.env?.KSCAN_VOICE_CERTIFICATION === 'true';
  const kscanVoiceNativeCapability = production.env?.KSCAN_VOICE_NATIVE_CAPABILITY === 'true';

  assert.equal(voiceScanEnabled, false, 'production must not commit EXPO_PUBLIC_VOICESCAN_ENABLED=true');
  assert.equal(kscanVoiceCertification, false, 'production must not commit KSCAN_VOICE_CERTIFICATION=true');
  assert.equal(kscanVoiceNativeCapability, false, 'production must not commit KSCAN_VOICE_NATIVE_CAPABILITY=true');
  assert.equal(
    voiceGuardViolation(PROD_PROFILE, voiceScanEnabled, kscanVoiceCertification, kscanVoiceNativeCapability),
    null,
    'the real production default must be a buildable state',
  );
});

test('VOICE-PROD-001: RECORD_AUDIO is absent from the real production artifact configuration', () => {
  const appConfig = readJson('app.json').expo;
  assert.ok(
    appConfig.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'),
    'app.json must still declare RECORD_AUDIO blocked',
  );
  assert.ok(
    !appConfig.android.permissions.includes('android.permission.RECORD_AUDIO'),
    'app.json must not declare RECORD_AUDIO granted',
  );

  const mainManifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  assert.match(
    mainManifest,
    /<uses-permission android:name="android\.permission\.RECORD_AUDIO" tools:node="remove"\/>/,
    'the main manifest -- which every profile except an active Voice-capable one ships -- must remove RECORD_AUDIO',
  );
});

/* ------------------------------------------------------------------ *
 * VOICE-PROD-002 — real staging-certification
 * ------------------------------------------------------------------ */

test('VOICE-PROD-002: real staging-certification resolves to no violation, selector accepted', () => {
  const eas = readJson('eas.json');
  const certification = resolveEasBuildProfile(eas, CERT_PROFILE);
  const voiceScanEnabled = certification.env?.EXPO_PUBLIC_VOICESCAN_ENABLED === 'true';
  const kscanVoiceCertification = certification.env?.KSCAN_VOICE_CERTIFICATION === 'true';

  assert.equal(voiceScanEnabled, true);
  assert.equal(kscanVoiceCertification, true);
  assert.equal(
    voiceGuardViolation(CERT_PROFILE, voiceScanEnabled, kscanVoiceCertification, false),
    null,
    'the real, unmutated staging-certification profile must remain a buildable state',
  );
});

test('VOICE-PROD-002: RECORD_AUDIO is present in the real certification manifest, still blocked in app.json', () => {
  const certManifest = read('android', 'app', 'src', 'certification', 'AndroidManifest.xml');
  assert.match(
    certManifest,
    /<uses-permission android:name="android\.permission\.RECORD_AUDIO" tools:node="replace"\/>/,
    'the certification manifest must still grant RECORD_AUDIO via tools:node="replace"',
  );
  // Production posture must be untouched by this repair -- re-asserted here
  // so this file alone proves both halves of the matrix side by side.
  const appConfig = readJson('app.json').expo;
  assert.ok(appConfig.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));
});

/* ------------------------------------------------------------------ *
 * VOICE-PROD-003 — minimal-delta future-production fixture
 * ------------------------------------------------------------------ */

test('VOICE-PROD-003: a minimal-delta future-production fixture validates and changes nothing else', () => {
  const eas = readJson('eas.json');
  const realProduction = eas.build.production;

  // Start with the REAL, committed production profile object (not a
  // synthetic "production-like" stand-in), and inject ONLY the two Voice
  // activation settings a release operator would supply out of band.
  const fixtureProduction = {
    ...realProduction,
    env: {
      ...(realProduction.env || {}),
      EXPO_PUBLIC_VOICESCAN_ENABLED: 'true',
      KSCAN_VOICE_NATIVE_CAPABILITY: 'true',
    },
  };

  // Prove the delta really is minimal: every key that existed before is
  // untouched, and the only new keys are the two Voice settings.
  for (const [key, value] of Object.entries(realProduction.env || {})) {
    assert.equal(fixtureProduction.env[key], value, `production env key "${key}" must be unchanged by the fixture`);
  }
  const newKeys = Object.keys(fixtureProduction.env).filter((key) => !(key in (realProduction.env || {})));
  assert.deepEqual(
    newKeys.sort(),
    ['EXPO_PUBLIC_VOICESCAN_ENABLED', 'KSCAN_VOICE_NATIVE_CAPABILITY'],
    'the fixture must add exactly the two Voice activation keys and nothing else',
  );
  for (const key of Object.keys(realProduction)) {
    if (key === 'env') continue;
    assert.deepEqual(fixtureProduction[key], realProduction[key], `production field "${key}" must be unchanged by the fixture`);
  }

  const voiceScanEnabled = fixtureProduction.env.EXPO_PUBLIC_VOICESCAN_ENABLED === 'true';
  const kscanVoiceCertification = fixtureProduction.env.KSCAN_VOICE_CERTIFICATION === 'true';
  const kscanVoiceNativeCapability = fixtureProduction.env.KSCAN_VOICE_NATIVE_CAPABILITY === 'true';

  assert.equal(
    voiceGuardViolation(PROD_PROFILE, voiceScanEnabled, kscanVoiceCertification, kscanVoiceNativeCapability),
    null,
    'the minimal-delta future-production fixture must validate: selector accepted',
  );
  // Materialization would follow: RECORD_AUDIO present, because
  // android/app/build.gradle's sourceSets swap fires on the SAME derived
  // signal (kscanVoiceCertification || kscanVoiceNativeCapability) this
  // mirror computes.
  assert.equal(kscanVoiceCertification || kscanVoiceNativeCapability, true);

  // The real, committed eas.json must NOT have been mutated by constructing
  // this in-memory fixture (self-check that this test built a fixture and
  // did not accidentally assert against a already-activated production).
  const stillReal = readJson('eas.json');
  assert.ok(!('KSCAN_VOICE_NATIVE_CAPABILITY' in (stillReal.build.production.env || {})));
});

/* ------------------------------------------------------------------ *
 * VOICE-PROD-NC-001 — invalid pairing
 * ------------------------------------------------------------------ */

test('VOICE-PROD-NC-001: runtime Voice ON with native capability OFF is rejected before build', () => {
  assert.equal(voiceGuardViolation(PROD_PROFILE, true, false, false), 'mismatch');
  assert.equal(voiceGuardViolation(CERT_PROFILE, true, false, false), 'mismatch');
});

/* ------------------------------------------------------------------ *
 * VOICE-PROD-NC-002 — unsupported environment
 * ------------------------------------------------------------------ */

test('VOICE-PROD-NC-002: an unsupported profile with the capability selector on fails closed', () => {
  for (const profile of ['staging', 'preview', 'development', 'some-future-profile']) {
    assert.equal(
      voiceGuardViolation(profile, true, false, true),
      'leaked-capability',
      `profile "${profile}" must not be able to activate native Voice capability`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * VOICE-PROD-NC-003 — permission mismatch (real gate, not just the mirror)
 * ------------------------------------------------------------------ */

const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-native-config-parity.js');
const GATE_INPUTS = [
  'app.json',
  'eas.json',
  path.join('config', 'native-config-authority.json'),
  path.join('android', 'app', 'build.gradle'),
  path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  path.join('android', 'app', 'src', 'release', 'AndroidManifest.xml'),
  path.join('android', 'app', 'src', 'certification', 'AndroidManifest.xml'),
];

function runGateAgainstMutatedManifest(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-prod-readiness-'));
  try {
    for (const relative of GATE_INPUTS) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, relative), destination);
    }
    mutate(root);
    try {
      execFileSync(process.execPath, [GATE_SCRIPT], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        env: { ...process.env, NATIVE_CONFIG_PARITY_ROOT: root },
      });
      return 0;
    } catch (error) {
      return error.status;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('VOICE-PROD-NC-003: removing RECORD_AUDIO from a Voice-capable manifest fails native config parity', () => {
  // "Voice-capable evaluation" here is the manifest EITHER selector chooses.
  // Stripping the grant it promises (additionalGrantedPermissions in both
  // declared exceptions) must fail the gate -- this is the (b2) rule added
  // by this repair to scripts/check-native-config-parity.js.
  const exitCode = runGateAgainstMutatedManifest((root) => {
    const certPath = path.join(root, 'android', 'app', 'src', 'certification', 'AndroidManifest.xml');
    const mutated = fs
      .readFileSync(certPath, 'utf8')
      .replace(
        '<uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="replace"/>',
        '<!-- RECORD_AUDIO grant removed by VOICE-PROD-NC-003 -->',
      );
    fs.writeFileSync(certPath, mutated);
  });
  assert.equal(exitCode, 1);
});

test('VOICE-PROD-NC-003 self-check: the unmutated fixture passes (the mutation above is what fails, not the fixture setup)', () => {
  const exitCode = runGateAgainstMutatedManifest(() => {});
  assert.equal(exitCode, 0);
});
