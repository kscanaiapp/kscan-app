const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadModule(relPath, mocks = {}) {
  const filename = path.join(ROOT, relPath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.ts`)) resolved = `${resolved}.ts`;
      const rel = path.relative(ROOT, resolved).replace(/\\/g, '/');
      return loadModule(rel, mocks);
    }
    if (specifier.includes('canonicalDressingRoomItem')) {
      return loadModule('types/canonicalDressingRoomItem.ts', mocks);
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    require: localRequire,
    console,
  }, { filename });
  return mod.exports;
}

const {
  resolveDressingRoomImageSource,
  hasUsableDressingRoomImageSource,
  isRemoteImageUrl,
  isLocalImageUri,
  describeMissingImageReason,
} = loadModule('services/dressingRoomItemContract.ts');

test('resolves a durable storage reference when bucket + path are present', () => {
  const source = resolveDressingRoomImageSource({
    storageBucket: 'style-library-images',
    storagePath: 'user-1/scans/a.jpg',
    imageUrl: null,
    localUri: null,
  });
  assert.equal(source.kind, 'storage');
  if (source.kind === 'storage') {
    assert.equal(source.storageBucket, 'style-library-images');
    assert.equal(source.storagePath, 'user-1/scans/a.jpg');
  }
});

test('storage reference is preferred over a local URI when both are present', () => {
  const source = resolveDressingRoomImageSource({
    storageBucket: 'style-library-images',
    storagePath: 'user-1/scans/a.jpg',
    localUri: 'file:///tmp/a.jpg',
  });
  assert.equal(source.kind, 'storage');
});

test('falls back to a remote https URL when no storage reference exists', () => {
  const source = resolveDressingRoomImageSource({ imageUrl: 'https://cdn.example.com/a.jpg' });
  assert.equal(source.kind, 'remote');
  if (source.kind === 'remote') assert.equal(source.imageUrl, 'https://cdn.example.com/a.jpg');
});

test('falls back to a local URI only when nothing durable/remote is available', () => {
  const source = resolveDressingRoomImageSource({ localUri: 'file:///tmp/a.jpg' });
  assert.equal(source.kind, 'local');
  if (source.kind === 'local') assert.equal(source.localUri, 'file:///tmp/a.jpg');
});

test('imageUrl: null does NOT mean "no image" when a storage reference exists', () => {
  const candidate = { imageUrl: null, localUri: null, storageBucket: 'style-library-images', storagePath: 'x/y.jpg' };
  assert.equal(hasUsableDressingRoomImageSource(candidate), true);
});

test('resolves to none when no source is usable', () => {
  assert.equal(resolveDressingRoomImageSource({}).kind, 'none');
  assert.equal(
    resolveDressingRoomImageSource({ imageUrl: null, localUri: null, storageBucket: null, storagePath: null }).kind,
    'none',
  );
});

test('a bucket without a path (or vice versa) is not a usable storage source', () => {
  assert.equal(hasUsableDressingRoomImageSource({ storageBucket: 'style-library-images', storagePath: null }), false);
  assert.equal(hasUsableDressingRoomImageSource({ storageBucket: null, storagePath: 'x/y.jpg' }), false);
});

test('a non-remote imageUrl (e.g. missing protocol) is rejected', () => {
  assert.equal(isRemoteImageUrl('cdn.example.com/a.jpg'), false);
  assert.equal(isRemoteImageUrl('ftp://example.com/a.jpg'), false);
  assert.equal(hasUsableDressingRoomImageSource({ imageUrl: 'cdn.example.com/a.jpg' }), false);
});

test('recognizes device-local URI schemes', () => {
  for (const scheme of ['file', 'content', 'asset', 'ph']) {
    assert.equal(isLocalImageUri(`${scheme}://some/path`), true);
  }
  assert.equal(isLocalImageUri('https://example.com/a.jpg'), false);
  assert.equal(isLocalImageUri(null), false);
});

test('describeMissingImageReason returns a non-empty, user-facing explanation', () => {
  const reason = describeMissingImageReason();
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 0);
});
