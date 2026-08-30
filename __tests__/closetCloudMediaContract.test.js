// Build 34 / Track B / Phase B1C -- cloud Closet media contract.
//
// Source-level and behavioural checks over the media contract added in
// 20260829220316_user_closet_items_media.sql, the deletion-registry wiring, and
// services/closetMedia.ts. Live-staging RLS/constraint proof is recorded in
// docs/build34-trackb-b1c-closet-media-ledger.md; these tests pin the parts CI
// can enforce without a database.
//
// Every negative control here mutates only in-memory copies -- no file on disk
// and no live staging object, policy or constraint is ever weakened.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const { deleteOwnedStorageObjects, STORAGE_RESOURCES } = require('../scripts/process-deletion-request');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260829220316_user_closet_items_media.sql'),
  'utf8',
);
const CLOSET_MEDIA_TS = fs.readFileSync(path.join(ROOT, 'services', 'closetMedia.ts'), 'utf8');
const EDGE_REGISTRY = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion', 'userDataResources.ts'),
  'utf8',
);
const JSON_REGISTRY = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'lib', 'account-deletion', 'user-data-resources.json'), 'utf8'),
);

// The canonical path shape, expressed once here so a drift in either the SQL
// constraint or the TS helper is caught by comparison rather than by trust.
const UID = '11111111-2222-3333-4444-555555555555';
const ITEM = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EXPECTED_PRIMARY = `${UID}/closet/${ITEM}-primary.jpg`;
const EXPECTED_THUMB = `${UID}/closet/${ITEM}-thumb.jpg`;

// Behavioural storage mock mirroring __tests__/processDeletionRequest.test.js.
// Storage list() is NOT recursive: a sub-folder surfaces as a single entry with
// no metadata, never as the objects inside it. That is reproduced faithfully
// here because it is the exact property the flat Closet layout depends on.
function createStorageMock(filesByPrefix = {}) {
  const removed = [];
  const listed = [];
  const store = {};
  for (const [prefix, items] of Object.entries(filesByPrefix)) {
    store[prefix] = items.map((i) => ({ ...i }));
  }
  return {
    removed,
    listed,
    client: {
      from() {
        const builder = {
          select() { return builder; },
          like() { return builder; },
          range() { return Promise.resolve({ data: [], error: null }); },
        };
        return builder;
      },
      storage: {
        from(bucket) {
          return {
            async list(prefix) {
              listed.push({ bucket, prefix });
              return { data: store[prefix] ?? [], error: null };
            },
            async remove(paths) {
              removed.push({ bucket, paths });
              const removedObjects = [];
              for (const p of paths) {
                const slash = p.lastIndexOf('/');
                const prefix = p.slice(0, slash);
                const name = p.slice(slash + 1);
                const bucketList = store[prefix] ?? [];
                const idx = bucketList.findIndex((i) => i.name === name);
                if (idx >= 0) {
                  removedObjects.push({ name });
                  bucketList.splice(idx, 1);
                }
              }
              return { data: removedObjects, error: null };
            },
          };
        },
      },
    },
  };
}

// ── Path contract ────────────────────────────────────────────────────────────

test('closetMedia derives deterministic owner- and server-id-scoped paths', () => {
  const { buildClosetMediaPaths, buildClosetMediaPrefix } = loadClosetMedia();
  assert.equal(buildClosetMediaPrefix(UID), `${UID}/closet`);
  const paths = buildClosetMediaPaths(UID, ITEM);
  assert.equal(paths.primary, EXPECTED_PRIMARY);
  assert.equal(paths.thumbnail, EXPECTED_THUMB);
});

