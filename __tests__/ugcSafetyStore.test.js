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
    async multiRemove(keys) {
      for (const k of keys) map.delete(k);
    },
  };
}

/**
 * Stand-in for services/actorScope, whose real implementation reads the live
 * actor epoch from services/actorContext. The store must ask for the actor on
 * every call rather than caching it, so this mock is mutable and the tests flip
 * it mid-run to model an account switch on one device.
 */
function makeActorScope(initialActorId = null) {
  const state = { actorId: initialActorId };
  return {
    state,
    module: {
      currentActorId: () => state.actorId,
    },
  };
}

function loadService(storage, actorScope = makeActorScope('actor-a')) {
  return loadTsModule('services/ugcSafetyStore.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
    './actorScope': actorScope.module,
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

// Key names moved v1 -> v2 when the store became actor-partitioned: the v1
// payload was a bare array with no owner, and the v2 payload is a
// {partition: ids} map. Reusing the key would have made an old array
// indistinguishable from a corrupt new map. This assertion tracks the current
// contract rather than the retired one.
test('ugcSafetyStore: content and user stores use separate partitioned keys', async () => {
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
  assert.ok(storage.map.has('kscan.hidden_content_ids.v2'));
  assert.ok(storage.map.has('kscan.hidden_user_ids.v2'));
});

test('ugcSafetyStore: corrupt content data is cleared and recovers', async () => {
  const storage = makeStorage({
    'kscan.hidden_content_ids.v2': JSON.stringify(['not', 'a', 'partition', 'map']),
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
    'kscan.hidden_user_ids.v2': 'not json',
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
    async multiRemove() {
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

// ── DR-P2-002 / DR-NC-006: actor isolation ──────────────────────────────────
// Report & Hide is a per-account moderation decision. On a shared device an
// account switch must not carry one account's hidden senders or messages into
// the next account's room chat.

test('ugcSafetyStore: one actor never reads another actor hidden ids', async () => {
  const storage = makeStorage();
  const actorScope = makeActorScope('actor-a');
  const { addHiddenContentId, addHiddenUserId, readHiddenContentIds, readHiddenUserIds } =
    loadService(storage, actorScope);

  await addHiddenContentId('msg-hidden-by-a');
  await addHiddenUserId('sender-hidden-by-a');
  assert.deepEqual(Array.from(await readHiddenContentIds()), ['msg-hidden-by-a']);
  assert.deepEqual(Array.from(await readHiddenUserIds()), ['sender-hidden-by-a']);

  // Account switch on the same device.
  actorScope.state.actorId = 'actor-b';
  assert.deepEqual(Array.from(await readHiddenContentIds()), []);
  assert.deepEqual(Array.from(await readHiddenUserIds()), []);

  // B's own hides stay B's.
  await addHiddenContentId('msg-hidden-by-b');
  assert.deepEqual(Array.from(await readHiddenContentIds()), ['msg-hidden-by-b']);

  // Switching back restores A's list untouched by B's activity.
  actorScope.state.actorId = 'actor-a';
  assert.deepEqual(Array.from(await readHiddenContentIds()), ['msg-hidden-by-a']);
  assert.deepEqual(Array.from(await readHiddenUserIds()), ['sender-hidden-by-a']);
});

test('ugcSafetyStore: signed-out partition is separate from any account', async () => {
  const storage = makeStorage();
  const actorScope = makeActorScope(null);
  const { addHiddenContentId, readHiddenContentIds } = loadService(storage, actorScope);

  await addHiddenContentId('msg-hidden-signed-out');
  assert.deepEqual(Array.from(await readHiddenContentIds()), ['msg-hidden-signed-out']);

  actorScope.state.actorId = 'actor-a';
  assert.deepEqual(Array.from(await readHiddenContentIds()), []);
});

test('ugcSafetyStore: legacy unpartitioned v1 keys are purged, never adopted', async () => {
  const storage = makeStorage({
    'kscan.hidden_content_ids.v1': JSON.stringify(['legacy-msg']),
    'kscan.hidden_user_ids.v1': JSON.stringify(['legacy-sender']),
  });
  const { readHiddenContentIds, readHiddenUserIds } = loadService(storage);

  // A device-wide list has no recorded owner, so no account inherits it.
  assert.deepEqual(Array.from(await readHiddenContentIds()), []);
  assert.deepEqual(Array.from(await readHiddenUserIds()), []);
  assert.equal(storage.map.has('kscan.hidden_content_ids.v1'), false);
  assert.equal(storage.map.has('kscan.hidden_user_ids.v1'), false);
});

test('ugcSafetyStore: a second actor partition does not overwrite the first on write', async () => {
  const storage = makeStorage();
  const actorScope = makeActorScope('actor-a');
  const { addHiddenUserId } = loadService(storage, actorScope);

  await addHiddenUserId('sender-1');
  actorScope.state.actorId = 'actor-b';
  await addHiddenUserId('sender-2');

  const persisted = JSON.parse(storage.map.get('kscan.hidden_user_ids.v2'));
  assert.deepEqual(Array.from(persisted['actor-a']), ['sender-1']);
  assert.deepEqual(Array.from(persisted['actor-b']), ['sender-2']);
});
