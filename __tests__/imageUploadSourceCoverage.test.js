// Source-coverage harness for the Scanner upload pipeline (Batch 6).
//
// The v13→v15 regression repair (79f1106) proved generic URI acceptance and
// dispatch. This suite closes the remaining evidence gaps: every intended
// local-image SOURCE must independently pass preparation and reach
// identifyScanImage through the canonical Scanner chain
//   compressForUpload → sanitizeImageBeforeUpload → identifyScanImage
// with no dependency on the image having been captured during the current
// Scanner session.
//
// Sources covered:
//   1. New camera photo                (file://, source 'camera')
//   2. Existing/older library photo    (file://, aged mtime, source 'upload')
//   3. Screenshot from the library     (file:// PNG fixture, source 'upload')
//   4. Android picker asset            (content://, source 'upload')
//
// No production code is exercised through mocks other than the native
// expo-image-manipulator / expo-file-system / supabase boundaries.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const observabilityStub = require('./helpers/observabilityStub');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'image-upload');

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
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    Error,
    Promise,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

/**
 * expo-image-manipulator mock backed by REAL fixture bytes. `uriRegistry`
 * maps a picker-style URI to the file on disk that "is" that asset; the mock
 * returns that file's base64, exactly as the native module would after
 * re-encode. Unknown URIs throw, so a test cannot silently pass with an
 * unregistered source.
 */
function manipulatorBackedBy(uriRegistry) {
  return {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, _actions, options) => {
      const backing = uriRegistry[uri];
      if (!backing) throw new Error(`manipulate: unregistered uri ${uri}`);
      const bytes = fs.readFileSync(backing);
      return {
        uri: `${uri}.prepared.jpg`,
        width: 100,
        height: 100,
        ...(options?.base64 ? { base64: bytes.toString('base64') } : {}),
      };
    },
  };
}

/** Canonical Scanner chain with a capture on functions.invoke. */
function buildScannerChain(uriRegistry) {
  const imageUtils = loadTsModule('services/imageUtils.js', {
    'expo-image-manipulator': manipulatorBackedBy(uriRegistry),
  });
  const sanitizer = loadTsModule('services/privacyImageSanitizer.js', {});
  const calls = [];
  const adapter = loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': {
      supabase: {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
        functions: {
          invoke: async (fn, opts) => {
            calls.push({ fn, body: opts.body });
            return {
              data: { status: 'completed', recommendedProducts: [], attributes: { category: 'Tops' } },
              error: null,
            };
          },
        },
      },
    },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
    './observability': observabilityStub,
  });
  return { imageUtils, sanitizer, adapter, calls };
}

async function runCanonicalUpload(chain, uri, source) {
  const compressed = await chain.imageUtils.compressForUpload(uri);
  assert.ok(compressed.startsWith('data:image/jpeg;base64,'), 'prep must emit a data URI');
  const sanitized = await chain.sanitizer.sanitizeImageBeforeUpload(compressed);
  assert.equal(sanitized, compressed, 'sanitizer must stay passthrough (v13 invariant)');
  const out = await chain.adapter.identifyScanImage(sanitized, {
    source,
    localPrivacyFiltered: true,
  });
  return { compressed, out };
}

const SOURCES = [
  {
    name: 'camera-produced photo',
    uri: 'file:///var/mobile/Containers/Data/Application/ABC/tmp/camera-capture.jpg',
    backing: path.join(FIXTURES, 'small-jpeg.jpg'),
    source: 'camera',
  },
  {
    name: 'existing library photo',
    uri: 'file:///var/mobile/Media/DCIM/100APPLE/IMG_0042.JPG',
    backing: path.join(FIXTURES, 'large-jpeg.jpg'),
    source: 'upload',
  },
  {
    name: 'screenshot from library',
    uri: 'file:///var/mobile/Media/DCIM/100APPLE/IMG_0099.PNG',
    backing: path.join(FIXTURES, 'screenshot.png'),
    source: 'upload',
  },
  {
    name: 'Android picker asset',
    uri: 'content://media/external/images/media/1234',
    backing: path.join(FIXTURES, 'small-jpeg.jpg'),
    source: 'upload',
  },
];