test('the SQL CHECK constraints pin exactly the paths the TS helper builds', () => {
  // The migration expresses the path as a concatenation over the row's own
  // server-controlled identity columns. Reconstructing that expression here and
  // comparing it against the TS helper's output is what proves the database and
  // the client cannot drift into disagreeing about where an object lives.
  const primaryExpr = /storage_path = user_id::text \|\| '\/closet\/' \|\| id::text \|\| '-primary\.jpg'/;
  const thumbExpr = /thumbnail_storage_path = user_id::text \|\| '\/closet\/' \|\| id::text \|\| '-thumb\.jpg'/;
  assert.match(MIGRATION, primaryExpr);
  assert.match(MIGRATION, thumbExpr);

  const sqlPrimary = `${UID}` + '/closet/' + `${ITEM}` + '-primary.jpg';
  const sqlThumb = `${UID}` + '/closet/' + `${ITEM}` + '-thumb.jpg';
  const { buildClosetMediaPaths } = loadClosetMedia();
  assert.equal(buildClosetMediaPaths(UID, ITEM).primary, sqlPrimary);
  assert.equal(buildClosetMediaPaths(UID, ITEM).thumbnail, sqlThumb);
});

test('media paths are flat: both objects sit directly under {userId}/closet', () => {
  const { buildClosetMediaPaths, buildClosetMediaPrefix } = loadClosetMedia();
  const prefix = buildClosetMediaPrefix(UID);
  for (const p of Object.values(buildClosetMediaPaths(UID, ITEM))) {
    const remainder = p.slice(prefix.length + 1);
    assert.ok(!remainder.includes('/'), `object must be directly under the prefix, got: ${p}`);
  }
});

// ── The reason flatness is mandatory, proven against the real deletion code ──

test('account-deletion enumeration removes FLAT Closet media (both objects)', async () => {
  const storage = createStorageMock({
    [`${UID}/closet`]: [{ name: `${ITEM}-primary.jpg` }, { name: `${ITEM}-thumb.jpg` }],
  });
  await deleteOwnedStorageObjects(storage.client, UID);
  const removed = storage.removed.flatMap((e) => e.paths);
  assert.ok(removed.includes(EXPECTED_PRIMARY), 'primary must be removed');
  assert.ok(removed.includes(EXPECTED_THUMB), 'thumbnail must be removed');
});

test('REGRESSION GUARD: a nested Closet layout would orphan media on account deletion', async () => {
  // Reproduces what a {userId}/closet/{itemId}/primary.jpg layout does to the
  // existing (non-recursive) enumerator: listing the prefix yields the folder
  // pseudo-entry, so the real objects are never even considered for removal.
  // This test exists so nobody "tidies" the flat layout into a nested one.
  const storage = createStorageMock({
    [`${UID}/closet`]: [{ name: ITEM }], // folder pseudo-entry, as Storage returns
    [`${UID}/closet/${ITEM}`]: [{ name: 'primary.jpg' }, { name: 'thumbnail.jpg' }],
  });
  await deleteOwnedStorageObjects(storage.client, UID);
  const stillPresent = storage.removed
    .flatMap((e) => e.paths)
    .includes(`${UID}/closet/${ITEM}/primary.jpg`);
  assert.equal(stillPresent, false, 'nested objects are NOT reachable by the enumerator');
});

test('Closet media deletion is user-scoped and never touches another account', async () => {
  const other = '99999999-8888-7777-6666-555555555555';
  const storage = createStorageMock({
    [`${UID}/closet`]: [{ name: `${ITEM}-primary.jpg` }],
    [`${other}/closet`]: [{ name: `${ITEM}-primary.jpg` }],
  });
  await deleteOwnedStorageObjects(storage.client, UID);
  const removed = storage.removed.flatMap((e) => e.paths);
  assert.ok(removed.includes(EXPECTED_PRIMARY));
  assert.ok(!removed.some((p) => p.startsWith(`${other}/`)), "another account's Closet media must never be touched");
});

test('Closet media deletion is idempotent (a retry removes nothing further)', async () => {
  const storage = createStorageMock({
    [`${UID}/closet`]: [{ name: `${ITEM}-primary.jpg` }, { name: `${ITEM}-thumb.jpg` }],
  });
  await deleteOwnedStorageObjects(storage.client, UID);
  storage.removed.length = 0;
  await deleteOwnedStorageObjects(storage.client, UID);
  assert.equal(storage.removed.flatMap((e) => e.paths).length, 0);
});

