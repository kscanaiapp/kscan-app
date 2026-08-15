'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

const PACKAGE = 'com.kscanai.app';

test('one package identity across the app config, Gradle and the manifest', () => {
  const appJson = readJson('app.json').expo;
  const buildGradle = read('android/app/build.gradle');

  assert.equal(appJson.android.package, PACKAGE);
  assert.match(buildGradle, new RegExp(`namespace '${PACKAGE.replace(/\./g, '\.')}'`));
  assert.match(buildGradle, new RegExp(`applicationId '${PACKAGE.replace(/\./g, '\.')}'`));
});

test('versionName agrees between the app config and Gradle', () => {
  const appJson = readJson('app.json').expo;
  const buildGradle = read('android/app/build.gradle');

  assert.match(buildGradle, new RegExp(`versionName "${appJson.version}"`));
});

test('EAS owns the versionCode, so the committed value is not the release authority', () => {
  const easJson = readJson('eas.json');

  // appVersionSource: remote means Play's version counter lives in EAS. Bumping the
  // committed versionCode on a repair branch would not change the release and could
  // desynchronise the remote counter, so nothing here asserts a specific number.
  assert.equal(easJson.cli.appVersionSource, 'remote');
  assert.equal(easJson.build.production.autoIncrement, true);
});

test('the production profile builds a store-distributed app bundle', () => {
  const production = readJson('eas.json').build.production;

  assert.equal(production.distribution, 'store');
  assert.equal(production.android.buildType, 'app-bundle');
});

test('the production profile does not point the app at the staging backend', () => {
  const { production, staging, preview } = readJson('eas.json').build;
  const stagingUrls = new Set(
    [staging, preview].map((profile) => profile.env.EXPO_PUBLIC_SUPABASE_URL),
  );

  assert.ok(production.env.EXPO_PUBLIC_SUPABASE_URL);
  assert.ok(
    !stagingUrls.has(production.env.EXPO_PUBLIC_SUPABASE_URL),
    'the production profile resolves to a non-production Supabase project',
  );
});

test('Sentry stays disabled for the Build 29 production artifact', () => {
  const production = readJson('eas.json').build.production;

  assert.equal(production.env.EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED, 'false');
  assert.equal(production.env.SENTRY_DISABLE_AUTO_UPLOAD, 'true');
});

test('release signing is not committed and not hard-coded into the release build type', () => {
  const buildGradle = read('android/app/build.gradle');
  const releaseBlock = /release \{[\s\S]*?\n {4}\}/.exec(buildGradle);

  assert.ok(releaseBlock, 'no release build type found');
  // EAS injects the upload credentials; a committed keystore or inline password
  // would put the signing material in the repository.
  assert.doesNotMatch(releaseBlock[0], /storePassword|keyPassword|storeFile/);
  assert.doesNotMatch(read('android/.gitignore') + read('.gitignore'), /^!.*\.(jks|keystore)$/m);
});

test('R8 and resource shrinking are on for release only', () => {
  const properties = read('android/gradle.properties');
  const buildGradle = read('android/app/build.gradle');
  const releaseBlock = /release \{[\s\S]*?\n {4}\}/.exec(buildGradle)[0];

  assert.match(properties, /^android\.enableMinifyInReleaseBuilds=true$/m);
  assert.match(properties, /^android\.enableShrinkResourcesInReleaseBuilds=true$/m);
  assert.match(releaseBlock, /minifyEnabled enableMinifyInReleaseBuilds/);
  assert.match(releaseBlock, /shrinkResources enableShrinkResources\.toBoolean\(\)/);

  const debugBlock = /debug \{[\s\S]*?\n {4}\}/.exec(buildGradle)[0];
  assert.doesNotMatch(debugBlock, /minifyEnabled true/);
});

test('R8 keep rules stay scoped to reflection K Scan actually reaches', () => {
  const proguard = read('android/app/proguard-rules.pro');
  const piiModule = readJson('modules/kscan-pii-native/expo-module.config.json');

  // The native PII module is Apple-only, so it contributes no Android JNI surface
  // and must not acquire a keep rule "just in case".
  assert.deepEqual(piiModule.platforms, ['apple']);
  assert.doesNotMatch(proguard, /kscan/i);

  // Blanket keeps would silently defeat R8 across every Expo module.
  assert.doesNotMatch(proguard, /-keep\s+class\s+expo\.modules\.\*\*/);
  assert.match(proguard, /-keep class expo\.modules\.securestore\.\*\* \{ \*; \}/);
});
