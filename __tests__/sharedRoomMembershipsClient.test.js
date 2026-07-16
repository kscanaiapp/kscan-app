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
      if (id === './roomDeepLinks') return require('../services/roomDeepLinks');
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

function createMockClient({ session = null, rpcImpl = async () => ({ data: null, error: null }) } = {}) {
  const rpcCalls = [];
  return {
    rpcCalls,
    auth: {
      getSession: async () => ({
        data: { session },
        error: session ? null : null,
      }),
    },
    rpc: async (name, params) => {
      rpcCalls.push({ name, params });
      return rpcImpl(name, params, rpcCalls);
    },
  };
}

function loadService(mockClient) {
  return loadTsModule('services/sharedRoomMemberships.ts', {
    './supabaseClient': { supabase: mockClient },
  });
}

test('save passes normalized token to save_shared_room_for_me RPC', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => ({ data: { status: 'saved' }, error: null }),
  });
  const svc = loadService(client);
  const result = await svc.saveSharedRoomForCurrentUser('  active-token-a  ');
  assert.equal(result.status, 'saved');
  assert.equal(client.rpcCalls.length, 1);
  assert.equal(client.rpcCalls[0].name, 'save_shared_room_for_me');
  assert.equal(client.rpcCalls[0].params.p_share_token, 'active-token-a');
});

test('save reuses normalizeRoomShareToken and rejects malformed tokens without RPC', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const result = await svc.saveSharedRoomForCurrentUser('bad token!');
  assert.equal(result.status, 'malformed');
  assert.equal(client.rpcCalls.length, 0);
});

test('save normalizes saved, already_saved, restored, owner, and unavailable', async () => {
  for (const status of ['saved', 'already_saved', 'restored', 'owner', 'unavailable']) {
    const client = createMockClient({
      session: { user: { id: 'user-1' } },
      rpcImpl: async () => ({ data: { status }, error: null }),
    });
    const svc = loadService(client);
    const result = await svc.saveSharedRoomForCurrentUser('active-token-a');
    assert.equal(result.status, status);
  }
});

test('save returns unauthenticated without calling RPC when session is absent', async () => {
  const client = createMockClient({ session: null });
  const svc = loadService(client);
  const result = await svc.saveSharedRoomForCurrentUser('active-token-a');
  assert.equal(result.status, 'unauthenticated');
  assert.equal(client.rpcCalls.length, 0);
});

test('save maps network and missing RPC failures to temporary_failure', async () => {
  const cases = [
    { error: { code: 'PGRST202', message: 'Could not find the function' } },
    { error: { code: '42883', message: 'function does not exist' } },
    { error: { message: 'fetch failed' } },
  ];
  for (const error of cases) {
    const client = createMockClient({
      session: { user: { id: 'user-1' } },
      rpcImpl: async () => ({ data: null, error }),
    });
    const svc = loadService(client);
    const result = await svc.saveSharedRoomForCurrentUser('active-token-a');
    assert.equal(result.status, 'temporary_failure');
  }
});

test('save does not expose raw backend error messages', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => ({
      data: null,
      error: { code: 'XX000', message: 'secret postgres detail' },
    }),
  });
  const svc = loadService(client);
  const result = await svc.saveSharedRoomForCurrentUser('active-token-a');
  assert.equal(result.status, 'temporary_failure');
  assert.equal(Object.keys(result).length, 1);
});

test('concurrent identical save calls are deduplicated', async () => {
  let rpcCount = 0;
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => {
      rpcCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { data: { status: 'saved' }, error: null };
    },
  });
  const svc = loadService(client);
  const first = svc.saveSharedRoomForCurrentUser('active-token-a');
  const second = svc.saveSharedRoomForCurrentUser('active-token-a');
  assert.strictEqual(first, second);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'saved');
  assert.equal(b.status, 'saved');
  assert.equal(rpcCount, 1);
  assert.equal(client.rpcCalls.length, 1);
});