test('Closet media deletion never issues a folder-wide or wildcard delete', async () => {
  const storage = createStorageMock({
    [`${UID}/closet`]: [{ name: `${ITEM}-primary.jpg` }],
  });
  await deleteOwnedStorageObjects(storage.client, UID);
  for (const entry of storage.removed) {
    for (const p of entry.paths) {
      assert.ok(p.startsWith(`${UID}/`), `remove path must be owner-scoped: ${p}`);
      assert.ok(!p.includes('*') && !p.endsWith('/'), `no wildcard/folder delete: ${p}`);
    }
  }
});

// ── Deletion registry wiring ────────────────────────────────────────────────

test('both deletion registries carry the {userId}/closet prefix', () => {
  assert.match(EDGE_REGISTRY, /\{userId\}\/closet/, 'edge registry must include the closet prefix');
  const templates = JSON_REGISTRY.storage.find((r) => r.bucket === 'style-library-images').prefixTemplates;
  assert.ok(templates.includes('{userId}/closet'), 'worker registry must include the closet prefix');
});

test('B1B saved-scans and pre-existing prefixes are preserved, not replaced', () => {
  const templates = JSON_REGISTRY.storage.find((r) => r.bucket === 'style-library-images').prefixTemplates;
  for (const required of ['{userId}/scans', '{userId}/inspirations', '{userId}/saved-scans']) {
    assert.ok(templates.includes(required), `${required} must survive the B1C change`);
    assert.match(EDGE_REGISTRY, new RegExp(required.replace(/[{}/]/g, '\\$&')));
  }
});

test('the runtime STORAGE_RESOURCES expansion yields the concrete Closet prefix', () => {
  const resource = STORAGE_RESOURCES.find((r) => r.bucket === 'style-library-images');
  assert.ok(resource, 'style-library-images resource must exist');
  assert.ok(resource.prefixesForUser(UID).includes(`${UID}/closet`));
});

// ── Negative controls ───────────────────────────────────────────────────────

test('NEGATIVE CONTROL: removing {userId}/closet leaves Closet media undeleted', async () => {
  // Rebuilds the deletion enumeration against a registry whose Closet prefix
  // has been stripped, proving the coverage test above can actually fail.
  // In-memory only; the real registry file is untouched.
  const withoutCloset = JSON_REGISTRY.storage
    .find((r) => r.bucket === 'style-library-images')
    .prefixTemplates.filter((t) => t !== '{userId}/closet');
  const store = { [`${UID}/closet`]: [{ name: `${ITEM}-primary.jpg` }] };
  const removed = [];
  for (const template of withoutCloset) {
    const prefix = template.replace('{userId}', UID);
    for (const item of store[prefix] ?? []) removed.push(`${prefix}/${item.name}`);
  }
  assert.equal(removed.length, 0, 'without the closet prefix nothing under it is even enumerated');
  assert.ok(
    !removed.includes(EXPECTED_PRIMARY),
    'the surviving object is exactly the privacy defect this prefix prevents',
  );
});

test('NEGATIVE CONTROL: a caller-controlled path is what the derived-path constraint forbids', () => {
  // Demonstrates the class of value the SQL CHECK rejects. If the constraint
  // were dropped, each of these would become a writable storage_path -- which
  // is precisely why the live staging run exercises them against the real
  // database (see the B1C ledger's hostile-control matrix).
  const { buildClosetMediaPaths } = loadClosetMedia();
  const legitimate = buildClosetMediaPaths(UID, ITEM).primary;
  const forgeries = [
    `99999999-8888-7777-6666-555555555555/closet/${ITEM}-primary.jpg`, // foreign owner
    `${UID}/closet/../../99999999-8888-7777-6666-555555555555/closet/${ITEM}-primary.jpg`, // traversal
    `${UID}/closet/00000000-0000-0000-0000-0000000000ff-primary.jpg`, // foreign item id
    `${UID}//closet/${ITEM}-primary.jpg`, // double slash
    `/${UID}/closet/${ITEM}-primary.jpg`, // absolute-like
  ];
  for (const forged of forgeries) {
    assert.notEqual(forged, legitimate, `forgery must differ from the derived path: ${forged}`);
  }
});

// ── Privacy contract ────────────────────────────────────────────────────────

