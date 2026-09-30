'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

/**
 * iOS data-container relocation must never turn Closet media into orphans.
 *
 * Closet and staged-candidate records store absolute file URIs such as
 *   file:///var/mobile/Containers/Data/Application/<UUID>/Documents/kscan_closet/images/a.jpg
 * iOS can relocate the data container (backup restore, a move to a new iPhone,
 * other system events; Apple DTS: "the path to your app's container ... can
 * change"). The files move with it; the stored paths do not. Both orphan sweeps
 * build their "still referenced" set from those stored paths and list files
 * under the CURRENT container, so after a relocation every real photo read as
 * unreferenced and was deleted once past the 10-minute grace window — on every
 * Library visit, 200 files at a time.
 *
 * The sweeps now refuse to run while any reference names a different iOS data
 * container. These tests drive the REAL services/library.js, closetLibrary.js
 * and closetCandidateMedia.js over an in-memory file system laid out with real
 * iOS container paths.
 */

const ROOT = path.resolve(__dirname, '..');

const OLD_DOCS = 'file:///var/mobile/Containers/Data/Application/1B6C2E0A-9F7D-4C2B-8E4A-2D3F5A6B7C8D/Documents/';
const NEW_DOCS = 'file:///var/mobile/Containers/Data/Application/7E1D4B2C-3A5F-4E6B-9C8D-0F1A2B3C4D5E/Documents/';
const ANDROID_DOCS = 'file:///data/user/0/com.kscanai.app/files/';
const DAY_MS = 24 * 60 * 60 * 1000;

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

/** Minimal in-memory expo-file-system/legacy rooted at `documentDirectory`. */
function memfs(documentDirectory) {
  const files = new Map();
  const modified = new Map();
  const api = {
    documentDirectory,
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync() {},
    async getInfoAsync(p) {
      if (!files.has(p)) return { exists: false };
      return { exists: true, size: files.get(p).length, modificationTime: (modified.get(p) ?? 0) / 1000 };
    },
    async readAsStringAsync(p) {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    async writeAsStringAsync(p, c) {
      files.set(p, c);
      modified.set(p, Date.now());
    },
    async moveAsync({ from, to }) {
      if (!files.has(from)) throw new Error('ENOENT');
      if (files.has(to)) throw new Error('EEXIST');
      files.set(to, files.get(from));
      modified.set(to, modified.get(from) ?? Date.now());
      files.delete(from);
      modified.delete(from);
    },
    async deleteAsync(p) {
      files.delete(p);
      modified.delete(p);
    },
    async readDirectoryAsync(dir) {
      const names = [];
      for (const key of files.keys()) {
        if (!key.startsWith(dir)) continue;
        const rest = key.slice(dir.length);
        if (rest && !rest.includes('/')) names.push(rest);
      }
      return names;
    },
  };
  const put = (p, content = 'jpeg', ageMs = DAY_MS) => {
    files.set(p, content);
    modified.set(p, Date.now() - ageMs);
  };
  return { files, api, put };
}

function load(documentDirectory) {
  const m = memfs(documentDirectory);
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const imageManipulator = { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async (uri) => ({ uri }) };

  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === './actorContext') return actorContext;
    if (spec === './identificationSnapshot') {
      return { hydrateScanHistory: () => ({ records: [], corruptedCount: 0 }) };
    }
    if (spec === './savedScansCloud') {
      return { saveScanToCloud: async () => ({}), softDeleteCloudSavedScan: async () => ({}) };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return { isPurchaseOptionsSnapshot: Array.isArray, normalizePurchaseOptions: (v) => (Array.isArray(v) ? v : []) };
    }
    return {};
  });

  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'ios' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });

  const types = runModule('types/closetCandidate.ts', () => ({}));
  const candidateMedia = runModule('services/closetCandidateMedia.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'expo-crypto') return {};
    if (spec === './library') return library;
    if (spec === '../types/closetCandidate') return types;
    return {};
  });

  return { m, library, closetLibrary, candidateMedia, actorContext };
}

