'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { PROFILE, REQUIRED_OFF, OPTIONAL_OFF, validateReleaseProfile, resolveCheckedProfile } = require('../scripts/check-build35-release-profile');
const ROOT = path.resolve(__dirname, '..');
function input() {
  return {
    eas: JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8')),
    app: JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')),
    gradle: fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8'),
  };
}
function checkMutation(mutate, expected) {
  const fixture = input();
  mutate(fixture);
  assert.match(validateReleaseProfile(fixture).join('\n'), expected);
}

test('canonical release resolves all holds OFF with production identities and store artifact shape', () => {
  assert.deepEqual(validateReleaseProfile(input()), []);
});
test('certification remains independently enabled for proof gathering', () => {
  const cert = resolveCheckedProfile(input().eas, 'production-certification');
  for (const key of ['EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED', 'EXPO_PUBLIC_PACKING_INTELLIGENCE_V1', 'EXPO_PUBLIC_SMART_WATCHLIST_V1', 'EXPO_PUBLIC_VTO_UI_ENABLED', 'EXPO_PUBLIC_VOICESCAN_ENABLED']) {
    assert.equal(cert.env[key], 'true');
  }
});
for (const key of REQUIRED_OFF) {
  test(`release guard rejects unapproved ${key} enablement or inherited/missing override`, () => {
    checkMutation(({ eas }) => { eas.build[PROFILE].env[key] = 'true'; }, /false/);
    checkMutation(({ eas }) => { delete eas.build[PROFILE].env[key]; eas.build.production.env[key] = 'true'; }, /false|override/);
  });
}
for (const key of OPTIONAL_OFF) {
  test(`release guard rejects inherited ${key}`, () => {
    checkMutation(({ eas }) => { eas.build.production.env[key] = 'true'; }, /absent or explicitly false/);
  });
}
test('a certification inheritance swap is rejected even if all held flags are overridden', () => {
  checkMutation(({ eas }) => { eas.build[PROFILE].extends = 'production-certification'; }, /independently of certification/);
});
test('resolver refuses missing parents, malformed maps and cycles rather than silently merging partial profiles', () => {
  for (const mutate of [
    (eas) => { eas.build.production.extends = 'absent-parent'; },
    (eas) => { eas.build.production.extends = '__proto__'; },
    (eas) => { eas.build.production.extends = PROFILE; },
    (eas) => { eas.build.production.env = []; },
  ]) {
    const fixture = input(); mutate(fixture.eas);
    assert.ok(validateReleaseProfile(fixture).length > 0);
  }
});
test('resolver honors nested parent env/platform fields before release overrides', () => {
  const fixture = input();
  fixture.eas.build.production.extends = 'base';
  fixture.eas.build.base = { env: { EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1: 'true' }, ios: { simulator: true } };
  assert.equal(resolveCheckedProfile(fixture.eas, PROFILE).env.EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1, 'false');
  assert.match(validateReleaseProfile(fixture).join('\n'), /physical-device/);
});
test('production identity checks reject substring spoofing, staging keys and native package drift', () => {
  checkMutation(({ eas }) => { eas.build.production.env.EXPO_PUBLIC_SUPABASE_URL += '.invalid'; }, /exact production origin/);
  checkMutation(({ eas }) => { eas.build.production.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = eas.build.staging.env.EXPO_PUBLIC_SUPABASE_ANON_KEY; }, /production anon identity/);
  checkMutation(({ app }) => { app.expo.ios.bundleIdentifier = 'com.kscanai.debug'; }, /native identities/);
  checkMutation((fixture) => { fixture.gradle = fixture.gradle.replace("applicationId 'com.kscanai.app'", "applicationId 'com.kscanai.debug'"); }, /applicationId/);
});
test('effective build environment must be complete, OFF and free of unapproved endpoints', () => {
  const fixture = input();
  fixture.effectiveEnv = resolveCheckedProfile(fixture.eas, PROFILE).env;
  assert.deepEqual(validateReleaseProfile(fixture), []);
  fixture.effectiveEnv = { ...fixture.effectiveEnv, EXPO_PUBLIC_ELISE_SPEECH: 'true' };
  assert.match(validateReleaseProfile(fixture).join('\n'), /ELISE_SPEECH/);
  fixture.effectiveEnv = { EXPO_PUBLIC_ENVIRONMENT: 'production' };
  assert.match(validateReleaseProfile(fixture).join('\n'), /explicitly false/);
  checkMutation(({ eas }) => { eas.build.production.env.EXPO_PUBLIC_API_URL = 'http://localhost:3001'; }, /endpoint is not approved/);
});
test('a newly enabled capability in any parent fails rather than expanding release scope', () => {
  checkMutation(({ eas }) => { eas.build.production.env.EXPO_PUBLIC_NEW_UNCERTIFIED_FEATURE = 'true'; }, /unapproved public capability/);
});
test('debug client, simulator, internal distribution and disabled versioning are rejected', () => {
  for (const mutate of [
    (profile) => { profile.developmentClient = true; },
    (profile) => { profile.ios.simulator = true; },
    (profile) => { profile.distribution = 'internal'; },
    (profile) => { profile.autoIncrement = false; },
    (profile) => { profile.android.gradleCommand = ':app:assembleDebug'; },
    (profile) => { profile.android.withoutCredentials = true; },
    (profile) => { profile.ios.autoIncrement = false; },
  ]) checkMutation(({ eas }) => mutate(eas.build[PROFILE]), /Release|release|numbering|iOS/);
});
test('CLI withholds malformed input values and exits nonzero', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-release-test-'));
  const file = path.join(folder, 'effective.json');
  try {
    fs.writeFileSync(file, '{ "private": "DO_NOT_LOG_THIS"');
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-build35-release-profile.js'), '--effective-env-json', file], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_LOG_THIS/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
