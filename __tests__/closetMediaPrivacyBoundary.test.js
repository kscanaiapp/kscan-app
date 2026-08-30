// Build 34 / Track B / Phase B2A — Closet media privacy boundary.
//
// Proves the two-state contract services/closetMediaPrivacy.ts must satisfy:
// either a SAFE pair of sanitized derivatives, or BLOCKED with no
// cloud-eligible artifact. The governing invariant is that no failure path
// anywhere can resolve to the caller's original image.
//
// Every negative control mutates only an injected dependency, never a file on
// disk, so a failing run cannot leave the working tree or any fixture
// modified. Each one asserts that the corresponding positive test would FAIL
// under the broken condition — that is what makes the positive tests evidence
// rather than decoration.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise, Set, Error,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const SOURCE_URI = 'file:///photos/original-with-a-face.jpg';
const SANITIZED_URI = 'file:///app-cache/kscan-privacy/san-verified.png';
const NAMESPACE = 'file:///app-cache/kscan-privacy/';

function completedProof() {
  // A SAFE result never has platesDetected > 0 under the Build 34 plate
  // policy: any accepted plate-shaped region blocks upstream in
  // privacyBoundary.ts before a proof reaches here. This fixture represents
  // the realistic SAFE case — faces present and masked, no plate found —
  // rather than an impossible "detected and masked a plate, still SAFE" state.
  return {
    proofVersion: 'privacy-proof-1.0.0',
    sanitizerVersion: 'native-face-mask-poc-1.0.0',
    faceDetectionPerformed: true,
    facesDetected: 2,
    facesMasked: 2,
    plateDetectionPerformed: true,
    platesDetected: 0,
    platesMasked: 0,
    metadataStripped: true,
    outputVerified: true,
    processingCompleted: true,
  };
}

function blockedProof() {
  return { ...completedProof(), outputVerified: false, processingCompleted: false };
}

/**
 * Builds the module under test with fully controllable dependencies.
 * `manipulate` records every source URI the encoder was asked to read — that
 * recording is what the thumbnail-leak control inspects.
 */
function buildHarness(overrides = {}) {
  const encodedFrom = [];
  const created = [];
  const deleted = [];
  const moved = [];
  let counter = 0;

  const boundaryResult = overrides.boundaryResult ?? {
    status: 'SANITIZED_AND_VERIFIED',
    sanitizedUri: SANITIZED_URI,
    proof: overrides.proof ?? completedProof(),
    cleanup: async () => { deleted.push(SANITIZED_URI); },
  };

  const manipulateAsync = overrides.manipulateAsync
    ?? (async (uri, ops) => {
      encodedFrom.push({ uri, width: ops?.[0]?.resize?.width });
      counter += 1;
      return { uri: `file:///tmp/render-${counter}.jpg`, width: ops[0].resize.width, height: 100 };
    });

  const closetMediaPrivacy = loadTsModule('services/closetMediaPrivacy.ts', {
    'expo-image-manipulator': {
      manipulateAsync,
      SaveFormat: { JPEG: 'jpeg' },
    },
    'expo-file-system/legacy': {
      getInfoAsync: overrides.getInfoAsync ?? (async () => ({ exists: true, size: 120_000 })),
      moveAsync: overrides.moveAsync ?? (async ({ from, to }) => { moved.push({ from, to }); }),
    },
    './privacy/privacyBoundary': {
      prepareImageForDispatch: overrides.prepareImageForDispatch ?? (async () => boundaryResult),
      isImageDispatchAllowed: () => true,
    },
    './privacy/privacyArtifactStore': {
      ensurePrivacyArtifactDir: async () => NAMESPACE,
      createArtifactPath: (kind, ext) => {
        const p = `${NAMESPACE}${kind}-${created.length}.${ext}`;
        created.push(p);
        return p;
      },
      deletePrivacyArtifact: async (uri) => { if (uri) deleted.push(uri); return true; },
    },
  });

  return { closetMediaPrivacy, encodedFrom, created, deleted, moved };
}

// ── SAFE path ───────────────────────────────────────────────────────────────

