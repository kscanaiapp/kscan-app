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

  return { m, library, closetLibrary, candidateMedia };
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