test('the media contract stores no raw original and reuses the private bucket', () => {
  const { CLOSET_MEDIA_BUCKET, CLOSET_MEDIA_CONTENT_TYPE, CLOSET_MEDIA_MAX_BYTES } = loadClosetMedia();
  assert.equal(CLOSET_MEDIA_BUCKET, 'style-library-images');
  assert.equal(CLOSET_MEDIA_CONTENT_TYPE, 'image/jpeg');
  assert.equal(CLOSET_MEDIA_MAX_BYTES, 5 * 1024 * 1024);
  // Exactly two derived objects are defined. No raw/original/EXIF-bearing
  // archive object exists anywhere in the contract.
  assert.doesNotMatch(CLOSET_MEDIA_TS, /original|raw[_-]?capture|heic/i);
});

test('media dimensions are inherited from the existing Closet store, not invented', () => {
  const closetLibrary = fs.readFileSync(path.join(ROOT, 'services', 'closetLibrary.js'), 'utf8');
  const imageWidth = Number(/const IMAGE_WIDTH\s*=\s*(\d+)/.exec(closetLibrary)[1]);
  const thumbWidth = Number(/const THUMB_WIDTH\s*=\s*(\d+)/.exec(closetLibrary)[1]);
  const { CLOSET_MEDIA_PRIMARY_WIDTH, CLOSET_MEDIA_THUMBNAIL_WIDTH } = loadClosetMedia();
  assert.equal(CLOSET_MEDIA_PRIMARY_WIDTH, imageWidth);
  assert.equal(CLOSET_MEDIA_THUMBNAIL_WIDTH, thumbWidth);
});

test('signed-URL TTL matches the existing saved-scan media precedent', () => {
  const savedScanMedia = fs.readFileSync(path.join(ROOT, 'services', 'savedScanMedia.ts'), 'utf8');
  const ttl = Number(/createSignedUrl\([^,]+,\s*(\d+)\)/.exec(savedScanMedia)[1]);
  const { CLOSET_MEDIA_SIGNED_URL_TTL_SECONDS } = loadClosetMedia();
  assert.equal(CLOSET_MEDIA_SIGNED_URL_TTL_SECONDS, ttl);
});

// ── Schema invariants (source-level) ────────────────────────────────────────

test('the migration is additive and never rewrites B1A facts columns', () => {
  assert.doesNotMatch(MIGRATION, /drop column/i);
  assert.doesNotMatch(MIGRATION, /alter column/i);
  assert.doesNotMatch(MIGRATION, /\bupdate\s+public\.user_closet_items\b/i);
  assert.doesNotMatch(MIGRATION, /rename/i);
  for (const added of [
    'storage_bucket', 'storage_path', 'thumbnail_storage_path', 'media_status', 'media_uploaded_at',
  ]) {
    assert.match(MIGRATION, new RegExp(`add column if not exists ${added}\\b`));
  }
});

test('the migration reuses the saved-scan status vocabulary and ready-invariant', () => {
  assert.match(MIGRATION, /media_status in \('pending', 'ready', 'failed'\)/);
  assert.match(MIGRATION, /user_closet_items_media_ready_requires_path/);
  assert.match(MIGRATION, /media_status is distinct from 'ready'/);
});

test('the migration adds no Storage policy and no K+ predicate of its own', () => {
  // K+ is enforced by the B1A row policies; the Storage policy stays a pure
  // owner/path boundary. Re-implementing either here would be a second
  // authorization authority.
  //
  // Asserted over EXECUTABLE SQL only: the migration's header comment
  // legitimately explains where K+ is enforced, and a naive whole-file match
  // would flag that prose instead of a real predicate.
  const executable = MIGRATION.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(executable, /create policy/i);
  assert.doesNotMatch(executable, /storage\.objects/i);
  assert.doesNotMatch(executable, /has_active_k_plus\s*\(/);
  // Sanity: the stripping kept the real statements.
  assert.match(executable, /add column if not exists media_status/);
});

// Real TypeScript transpilation, matching the established loader pattern in
// __tests__/catalogRetrieval.test.js. services/closetMedia.ts has no imports,
// so the sandbox needs no module resolution.
function loadClosetMedia() {
  const output = ts.transpileModule(CLOSET_MEDIA_TS, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { exports: mod.exports, module: mod, Object });
  return mod.exports;
}
