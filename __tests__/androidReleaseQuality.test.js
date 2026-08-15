'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('Build 29 release enables R8 optimization and resource shrinking', () => {
  const properties = read('android/gradle.properties');
  const buildGradle = read('android/app/build.gradle');

  assert.match(properties, /^android\.enableMinifyInReleaseBuilds=true$/m);
  assert.match(properties, /^android\.enableShrinkResourcesInReleaseBuilds=true$/m);
  assert.match(properties, /^org\.gradle\.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m$/m);
  assert.match(buildGradle, /minifyEnabled enableMinifyInReleaseBuilds/);
  assert.match(buildGradle, /shrinkResources enableShrinkResources\.toBoolean\(\)/);
  assert.match(buildGradle, /getDefaultProguardFile\("proguard-android-optimize\.txt"\)/);
});

test('release R8 preserves the reflected Expo SecureStore bridge used by auth', () => {
  const proguardRules = read('android/app/proguard-rules.pro');

  assert.match(
    proguardRules,
    /-keep\s+class\s+expo\.modules\.securestore\.\*\*\s*\{\s*\*;\s*\}/,
  );
  assert.match(
    proguardRules,
    /-keep\s+class\s+expo\.modules\.kotlin\.records\.\*\*\s*\{\s*\*;\s*\}/,
  );
  assert.doesNotMatch(proguardRules, /-keep\s+class\s+expo\.modules\.\*\*/);
});

/** Orientation values that leave the activity free to follow the device. */
const ADAPTIVE_ORIENTATIONS = ['unspecified', 'fullSensor', 'fullUser', 'user', 'behind'];

test('Android activity is adaptive and is not locked to a single orientation', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const appConfig = JSON.parse(read('app.json'));

  // B29-UI-001 removed the K Scan-owned portrait restriction so the app follows the
  // device on phones, tablets and foldables. Assert that invariant rather than the
  // literal absence of the attribute: `expo prebuild` writes the behaviourally
  // equivalent android:screenOrientation="unspecified" from orientation: "default",
  // and a test that forbids the attribute outright fails on a faithful regeneration.
  const declared = /android:screenOrientation="([^"]+)"/.exec(manifest);
  if (declared) {
    assert.ok(
      ADAPTIVE_ORIENTATIONS.includes(declared[1]),
      `MainActivity is locked to android:screenOrientation="${declared[1]}"`,
    );
  }
  assert.equal(appConfig.expo.orientation, 'default');
});

test('edge-to-edge uses the supported Expo flag without app-owned system-bar colors', () => {
  const properties = read('android/gradle.properties');
  const styles = read('android/app/src/main/res/values/styles.xml');
  const appConfig = JSON.parse(read('app.json'));

  assert.equal(appConfig.expo.android.edgeToEdgeEnabled, true);
  assert.match(properties, /^edgeToEdgeEnabled=true$/m);
  assert.doesNotMatch(properties, /^expo\.edgeToEdgeEnabled=/m);
  assert.doesNotMatch(styles, /android:(?:statusBarColor|navigationBarColor)/);
});

test('the Build 29 JavaScript dependency set does not declare the Build 28 pose runtime', () => {
  const packageJson = JSON.parse(read('package.json'));
  const lock = read('package-lock.json');
  const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };

  assert.equal(declared['@react-native-ml-kit/pose-detection'], undefined);
  assert.equal(declared['react-native-fast-tflite'], undefined);
  assert.equal(declared['react-native-nitro-modules'], undefined);
  assert.doesNotMatch(lock, /"com\.google\.mlkit:pose-detection/);
});
