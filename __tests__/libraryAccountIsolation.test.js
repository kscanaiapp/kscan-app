// Local Style Library must not cross accounts.
//
// Before scoping, every account on a device shared
// FileSystem.documentDirectory/kscan_library/. Sign-out cleared the Supabase
// session but nothing else, so after User A signed out and User B signed in,
// User B's Style Library listed User A's scan photos and style reads. Because
// the Style Library can push a scan into a Dressing Room, that local leak could
// also become a server-side cross-account write of User A's photo into User B's
// account.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const USER_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';

/**
 * In-memory expo-file-system stand-in. Directories are implicit: a path exists
 * if it is a stored file, or a prefix of one.
 */
function createFakeFs() {
  const files = new Map();

  const asDir = (p) => (p.endsWith('/') ? p : `${p}/`);

  return {
    files,
    api: {
      documentDirectory: 'file:///documents/',
      EncodingType: { UTF8: 'utf8' },
      makeDirectoryAsync: async () => undefined,
      getInfoAsync: async (uri) => {
        if (files.has(uri)) return { exists: true, isDirectory: false };
        const dir = asDir(uri);
        for (const key of files.keys()) {
          if (key.startsWith(dir)) return { exists: true, isDirectory: true };
        }
        return { exists: false };
      },
      readAsStringAsync: async (uri) => {
        if (!files.has(uri)) throw new Error(`ENOENT ${uri}`);
        return files.get(uri);
      },
      writeAsStringAsync: async (uri, contents) => {
        files.set(uri, contents);
      },
      moveAsync: async ({ from, to }) => {
        files.set(to, files.get(from) ?? `<binary:${from}>`);
        files.delete(from);
      },
      deleteAsync: async (uri) => {
        files.delete(uri);
        const dir = asDir(uri);
        for (const key of [...files.keys()]) {
          if (key.startsWith(dir)) files.delete(key);
        }
      },
    },
  };
}

/**
 * Load services/library.js with a fake filesystem and a controllable session.
 * @param {{fakeFs: object, getUserId: () => string|null}} opts
 */
function loadLibrary({ fakeFs, getUserId }) {
  const filename = path.join(ROOT, 'services', 'library.js');
  let source = fs.readFileSync(filename, 'utf8');

  // Strip ESM imports; dependencies are injected through the sandbox instead.
  source = source.replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '');
  source = source.replace(/^export const /gm, 'const ');
  source = source.replace(/^export async function /gm, 'async function ');
  source = source.replace(/^export function /gm, 'function ');
  source += '\nmodule.exports = { loadLibrary, saveScan, deleteScan, clearLibrary, __testing };';

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    Date,
    Math,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    Number,
    Promise,
    Error,
    Set,
    FileSystem: fakeFs.api,
    ImageManipulator: {
      SaveFormat: { JPEG: 'jpeg' },
      manipulateAsync: async (uri) => ({ uri: `${uri}#derived` }),
    },
    supabase: {
      auth: {
        getSession: async () => {
          const id = getUserId();
          return { data: { session: id ? { user: { id } } : null } };
        },
      },
    },
  };

  vm.runInNewContext(source, sandbox, { filename });
  return mod.exports;
}

function analysisFixture(category) {
  return {
    result: `A ${category} read`,
    metadata: { category, color: 'Black', silhouette: 'Relaxed', styleTags: ['Casual'] },
    products: [],
  };
}

// ── Core isolation ───────────────────────────────────────────────────────────

test('User B never sees User A scans after an account switch', async () => {
  const fakeFs = createFakeFs();
  let currentUser = USER_A;
  const lib = loadLibrary({ fakeFs, getUserId: () => currentUser });

  const savedA = await lib.saveScan({
    photoUri: 'file:///cache/a.jpg',
    analysis: analysisFixture('Outerwear'),
  });
  assert.ok(savedA, 'User A must be able to save');
  assert.equal((await lib.loadLibrary()).length, 1);

  // A signs out, B signs in on the same device.
  currentUser = USER_B;
  const bLibrary = await lib.loadLibrary();
  assert.deepEqual(
    Array.from(bLibrary),
    [],
    "User B's Style Library must not contain User A's scans",
  );

  // B saves their own scan; A's library is untouched.
  await lib.saveScan({ photoUri: 'file:///cache/b.jpg', analysis: analysisFixture('Footwear') });
  assert.equal((await lib.loadLibrary()).length, 1);

  currentUser = USER_A;
  const aLibrary = await lib.loadLibrary();
  assert.equal(aLibrary.length, 1);
  assert.equal(aLibrary[0].attributes.category, 'Outerwear', "User A keeps their own library");
});

test('signing out drops to the anonymous scope, not the last account', async () => {
  const fakeFs = createFakeFs();
  let currentUser = USER_A;
  const lib = loadLibrary({ fakeFs, getUserId: () => currentUser });

  await lib.saveScan({ photoUri: 'file:///cache/a.jpg', analysis: analysisFixture('Tops') });

  currentUser = null;
  assert.deepEqual(
    Array.from(await lib.loadLibrary()),
    [],
    'a signed-out device must not list the previous account’s scans',
  );
});