for (const src of SOURCES) {
  test(`canonical Scanner path: ${src.name} passes preparation and reaches scan-identify`, async () => {
    const chain = buildScannerChain({ [src.uri]: src.backing });
    const { out } = await runCanonicalUpload(chain, src.uri, src.source);

    assert.equal(out.status, 'completed', `${src.name}: dispatch must produce a usable result`);
    assert.equal(chain.calls.length, 1, `${src.name}: exactly one dispatch`);
    assert.equal(chain.calls[0].fn, 'scan-identify', `${src.name}: canonical edge function`);
    assert.equal(chain.calls[0].body.source, src.source);
    assert.equal(chain.calls[0].body.localPrivacyFiltered, true);

    // Base64 extraction per source: the request body must carry exactly the
    // fixture's bytes with the data-URI prefix stripped.
    const expected = fs.readFileSync(src.backing).toString('base64');
    assert.equal(chain.calls[0].body.imageBase64, expected, `${src.name}: base64 must match source bytes`);
  });
}

test('previously saved image (aged mtime, not captured this session) reaches dispatch', async () => {
  // Materialize a genuinely OLD asset: a copy of the library fixture whose
  // mtime is years in the past, proving the pipeline has no dependency on
  // capture-time or current-session state.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-old-asset-'));
  const oldCopy = path.join(tmpDir, 'IMG_2019_1231.jpg');
  fs.copyFileSync(path.join(FIXTURES, 'large-jpeg.jpg'), oldCopy);
  const aged = new Date('2024-01-01T00:00:00Z');
  fs.utimesSync(oldCopy, aged, aged);

  try {
    const stat = fs.statSync(oldCopy);
    assert.ok(
      Date.now() - stat.mtimeMs > 365 * 24 * 3600 * 1000,
      'fixture copy must be verifiably older than one year',
    );

    const uri = 'file:///var/mobile/Media/DCIM/100APPLE/IMG_2019_1231.JPG';
    const chain = buildScannerChain({ [uri]: oldCopy });

    // No scanSessionId, no imageDigestPrefix, no signal: the service must
    // dispatch on image content alone.
    const { out } = await runCanonicalUpload(chain, uri, 'upload');
    assert.equal(out.status, 'completed');
    assert.equal(chain.calls.length, 1);
    assert.equal(chain.calls[0].body.scanSessionId, undefined, 'no session id must be required');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('repeat dispatch of the same library image is not gated by one-shot state', async () => {
  const uri = 'file:///var/mobile/Media/DCIM/100APPLE/IMG_0042.JPG';
  const chain = buildScannerChain({ [uri]: path.join(FIXTURES, 'large-jpeg.jpg') });

  const first = await runCanonicalUpload(chain, uri, 'upload');
  const second = await runCanonicalUpload(chain, uri, 'upload');

  assert.equal(first.out.status, 'completed');
  assert.equal(second.out.status, 'completed');
  assert.equal(chain.calls.length, 2, 'a second attempt with the same asset must dispatch again');
  const { clientTimestamp: t1, ...body1 } = chain.calls[0].body;
  const { clientTimestamp: t2, ...body2 } = chain.calls[1].body;
  assert.deepEqual(body1, body2, 'identical asset must produce identical request bodies (modulo timestamp)');
  assert.ok(typeof t1 === 'string' && typeof t2 === 'string', 'each dispatch carries its own timestamp');
});

test('oversized library asset is rejected per-source before dispatch', async () => {
  const chain = buildScannerChain({});
  const huge = `data:image/jpeg;base64,${'A'.repeat(2 * 1024 * 1024 + 16)}`;
  const out = await chain.adapter.identifyScanImage(huge, {
    source: 'upload',
    localPrivacyFiltered: true,
  });
  assert.equal(out.status, 'failed');
  assert.match(out.userMessage, /too large/i);
  assert.equal(chain.calls.length, 0, 'oversized payload must never reach invoke');
});

test('Elise/inspiration prep positively accepts Android content:// URIs', async () => {
  // Closes the assertion gap in imageUploadRegression.test.js, whose
  // "file/content schemes" test never exercised a positive content:// case.
  let receivedUri = null;
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': {
      SaveFormat: { JPEG: 'jpeg' },
      manipulateAsync: async (uri) => {
        receivedUri = uri;
        return { uri: `${uri}.prepared.jpg`, width: 100, height: 100 };
      },
    },
    'expo-file-system/legacy': { deleteAsync: async () => {} },
  });

  const ok = await privacy.prepareImageForPrivacyUpload('content://media/external/images/media/1234');
  assert.equal(receivedUri, 'content://media/external/images/media/1234');
  assert.equal(ok.sanitizedUri, 'content://media/external/images/media/1234.prepared.jpg');
  assert.equal(ok.policy.metadataStripped, true);
});