function putClosetRows(env, rows) {
  const manifestPath = `${env.m.api.documentDirectory}kscan_closet/kscan_closet.json`;
  env.m.put(manifestPath, JSON.stringify(rows), 0);
  return manifestPath;
}

function closetManifest(docs, names) {
  return JSON.stringify(
    names.map((name, i) => ({
      id: `closet-${i}`,
      ownerId: 'user-a',
      imageUri: `${docs}kscan_closet/images/${name}`,
      thumbnailUri: `${docs}kscan_closet/thumbnails/${name}`,
    })),
  );
}

test('relocated committed image is usable on first load and durably re-anchored', async () => {
  const env = load(NEW_DOCS);
  const manifestPath = `${NEW_DOCS}kscan_closet/kscan_closet.json`;
  const oldImage = `${OLD_DOCS}kscan_closet/images/a.jpg`;
  const oldThumbnail = `${OLD_DOCS}kscan_closet/thumbnails/a.jpg`;
  const newImage = `${NEW_DOCS}kscan_closet/images/a.jpg`;
  const newThumbnail = `${NEW_DOCS}kscan_closet/thumbnails/a.jpg`;
  env.m.put(manifestPath, JSON.stringify([{ id: 'a', ownerId: 'user-a', imageUri: oldImage, thumbnailUri: oldThumbnail }]));
  env.m.put(newImage);
  env.m.put(newThumbnail);

  const before = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(before.reason, 'foreign_container_references');
  assert.equal(before.deleted, 0);
  assert.equal((await env.m.api.getInfoAsync(oldImage)).exists, false);
  assert.equal((await env.m.api.getInfoAsync(newImage)).exists, true);

  const loaded = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.items[0].imageUri, newImage);
  assert.equal(loaded.items[0].thumbnailUri, newThumbnail);
  assert.equal(JSON.parse(env.m.files.get(manifestPath))[0].imageUri, newImage);
});

test('committed sweep: a relocated container keeps every Closet photo', async () => {
  const env = load(NEW_DOCS);
  // Records were written under the previous container; the files moved with it.
  env.m.put(`${NEW_DOCS}kscan_closet/kscan_closet.json`, closetManifest(OLD_DOCS, ['a.jpg', 'b.jpg']), 0);
  for (const name of ['a.jpg', 'b.jpg']) {
    env.m.put(`${NEW_DOCS}kscan_closet/images/${name}`);
    env.m.put(`${NEW_DOCS}kscan_closet/thumbnails/${name}`);
  }

  const result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'foreign_container_references');
  assert.equal(result.deleted, 0);
  for (const name of ['a.jpg', 'b.jpg']) {
    assert.ok(env.m.files.has(`${NEW_DOCS}kscan_closet/images/${name}`), `${name} image must survive`);
    assert.ok(env.m.files.has(`${NEW_DOCS}kscan_closet/thumbnails/${name}`), `${name} thumbnail must survive`);
  }
});

test('committed sweep control: in the same container a true orphan is still collected', async () => {
  const env = load(NEW_DOCS);
  env.m.put(`${NEW_DOCS}kscan_closet/kscan_closet.json`, closetManifest(NEW_DOCS, ['a.jpg']), 0);
  env.m.put(`${NEW_DOCS}kscan_closet/images/a.jpg`);
  env.m.put(`${NEW_DOCS}kscan_closet/thumbnails/a.jpg`);
  env.m.put(`${NEW_DOCS}kscan_closet/images/orphan.jpg`);

  const result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });

  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
  assert.equal(env.m.files.has(`${NEW_DOCS}kscan_closet/images/orphan.jpg`), false);
  assert.ok(env.m.files.has(`${NEW_DOCS}kscan_closet/images/a.jpg`));
});

