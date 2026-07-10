const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

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
    if (fsSync.existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve relative module ${request} from ${fromDir}`);
}

const moduleCache = new Map();

function loadTsModule(relativeOrAbsolutePath, requireCache = {}) {
  const absolutePath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(ROOT, relativeOrAbsolutePath);

  if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath);

  const source = fsSync.readFileSync(absolutePath, 'utf8');
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
    Uint8Array,
    ArrayBuffer,
    DataView,
    Buffer,
    exports: moduleObj.exports,
    module: moduleObj,
    require: (id) => {
      if (id in requireCache) return requireCache[id];
      if (id.startsWith('.')) {
        const resolved = resolveRelative(id, dir);
        if (resolved.endsWith('.ts')) {
          return loadTsModule(resolved, requireCache);
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

const onDevice = loadTsModule('services/privacy/onDeviceMasking/index.ts');

const {
  validateBox,
  boxIoU,
  deduplicateRegions,
  maskRgbaRegions,
  verifyMasking,
  verifyMaskingResult,
  unsupportedFaceDetector,
  unsupportedLicensePlateDetector,
  syntheticFaceDetector,
  syntheticLicensePlateDetector,
  unsupportedLocalImageCodec,
  runDecodedRgbaPrivacyPipeline,
  runEncodedImagePrivacyPipeline,
  toPrivacySanitizerResult,
  UnsupportedCodecError,
} = onDevice;

function createBuffer(width, height, fillFn) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const c = fillFn ? fillFn(x, y) : { r: 255, g: 255, b: 255, a: 255 };
      pixels[idx] = c.r;
      pixels[idx + 1] = c.g;
      pixels[idx + 2] = c.b;
      pixels[idx + 3] = c.a;
    }
  }
  return { width, height, pixels };
}

// ───────────────────────────────────────────────────────────────────────────────
// Buffer validation
// ───────────────────────────────────────────────────────────────────────────────

test('maskRgbaRegions accepts valid 4×4 RGBA buffer', () => {
  const input = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const result = maskRgbaRegions(input, []);
  assert.strictEqual(result.completed, true);
});

test('maskRgbaRegions rejects invalid buffer length', () => {
  const input = { width: 4, height: 4, pixels: new Uint8Array(10) };
  assert.throws(() => maskRgbaRegions(input, []), /expected 64 bytes/);
});

test('maskRgbaRegions rejects zero width', () => {
  const input = { width: 0, height: 4, pixels: new Uint8Array(0) };
  assert.throws(() => maskRgbaRegions(input, []), /width must be a positive integer/);
});

test('maskRgbaRegions rejects zero height', () => {
  const input = { width: 4, height: 0, pixels: new Uint8Array(0) };
  assert.throws(() => maskRgbaRegions(input, []), /height must be a positive integer/);
});

test('maskRgbaRegions rejects NaN dimensions', () => {
  const input = { width: NaN, height: 4, pixels: new Uint8Array(16) };
  assert.throws(() => maskRgbaRegions(input, []));
});

test('maskRgbaRegions rejects oversized dimensions safely', () => {
  const input = { width: 100000, height: 100000, pixels: new Uint8Array(16) };
  assert.throws(() => maskRgbaRegions(input, []));
});

test('maskRgbaRegions does not mutate the input buffer', () => {
  const input = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const original = new Uint8Array(input.pixels);
  maskRgbaRegions(input, [{ type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'test' }]);
  assert.deepStrictEqual(input.pixels, original);
});

// ───────────────────────────────────────────────────────────────────────────────
// Bounding boxes
// ───────────────────────────────────────────────────────────────────────────────

test('validateBox accepts fully inside box', () => {
  const result = validateBox({ x: 1, y: 1, width: 2, height: 2 }, 4, 4);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.area, 4);
});

test('validateBox clamps partially outside box', () => {
  const result = validateBox({ x: 2, y: 2, width: 4, height: 4 }, 4, 4);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.box.width, 2);
  assert.strictEqual(result.box.height, 2);
});

test('validateBox rejects negative width', () => {
  const result = validateBox({ x: 0, y: 0, width: -1, height: 2 }, 4, 4);
  assert.strictEqual(result.valid, false);
});

test('validateBox rejects zero dimensions', () => {
  const result = validateBox({ x: 0, y: 0, width: 0, height: 2 }, 4, 4);
  assert.strictEqual(result.valid, false);
});

test('validateBox rejects NaN coordinates', () => {
  const result = validateBox({ x: NaN, y: 0, width: 2, height: 2 }, 4, 4);
  assert.strictEqual(result.valid, false);
});

test('validateBox rejects Infinity', () => {
  const result = validateBox({ x: 0, y: 0, width: Infinity, height: 2 }, 4, 4);
  assert.strictEqual(result.valid, false);
});

test('validateBox rejects completely outside image', () => {
  const result = validateBox({ x: 10, y: 10, width: 2, height: 2 }, 4, 4);
  assert.strictEqual(result.valid, false);
});

test('boxIoU is 1.0 for identical boxes', () => {
  const box = { x: 0, y: 0, width: 2, height: 2 };
  assert.strictEqual(boxIoU(box, box), 1);
});

test('boxIoU is 0.5 for half-overlapping boxes', () => {
  const a = { x: 0, y: 0, width: 2, height: 2 };
  const b = { x: 1, y: 0, width: 2, height: 2 };
  const iou = boxIoU(a, b);
  assert.ok(Math.abs(iou - 1 / 3) < 0.001, `expected ~0.333, got ${iou}`);
});

test('boxIoU is 0 for non-overlapping boxes', () => {
  const a = { x: 0, y: 0, width: 2, height: 2 };
  const b = { x: 5, y: 5, width: 2, height: 2 };
  assert.strictEqual(boxIoU(a, b), 0);
});

test('deduplicateRegions keeps higher confidence same-type overlap', () => {
  const regions = [
    { type: 'face', box: { x: 0, y: 0, width: 4, height: 4 }, confidence: 0.9 },
    { type: 'face', box: { x: 1, y: 1, width: 3, height: 3 }, confidence: 0.95 },
  ];
  const result = deduplicateRegions(regions);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].confidence, 0.95);
});

test('deduplicateRegions keeps larger box when confidence equal', () => {
  const regions = [
    { type: 'face', box: { x: 0, y: 0, width: 4, height: 4 }, confidence: 0.9 },
    { type: 'face', box: { x: 1, y: 1, width: 3, height: 3 }, confidence: 0.9 },
  ];
  const result = deduplicateRegions(regions);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].box.width, 4);
});

test('deduplicateRegions preserves cross-type overlap', () => {
  const regions = [
    { type: 'face', box: { x: 0, y: 0, width: 4, height: 4 }, confidence: 0.9 },
    { type: 'license_plate', box: { x: 1, y: 1, width: 2, height: 2 }, confidence: 0.9 },
  ];
  const result = deduplicateRegions(regions);
  assert.strictEqual(result.length, 2);
});

// ───────────────────────────────────────────────────────────────────────────────
// Redaction
// ───────────────────────────────────────────────────────────────────────────────

test('maskRgbaRegions changes bytes inside the box', () => {
  const input = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const region = { type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'test' };
  const result = maskRgbaRegions(input, [region]);

  assert.strictEqual(result.completed, true);
  assert.strictEqual(result.regionsMasked, 1);
  assert.strictEqual(result.pixelsChanged, true);
  assert.notStrictEqual(result.inputHash, result.outputHash);

  // Inside box should be black
  const out = result.output;
  assert.strictEqual(out.pixels[0], 0);
  assert.strictEqual(out.pixels[1], 0);
  assert.strictEqual(out.pixels[2], 0);
  assert.strictEqual(out.pixels[3], 255);

  // Outside box should remain red
  const outsideIdx = (0 * 4 + 3) * 4;
  assert.strictEqual(out.pixels[outsideIdx], 255);
  assert.strictEqual(out.pixels[outsideIdx + 1], 0);
});

test('maskRgbaRegions processes multiple boxes', () => {
  const input = createBuffer(8, 8, () => ({ r: 255, g: 255, b: 255, a: 255 }));
  const regions = [
    { type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'test' },
    { type: 'license_plate', box: { x: 4, y: 4, width: 2, height: 2 }, detectorVersion: 'test' },
  ];
  const result = maskRgbaRegions(input, regions);
  assert.strictEqual(result.regionsMasked, 2);
  assert.strictEqual(result.pixelsChanged, true);
});

test('maskRgbaRegions handles overlapping boxes deterministically', () => {
  const input = createBuffer(4, 4, () => ({ r: 255, g: 255, b: 255, a: 255 }));
  const regions = [
    { type: 'face', box: { x: 0, y: 0, width: 3, height: 3 }, detectorVersion: 'test' },
    { type: 'face', box: { x: 1, y: 1, width: 3, height: 3 }, detectorVersion: 'test' },
  ];
  const result = maskRgbaRegions(input, regions);
  assert.strictEqual(result.regionsMasked, 2);
  assert.strictEqual(result.pixelsChanged, true);
});

test('maskRgbaRegions no-region output does not claim masking', () => {
  const input = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const result = maskRgbaRegions(input, []);
  assert.strictEqual(result.regionsMasked, 0);
  assert.strictEqual(result.pixelsChanged, false);
  assert.strictEqual(result.inputHash, result.outputHash);
});

test('maskRgbaRegions does not return the original input object', () => {
  const input = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const region = { type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'test' };
  const result = maskRgbaRegions(input, [region]);
  assert.notStrictEqual(result.output, input);
  assert.notStrictEqual(result.output.pixels, input.pixels);
});

test('verifyMasking detects unchanged region', () => {
  const input = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const output = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const regions = [{ type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'test' }];
  const verification = verifyMasking(input, output, regions);
  assert.strictEqual(verification.passed, false);
  assert.strictEqual(verification.regionsFailed, 1);
});

test('verifyMaskingResult fails partial masking', () => {
  const result = {
    attempted: true,
    completed: true,
    regionsRequested: 2,
    regionsMasked: 1,
    inputHash: 'a',
    outputHash: 'a',
    pixelsChanged: false,
    output: undefined,
    warnings: [],
  };
  const verification = verifyMaskingResult(result);
  assert.strictEqual(verification.passed, false);
});

// ───────────────────────────────────────────────────────────────────────────────
// Detection providers
// ───────────────────────────────────────────────────────────────────────────────

test('unsupported face provider reports unsupported', async () => {
  const result = await unsupportedFaceDetector.detect({});
  assert.strictEqual(result.supported, false);
  assert.strictEqual(result.completed, false);
  assert.strictEqual(result.regions.length, 0);
  assert.ok(result.warnings[0].includes('not supported'));
});

test('unsupported plate provider reports unsupported', async () => {
  const result = await unsupportedLicensePlateDetector.detect({});
  assert.strictEqual(result.supported, false);
  assert.strictEqual(result.completed, false);
  assert.strictEqual(result.regions.length, 0);
});

test('synthetic face provider returns supplied fixture boxes', async () => {
  const regions = [{ type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'synthetic' }];
  const detector = syntheticFaceDetector({ regions });
  const result = await detector.detect({});
  assert.strictEqual(result.regions.length, 1);
  assert.strictEqual(result.supported, false);
  assert.ok(result.warnings[0].includes('synthetic'));
});

test('synthetic plate provider returns supplied fixture boxes', async () => {
  const regions = [{ type: 'license_plate', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'synthetic' }];
  const detector = syntheticLicensePlateDetector({ regions });
  const result = await detector.detect({});
  assert.strictEqual(result.regions.length, 1);
  assert.strictEqual(result.supported, false);
});

test('synthetic detector label cannot be confused with real detection', async () => {
  const detector = syntheticFaceDetector({ regions: [] });
  const result = await detector.detect({});
  assert.strictEqual(result.supported, false);
  assert.ok(result.warnings.some((w) => w.includes('synthetic') && w.includes('No real image analysis')));
});

test('synthetic detector can force an exception', async () => {
  const detector = syntheticFaceDetector({ shouldThrow: true });
  await assert.rejects(detector.detect({}), /forced failure/);
});

// ───────────────────────────────────────────────────────────────────────────────
// Pipeline
// ───────────────────────────────────────────────────────────────────────────────

test('decoded pipeline with synthetic face flow masks and succeeds', async () => {
  const rgba = createBuffer(8, 8, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const regions = [{ type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'synthetic' }];
  const result = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { face: syntheticFaceDetector({ regions }) },
    policy: { requireFaceDetection: true, allowCleanNoDetection: false },
  });
  assert.strictEqual(result.faceDetection.completed, true);
  assert.strictEqual(result.masking.regionsMasked, 1);
  assert.strictEqual(result.masking.pixelsChanged, true);
  assert.strictEqual(result.safeForTransmission, true);
});

test('decoded pipeline with synthetic plate flow masks and succeeds', async () => {
  const rgba = createBuffer(8, 8, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const regions = [{ type: 'license_plate', box: { x: 4, y: 4, width: 2, height: 2 }, detectorVersion: 'synthetic' }];
  const result = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { plate: syntheticLicensePlateDetector({ regions }) },
    policy: { requirePlateDetection: true, allowCleanNoDetection: false },
  });
  assert.strictEqual(result.plateDetection.completed, true);
  assert.strictEqual(result.masking.regionsMasked, 1);
  assert.strictEqual(result.safeForTransmission, true);
});

test('decoded pipeline with combined synthetic face and plate flow', async () => {
  const rgba = createBuffer(8, 8, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const faceRegions = [{ type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'synthetic' }];
  const plateRegions = [{ type: 'license_plate', box: { x: 4, y: 4, width: 2, height: 2 }, detectorVersion: 'synthetic' }];
  const result = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: {
      face: syntheticFaceDetector({ regions: faceRegions }),
      plate: syntheticLicensePlateDetector({ regions: plateRegions }),
    },
    policy: { requireFaceDetection: true, requirePlateDetection: true, allowCleanNoDetection: false },
  });
  assert.strictEqual(result.masking.regionsMasked, 2);
  assert.strictEqual(result.safeForTransmission, true);
});

test('unsupported real detector blocks transmission', async () => {
  const rgba = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const result = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { face: unsupportedFaceDetector },
    policy: { requireFaceDetection: true, allowCleanNoDetection: false },
  });
  assert.strictEqual(result.safeForTransmission, false);
  assert.ok(result.failureReasons.some((r) => r.includes('not supported')));
});

test('unsupported codec blocks encoded-image transmission', async () => {
  const result = await runEncodedImagePrivacyPipeline({
    base64: 'data:image/jpeg;base64,abc',
    mimeType: 'image/jpeg',
    codec: unsupportedLocalImageCodec,
    detectors: { face: unsupportedFaceDetector },
    policy: { requireFaceDetection: true, allowCleanNoDetection: false },
  });
  assert.strictEqual(result.safeForTransmission, false);
  assert.ok(result.failureReasons.some((r) => r.includes('codec')));
});

test('detector failure blocks transmission', async () => {
  const rgba = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const result = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { face: syntheticFaceDetector({ shouldThrow: true }) },
    policy: { requireFaceDetection: true, allowCleanNoDetection: false },
  });
  assert.strictEqual(result.safeForTransmission, false);
  assert.strictEqual(result.faceDetection.completed, false);
});

test('no-region conservative result is not safe by default', async () => {
  const rgba = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const result = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { face: syntheticFaceDetector({ regions: [] }) },
    policy: { requireFaceDetection: true, allowCleanNoDetection: false },
  });
  assert.strictEqual(result.masking.regionsMasked, 0);
  assert.strictEqual(result.safeForTransmission, false);
  assert.ok(result.failureReasons.some((r) => r.includes('No PII regions detected')));
});

test('no-region result can pass when policy explicitly allows clean passthrough', async () => {
  const rgba = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const result = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { face: syntheticFaceDetector({ regions: [] }) },
    policy: { requireFaceDetection: true, allowCleanNoDetection: true },
  });
  assert.strictEqual(result.masking.pixelsChanged, false);
  assert.strictEqual(result.safeForTransmission, true);
});

// ───────────────────────────────────────────────────────────────────────────────
// Network isolation
// ───────────────────────────────────────────────────────────────────────────────

test('POC does not call fetch, XMLHttpRequest, or WebSocket', async () => {
  const originalFetch = globalThis.fetch;
  const originalXHR = globalThis.XMLHttpRequest;
  const originalWebSocket = globalThis.WebSocket;

  let fetchCalled = false;
  let xhrCalled = false;
  let wsCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  };
  globalThis.XMLHttpRequest = class MockXHR {
    constructor() {
      xhrCalled = true;
    }
  };
  globalThis.WebSocket = class MockWS {
    constructor() {
      wsCalled = true;
    }
  };

  try {
    const rgba = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
    const regions = [{ type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'synthetic' }];
    await runDecodedRgbaPrivacyPipeline({
      rgba,
      detectors: { face: syntheticFaceDetector({ regions }) },
      policy: { requireFaceDetection: true, allowCleanNoDetection: false },
    });

    await runEncodedImagePrivacyPipeline({
      base64: 'abc',
      mimeType: 'image/jpeg',
      codec: unsupportedLocalImageCodec,
      detectors: { face: unsupportedFaceDetector },
      policy: { requireFaceDetection: true, allowCleanNoDetection: false },
    });

    assert.strictEqual(fetchCalled, false, 'fetch was called');
    assert.strictEqual(xhrCalled, false, 'XMLHttpRequest was constructed');
    assert.strictEqual(wsCalled, false, 'WebSocket was constructed');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXHR;
    globalThis.WebSocket = originalWebSocket;
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Adapter
// ───────────────────────────────────────────────────────────────────────────────

test('adapter maps real changed pixels to masked', async () => {
  const rgba = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const regions = [{ type: 'face', box: { x: 0, y: 0, width: 2, height: 2 }, detectorVersion: 'synthetic' }];
  const pipelineResult = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { face: syntheticFaceDetector({ regions }) },
    policy: { requireFaceDetection: true, allowCleanNoDetection: false },
  });
  const adapted = toPrivacySanitizerResult(pipelineResult);
  assert.strictEqual(adapted.mode, 'masked');
  assert.strictEqual(adapted.faceMaskApplied, true);
});

test('adapter maps no changed pixels to passthrough', async () => {
  const rgba = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const pipelineResult = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { face: syntheticFaceDetector({ regions: [] }) },
    policy: { requireFaceDetection: true, allowCleanNoDetection: true },
  });
  const adapted = toPrivacySanitizerResult(pipelineResult);
  assert.strictEqual(adapted.mode, 'passthrough');
  assert.strictEqual(adapted.faceMaskApplied, false);
});

test('adapter does not map unsupported detection to masked', async () => {
  const rgba = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const pipelineResult = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { face: unsupportedFaceDetector },
    policy: { requireFaceDetection: true, allowCleanNoDetection: false },
  });
  const adapted = toPrivacySanitizerResult(pipelineResult);
  assert.strictEqual(adapted.mode, 'passthrough');
  assert.ok(adapted.warnings.some((w) => w.includes('not supported')));
});

test('adapter does not map failed codec to masked', async () => {
  const pipelineResult = await runEncodedImagePrivacyPipeline({
    base64: 'abc',
    mimeType: 'image/jpeg',
    codec: unsupportedLocalImageCodec,
    detectors: { face: unsupportedFaceDetector },
    policy: { requireFaceDetection: true, allowCleanNoDetection: false },
  });
  const adapted = toPrivacySanitizerResult(pipelineResult);
  assert.strictEqual(adapted.mode, 'passthrough');
  assert.ok(adapted.warnings.some((w) => w.includes('codec')));
});

test('adapter preserves sanitizer version', async () => {
  const rgba = createBuffer(4, 4, () => ({ r: 255, g: 0, b: 0, a: 255 }));
  const pipelineResult = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: { face: syntheticFaceDetector({ regions: [] }) },
    policy: { requireFaceDetection: true, allowCleanNoDetection: true },
  });
  const adapted = toPrivacySanitizerResult(pipelineResult);
  assert.strictEqual(typeof adapted.sanitizerVersion, 'string');
  assert.ok(adapted.sanitizerVersion.length > 0);
});

// ───────────────────────────────────────────────────────────────────────────────
// Synthetic fixtures
// ───────────────────────────────────────────────────────────────────────────────

test('fixture: partially out-of-bounds box is clamped and masked', () => {
  const input = createBuffer(4, 4, () => ({ r: 255, g: 255, b: 255, a: 255 }));
  const region = { type: 'face', box: { x: 2, y: 2, width: 4, height: 4 }, detectorVersion: 'test' };
  const result = maskRgbaRegions(input, [region]);
  assert.strictEqual(result.regionsMasked, 1);
  assert.strictEqual(result.pixelsChanged, true);
});

test('fixture: invalid box is skipped with warning', () => {
  const input = createBuffer(4, 4, () => ({ r: 255, g: 255, b: 255, a: 255 }));
  const region = { type: 'face', box: { x: 0, y: 0, width: -2, height: 2 }, detectorVersion: 'test' };
  const result = maskRgbaRegions(input, [region]);
  assert.strictEqual(result.regionsMasked, 0);
  assert.strictEqual(result.pixelsChanged, false);
  assert.ok(result.warnings.length > 0);
});
