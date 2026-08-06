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

const AUTH_USER_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '33333333-3333-3333-3333-333333333333';

function authSession(userId = AUTH_USER_ID) {
  return { user: { id: userId } };
}

function createMockClient({ session = null, rpcImpl } = {}) {
  const calls = [];
  return {
    _calls: calls,
    auth: {
      getSession: async () => ({
        data: { session },
        error: session ? null : new Error('No session'),
      }),
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      return rpcImpl ? rpcImpl(name, args) : { data: null, error: null };
    },
  };
}

function loadService(mockClient) {
  return loadTsModule('services/dressingRoomBlocks.ts', {
    './supabaseClient': { __esModule: true, supabase: mockClient },
  });
}

test('dressingRoomBlocks: blockDressingRoomUser calls the RPC with the target id', async () => {
  const client = createMockClient({
    session: authSession(),
    rpcImpl: (name) => (name === 'block_dressing_room_user' ? { data: { ok: true }, error: null } : { data: null, error: null }),
  });
  const { blockDressingRoomUser } = loadService(client);

  const result = await blockDressingRoomUser(TARGET_USER_ID);

  assert.equal(result.ok, true);
  assert.equal(client._calls.length, 1);
  assert.equal(client._calls[0].name, 'block_dressing_room_user');
  assert.equal(client._calls[0].args.p_target_user_id, TARGET_USER_ID);
});

test('dressingRoomBlocks: blockDressingRoomUser rejects self-block before calling the RPC', async () => {
  const client = createMockClient({ session: authSession() });
  const { blockDressingRoomUser } = loadService(client);

  await assert.rejects(() => blockDressingRoomUser(AUTH_USER_ID));
  assert.equal(client._calls.length, 0);
});

test('dressingRoomBlocks: blockDressingRoomUser rejects an invalid uuid before calling the RPC', async () => {
  const client = createMockClient({ session: authSession() });
  const { blockDressingRoomUser } = loadService(client);

  await assert.rejects(() => blockDressingRoomUser('not-a-uuid'));
  assert.equal(client._calls.length, 0);
});

test('dressingRoomBlocks: blockDressingRoomUser without a session throws the neutral interaction-unavailable error', async () => {
  const client = createMockClient({ session: null });
  const { blockDressingRoomUser, DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR } = loadService(client);

  await assert.rejects(
    () => blockDressingRoomUser(TARGET_USER_ID),
    (err) => err.message === DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR,
  );
});

test('dressingRoomBlocks: blockDressingRoomUser maps a 42501 RPC failure to the neutral copy (never leaks why)', async () => {
  const client = createMockClient({
    session: authSession(),
    rpcImpl: () => ({ data: null, error: { code: '42501', message: 'permission denied' } }),
  });
  const { blockDressingRoomUser, DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR } = loadService(client);

  await assert.rejects(
    () => blockDressingRoomUser(TARGET_USER_ID),
    (err) => {
      assert.equal(err.message, DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR);
      assert.equal(/permission denied/i.test(err.message), false);
      return true;
    },
  );
});

test('dressingRoomBlocks: unblockDressingRoomUser is idempotent-shaped (reports removed=false safely)', async () => {
  const client = createMockClient({
    session: authSession(),
    rpcImpl: () => ({ data: { ok: true, removed: false }, error: null }),
  });
  const { unblockDressingRoomUser } = loadService(client);

  const result = await unblockDressingRoomUser(TARGET_USER_ID);

  assert.equal(result.ok, true);
  assert.equal(result.removed, false);
});

test('dressingRoomBlocks: unblockDressingRoomUser surfaces removed=true on success', async () => {
  const client = createMockClient({
    session: authSession(),
    rpcImpl: () => ({ data: { ok: true, removed: true }, error: null }),
  });
  const { unblockDressingRoomUser } = loadService(client);

  const result = await unblockDressingRoomUser(TARGET_USER_ID);

  assert.equal(result.removed, true);
});

test('dressingRoomBlocks: listDressingRoomBlockedUsers maps rows and never includes anything but id/createdAt', async () => {
  const client = createMockClient({
    session: authSession(),
    rpcImpl: () => ({
      data: [
        { blocked_user_id: TARGET_USER_ID, created_at: '2026-08-06T00:00:00Z' },
        { blocked_user_id: OTHER_USER_ID, created_at: '2026-08-05T00:00:00Z' },
      ],
      error: null,
    }),
  });
  const { listDressingRoomBlockedUsers } = loadService(client);

  const result = await listDressingRoomBlockedUsers();

  // Field-by-field, not assert.deepEqual(result, [...]): the module is
  // loaded via vm.runInNewContext, so returned arrays/objects are a
  // different realm than this file's own Array/Object — deepEqual can
  // report "same structure but not reference-equal" across that boundary.
  assert.equal(result.length, 2);
  assert.equal(result[0].blockedUserId, TARGET_USER_ID);
  assert.equal(result[0].createdAt, '2026-08-06T00:00:00Z');
  assert.equal(result[1].blockedUserId, OTHER_USER_ID);
  assert.equal(result[1].createdAt, '2026-08-05T00:00:00Z');
  for (const entry of result) {
    assert.equal(Object.keys(entry).sort().join(','), 'blockedUserId,createdAt');
  }
});

test('dressingRoomBlocks: listDressingRoomBlockedUsers drops malformed rows instead of throwing', async () => {
  const client = createMockClient({
    session: authSession(),
    rpcImpl: () => ({ data: [{ blocked_user_id: 123, created_at: null }, null, 'garbage'], error: null }),
  });
  const { listDressingRoomBlockedUsers } = loadService(client);

  const result = await listDressingRoomBlockedUsers();

  assert.equal(result.length, 0);
});

test('dressingRoomBlocks: listDressingRoomBlockedUsers requires a session', async () => {
  const client = createMockClient({ session: null });
  const { listDressingRoomBlockedUsers } = loadService(client);

  await assert.rejects(() => listDressingRoomBlockedUsers());
});
