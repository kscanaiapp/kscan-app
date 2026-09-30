'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = '/doc/kscan_closet/kscan_closet.json';
const TEMP = MANIFEST + '.tmp';
const BACKUP = MANIFEST + '.bak';
const IMAGE = '/doc/kscan_closet/images/a.jpg';

function record(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'a', ownerId: 'user-a', title: 'Coat', imageUri: IMAGE,
    thumbnailUri: null, category: 'Outerwear', sourceCandidateId: 'candidate-a',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      esModuleInterop: true, allowJs: true,
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

function disk(initial = [record()]) {
  const files = new Map([[MANIFEST, JSON.stringify(initial)], [IMAGE, 'jpeg']]);
  const faults = { stage: null, move: null, deleteBackup: false, pauseStage: null };
  const events = [];
  const api = {
    documentDirectory: '/doc/',
    EncodingType: { UTF8: 'utf8' },
    async makeDirectoryAsync() {},
    async getInfoAsync(uri) {
      return files.has(uri) ? { exists: true, size: files.get(uri).length } : { exists: false };
    },
    async readAsStringAsync(uri) {
      if (!files.has(uri)) throw new Error('ENOENT');
      return files.get(uri);
    },
    async writeAsStringAsync(uri, value) {
      events.push(['write', uri]);
      if (uri === TEMP && faults.pauseStage) await faults.pauseStage();
      if (uri === TEMP && faults.stage === 'partial') {
        files.set(uri, value.slice(0, 3));
        throw new Error('ENOSPC');
      }
      if (uri === TEMP && faults.stage === 'zero') return void files.set(uri, '');
      if (uri === TEMP && faults.stage === 'malformed') return void files.set(uri, '{bad');
      files.set(uri, value);
    },
    async moveAsync({ from, to }) {
      events.push(['move', from, to]);
      if (faults.move === 'backup' && from === MANIFEST && to === BACKUP) {
        throw new Error('backup move failed');
      }
      if (['replace', 'replace-and-restore'].includes(faults.move) && from === TEMP && to === MANIFEST) {
        throw new Error('replacement failed');
      }
      if (faults.move === 'replace-and-restore' && from === BACKUP && to === MANIFEST) {
        throw new Error('restoration temporarily failed');
      }
      if (!files.has(from)) throw new Error('ENOENT');
      if (files.has(to)) throw new Error('EEXIST');
      files.set(to, files.get(from));
      files.delete(from);
      if (faults.move === 'corrupt-replace' && from === TEMP && to === MANIFEST) {
        files.set(MANIFEST, '{bad');
      }
    },
    async deleteAsync(uri) {
      events.push(['delete', uri]);
      if (uri === BACKUP && faults.deleteBackup) throw new Error('backup delete failed');
      files.delete(uri);
    },
  };
  return { files, faults, events, api };
}

function boot(storage) {
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const library = {
    canonicalizeMediaPath: (uri) => uri,
    async unlinkUnreferencedMedia(candidates, survivors) {
      const referenced = new Set(survivors.flatMap((item) => [item.imageUri, item.thumbnailUri]));
      for (const uri of candidates) {
        if (uri && !referenced.has(uri)) storage.files.delete(uri);
      }
      return [];
    },
  };
  return runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return storage.api;
    if (spec === 'expo-image-manipulator') return { SaveFormat: { JPEG: 'jpeg' } };
    if (spec === 'react-native') return { Platform: { OS: 'ios' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });
}

async function commit(library, value = '/doc/kscan_closet/thumbnails/new.jpg') {
  return library.applyRestoredClosetItemMedia('a', 'user-a', { thumbnailUri: value });
}

test('T2/T8: successful commit is readable from a fresh store instance', async () => {
  const storage = disk();
  assert.equal((await commit(boot(storage))).ok, true);
  assert.equal((await boot(storage).loadClosetTyped('user-a')).items[0].thumbnailUri,
    '/doc/kscan_closet/thumbnails/new.jpg');
  assert.equal(storage.files.has(BACKUP), false);
  assert.equal(storage.files.has(TEMP), false);
  assert.equal(storage.events.some(([op, uri]) => op === 'write' && uri === MANIFEST), false);
});

test('T3/T7: partial staging write fails and next load returns old manifest', async () => {
  const storage = disk();
  const original = storage.files.get(MANIFEST);
  storage.faults.stage = 'partial';
  assert.equal((await commit(boot(storage))).ok, false);
  assert.equal(storage.files.get(MANIFEST), original);
  assert.equal((await boot(storage).loadClosetTyped('user-a')).items[0].thumbnailUri, null);
});

for (const [name, fault] of [['T5 zero-byte', 'zero'], ['T6 malformed JSON', 'malformed']]) {
  test(`${name} staged manifest cannot replace good manifest`, async () => {
    const storage = disk();
    const original = storage.files.get(MANIFEST);
    storage.faults.stage = fault;
    assert.equal((await commit(boot(storage))).ok, false);
    assert.equal(storage.files.get(MANIFEST), original);
    assert.equal(storage.events.some(([op, from]) => op === 'move' && from === MANIFEST), false);
  });
}

for (const fault of ['backup', 'replace', 'corrupt-replace']) {
  test(`T4: ${fault} failure retains or recovers the old manifest`, async () => {
    const storage = disk();
    const original = storage.files.get(MANIFEST);
    storage.faults.move = fault;
    assert.equal((await commit(boot(storage))).ok, false);
    storage.faults.move = null;
    const loaded = await boot(storage).loadClosetTyped('user-a');
    assert.equal(loaded.ok, true);
    assert.equal(storage.files.get(MANIFEST), original);
    assert.equal(loaded.items[0].thumbnailUri, null);
  });
}

test('T4: an interrupted replacement with backup and provisional canonical restores old', async () => {
  const storage = disk();
  const original = storage.files.get(MANIFEST);
  storage.files.set(BACKUP, original);
  storage.files.set(MANIFEST, JSON.stringify([record({ title: 'Provisional' })]));
  const result = await boot(storage).loadClosetTyped('user-a');
  assert.equal(result.code, 'RECOVERED_WITH_ITEMS');
  assert.equal(storage.files.get(MANIFEST), original);
});

test('T4: an interrupted gap with no canonical restores the last good backup', async () => {
  const storage = disk();
  const original = storage.files.get(MANIFEST);
  storage.files.delete(MANIFEST);
  storage.files.set(BACKUP, original);
  const result = await boot(storage).loadClosetTyped('user-a');
  assert.equal(result.code, 'RECOVERED_WITH_ITEMS');
  assert.equal(storage.files.get(MANIFEST), original);
});

test('T4: a failed immediate rollback keeps the backup for the next load', async () => {
  const storage = disk();
  const original = storage.files.get(MANIFEST);
  storage.faults.move = 'replace-and-restore';
  assert.equal((await commit(boot(storage))).ok, false);
  assert.equal(storage.files.get(BACKUP), original);
  storage.faults.move = null;
  const loaded = await boot(storage).loadClosetTyped('user-a');
  assert.equal(loaded.code, 'RECOVERED_WITH_ITEMS');
  assert.equal(storage.files.get(MANIFEST), original);
});

test('backup cleanup failure reports failure and leaves the prior manifest authoritative', async () => {
  const storage = disk();
  const original = storage.files.get(MANIFEST);
  storage.faults.deleteBackup = true;
  assert.equal((await commit(boot(storage))).ok, false);
  storage.faults.deleteBackup = false;
  assert.equal((await boot(storage).loadClosetTyped('user-a')).items[0].thumbnailUri, null);
  assert.equal(storage.files.get(MANIFEST), original);
});

test('T9/T10: successful commit preserves raw unknown fields and actor partitions', async () => {
  const extras = { opaqueFutureField: { nested: [1, 'x'] }, exactHash: 'abc' };
  const other = record({ id: 'b', ownerId: 'user-b', imageUri: '/other.jpg' });
  const storage = disk([{ ...record(), ...extras }, other]);
  assert.equal((await commit(boot(storage))).ok, true);
  const raw = JSON.parse(storage.files.get(MANIFEST));
  assert.deepEqual(raw[0].opaqueFutureField, extras.opaqueFutureField);
  assert.equal(raw[0].exactHash, 'abc');
  assert.deepEqual(raw[1], other);
  assert.deepEqual((await boot(storage).loadClosetTyped('user-b')).items.map((item) => item.id), ['b']);
  assert.deepEqual((await boot(storage).loadClosetTyped('user-a')).items.map((item) => item.id), ['a']);
});

test('T11: queued concurrent mutations combine rather than overwrite each other', async () => {
  const storage = disk();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let staged = 0;
  storage.faults.pauseStage = async () => {
    staged += 1;
    if (staged === 1) await gate;
  };
  const library = boot(storage);
  const first = library.applyRestoredClosetItemMedia('a', 'user-a', { imageUri: '/first.jpg' });
  const second = library.applyRestoredClosetItemMedia('a', 'user-a', { thumbnailUri: '/second.jpg' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(staged, 1);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  const saved = JSON.parse(storage.files.get(MANIFEST))[0];
  assert.equal(saved.imageUri, '/first.jpg');
  assert.equal(saved.thumbnailUri, '/second.jpg');
});

for (const action of ['delete', 'purge']) {
  test(`T12: failed ${action} commit does not delete referenced media`, async () => {
    const storage = disk();
    storage.faults.stage = 'partial';
    const library = boot(storage);
    const result = action === 'delete'
      ? await library.deleteClosetItem('a', { ownerId: 'user-a' })
      : await library.purgeLocalClosetForOwner('user-a');
    assert.equal(action === 'delete' ? result : result.ok, false);
    assert.equal(storage.files.has(IMAGE), true);
    assert.equal((await boot(storage).loadClosetTyped('user-a')).items.length, 1);
  });
}