test('candidate sweep: a relocated container keeps every staged photo', async () => {
  const env = load(NEW_DOCS);
  env.m.put(`${NEW_DOCS}kscan_closet_candidates/images/c.jpg`);
  env.m.put(`${NEW_DOCS}kscan_closet_candidates/thumbnails/c.jpg`);
  const records = [{
    candidateImageUri: `${OLD_DOCS}kscan_closet_candidates/images/c.jpg`,
    candidateThumbnailUri: `${OLD_DOCS}kscan_closet_candidates/thumbnails/c.jpg`,
  }];

  const result = await env.candidateMedia.sweepOrphanedCandidateMedia(records, {
    manifestComplete: true,
    nowMs: Date.now(),
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'foreign_container_references');
  assert.equal(result.deleted, 0);
  assert.ok(env.m.files.has(`${NEW_DOCS}kscan_closet_candidates/images/c.jpg`));
  assert.ok(env.m.files.has(`${NEW_DOCS}kscan_closet_candidates/thumbnails/c.jpg`));
});

test('candidate sweep control: in the same container a true orphan is still collected', async () => {
  const env = load(NEW_DOCS);
  env.m.put(`${NEW_DOCS}kscan_closet_candidates/images/c.jpg`);
  env.m.put(`${NEW_DOCS}kscan_closet_candidates/images/orphan.jpg`);
  const records = [{ candidateImageUri: `${NEW_DOCS}kscan_closet_candidates/images/c.jpg` }];

  const result = await env.candidateMedia.sweepOrphanedCandidateMedia(records, {
    manifestComplete: true,
    nowMs: Date.now(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
  assert.equal(env.m.files.has(`${NEW_DOCS}kscan_closet_candidates/images/orphan.jpg`), false);
  assert.ok(env.m.files.has(`${NEW_DOCS}kscan_closet_candidates/images/c.jpg`));
});

test('the guard is inert outside the iOS container layout (Android files directory)', async () => {
  const env = load(ANDROID_DOCS);
  env.m.put(`${ANDROID_DOCS}kscan_closet/kscan_closet.json`, closetManifest(ANDROID_DOCS, ['a.jpg']), 0);
  env.m.put(`${ANDROID_DOCS}kscan_closet/images/a.jpg`);
  env.m.put(`${ANDROID_DOCS}kscan_closet/images/orphan.jpg`);

  const result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });

  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1, 'Android sweeping behaviour is unchanged');
  assert.ok(env.m.files.has(`${ANDROID_DOCS}kscan_closet/images/a.jpg`));
});

test('referencesForeignDataContainer compares only iOS container identities', () => {
  const { library } = load(NEW_DOCS);
  const canonical = (uri) => library.canonicalizeMediaPath(uri);

  assert.equal(library.referencesForeignDataContainer([canonical(`${OLD_DOCS}kscan_closet/images/a.jpg`)], NEW_DOCS), true);
  assert.equal(library.referencesForeignDataContainer([canonical(`${NEW_DOCS}kscan_closet/images/a.jpg`)], NEW_DOCS), false);
  assert.equal(library.referencesForeignDataContainer([canonical(`${ANDROID_DOCS}kscan_closet/images/a.jpg`)], ANDROID_DOCS), false);
  assert.equal(library.referencesForeignDataContainer([canonical('https://cdn.example.com/a.jpg')], NEW_DOCS), false);
  assert.equal(library.referencesForeignDataContainer([], NEW_DOCS), false);
  assert.equal(library.referencesForeignDataContainer([canonical(`${OLD_DOCS}a.jpg`)], null), false);
});

test('primary re-anchors even when its old thumbnail has no current target', async () => {
  const env = load(NEW_DOCS);
  const oldThumb = `${OLD_DOCS}kscan_closet/thumbnails/a.jpg`;
  const currentImage = `${NEW_DOCS}kscan_closet/images/a.jpg`;
  const path = putClosetRows(env, [{ id: 'a', ownerId: 'user-a', imageUri: `${OLD_DOCS}kscan_closet/images/a.jpg`, thumbnailUri: oldThumb }]);
  env.m.put(currentImage);
  const loaded = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(loaded.items[0].imageUri, currentImage);
  assert.equal(loaded.items[0].thumbnailUri, oldThumb);
  assert.equal(JSON.parse(env.m.files.get(path))[0].thumbnailUri, oldThumb);
});

test('missing and known empty targets keep old references and the foreign sweep guard', async () => {
  for (const content of [null, '']) {
    const env = load(NEW_DOCS);
    const oldImage = `${OLD_DOCS}kscan_closet/images/a.jpg`;
    const currentImage = `${NEW_DOCS}kscan_closet/images/a.jpg`;
    const path = putClosetRows(env, [{ id: 'a', ownerId: 'user-a', imageUri: oldImage }]);
    if (content !== null) env.m.put(currentImage, content);
    const loaded = await env.closetLibrary.loadClosetTyped('user-a');
    assert.equal(loaded.items[0].imageUri, oldImage);
    assert.equal(JSON.parse(env.m.files.get(path))[0].imageUri, oldImage);
    const sweep = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
    assert.equal(sweep.reason, 'foreign_container_references');
    assert.equal(sweep.deleted, 0);
  }
});

test('remote, arbitrary, traversal, malformed, and same-container URIs are inert', async () => {
  const rejected = [
    'https://cdn.example.com/a.jpg', 'http://cdn.example.com/a.jpg',
    'content://provider/a.jpg', 'asset://a.jpg', 'ph://asset/a.jpg',
    `${OLD_DOCS}some_other_store/images/a.jpg`,
    `${OLD_DOCS}notes/kscan_closet/images/a.jpg`,
    `${OLD_DOCS}kscan_closet/images/../a.jpg`,
    `${OLD_DOCS}kscan_closet/images/%2e%2e/a.jpg`,
    `${OLD_DOCS}kscan_closet/images//a.jpg`,
    `${OLD_DOCS}kscan_closet/images/a.jpg?query=1`,
    `${NEW_DOCS}kscan_closet/images/a.jpg`,
  ];
  const env = load(NEW_DOCS);
  env.m.put(`${NEW_DOCS}kscan_closet/images/a.jpg`);
  env.m.put(`${NEW_DOCS}some_other_store/images/a.jpg`);
  for (const uri of rejected) {
    assert.equal(await env.closetLibrary.resolveRelocatedIosClosetMediaUri(uri, NEW_DOCS), null, uri);
  }
  const rows = rejected.map((imageUri, i) => ({ id: `item-${i}`, ownerId: 'user-a', imageUri }));
  const manifestPath = putClosetRows(env, rows);
  assert.equal((await env.closetLibrary.loadClosetTyped('user-a')).items.length, rows.length);
  assert.deepEqual(JSON.parse(env.m.files.get(manifestPath)), rows);
});

test('Android path does not attempt relocation or alter sweeping', async () => {
  const env = load(ANDROID_DOCS);
  const image = `${ANDROID_DOCS}kscan_closet/images/a.jpg`;
  putClosetRows(env, [{ id: 'a', ownerId: 'user-a', imageUri: image }]);
  env.m.put(image);
  env.m.put(`${ANDROID_DOCS}kscan_closet/images/orphan.jpg`);
  let relocationProbes = 0;
  const getInfo = env.m.api.getInfoAsync;
  env.m.api.getInfoAsync = async (uri) => {
    if (uri.includes('Application/')) relocationProbes += 1;
    return getInfo(uri);
  };
  assert.equal((await env.closetLibrary.loadClosetTyped('user-a')).items[0].imageUri, image);
  assert.equal(relocationProbes, 0);
  const sweep = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(sweep.deleted, 1);
  assert.equal(env.m.files.has(image), true);
});

test('raw fields and all actor partitions survive; only visible items are returned', async () => {
  const env = load(NEW_DOCS);
  const oldImage = `${OLD_DOCS}kscan_closet/images/a.jpg`;
  const newImage = `${NEW_DOCS}kscan_closet/images/a.jpg`;
  const a = { id: 'a', ownerId: 'user-a', imageUri: oldImage, sourceCandidateId: 'candidate-a', sourceLineageId: 'lineage-a', contentHash: 'exact-hash', brand: 'Acme', opaqueFutureField: { nested: [1, 'x'] } };
  const b = { id: 'b', ownerId: 'user-b', imageUri: 'https://example.com/b.jpg', opaqueFutureField: 'b' };
  const path = putClosetRows(env, [a, b]);
  env.m.put(newImage);
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.deepEqual(result.items.map((item) => item.id), ['a']);
  assert.equal(result.items[0].imageUri, newImage);
  const saved = JSON.parse(env.m.files.get(path));
  assert.deepEqual(saved[0], { ...a, imageUri: newImage });
  assert.deepEqual(saved[1], b);
  assert.deepEqual((await env.closetLibrary.loadClosetTyped('user-b')).items.map((item) => item.id), ['b']);
});

test('failed durable write retains the old raw record, media, and sweep guard', async () => {
  const env = load(NEW_DOCS);
  const oldImage = `${OLD_DOCS}kscan_closet/images/a.jpg`;
  const currentImage = `${NEW_DOCS}kscan_closet/images/a.jpg`;
  const path = putClosetRows(env, [{ id: 'a', ownerId: 'user-a', imageUri: oldImage }]);
  const original = env.m.files.get(path);
  env.m.put(currentImage);
  const write = env.m.api.writeAsStringAsync;
  env.m.api.writeAsStringAsync = async (uri, content) => {
    if (uri === `${path}.tmp`) throw new Error('ENOSPC');
    return write(uri, content);
  };
  const loaded = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(loaded.items[0].imageUri, oldImage);
  assert.equal(env.m.files.get(path), original);
  assert.equal(env.m.files.has(currentImage), true);
  const sweep = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(sweep.reason, 'foreign_container_references');
  assert.equal(sweep.deleted, 0);
});

test('durable re-anchor permits normal sweeping, preserves references, and is idempotent', async () => {
  const env = load(NEW_DOCS);
  const currentImage = `${NEW_DOCS}kscan_closet/images/a.jpg`;
  const orphan = `${NEW_DOCS}kscan_closet/images/orphan.jpg`;
  const path = putClosetRows(env, [{ id: 'a', ownerId: 'user-a', imageUri: `${OLD_DOCS}kscan_closet/images/a.jpg` }]);
  env.m.put(currentImage);
  env.m.put(orphan);
  let stageWrites = 0;
  const write = env.m.api.writeAsStringAsync;
  env.m.api.writeAsStringAsync = async (uri, content) => {
    if (uri === `${path}.tmp`) stageWrites += 1;
    return write(uri, content);
  };
  assert.equal((await env.closetLibrary.loadClosetTyped('user-a')).items[0].imageUri, currentImage);
  assert.equal((await env.closetLibrary.loadClosetTyped('user-a')).items[0].imageUri, currentImage);
  assert.equal(stageWrites, 1);
  assert.equal(env.library.referencesForeignDataContainer([env.library.canonicalizeMediaPath(JSON.parse(env.m.files.get(path))[0].imageUri)], NEW_DOCS), false);
  const sweep = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(sweep.deleted, 1);
  assert.equal(env.m.files.has(currentImage), true);
  assert.equal(env.m.files.has(orphan), false);
});

test('actor generation change during async proof never exposes prior actor records', async () => {
  const env = load(NEW_DOCS);
  const currentImage = `${NEW_DOCS}kscan_closet/images/a.jpg`;
  putClosetRows(env, [{ id: 'a', ownerId: 'user-a', imageUri: `${OLD_DOCS}kscan_closet/images/a.jpg` }]);
  env.m.put(currentImage);
  env.actorContext.advanceActorEpoch('user-a');
  const request = env.actorContext.createActorRequest();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const getInfo = env.m.api.getInfoAsync;
  env.m.api.getInfoAsync = async (uri) => {
    if (uri === currentImage) { entered(); await gate; }
    return getInfo(uri);
  };
  const pending = env.closetLibrary.loadClosetTyped('user-a', { actorRequest: request });
  await reached;
  env.actorContext.advanceActorEpoch('user-b');
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTOR_CHANGED');
  assert.deepEqual(result.items, []);
});
