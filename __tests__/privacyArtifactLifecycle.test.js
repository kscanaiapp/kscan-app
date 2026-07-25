// Privacy-artifact lifecycle tests: ownership validation, idempotent
// deletion, guaranteed cleanup on every terminal path, bounded stale sweep,
// and actor-change/sign-out hygiene.

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

function makeState() {
  return {
    files: new Map(), // uri -> { modificationTime (seconds) }
    deletes: [],
    dirDeletes: [],
  };
}

function loadStore(state) {
  const fsStub = {
    cacheDirectory: 'file:///app-cache/',
    makeDirectoryAsync: async () => {},
    deleteAsync: async (uri) => {
      state.deletes.push(uri);
      if (uri.endsWith('/')) state.dirDeletes.push(uri);
      state.files.delete(uri);
    },
    readDirectoryAsync: async () => {
      return [...state.files.keys()]
        .filter((u) => u.startsWith('file:///app-cache/kscan-privacy/'))
        .map((u) => u.replace('file:///app-cache/kscan-privacy/', ''));
    },
    getInfoAsync: async (uri) => {
      const f = state.files.get(uri);
      return f ? { exists: true, modificationTime: f.modificationTime } : { exists: false };
    },
  };
  return loadTsModule('services/privacy/privacyArtifactStore.ts', {
    'expo-file-system/legacy': fsStub,
    'expo-crypto': { randomUUID: () => 'uuid-1' },
  });
}

test('ownership: only file:// URIs inside the namespace are owned', () => {
  const store = loadStore(makeState());
  assert.equal(store.isOwnedPrivacyArtifactUri('file:///app-cache/kscan-privacy/san-a.png'), true);
  assert.equal(store.isOwnedPrivacyArtifactUri('file:///app-cache/kscan-privacy-evil/san-a.png'), false);
  assert.equal(store.isOwnedPrivacyArtifactUri('file:///app-cache/other/san-a.png'), false);
  assert.equal(store.isOwnedPrivacyArtifactUri('content://media/1'), false);
  assert.equal(store.isOwnedPrivacyArtifactUri('https://example.invalid/x.png'), false);
  assert.equal(store.isOwnedPrivacyArtifactUri(null), false);
});

test('deletion is ownership-guarded and idempotent (repeated cleanup safe)', async () => {
  const state = makeState();
  const store = loadStore(state);
  const owned = 'file:///app-cache/kscan-privacy/orig-a.jpg';
  state.files.set(owned, { modificationTime: 1 });
  assert.equal(await store.deletePrivacyArtifact(owned), true);
  assert.equal(await store.deletePrivacyArtifact(owned), true, 'second delete is idempotent');
  assert.equal(
    await store.deletePrivacyArtifact('file:///somewhere/else.jpg'),
    false,
    'non-owned URIs are rejected untouched',
  );
  assert.ok(!state.deletes.includes('file:///somewhere/else.jpg'));
});

test('stale sweep deletes only old artifacts and is bounded', async () => {
  const state = makeState();
  const nowSec = Math.floor(Date.now() / 1000);
  // 3 stale (10h old), 1 fresh.
  for (let i = 0; i < 3; i++) {
    state.files.set(`file:///app-cache/kscan-privacy/orig-stale-${i}.jpg`, {
      modificationTime: nowSec - 10 * 3600,
    });
  }
  state.files.set('file:///app-cache/kscan-privacy/san-fresh.png', { modificationTime: nowSec - 60 });
  const store = loadStore(state);
  const summary = await store.sweepStalePrivacyArtifacts({ maxDeletions: 2 });
  assert.equal(summary.deleted, 2, 'sweep must honor the deletion bound');
  const remainingStale = [...state.files.keys()].filter((u) => u.includes('stale'));
  assert.equal(remainingStale.length, 1, 'one stale artifact remains for the next sweep');
  assert.ok(state.files.has('file:///app-cache/kscan-privacy/san-fresh.png'), 'fresh artifact untouched');
});

test('cleanupAllPrivacyArtifacts removes the whole namespace (sign-out / actor change)', async () => {
  const state = makeState();
  const store = loadStore(state);
  await store.cleanupAllPrivacyArtifacts();
  assert.ok(
    state.deletes.includes('file:///app-cache/kscan-privacy/'),
    'namespace directory removed',
  );
});

