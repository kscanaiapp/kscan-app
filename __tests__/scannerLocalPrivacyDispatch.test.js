// Component coverage of the REAL privacy boundary, native adapters, artifact
// lifecycle, encoder and dispatch guard. Only native/Expo platform APIs are
// injected. This does not certify native detector accuracy or device pixels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '..');

function load(file, map = {}) {
  const filename = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, __DEV__: false, console,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise, Set, WeakMap, Error,
    require(id) { if (id in map) return map[id]; throw new Error(`Unexpected import ${id}`); },
  }, { filename });
  return module.exports;
}

function harness(options = {}) {
  let serial = 0;
  const raw = 'file:///photos/original.jpg';
  const faceUri = 'file:///cache/kscan-pii-native/face.png';
  const plateUri = 'file:///cache/kscan-pii-native/plate.png';
  const files = new Map([[raw, 'RAW_IMAGE_WITH_EXIF'], ['content://picker/photo', 'RAW_PICKER_WITH_EXIF']]);
  const calls = { faces: [], plates: [], encodes: [], deleted: [], nativeDeleted: [], copies: [] };
  const filesystem = {
    cacheDirectory: 'file:///cache/',
    makeDirectoryAsync: async () => {},
    copyAsync: async ({ from, to }) => {
      calls.copies.push({ from, to });
      if (!files.has(from)) throw new Error('missing source');
      files.set(to, files.get(from));
    },
    getInfoAsync: async (uri) => ({ exists: files.has(uri), size: files.get(uri)?.length ?? 0 }),
    deleteAsync: async (uri) => { calls.deleted.push(uri); files.delete(uri); },
  };
  const native = {
    getPrivacyCapabilities: async () => ({ supported: true }),
    getPlateCapabilities: async () => ({ supported: true }),
    cleanupSanitizedImage: async (uri) => {
      calls.nativeDeleted.push(uri); files.delete(uri);
      return { deleted: true, rejected: false, warnings: [] };
    },
    detectAndMaskFaces: async (input) => {
      calls.faces.push(input.imageUri);
      if (options.faceThrow) throw new Error('native face error');
      files.set(faceUri, 'LOCAL_FACE_MASKED_NO_EXIF');
      return {
        status: 'success', facesDetected: 1, facesAccepted: 1, facesMasked: 1,
        outputWidth: 1200, outputHeight: 2400, outputChecksum: 'verified-face-pixels',
        verificationDurationMs: 0, sanitizedUri: faceUri, sanitizerVersion: 'native-test-contract',
        ...options.face,
      };
    },
    detectAndMaskPlates: async (input) => {
      calls.plates.push(input.imageUri);
      assert.equal(input.imageUri, faceUri, 'plate detection must consume masked faces');
      if (options.plateThrow) throw new Error('native plate error');
      files.set(plateUri, 'LOCAL_FACE_AND_PLATE_MASKED_NO_EXIF');
      const result = {
        status: 'success', platesDetected: 1, platesAccepted: 1, platesMasked: 1,
        inputWidth: 1200, inputHeight: 2400, outputWidth: 1200, outputHeight: 2400,
        outputChecksum: 'verified-plate-pixels', verificationDurationMs: 0,
        sanitizedUri: plateUri, recognizedTextConsumed: false,
        ...options.plate,
      };
      options.afterPlate?.();
      return result;
    },
  };
  if (options.noFaceCapability) delete native.detectAndMaskFaces;
  if (options.noPlateCapability) delete native.detectAndMaskPlates;
  const manipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, actions, config) => {
      calls.encodes.push({ uri, actions, config });
      assert.equal(uri, options.plate?.status === 'no_plates' ? faceUri : plateUri);
      if (options.encodeThrow) throw new Error('encoding failed');
      const outputUri = 'file:///cache/scanner-output.jpg';
      const bytes = Buffer.from(files.get(uri) ?? '');
      files.set(outputUri, bytes.toString());
      options.afterEncode?.();
      return { uri: outputUri, base64: bytes.toString('base64'), ...options.encoded };
    },
  };
  const platformMap = {
    '../../modules/kscan-pii-native/src/KScanPiiNativeModule': native,
  };
  const face = load('services/privacy/nativeFaceEngine.ts', platformMap);
  const nativePlate = load('services/privacy/nativePlateEngine.ts', platformMap);
  const plate = load('services/privacy/plateDetection.ts', { './nativePlateEngine': nativePlate });
  const artifacts = load('services/privacy/privacyArtifactStore.ts', {
    'expo-file-system/legacy': filesystem, 'expo-crypto': { randomUUID: () => `test-${++serial}` },
  });
  const materializer = load('services/privacy/uriMaterializer.ts', {
    'expo-file-system/legacy': filesystem, './privacyArtifactStore': artifacts,
  });
  const proof = load('services/privacy/privacyProof.ts');
  const boundary = load('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': face, './plateDetection': plate, './privacyProof': proof,
    './privacyArtifactStore': artifacts, './uriMaterializer': materializer,
  });
  const upload = load('services/privacyImageUpload.ts', {
    'expo-image-manipulator': manipulator, 'expo-file-system/legacy': filesystem,
  });
  const guard = load('services/privacy/scannerDispatchGuard.ts');
  const prepare = load('services/privacy/scannerImagePreparation.ts', {
    './privacyBoundary': boundary, '../privacyImageUpload': upload, './scannerDispatchGuard': guard,
  });
  const scanner = load('services/scannerScanRequest.ts', {
    './privacy/scannerDispatchGuard': guard,
    './scanIdentification': {}, './scannerIdentificationV2': {},
  });
  const dispatched = [];
  const dispatch = (imageBase64, privacyProof) => scanner.runScannerIdentification({
    mode: 'detect_items', evidence: { evidenceId: 'ev_privacy_test', imageBase64, source: 'camera', mimeType: 'image/jpeg' },
    privacyProof, sessionFlag: { enabled: false }, platform: 'ios', requestId: 'local-privacy-test',
    transport: async (image, request) => { dispatched.push({ image, request }); return { status: 'completed', recommendedProducts: [] }; },
  });
  return { raw, faceUri, plateUri, files, calls, boundary, guard, dispatch, dispatched, ...prepare };
}

