const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkAndroidApkProfile } = require('../scripts/check-android-apk-profile.cjs');
const eas = require('../eas.json');
const environment = { EAS_BUILD_PROFILE: 'build35-testing', EAS_BUILD_PLATFORM: 'android' };

test('the approved existing internal profile builds a Production-equivalent Android APK', () => {
  assert.deepEqual(checkAndroidApkProfile(eas, environment), {
    applicable: true, platform: 'android', artifact: 'apk', distribution: 'internal',
  });
});

test('the APK profile rejects iOS, missing platform, AAB, and store distribution', () => {
  assert.throws(() => checkAndroidApkProfile(eas, { ...environment, EAS_BUILD_PLATFORM: 'ios' }), /Android APK-only/);
  assert.throws(() => checkAndroidApkProfile(eas, { EAS_BUILD_PROFILE: 'build35-testing' }), /Android APK-only/);
  for (const mutation of [p => p.android.buildType = 'app-bundle', p => p.distribution = 'store',
    p => p.android.applicationArchivePath = 'app.aab']) {
    const changed = structuredClone(eas);
    mutation(changed.build['build35-testing']);
    assert.throws(() => checkAndroidApkProfile(changed, environment), /internal APK/);
  }
});

test('APK capability/Elise drift fails closed without altering other build profiles', () => {
  for (const key of ['EXPO_PUBLIC_VOICESCAN_ENABLED', 'KSCAN_VOICE_NATIVE_CAPABILITY',
    'EXPO_PUBLIC_ELISE_SPEECH', 'EXPO_PUBLIC_ELISE_V10']) {
    const changed = structuredClone(eas);
    changed.build['build35-testing'].env[key] = 'false';
    assert.throws(() => checkAndroidApkProfile(changed, environment), /capability matrix/);
  }
  assert.deepEqual(checkAndroidApkProfile(eas, { EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'ios' }),
    { applicable: false });
});

test('EAS checks the artifact before installation and repairs alpha before Metro', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts['eas-build-pre-install'], 'node scripts/check-android-apk-profile.cjs');
  assert.equal(pkg.scripts['eas-build-post-install'], 'node scripts/repair-elise-mouth-alpha.cjs');
});

test('native artifact guard independently forbids bundle tasks for the APK profile', () => {
  const gradle = fs.readFileSync(path.join(__dirname, '../android/app/build.gradle'), 'utf8');
  assert.match(gradle, /if \(easBuildProfile == 'build35-testing'\)[\s\S]*?gradle\.taskGraph\.whenReady/);
  assert.match(gradle, /it\.project == project && it\.name ==~ \/bundle\.\*\(Release\|Debug\)\//);
  assert.match(gradle, /throw new GradleException\('kscan: build35-testing is APK-only/);
});
