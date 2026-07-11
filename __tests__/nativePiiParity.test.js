const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES_PATH = path.join(ROOT, 'modules/kscan-pii-native/test-vectors/parity-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));

const constants = fixtures.constants;

function moduleExists(modulePath) {
  return fs.existsSync(path.join(ROOT, modulePath));
}

test('Android module source exists', () => {
  assert.ok(moduleExists('modules/kscan-pii-native/android/build.gradle'));
  assert.ok(moduleExists('modules/kscan-pii-native/android/src/main/java/expo/modules/kscanpiinative/KScanPiiNativeModule.kt'));
});

test('iOS module source exists', () => {
  assert.ok(moduleExists('modules/kscan-pii-native/ios/KScanPiiNativeModule.swift'));
  assert.ok(moduleExists('modules/kscan-pii-native/ios/KScanPiiNative.podspec'));
});

test('TypeScript bridge source exists', () => {
  assert.ok(moduleExists('modules/kscan-pii-native/src/index.ts'));
  assert.ok(moduleExists('modules/kscan-pii-native/src/KScanPiiNative.types.ts'));
  assert.ok(moduleExists('modules/kscan-pii-native/src/KScanPiiNativeModule.ts'));
  assert.ok(moduleExists('modules/kscan-pii-native/src/KScanPiiNativeModule.web.ts'));
});

test('Shared parity constants match specification', () => {
  assert.strictEqual(constants.sanitizerVersion, 'native-face-mask-poc-1.0.0');
  assert.strictEqual(constants.checksumAlgorithm, 'fnv1a-dual-lane-64');
  assert.deepStrictEqual(constants.acceptedUriSchemes, ['file']);
  assert.deepStrictEqual(constants.acceptedMimeTypes, ['image/jpeg', 'image/png']);
  assert.strictEqual(constants.outputMimeType, 'image/png');
  assert.strictEqual(constants.maxWidth, 4096);
  assert.strictEqual(constants.maxHeight, 4096);
  assert.strictEqual(constants.maxPixels, 16_777_216);
  assert.strictEqual(constants.defaultPaddingRatio, 0.15);
  assert.strictEqual(constants.minPaddingRatio, 0.0);
  assert.strictEqual(constants.maxPaddingRatio, 0.5);
  assert.strictEqual(constants.iouDeduplicationThreshold, 0.5);
  assert.deepStrictEqual(constants.redactionColor, { r: 0, g: 0, b: 0, a: 255 });
});

test('Checksum vectors produce identical results across platforms', () => {
  for (const vector of fixtures.checksumVectors) {
    assert.strictEqual(typeof vector.expected, 'string');
    assert.strictEqual(vector.expected.length, 24);
    assert.ok(/^[0-9a-f]+$/.test(vector.expected), `Expected hex for ${vector.name}`);
  }
});

test('Region fixtures define outward rounding and clamping', () => {
  for (const fixture of fixtures.regionFixtures) {
    if (fixture.expected) {
      assert.ok(fixture.expected.x >= 0);
      assert.ok(fixture.expected.y >= 0);
      assert.ok(fixture.expected.x + fixture.expected.width <= fixture.imageWidth);
      assert.ok(fixture.expected.y + fixture.expected.height <= fixture.imageHeight);
      assert.ok(fixture.expected.width > 0);
      assert.ok(fixture.expected.height > 0);
    }
  }
});

test('IoU fixtures are within valid range', () => {
  for (const fixture of fixtures.iouFixtures) {
    assert.ok(fixture.expected >= 0 && fixture.expected <= 1, `IoU for ${fixture.name} out of range`);
  }
});

test('Expected failure cases cover input validation', () => {
  const seen = new Set();
  for (const failure of fixtures.expectedFailures) {
    assert.ok(failure.imageUri || failure.imageUri === '');
    assert.ok(failure.errorCode);
    seen.add(failure.errorCode);
  }
  assert.ok(seen.has('INVALID_INPUT'));
  assert.ok(seen.has('UNSUPPORTED_SCHEME'));
});

test('No safeForTransmission field is exposed in native contract types', () => {
  const typesSource = fs.readFileSync(path.join(ROOT, 'modules/kscan-pii-native/src/KScanPiiNative.types.ts'), 'utf8');
  assert.ok(!typesSource.includes('safeForTransmission'));
});

test('Public API exposes exactly the three required functions', () => {
  const indexSource = fs.readFileSync(path.join(ROOT, 'modules/kscan-pii-native/src/index.ts'), 'utf8');
  assert.ok(indexSource.includes('getPrivacyCapabilities'));
  assert.ok(indexSource.includes('detectAndMaskFaces'));
  assert.ok(indexSource.includes('cleanupSanitizedImage'));
  assert.ok(!indexSource.includes('safeForTransmission'));
});

test('Android and iOS constants files mirror TypeScript constants', () => {
  const androidConstants = fs.readFileSync(path.join(ROOT, 'modules/kscan-pii-native/android/src/main/java/expo/modules/kscanpiinative/NativePrivacyConstants.kt'), 'utf8');
  const iosConstants = fs.readFileSync(path.join(ROOT, 'modules/kscan-pii-native/ios/NativePrivacyConstants.swift'), 'utf8');

  assert.ok(androidConstants.includes('native-face-mask-poc-1.0.0'));
  assert.ok(iosConstants.includes('native-face-mask-poc-1.0.0'));
  assert.ok(androidConstants.includes('4096'));
  assert.ok(iosConstants.includes('4096'));
  assert.ok(androidConstants.includes('0.15'));
  assert.ok(iosConstants.includes('0.15'));
});

test('Web fallback reports unsupported and does not fabricate sanitized URI', () => {
  const webSource = fs.readFileSync(path.join(ROOT, 'modules/kscan-pii-native/src/KScanPiiNativeModule.web.ts'), 'utf8');
  assert.ok(webSource.includes('status: \'unsupported\''));
  assert.ok(!webSource.includes('sanitizedUri'));
  assert.ok(webSource.includes('supported: false'));
});

test('No active app imports reference the native module', () => {
  const dirs = ['app', 'components', 'hooks', 'services'];
  const forbidden = ['KScanPiiNative', 'detectAndMaskFaces', 'getPrivacyCapabilities', 'cleanupSanitizedImage'];
  const allowedPaths = [
    path.join(ROOT, 'services/privacy/onDeviceMasking/nativeAdapter.ts'),
  ];
  for (const dir of dirs) {
    const fullDir = path.join(ROOT, dir);
    if (!fs.existsSync(fullDir)) continue;
    const entries = fs.readdirSync(fullDir, { recursive: true });
    for (const entry of entries) {
      const fullPath = path.join(fullDir, entry.toString());
      if (!fs.statSync(fullPath).isFile()) continue;
      if (allowedPaths.includes(fullPath)) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const pattern of forbidden) {
        assert.ok(
          !content.includes(pattern),
          `Forbidden reference to ${pattern} found in ${fullPath}`,
        );
      }
    }
  }
});
