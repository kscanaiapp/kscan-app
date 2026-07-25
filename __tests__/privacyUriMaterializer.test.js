// URI-materialization tests: content:// and file:// sources are copied into
// the app-private privacy cache while the temporary grant is valid; every
// failure leaves no partial copy behind.

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
    console,
    exports: mod.exports,
    module: mod,
    Date,
    Math,
    Object,
    Array,
    JSON,
    String,
    Promise,
    RegExp,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

function makeFsStub(state) {
  return {
    cacheDirectory: 'file:///app-cache/',
    makeDirectoryAsync: async () => {},
    copyAsync: async ({ from, to }) => {
      state.copies.push({ from, to });
      if (state.copyError) throw state.copyError;
      state.files.set(to, { size: state.copiedSize });
    },
    getInfoAsync: async (uri) => {
      const f = state.files.get(uri);
      return f ? { exists: true, size: f.size } : { exists: false };
    },
    deleteAsync: async (uri) => {
      state.deletes.push(uri);
      state.files.delete(uri);
    },
    readDirectoryAsync: async () => [],
  };
}

function loadChain(state) {
  const fsStub = makeFsStub(state);
  const store = loadTsModule('services/privacy/privacyArtifactStore.ts', {
    'expo-file-system/legacy': fsStub,
    'expo-crypto': { randomUUID: () => `uuid-${state.uuidCounter++}` },
  });
  const materializer = loadTsModule('services/privacy/uriMaterializer.ts', {
    './privacyArtifactStore': store,
    'expo-file-system/legacy': fsStub,
  });
  return { store, materializer };
}

function freshState(overrides = {}) {
  return {
    files: new Map(),
    copies: [],
    deletes: [],
    copyError: null,
    copiedSize: 1024,
    uuidCounter: 1,
    ...overrides,
  };
}

test('file:// source materializes into a randomized app-private path', async () => {
  const state = freshState();
  const { materializer } = loadChain(state);
  const out = await materializer.materializeImageForPrivacy('file:///photos/original.jpg');
  assert.ok(out.uri.startsWith('file:///app-cache/kscan-privacy/orig-uuid-'), out.uri);
  assert.ok(!out.uri.includes('original'), 'materialized name must not leak the source name');
  assert.equal(out.sizeBytes, 1024);
});

test('content:// source materializes through a copy of the temporary grant', async () => {
  const state = freshState();
  const { materializer } = loadChain(state);
  const out = await materializer.materializeImageForPrivacy(
    'content://media/picker/0/com.android.providers.media.photopicker/media/1234',
  );
  assert.equal(state.copies.length, 1);
  assert.equal(
    state.copies[0].from,
    'content://media/picker/0/com.android.providers.media.photopicker/media/1234',
  );
  assert.ok(out.uri.startsWith('file:///app-cache/kscan-privacy/'));
});

test('expired or revoked content:// grant fails closed with recoverable message', async () => {
  const state = freshState({ copyError: new Error('SecurityException: permission revoked') });
  const { materializer } = loadChain(state);
  await assert.rejects(
    () => materializer.materializeImageForPrivacy('content://media/external/images/media/9'),
    (err) => {
      assert.equal(err.code, 'ACCESS_EXPIRED_OR_DENIED');
      assert.match(err.message, /reselect the image/i);
      return true;
    },
  );
  assert.equal(state.deletes.length, 1, 'partial copy must be cleaned up');
});

test('file:// copy failure is COPY_FAILED and cleans the partial copy', async () => {
  const state = freshState({ copyError: new Error('disk full') });
  const { materializer } = loadChain(state);
  await assert.rejects(
    () => materializer.materializeImageForPrivacy('file:///photos/a.jpg'),
    (err) => err.code === 'COPY_FAILED',
  );
  assert.equal(state.deletes.length, 1);
});

test('oversized source is rejected before processing and removed', async () => {
  const state = freshState({ copiedSize: 30 * 1024 * 1024 });
  const { materializer } = loadChain(state);
  await assert.rejects(
    () => materializer.materializeImageForPrivacy('file:///photos/huge.jpg'),
    (err) => {
      assert.equal(err.code, 'SOURCE_TOO_LARGE');
      return true;
    },
  );
  assert.equal(state.deletes.length, 1, 'oversized copy must be deleted');
});

test('empty source is rejected and removed', async () => {
  const state = freshState({ copiedSize: 0 });
  const { materializer } = loadChain(state);
  await assert.rejects(
    () => materializer.materializeImageForPrivacy('file:///photos/empty.jpg'),
    (err) => err.code === 'EMPTY_SOURCE',
  );
  assert.equal(state.deletes.length, 1);
});

test('unsupported schemes are rejected without any file work', async () => {
  const state = freshState();
  const { materializer } = loadChain(state);
  for (const uri of ['https://example.invalid/a.jpg', 'data:image/jpeg;base64,QUJD', '', null]) {
    await assert.rejects(
      () => materializer.materializeImageForPrivacy(uri),
      (err) => err.code === 'UNSUPPORTED_SCHEME',
    );
  }
  assert.equal(state.copies.length, 0);
});

test('boundary removes the materialized original after processing', async () => {
  // Full-boundary run with the closed plate gate: even the earliest BLOCKED
  // return path must leave no materialized original behind. (The gate blocks
  // before materialization, so nothing is created; the failure-path cleanup
  // is covered in privacyBoundaryEnforcement.test.js with an open gate.)
  const state = freshState();
  const { store, materializer } = loadChain(state);
  const boundary = loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': {
      isNativeFaceEngineLinked: () => false,
      detectAndMaskFacesLocal: async () => null,
      cleanupNativeSanitizedImage: async () => null,
    },
    './plateDetection': loadTsModule('services/privacy/plateDetection.ts'),
    './privacyProof': loadTsModule('services/privacy/privacyProof.ts'),
    './privacyArtifactStore': store,
    './uriMaterializer': materializer,
  });
  const result = await boundary.prepareImageForDispatch('file:///photos/a.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(state.copies.length, 0, 'blocked gate must not materialize anything');
  for (const [uri] of state.files) {
    assert.ok(!uri.includes('orig-'), 'no original may persist');
  }
});