test('a completed native run yields SAFE with a primary and a thumbnail', async () => {
  const h = buildHarness();
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);

  assert.equal(result.status, 'SAFE');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.privacyScanCompleted, true);
  assert.equal(result.metadataStripped, true);
  assert.ok(result.primary.uri.startsWith(NAMESPACE), 'primary must live in the privacy namespace');
  assert.ok(result.thumbnail.uri.startsWith(NAMESPACE), 'thumbnail must live in the privacy namespace');
  assert.notEqual(result.primary.uri, result.thumbnail.uri);
  assert.ok(result.primary.byteLength > 0);
});

test('SAFE never returns the caller original as a cloud-eligible artifact', async () => {
  const h = buildHarness();
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.equal(result.status, 'SAFE');
  for (const artifact of [result.primary, result.thumbnail]) {
    assert.notEqual(artifact.uri, SOURCE_URI);
    assert.notEqual(artifact.uri, SANITIZED_URI, 'the intermediate is released, not handed out');
  }
});

test('derivatives use the B1C cloud contract dimensions: primary 1440, thumbnail 160', async () => {
  const h = buildHarness();
  const mod = h.closetMediaPrivacy;
  await mod.sanitizeClosetMedia(SOURCE_URI);
  const widths = h.encodedFrom.map((e) => e.width);
  assert.deepEqual(widths, [mod.CLOSET_MEDIA_PRIMARY_WIDTH, mod.CLOSET_MEDIA_THUMBNAIL_WIDTH]);
  assert.equal(mod.CLOSET_MEDIA_PRIMARY_WIDTH, 1440);
  // B1C's authoritative value (feature/backend-build34-closet-media-v1,
  // services/closetMedia.ts CLOSET_MEDIA_THUMBNAIL_WIDTH). This module must
  // conform to the backend's cloud contract, not to any client rendering
  // choice — see the constant's own comment for the corrected reasoning.
  assert.equal(mod.CLOSET_MEDIA_THUMBNAIL_WIDTH, 160);
});

test('the cloud thumbnail width is intentionally different from the local UI thumbnail', async () => {
  // Proves the two concepts were kept separate rather than re-merged: this
  // module's cloud derivative is 160w (B1C); the LOCAL Closet UI thumbnail in
  // services/closetLibrary.js is untouched by this correction and remains
  // whatever that file declares for on-device display.
  const closetLibrary = fs.readFileSync(path.join(ROOT, 'services', 'closetLibrary.js'), 'utf8');
  const localThumbWidth = Number(/const THUMB_WIDTH\s*=\s*(\d+)/.exec(closetLibrary)[1]);
  const h = buildHarness();
  assert.notEqual(
    h.closetMediaPrivacy.CLOSET_MEDIA_THUMBNAIL_WIDTH,
    localThumbWidth,
    'the cloud derivative and the local UI asset are different concepts and are not required to match',
  );
});

test('the verified intermediate is always released, even on the success path', async () => {
  const h = buildHarness();
  await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.ok(h.deleted.includes(SANITIZED_URI), 'boundary cleanup must run in finally');
});

// ── THE thumbnail-leak invariant ────────────────────────────────────────────

test('BOTH derivatives are encoded from the sanitized output, never the original', async () => {
  const h = buildHarness();
  await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);

  assert.equal(h.encodedFrom.length, 2, 'exactly one primary and one thumbnail');
  for (const entry of h.encodedFrom) {
    assert.equal(entry.uri, SANITIZED_URI, `encoder read ${entry.uri} instead of the sanitized output`);
    assert.notEqual(entry.uri, SOURCE_URI);
  }
});

test('NEGATIVE CONTROL C: a thumbnail taken from the raw original fails the leak test', async () => {
  // Simulates the exact defect: primary from sanitized, thumbnail from source.
  const encodedFrom = [];
  let call = 0;
  const h = buildHarness({
    manipulateAsync: async (uri, ops) => {
      call += 1;
      const readUri = call === 2 ? SOURCE_URI : uri; // second call leaks
      encodedFrom.push({ uri: readUri, width: ops[0].resize.width });
      return { uri: `file:///tmp/r${call}.jpg`, width: ops[0].resize.width, height: 100 };
    },
  });
  await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);

  const leaked = encodedFrom.some((e) => e.uri === SOURCE_URI);
  assert.equal(leaked, true, 'control must reproduce the leak');
  // And the assertion the real test uses must reject it.
  assert.throws(
    () => { for (const e of encodedFrom) assert.equal(e.uri, SANITIZED_URI); },
    'the leak invariant must detect a raw-original thumbnail',
  );
});