test('failed in-flight save clears and allows a later retry', async () => {
  let attempt = 0;
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => {
      attempt += 1;
      if (attempt === 1) {
        return { data: null, error: { message: 'fetch failed' } };
      }
      return { data: { status: 'saved' }, error: null };
    },
  });
  const svc = loadService(client);
  const first = await svc.saveSharedRoomForCurrentUser('active-token-a');
  assert.equal(first.status, 'temporary_failure');
  const second = await svc.saveSharedRoomForCurrentUser('active-token-a');
  assert.equal(second.status, 'saved');
  assert.equal(client.rpcCalls.length, 2);
});

test('list rows normalize safe fields and skip malformed rows', () => {
  const svc = loadService(createMockClient());
  const rooms = svc.normalizeSharedRoomMembershipListRows([
    {
      share_token: 'active-token-a',
      title: 'Summer Capsule',
      item_count: 3,
      first_opened_at: '2026-07-01T00:00:00.000Z',
      last_accessed_at: '2026-07-02T00:00:00.000Z',
      status: 'available',
      room_updated_at: '2026-07-03T00:00:00.000Z',
    },
    {
      share_token: 'bad token!',
      title: 'Broken',
      item_count: 1,
      first_opened_at: '2026-07-01T00:00:00.000Z',
      last_accessed_at: '2026-07-02T00:00:00.000Z',
      status: 'available',
    },
    null,
  ]);
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].shareToken, 'active-token-a');
  assert.equal(rooms[0].title, 'Summer Capsule');
  assert.equal(rooms[0].itemCount, 3);
  assert.equal(rooms[0].firstOpenedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(rooms[0].lastAccessedAt, '2026-07-02T00:00:00.000Z');
  assert.equal(rooms[0].availability, 'available');
  assert.equal(rooms[0].updatedAt, '2026-07-03T00:00:00.000Z');
});

test('list does not surface prohibited private fields', () => {
  const svc = loadService(createMockClient());
  const rooms = svc.normalizeSharedRoomMembershipListRows([
    {
      share_token: 'active-token-a',
      title: 'Room',
      item_count: 0,
      first_opened_at: '2026-07-01T00:00:00.000Z',
      last_accessed_at: '2026-07-02T00:00:00.000Z',
      status: 'empty',
      room_updated_at: null,
      recipient_user_id: 'secret-recipient',
      owner_id: 'secret-owner',
      room_id: 'secret-room',
      storage_bucket: 'secret-bucket',
      storage_path: 'secret/path',
    },
  ]);
  assert.equal(Object.keys(rooms[0]).sort().join(','), [
    'availability',
    'firstOpenedAt',
    'itemCount',
    'lastAccessedAt',
    'shareToken',
    'title',
    'updatedAt',
  ].sort().join(','));
});

test('listSharedRoomsForCurrentUser returns unauthenticated without RPC', async () => {
  const client = createMockClient({ session: null });
  const svc = loadService(client);
  const result = await svc.listSharedRoomsForCurrentUser();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthenticated');
  assert.equal(client.rpcCalls.length, 0);
});

test('listSharedRoomsForCurrentUser maps auth-required RPC errors to unauthenticated', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => ({
      data: null,
      error: { code: '28000', message: 'Authentication required' },
    }),
  });
  const svc = loadService(client);
  const result = await svc.listSharedRoomsForCurrentUser();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthenticated');
});

test('touch and remove normalize expected statuses', async () => {
  const touchClient = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async (name) =>
      name === 'touch_shared_room_for_me'
        ? { data: { status: 'touched' }, error: null }
        : { data: { status: 'removed' }, error: null },
  });
  const svc = loadService(touchClient);
  const touchResult = await svc.touchSharedRoomForCurrentUser('active-token-a');
  assert.equal(touchResult.status, 'touched');
  const removeResult = await svc.removeSharedRoomForCurrentUser('active-token-a');
  assert.equal(removeResult.status, 'removed');
});

test('touch malformed token does not call RPC', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const result = await svc.touchSharedRoomForCurrentUser('!!!');
  assert.equal(result.status, 'malformed');
  assert.equal(client.rpcCalls.length, 0);
});