test('_layout wires the stale sweep and actor-change cleanup', () => {
  const layout = fs.readFileSync(path.join(ROOT, 'app/_layout.tsx'), 'utf8');
  assert.match(layout, /sweepStalePrivacyArtifacts\(\)/, 'init sweep must run at startup');
  assert.match(layout, /cleanupAllPrivacyArtifacts\(\)/, 'actor-change cleanup must be wired');
  assert.match(
    layout,
    /useEffect\(\(\) => \{[\s\S]{0,400}cleanupAllPrivacyArtifacts/,
    'cleanup runs from an effect watching the session actor',
  );
});

test('boundary guarantees cleanup on cancellation-like rejection (finally path)', async () => {
  // A detector that rejects mid-flight simulates timeout/cancellation. The
  // finally block must still remove the materialized original.
  const deleted = [];
  const boundary = loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': {
      isNativeFaceEngineLinked: () => true,
      detectAndMaskFacesLocal: async () => {
        throw new Error('aborted');
      },
      cleanupNativeSanitizedImage: async () => null,
    },
    './plateDetection': {
      PLATE_DETECTION_SUPPORTED: true,
      detectPlates: async () => ({ supported: true, performed: true, regionsDetected: 0, regionsAccepted: 0, confidence: [], boundingBoxes: [], durationMs: 1 }),
    },
    './privacyProof': loadTsModule('services/privacy/privacyProof.ts'),
    './privacyArtifactStore': {
      deletePrivacyArtifact: async (uri) => {
        deleted.push(uri);
        return true;
      },
      isOwnedPrivacyArtifactUri: () => true,
    },
    './uriMaterializer': {
      materializeImageForPrivacy: async () => ({ uri: 'file:///app-cache/kscan-privacy/orig-c.jpg', sizeBytes: 5 }),
      MaterializeError: class extends Error {},
    },
  });
  await assert.rejects(() => boundary.prepareImageForDispatch('file:///photos/c.jpg'), /aborted/);
  assert.ok(deleted.includes('file:///app-cache/kscan-privacy/orig-c.jpg'), 'finally cleanup ran');
});

test('successful run transfers sanitized ownership and cleanup handle works', async () => {
  const deleted = [];
  const nativeCleaned = [];
  const boundary = loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': {
      isNativeFaceEngineLinked: () => true,
      detectAndMaskFacesLocal: async () => ({
        status: 'success',
        sanitizedUri: 'file:///app-cache/kscan-privacy/san-ok.png',
        facesDetected: 2,
        facesMasked: 2,
        sanitizerVersion: 'test-1',
        warnings: [],
      }),
      cleanupNativeSanitizedImage: async (uri) => {
        nativeCleaned.push(uri);
        return { deleted: true, rejected: false, warnings: [] };
      },
    },
    './plateDetection': {
      PLATE_DETECTION_SUPPORTED: true,
      detectPlates: async () => ({ supported: true, performed: true, regionsDetected: 0, regionsAccepted: 0, confidence: [], boundingBoxes: [], durationMs: 1 }),
    },
    './privacyProof': loadTsModule('services/privacy/privacyProof.ts'),
    './privacyArtifactStore': {
      deletePrivacyArtifact: async (uri) => {
        deleted.push(uri);
        return true;
      },
      isOwnedPrivacyArtifactUri: (uri) => String(uri).includes('/kscan-privacy/'),
    },
    './uriMaterializer': {
      materializeImageForPrivacy: async () => ({ uri: 'file:///app-cache/kscan-privacy/orig-d.jpg', sizeBytes: 5 }),
      MaterializeError: class extends Error {},
    },
  });
  const result = await boundary.prepareImageForDispatch('file:///photos/d.jpg');
  assert.equal(result.status, 'SANITIZED_AND_VERIFIED');
  assert.equal(result.proof.facesMasked, 2);
  assert.equal(result.proof.processingCompleted, true);
  assert.ok(deleted.includes('file:///app-cache/kscan-privacy/orig-d.jpg'), 'original removed after success');
  assert.ok(!deleted.includes('file:///app-cache/kscan-privacy/san-ok.png'), 'sanitized artifact survives for the caller');
  await result.cleanup();
  assert.ok(nativeCleaned.includes('file:///app-cache/kscan-privacy/san-ok.png'));
  assert.ok(deleted.includes('file:///app-cache/kscan-privacy/san-ok.png'), 'cleanup handle removes sanitized artifact');
});