// ── BLOCKED paths ───────────────────────────────────────────────────────────

const BOUNDARY_TO_REASON = [
  ['PLATE_CAPABILITY_MISSING', 'plate_detector_unavailable'],
  ['FACE_ENGINE_UNAVAILABLE', 'face_detector_unavailable'],
  ['SOURCE_ACCESS_FAILED', 'decode_failed'],
  ['FACE_PROCESSING_FAILED', 'face_sanitization_failed'],
  ['PLATE_DETECTED', 'plate_detected'],
  ['PLATE_PROCESSING_FAILED', 'detector_failed'],
  ['VERIFICATION_FAILED', 'masking_failed'],
];

for (const [code, reason] of BOUNDARY_TO_REASON) {
  test(`boundary ${code} blocks with machine-readable reason ${reason}`, async () => {
    const h = buildHarness({
      prepareImageForDispatch: async () => ({
        status: 'BLOCKED',
        errorCode: code,
        reason: 'native said no',
        userMessage: 'unavailable',
        proof: blockedProof(),
      }),
    });
    const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, reason);
    assert.equal(result.primary, undefined, 'a blocked run exposes no artifact');
    assert.equal(result.thumbnail, undefined);
  });
}

test('NEGATIVE CONTROL E: an unlinked native module blocks and never returns the original', async () => {
  const h = buildHarness({
    prepareImageForDispatch: async () => ({
      status: 'BLOCKED',
      errorCode: 'FACE_ENGINE_UNAVAILABLE',
      reason: 'The native face-masking engine is not present in this binary.',
      userMessage: 'unavailable',
      proof: blockedProof(),
    }),
  });
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'face_detector_unavailable');
  assert.ok(!('primary' in result) || result.primary === undefined);
  assert.notEqual(JSON.stringify(result), undefined);
  assert.ok(!JSON.stringify(result).includes(SOURCE_URI), 'the original URI is never echoed as an artifact');
});

test('NEGATIVE CONTROL B: a detector that fails mid-run cannot produce SAFE', async () => {
  const h = buildHarness({
    prepareImageForDispatch: async () => ({
      status: 'BLOCKED',
      errorCode: 'FACE_PROCESSING_FAILED',
      reason: 'DETECTION_FAILED: Vision request threw',
      userMessage: 'unavailable',
      proof: blockedProof(),
    }),
  });
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.equal(result.status, 'BLOCKED');
  assert.notEqual(result.status, 'SAFE');
});

test('a proof that does not attest completion blocks even though both files exist', async () => {
  // File existence is not evidence of privacy. This is the §41 invariant:
  // B2B must never infer safety from an artifact being present on disk.
  const h = buildHarness({
    boundaryResult: {
      status: 'SANITIZED_AND_VERIFIED',
      sanitizedUri: SANITIZED_URI,
      proof: { ...completedProof(), processingCompleted: false },
      cleanup: async () => {},
    },
  });
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'unexpected_native_result');
  // Both derivatives were written, then removed because the run is untrusted.
  assert.equal(h.created.length, 2);
  for (const created of h.created) {
    assert.ok(h.deleted.includes(created), `untrusted derivative ${created} must be deleted`);
  }
});

test('a thumbnail failure blocks and removes the already-written primary', async () => {
  let call = 0;
  const h = buildHarness({
    manipulateAsync: async (uri, ops) => {
      call += 1;
      if (call === 2) throw new Error('encoder exploded');
      return { uri: `file:///tmp/r${call}.jpg`, width: ops[0].resize.width, height: 100 };
    },
  });
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'thumbnail_failed');
  assert.equal(h.created.length, 1, 'only the primary got a path');
  assert.ok(h.deleted.includes(h.created[0]), 'the orphaned primary must be deleted');
});

test('an oversize derivative is rejected rather than uploaded', async () => {
  const h = buildHarness({
    getInfoAsync: async () => ({ exists: true, size: 9 * 1024 * 1024 }),
  });
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'primary_failed');
});