test('Scanner uses actual boundary artifacts, masks faces then plates, and dispatches only derived bytes', async () => {
  const h = harness();
  const out = await h.prepareScannerImageForDispatch(h.raw);
  assert.equal(Buffer.from(out.imageBase64.split(',')[1], 'base64').toString(), 'LOCAL_FACE_AND_PLATE_MASKED_NO_EXIF');
  assert.equal(h.calls.faces.length, 1);
  assert.notEqual(h.calls.faces[0], h.raw, 'native input is the owned materialized copy');
  assert.equal(h.calls.plates[0], h.faceUri);
  assert.equal(h.calls.encodes[0].uri, h.plateUri);
  assert.equal(JSON.stringify(h.calls.encodes[0].actions), JSON.stringify([{ resize: { height: 1536 } }]));
  assert.equal(h.calls.encodes[0].config.compress, 0.85);
  assert.equal(out.width, 768); assert.equal(out.height, 1536);
  for (const key of ['processingCompleted', 'outputVerified', 'metadataStripped', 'faceDetectionPerformed', 'plateDetectionPerformed']) assert.equal(out.proof[key], true);
  assert.equal(out.proof.facesMasked, 1); assert.equal(out.proof.platesMasked, 1);
  const response = await h.dispatch(out.imageBase64, out.proof);
  assert.equal(response.response.status, 'completed');
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.dispatched[0].image, out.imageBase64, 'real Scanner orchestration sends exact prepared bytes');
  assert.ok(h.files.has(h.raw), 'the original stays on device and is not deleted');
  assert.equal(h.files.has(h.faceUri), false); assert.equal(h.files.has(h.plateUri), false);
  assert.ok(h.calls.deleted.some((uri) => /orig-/.test(uri)));
  assert.ok(h.calls.deleted.includes('file:///cache/scanner-output.jpg'));
});

test('proof is bound to exact bytes, cannot be copied, and does not authorize a new crop', async () => {
  const h = harness(); const out = await h.prepareScannerImageForDispatch(h.raw);
  assert.equal(h.guard.assertScannerImageReadyForDispatch(out.imageBase64.split(',')[1], out.proof), true);
  assert.equal(h.guard.assertScannerImageReadyForDispatch(out.imageBase64, { ...out.proof }), false);
  assert.equal(h.guard.assertScannerImageReadyForDispatch('data:image/jpeg;base64,T1RIRVI=', out.proof), false);
  assert.equal(h.guard.assertScannerImageReadyForDispatch(out.imageBase64, undefined), false);
  for (const [image, proof] of [[out.imageBase64, { ...out.proof }], ['UkFX', out.proof], [out.imageBase64, undefined]]) {
    const response = await h.dispatch(image, proof);
    assert.equal(response.response.status, 'failed');
  }
  assert.equal(h.dispatched.length, 0, 'real Scanner transport cannot dispatch copied proofs or raw bytes');
  const second = await h.prepareScannerImageForDispatch('content://picker/photo', { proof: out.proof });
  assert.equal(h.calls.faces.length, 2, 'an asserted prior proof never skips a fresh privacy run');
  assert.notEqual(second.proof, out.proof);
});

