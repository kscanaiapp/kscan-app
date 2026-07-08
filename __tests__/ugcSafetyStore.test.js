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

  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
    },
  };
}

function loadService(storage) {
  return loadTsModule('services/ugcSafetyStore.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
  });
}

test('ugcSafetyStore: hidden content ids persist', async () => {
  const storage = makeStorage();
  const { addHiddenContentId, readHiddenContentIds } = loadService(storage);

  assert.equal((await readHiddenContentIds()).length, 0);
  assert.equal(await addHiddenContentId('msg-1'), true);
  assert.equal(await addHiddenContentId('msg-1'), true);
  assert.equal(await addHiddenContentId('msg-2'), true);
  const contentIds = await readHiddenContentIds();
  assert.equal(contentIds.length, 2);
  assert.equal(contentIds[0], 'msg-1');
  assert.equal(contentIds[1], 'msg-2');
});

test('ugcSafetyStore: hidden user ids persist', async () => {
  const storage = makeStorage();
  const { addHiddenUserId, readHiddenUserIds } = loadService(storage);

  assert.equal((await readHiddenUserIds()).length, 0);
  assert.equal(await addHiddenUserId('user-a'), true);
  assert.equal(await addHiddenUserId('user-a'), true);
  assert.equal(await addHiddenUserId('user-b'), true);
  const userIds = await readHiddenUserIds();
  assert.equal(userIds.length, 2);
  assert.equal(userIds[0], 'user-a');
  assert.equal(userIds[1], 'user-b');
});

test('ugcSafetyStore: content and user stores use separate keys', async () => {
  const storage = makeStorage();
  const { addHiddenContentId, addHiddenUserId, readHiddenContentIds, readHiddenUserIds } =
    loadService(storage);

  await addHiddenContentId('msg-1');
  await addHiddenUserId('user-a');

  const contentIds = await readHiddenContentIds();
  const userIds = await readHiddenUserIds();
  assert.equal(contentIds.length, 1);
  assert.equal(contentIds[0], 'msg-1');
  assert.equal(userIds.length, 1);
  assert.equal(userIds[0], 'user-a');
  assert.ok(storage.map.has('kscan.hidden_content_ids.v1'));
  assert.ok(storage.map.has('kscan.hidden_user_ids.v1'));
});

test('ugcSafetyStore: corrupt content data is cleared and recovers', async () => {
  const storage = makeStorage({
    'kscan.hidden_content_ids.v1': JSON.stringify({ not: 'an array' }),
  });
  const { readHiddenContentIds, addHiddenContentId } = loadService(storage);

  assert.equal((await readHiddenContentIds()).length, 0);
  assert.equal(await addHiddenContentId('msg-1'), true);
  const contentIds = await readHiddenContentIds();
  assert.equal(contentIds.length, 1);
  assert.equal(contentIds[0], 'msg-1');
});

test('ugcSafetyStore: corrupt user data is cleared and recovers', async () => {
  const storage = makeStorage({
    'kscan.hidden_user_ids.v1': 'not json',
  });
  const { readHiddenUserIds, addHiddenUserId } = loadService(storage);

  assert.equal((await readHiddenUserIds()).length, 0);
  assert.equal(await addHiddenUserId('user-a'), true);
  const userIds = await readHiddenUserIds();
  assert.equal(userIds.length, 1);
  assert.equal(userIds[0], 'user-a');
});

test('ugcSafetyStore: storage failure returns false but does not throw', async () => {
  const failingStorage = {
    async getItem() {
      return null;
    },
    async setItem() {
      throw new Error('disk full');
    },
  };
  const { addHiddenContentId, addHiddenUserId } = loadService(failingStorage);

  assert.equal(await addHiddenContentId('msg-1'), false);
  assert.equal(await addHiddenUserId('user-a'), false);
});

test('ugcSafetyStore: isValidUuid accepts only canonical UUIDs', () => {
  const storage = makeStorage();
  const { isValidUuid } = loadService(storage);

  assert.equal(isValidUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isValidUuid(''), false);
  assert.equal(isValidUuid(null), false);
  assert.equal(isValidUuid(undefined), false);
  assert.equal(isValidUuid('not-a-uuid'), false);
  assert.equal(isValidUuid('550e8400e29b41d4a716446655440000'), false);
});