test('an empty encoded artifact is rejected', async () => {
  const h = buildHarness({ getInfoAsync: async () => ({ exists: true, size: 0 }) });
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.equal(result.status, 'BLOCKED');
});

test('a non-local or unsupported input is refused before any image work', async () => {
  const h = buildHarness();
  for (const bad of ['https://example.com/a.jpg', '', null, undefined, 'data:image/jpeg;base64,AAA']) {
    const result = await h.closetMediaPrivacy.sanitizeClosetMedia(bad);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'unsupported_format');
  }
  assert.equal(h.encodedFrom.length, 0, 'no encoding is attempted for a refused input');
});

// ── Cancellation and cleanup ────────────────────────────────────────────────

test('cancellation before processing blocks and touches nothing', async () => {
  const h = buildHarness();
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI, {
    signal: { aborted: true },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'cancelled');
  assert.equal(h.created.length, 0);
});

test('cancellation after sanitization still releases the intermediate', async () => {
  const signal = { aborted: false };
  const h = buildHarness({
    prepareImageForDispatch: async () => {
      signal.aborted = true; // cancelled while the native run was in flight
      return {
        status: 'SANITIZED_AND_VERIFIED',
        sanitizedUri: SANITIZED_URI,
        proof: completedProof(),
        cleanup: async () => { h.deleted.push(SANITIZED_URI); },
      };
    },
  });
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI, { signal });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'cancelled');
  assert.equal(h.created.length, 0, 'no derivative is written after cancellation');
});

test('the SAFE cleanup handle removes both derivatives and is idempotent', async () => {
  const h = buildHarness();
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.equal(result.status, 'SAFE');
  await result.cleanup();
  await result.cleanup();
  assert.ok(h.deleted.includes(result.primary.uri));
  assert.ok(h.deleted.includes(result.thumbnail.uri));
});

// ── Concurrency ─────────────────────────────────────────────────────────────

test('concurrent sanitizations never share an artifact path', async () => {
  const h = buildHarness();
  const [a, b] = await Promise.all([
    h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI),
    h.closetMediaPrivacy.sanitizeClosetMedia('file:///photos/other.jpg'),
  ]);
  assert.equal(a.status, 'SAFE');
  assert.equal(b.status, 'SAFE');
  const uris = [a.primary.uri, a.thumbnail.uri, b.primary.uri, b.thumbnail.uri];
  assert.equal(new Set(uris).size, 4, 'every concurrent artifact path must be unique');
});

// ── Zero-Knowledge scope ────────────────────────────────────────────────────

test('the module performs no upload and imports nothing network-capable', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'closetMediaPrivacy.ts'), 'utf8');
  const executable = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const forbidden of [
    'supabase', 'storage.from', 'createSignedUploadUrl', 'fetch(', 'XMLHttpRequest', 'axios',
  ]) {
    assert.ok(
      !executable.includes(forbidden),
      `B2A must make zero network/storage calls, found: ${forbidden}`,
    );
  }
});

test('blocked reasons are a closed machine-readable vocabulary, not raw exception text', async () => {
  const allowed = new Set([
    'sanitizer_unavailable', 'face_detector_unavailable', 'face_sanitization_failed',
    'plate_detector_unavailable', 'plate_detected',
    'detector_failed', 'masking_failed', 'metadata_strip_failed', 'unsupported_format',
    'decode_failed', 'memory_or_decode_failure', 'primary_failed', 'thumbnail_failed',
    'cancelled', 'unexpected_native_result',
  ]);
  const h = buildHarness({
    prepareImageForDispatch: async () => ({
      status: 'BLOCKED',
      errorCode: 'SOMETHING_NOBODY_DECLARED',
      reason: 'Error: ENOENT at /Users/someone/secret/path.jpg',
      userMessage: 'unavailable',
      proof: blockedProof(),
    }),
  });
  const result = await h.closetMediaPrivacy.sanitizeClosetMedia(SOURCE_URI);
  assert.ok(allowed.has(result.reason), `unknown reason leaked: ${result.reason}`);
  assert.equal(result.reason, 'unexpected_native_result');
});