test('no-faces/no-plates run still requires a metadata-free verified artifact and never upscales', async () => {
  const h = harness({ face: { status: 'no_faces', facesDetected: 0, facesAccepted: 0, facesMasked: 0, outputWidth: 200, outputHeight: 300 }, plate: { status: 'no_plates', platesDetected: 0, platesAccepted: 0, platesMasked: 0, sanitizedUri: undefined } });
  const out = await h.prepareScannerImageForDispatch(h.raw);
  assert.equal(out.width, 200); assert.equal(out.height, 300);
  assert.equal(h.calls.encodes[0].actions.length, 0);
  assert.equal(out.proof.facesMasked, 0); assert.equal(out.proof.platesMasked, 0);
});

for (const [name, options] of Object.entries({
  noFaceCapability: { noFaceCapability: true }, noPlateCapability: { noPlateCapability: true },
  faceThrow: { faceThrow: true }, plateThrow: { plateThrow: true },
  invalidFaceCounts: { face: { facesMasked: 0 } }, missingFaceVerification: { face: { outputChecksum: undefined } },
  rawFaceOutput: { face: { sanitizedUri: 'file:///photos/original.jpg' } },
  missingPlateMask: { plate: { sanitizedUri: undefined } }, partialPlateMask: { plate: { platesMasked: 0 } },
  missingPlateVerification: { plate: { outputChecksum: undefined } }, changedPlateDimensions: { plate: { outputWidth: 1199 } },
  rawPlateOutput: { plate: { sanitizedUri: 'file:///photos/original.jpg' } },
  unknownPlateStatus: { plate: { status: 'surprise' } }, encodeThrow: { encodeThrow: true },
  missingEncodedOutput: { encoded: { base64: undefined } },
})) {
  test(`fail closed before dispatch: ${name}`, async () => {
    const h = harness(options);
    await assert.rejects(h.prepareScannerImageForDispatch(h.raw));
    assert.ok(h.files.has(h.raw), 'failed preparation must never delete the original');
    assert.equal(h.guard.assertScannerImageReadyForDispatch('RAW_IMAGE_WITH_EXIF', {}), false);
    await h.dispatch('RAW_IMAGE_WITH_EXIF', {});
    assert.equal(h.dispatched.length, 0);
  });
}

test('cancellation after local screening and encoding produces no dispatchable proof', async () => {
  for (const stage of ['afterPlate', 'afterEncode']) {
    const signal = { aborted: false }; const h = harness({ [stage]: () => { signal.aborted = true; } });
    await assert.rejects(h.prepareScannerImageForDispatch(h.raw, { signal }));
    assert.equal(h.files.has(h.plateUri), false);
  }
});

test('existing Closet boundary retains block-on-plate policy unless Scanner explicitly opts in', async () => {
  const h = harness(); const out = await h.boundary.prepareImageForDispatch(h.raw);
  assert.equal(out.status, 'BLOCKED'); assert.equal(out.errorCode, 'PLATE_DETECTED');
  assert.equal(h.calls.encodes.length, 0);
});

test('remote URLs, raw base64, data URIs and invalid limits never reach native processing', async () => {
  const h = harness();
  for (const uri of ['https://example.com/photo.jpg', 'UkFX', 'data:image/jpeg;base64,UkFX']) await assert.rejects(h.prepareScannerImageForDispatch(uri));
  for (const options of [{ maxDimension: 99999 }, { quality: NaN }, { signal: { aborted: true } }]) await assert.rejects(h.prepareScannerImageForDispatch(h.raw, options));
  assert.equal(h.calls.faces.length, 0); assert.equal(h.calls.copies.length, 0);
});

test('Android native no-face path uses the existing PNG encoder and persisted-output verifier', () => {
  const kotlin = fs.readFileSync(path.join(ROOT, 'modules/kscan-pii-native/android/src/main/java/expo/modules/kscanpiinative/KScanPiiNativeModule.kt'), 'utf8');
  assert.match(kotlin, /status = if \(faces\.isEmpty\(\)\) NativePrivacyStatus\.NO_FACES else NativePrivacyStatus\.SUCCESS/);
  assert.match(kotlin, /faces\.isNotEmpty\(\) && normalizedBoxes\.isEmpty\(\)/);
  assert.match(kotlin, /check\(redaction\.output\.compress\(Bitmap\.CompressFormat\.PNG/);
  assert.ok(kotlin.indexOf('AndroidOutputVerifier.verify(') < kotlin.indexOf('status = if (faces.isEmpty())'));
});
