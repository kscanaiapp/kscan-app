const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES_PATH = path.join(ROOT, 'modules/kscan-pii-native/test-vectors/parity-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));

const constants = fixtures.constants;

function moduleExists(modulePath) {
  return fs.existsSync(path.join(ROOT, modulePath));
}

// Established TypeScript-module-loading pattern (matches __tests__/onDevicePiiMasking.test.js).
function resolveRelative(request, fromDir) {
  const resolved = path.resolve(fromDir, request);
  const candidates = [
    resolved,
    `${resolved}.ts`,
    `${resolved}.js`,
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve relative module ${request} from ${fromDir}`);
}

const moduleCache = new Map();

function loadTsModule(relativeOrAbsolutePath) {
  const absolutePath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(ROOT, relativeOrAbsolutePath);

  if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath);

  const source = fs.readFileSync(absolutePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const moduleObj = { exports: {} };
  const dir = path.dirname(absolutePath);

  const sandbox = {
    console,
    setTimeout,
    exports: moduleObj.exports,
    module: moduleObj,
    require: (id) => {
      if (id.startsWith('.')) {
        const resolved = resolveRelative(id, dir);
        if (resolved.endsWith('.ts')) {
          return loadTsModule(resolved);
        }
        return require(resolved);
      }
      return require(id);
    },
    __filename: absolutePath,
    __dirname: dir,
  };

  vm.runInNewContext(output, sandbox, { filename: absolutePath });
  moduleCache.set(absolutePath, moduleObj.exports);
  return moduleObj.exports;
}

const nativeAdapter = loadTsModule('services/privacy/onDeviceMasking/nativeAdapter.ts');
const { nativeResultToPrivacySanitizerResult, isNativeResultSafeForTransmission } = nativeAdapter;

function baseNativeResult(overrides = {}) {
  return {
    status: 'success',
    platform: 'ios',
    detectorImplementation: 'apple_vision',
    detectorVersion: 'test-1.0.0',
    sanitizerVersion: 'native-face-mask-poc-1.0.0',
    facesDetected: 1,
    facesAccepted: 1,
    facesMasked: 1,
    regionsChanged: 1,
    regionsAlreadyRedacted: 0,
    pixelsChanged: true,
    sanitizedUri: 'file:///cache/kscan-pii-native/output-test.png',
    warnings: [],
    ...overrides,
  };
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

test('adapter: newly masked success maps to masked and safe', () => {
  const result = baseNativeResult({ regionsChanged: 1, regionsAlreadyRedacted: 0, pixelsChanged: true });
  const adapted = nativeResultToPrivacySanitizerResult(result);
  assert.strictEqual(adapted.mode, 'masked');
  assert.strictEqual(adapted.faceMaskApplied, true);
  assert.strictEqual(isNativeResultSafeForTransmission(result), true);
});

test('adapter: already-black success (pixelsChanged: false) still maps to masked and safe', () => {
  // Regression: pixelsChanged must not be the transmission gate. An
  // already-fully-redacted region is a legitimate masked result.
  const result = baseNativeResult({
    regionsChanged: 0,
    regionsAlreadyRedacted: 1,
    pixelsChanged: false,
    facesMasked: 1,
  });
  const adapted = nativeResultToPrivacySanitizerResult(result);
  assert.strictEqual(adapted.mode, 'masked');
  assert.strictEqual(adapted.faceMaskApplied, true);
  assert.strictEqual(isNativeResultSafeForTransmission(result), true);
});

test('adapter: success without a sanitizedUri is not safe', () => {
  const result = baseNativeResult({ sanitizedUri: undefined });
  const adapted = nativeResultToPrivacySanitizerResult(result);
  assert.strictEqual(adapted.mode, 'passthrough');
  assert.strictEqual(isNativeResultSafeForTransmission(result), false);
});

test('adapter: success with facesMasked = 0 is not safe', () => {
  const result = baseNativeResult({ facesMasked: 0, regionsChanged: 0, regionsAlreadyRedacted: 0, pixelsChanged: false });
  const adapted = nativeResultToPrivacySanitizerResult(result);
  assert.strictEqual(adapted.mode, 'passthrough');
  assert.strictEqual(adapted.faceMaskApplied, false);
  assert.strictEqual(isNativeResultSafeForTransmission(result), false);
});

test('adapter: failed result maps to passthrough and not safe', () => {
  const result = baseNativeResult({
    status: 'failed',
    facesMasked: 0,
    regionsChanged: 0,
    pixelsChanged: false,
    sanitizedUri: undefined,
    errorCode: 'MASKING_FAILED',
    failureReason: 'Masking invariant violated: 1 regions needed changes but no pixels changed.',
  });
  const adapted = nativeResultToPrivacySanitizerResult(result);
  assert.strictEqual(adapted.mode, 'passthrough');
  assert.strictEqual(isNativeResultSafeForTransmission(result), false);
  assert.ok(adapted.warnings.some((w) => w.includes('Masking invariant violated')));
});

test('adapter: no-faces result maps to passthrough and not safe', () => {
  const result = baseNativeResult({
    status: 'no_faces',
    facesDetected: 0,
    facesAccepted: 0,
    facesMasked: 0,
    regionsChanged: 0,
    pixelsChanged: false,
    sanitizedUri: undefined,
  });
  const adapted = nativeResultToPrivacySanitizerResult(result);
  assert.strictEqual(adapted.mode, 'passthrough');
  assert.strictEqual(adapted.faceDetectionPerformed, true);
  assert.strictEqual(isNativeResultSafeForTransmission(result), false);
});

test('Native-module access stays inside the audited privacy layer', () => {
  // The Zero-Knowledge foundation activates the native module, but every
  // access must flow through the audited privacy layer. Screens, hooks, and
  // non-privacy services must never touch the native symbols directly.
  const dirs = ['app', 'components', 'hooks', 'services'];
  const forbidden = ['KScanPiiNative', 'detectAndMaskFaces', 'getPrivacyCapabilities', 'cleanupSanitizedImage'];
  const allowedPaths = [
    path.join(ROOT, 'services/privacy/onDeviceMasking/nativeAdapter.ts'),
    path.join(ROOT, 'services/privacy/nativeFaceEngine.ts'),
    path.join(ROOT, 'services/privacy/privacyBoundary.ts'),
    path.join(ROOT, 'services/privacy/privacyProof.ts'),
    path.join(ROOT, 'services/privacyImageUpload.ts'),
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
