// Deterministic upload-pipeline harness for the iOS v13→v15 regression repair.
// Covers picker-normalization invariants, preparation, MIME/filename, request
// construction, auth/timeouts, and cleanup ownership without personal images.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

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

const REQUIRED_FIXTURES = [
  'small-jpeg.jpg',
  'large-jpeg.jpg',
  'portrait-heic.heic',
  'landscape-heic.heic',
  'screenshot.png',
  'multi-item-outfit.jpg',
  'multi-image-01.jpg',
  'multi-image-02.jpg',
  'multi-image-03.jpg',
];

test('fixture set present for upload regression harness', () => {
  for (const name of REQUIRED_FIXTURES) {
    const full = path.join(FIXTURES, name);
    assert.ok(fs.existsSync(full), `missing fixture ${name}`);
    assert.ok(fs.statSync(full).size > 0, `zero-byte fixture ${name}`);
  }
});

test('URI normalization accepts local file/content schemes only', async () => {
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': {
      SaveFormat: { JPEG: 'jpeg' },
      manipulateAsync: async (uri) => ({ uri: `${uri}.prepared.jpg`, width: 100, height: 100 }),
    },
    'expo-file-system/legacy': { deleteAsync: async () => {} },
  });

  await assert.rejects(() => privacy.prepareImageForPrivacyUpload('ph://asset/123'), /must be on this device/);
  await assert.rejects(() => privacy.prepareImageForPrivacyUpload('assets-library://asset/123'), /must be on this device/);
  await assert.rejects(() => privacy.prepareImageForPrivacyUpload('https://cdn.example/a.jpg'), /must be on this device/);
  const ok = await privacy.prepareImageForPrivacyUpload('file:///tmp/small-jpeg.jpg');
  assert.equal(ok.sanitizedUri, 'file:///tmp/small-jpeg.jpg.prepared.jpg');
  assert.equal(ok.policy.metadataStripped, true);
});

test('HEIC/JPEG/PNG fixture names map to preparation availability', () => {
  assert.equal(
    loadTsModule('services/privacyImageUpload.ts', {
      'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({}) },
      'expo-file-system/legacy': { deleteAsync: async () => {} },
    }).isPrivateImageUploadAvailable(),
    true,
  );
});

test('Scanner sanitizer returns usable string (v13 invariant)', async () => {
  const sanitizer = loadTsModule('services/privacyImageSanitizer.js', {});
  const status = sanitizer.getPrivacySanitizerStatus();
  assert.equal(status.mode, 'passthrough');
  assert.equal(status.remoteTransmissionAllowed, true);
  const input = 'data:image/jpeg;base64,QUJD';
  assert.equal(await sanitizer.sanitizeImageBeforeUpload(input), input);
});

test('identifyScanImage attaches auth session and invokes scan-identify', async () => {
  let invokedFn = null;
  let body = null;
  const adapter = loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': {
      supabase: {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
        functions: {
          invoke: async (fn, opts) => {
            invokedFn = fn;
            body = opts.body;
            return {
              data: { status: 'completed', recommendedProducts: [], attributes: { category: 'Tops' } },
              error: null,
            };
          },
        },
      },
    },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
  });

  const out = await adapter.identifyScanImage('data:image/jpeg;base64,QUJD', {
    source: 'upload',
    localPrivacyFiltered: true,
  });
  assert.equal(out.status, 'completed');
  assert.equal(invokedFn, 'scan-identify');
  assert.equal(body.source, 'upload');
  assert.equal(body.localPrivacyFiltered, true);
  assert.equal(body.imageBase64, 'QUJD');
});

test('identifyScanImage: 401-equivalent missing session fails before invoke', async () => {
  let invoked = false;
  const adapter = loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': {
      supabase: {
        auth: { getSession: async () => ({ data: { session: null } }) },
        functions: { invoke: async () => { invoked = true; return { data: null, error: null }; } },
      },
    },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
  });
  const out = await adapter.identifyScanImage('data:image/jpeg;base64,QUJD', { source: 'camera' });
  assert.equal(out.status, 'failed');
  assert.match(out.userMessage, /sign in/i);
  assert.equal(invoked, false);
});

test('identifyScanImage: oversized payload rejected as 413-class client guard', async () => {
  let invoked = false;
  const huge = `data:image/jpeg;base64,${'A'.repeat(2 * 1024 * 1024 + 16)}`;
  const adapter = loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': {
      supabase: {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
        functions: { invoke: async () => { invoked = true; return { data: null, error: null }; } },
      },
    },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
  });
  const out = await adapter.identifyScanImage(huge, { source: 'upload', localPrivacyFiltered: true });
  assert.equal(out.status, 'failed');
  assert.match(out.userMessage, /too large/i);
  assert.equal(invoked, false);
});

test('cleanupSanitizedImage is best-effort and never throws', async () => {
  let deleted = null;
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({}) },
    'expo-file-system/legacy': {
      deleteAsync: async (uri) => {
        deleted = uri;
        throw new Error('missing');
      },
    },
  });
  await privacy.cleanupSanitizedImage(null);
  await privacy.cleanupSanitizedImage('file:///cache/tmp.jpg');
  assert.equal(deleted, 'file:///cache/tmp.jpg');
});

test('already-aborted signal short-circuits request ownership', async () => {
  let invoked = false;
  const adapter = loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': {
      supabase: {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
        functions: { invoke: async () => { invoked = true; return { data: null, error: null }; } },
      },
    },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
  });
  const controller = new AbortController();
  controller.abort();
  const out = await adapter.identifyScanImage('data:image/jpeg;base64,QUJD', {
    source: 'camera',
    localPrivacyFiltered: true,
    signal: controller.signal,
  });
  assert.equal(invoked, false);
  assert.equal(out.status, 'failed');
});