test('scan media is written under the owning account scope', async () => {
  const fakeFs = createFakeFs();
  const lib = loadLibrary({ fakeFs, getUserId: () => USER_A });

  const saved = await lib.saveScan({
    photoUri: 'file:///cache/a.jpg',
    analysis: analysisFixture('Dresses'),
  });

  assert.match(saved.imageUri, new RegExp(`kscan_library/u_${USER_A}/images/`));
  assert.match(saved.thumbnailUri, new RegExp(`kscan_library/u_${USER_A}/thumbnails/`));

  for (const key of fakeFs.files.keys()) {
    assert.match(
      key,
      /kscan_library\/(u_[A-Za-z0-9_-]+|anonymous)\//,
      `every stored path must be account-scoped: ${key}`,
    );
  }
});

test('deleting a scan only affects the owning account', async () => {
  const fakeFs = createFakeFs();
  let currentUser = USER_A;
  const lib = loadLibrary({ fakeFs, getUserId: () => currentUser });

  const savedA = await lib.saveScan({
    photoUri: 'file:///cache/a.jpg',
    analysis: analysisFixture('Tops'),
  });

  currentUser = USER_B;
  // User B cannot reach into User A's library even with a known id.
  await lib.deleteScan(savedA.id);

  currentUser = USER_A;
  assert.equal((await lib.loadLibrary()).length, 1, "User A's scan must survive");
});

// ── Account deletion ─────────────────────────────────────────────────────────

test('clearLibrary removes the account scan media from the device', async () => {
  const fakeFs = createFakeFs();
  const lib = loadLibrary({ fakeFs, getUserId: () => USER_A });

  await lib.saveScan({ photoUri: 'file:///cache/a.jpg', analysis: analysisFixture('Tops') });
  assert.ok(fakeFs.files.size > 0);

  await lib.clearLibrary();

  assert.deepEqual(Array.from(await lib.loadLibrary()), []);
  for (const key of fakeFs.files.keys()) {
    assert.doesNotMatch(key, new RegExp(`u_${USER_A}`), `residual file for a deleted account: ${key}`);
  }
});

test('account deletion clears the local library', () => {
  const screen = fs.readFileSync(path.join(ROOT, 'app', 'privacy.tsx'), 'utf8');
  assert.match(screen, /clearLibrary/, 'deletion must purge device-local scan media');
});

// ── Upgrade migration ────────────────────────────────────────────────────────

test('a pre-scoping library migrates once into the signed-in account and is removed', async () => {
  const fakeFs = createFakeFs();
  const root = 'file:///documents/kscan_library/';

  const legacyScan = {
    id: 'scan_legacy_1',
    createdAt: '2026-09-01T00:00:00.000Z',
    imageUri: `${root}images/scan_legacy_1.jpg`,
    thumbnailUri: `${root}thumbnails/scan_legacy_1.jpg`,
    attributes: { category: 'Accessories', silhouette: '', color_palette: '' },
    result: 'legacy read',
    products: [],
    source: 'scan',
  };
  fakeFs.files.set(`${root}kscan_library.json`, JSON.stringify([legacyScan]));
  fakeFs.files.set(legacyScan.imageUri, '<binary:image>');
  fakeFs.files.set(legacyScan.thumbnailUri, '<binary:thumb>');

  let currentUser = USER_A;
  const lib = loadLibrary({ fakeFs, getUserId: () => currentUser });

  const migrated = await lib.loadLibrary();
  assert.equal(migrated.length, 1, 'an upgrading user must keep their existing scans');
  assert.match(migrated[0].imageUri, new RegExp(`u_${USER_A}/images/`));

  // The legacy copy must be gone so the next account cannot read it.
  assert.equal(fakeFs.files.has(`${root}kscan_library.json`), false);

  currentUser = USER_B;
  assert.deepEqual(
    Array.from(await lib.loadLibrary()),
    [],
    'the migrated library must not leak to the next account',
  );
});

// ── Scope key ────────────────────────────────────────────────────────────────

test('scope keys are path-safe and distinct per account', () => {
  const fakeFs = createFakeFs();
  const lib = loadLibrary({ fakeFs, getUserId: () => USER_A });
  const { scopeKeyForOwner, ANONYMOUS_SCOPE } = lib.__testing;

  assert.equal(scopeKeyForOwner(USER_A), `u_${USER_A}`);
  assert.notEqual(scopeKeyForOwner(USER_A), scopeKeyForOwner(USER_B));

  for (const empty of [null, undefined, '', '   ', 123]) {
    assert.equal(scopeKeyForOwner(empty), ANONYMOUS_SCOPE);
  }

  // A hostile id must not be able to escape the library root.
  assert.equal(scopeKeyForOwner('../../etc/passwd'), 'u_etcpasswd');
  assert.doesNotMatch(scopeKeyForOwner('../../etc/passwd'), /[./]/);
});
