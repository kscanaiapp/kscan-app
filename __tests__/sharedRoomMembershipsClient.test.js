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

function createMockClient({
  session = null,
  sessionImpl,
  rpcImpl = async () => ({ data: null, error: null }),
} = {}) {
  const rpcCalls = [];
  return {
    rpcCalls,
    auth: {
      getSession: sessionImpl ?? (async () => ({
        data: { session },
        error: null,
      })),
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

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
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

test('save preserves mixed case, underscores, and hyphens and rejects full URLs', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => ({ data: { status: 'saved' }, error: null }),
  });
  const svc = loadService(client);

  await svc.saveSharedRoomForCurrentUser('MiXeD_token-1');
  const urlResult = await svc.saveSharedRoomForCurrentUser(
    'https://kscan.app/rooms/MiXeD_token-1',
  );

  assert.equal(client.rpcCalls[0].params.p_share_token, 'MiXeD_token-1');
  assert.equal(urlResult.status, 'malformed');
  assert.equal(client.rpcCalls.length, 1);
});

test('save normalizes every backend status', async () => {
  for (const status of [
    'saved',
    'already_saved',
    'restored',
    'owner',
    'unavailable',
    'unauthenticated',
    'malformed',
  ]) {
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

test('save maps thrown session and RPC failures to temporary_failure', async () => {
  const sessionFailure = loadService(createMockClient({
    sessionImpl: async () => {
      throw new Error('raw auth transport detail');
    },
  }));
  assert.equal(
    (await sessionFailure.saveSharedRoomForCurrentUser('active-token-a')).status,
    'temporary_failure',
  );

  const rpcFailure = loadService(createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => {
      throw new Error('raw network detail');
    },
  }));
  assert.equal(
    (await rpcFailure.saveSharedRoomForCurrentUser('active-token-a')).status,
    'temporary_failure',
  );
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
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'saved');
  assert.equal(b.status, 'saved');
  assert.equal(rpcCount, 1);
  assert.equal(client.rpcCalls.length, 1);
});

test('in-flight save deduplication is isolated by authenticated actor', async () => {
  let currentUserId = 'user-a';
  const pending = [];
  const client = createMockClient({
    sessionImpl: async () => {
      const actorAtLookup = currentUserId;
      return {
        data: { session: { user: { id: actorAtLookup } } },
        error: null,
      };
    },
    rpcImpl: async () => new Promise((resolve) => pending.push(resolve)),
  });
  const svc = loadService(client);

  const first = svc.saveSharedRoomForCurrentUser('active-token-a');
  await waitFor(() => client.rpcCalls.length === 1, 'first actor RPC did not start');
  currentUserId = 'user-b';
  const second = svc.saveSharedRoomForCurrentUser('active-token-a');
  await waitFor(() => client.rpcCalls.length === 2, 'second actor RPC was suppressed');

  assert.equal(client.rpcCalls.length, 2);
  pending.forEach((resolve) => resolve({ data: { status: 'saved' }, error: null }));
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.status), ['saved', 'saved']);
});

test('different normalized tokens do not share an in-flight save', async () => {
  const pending = [];
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => new Promise((resolve) => pending.push(resolve)),
  });
  const svc = loadService(client);
  const first = svc.saveSharedRoomForCurrentUser('active-token-a');
  const second = svc.saveSharedRoomForCurrentUser('active-token-b');
  await waitFor(() => client.rpcCalls.length === 2, 'different-token RPCs did not both start');

  assert.equal(client.rpcCalls.length, 2);
  pending.forEach((resolve) => resolve({ data: { status: 'saved' }, error: null }));
  await Promise.all([first, second]);
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

test('successful in-flight save clears so a later removed membership can be restored', async () => {
  let attempt = 0;
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => {
      attempt += 1;
      return { data: { status: attempt === 1 ? 'saved' : 'restored' }, error: null };
    },
  });
  const svc = loadService(client);

  assert.equal((await svc.saveSharedRoomForCurrentUser('active-token-a')).status, 'saved');
  assert.equal((await svc.saveSharedRoomForCurrentUser('active-token-a')).status, 'restored');
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

test('list normalization accepts only documented snake_case fields and valid timestamps', () => {
  const svc = loadService(createMockClient());
  const rooms = svc.normalizeSharedRoomMembershipListRows([
    {
      shareToken: 'camel-token',
      title: 'Undocumented',
      itemCount: 1,
      firstOpenedAt: '2026-07-01T00:00:00.000Z',
      lastAccessedAt: '2026-07-02T00:00:00.000Z',
      availability: 'available',
      updatedAt: '2026-07-03T00:00:00.000Z',
    },
    {
      share_token: 'bad-date-token',
      title: 'Bad timestamp',
      item_count: 1,
      first_opened_at: 'not-a-date',
      last_accessed_at: '2026-07-02T00:00:00.000Z',
      status: 'available',
      room_updated_at: null,
    },
    {
      share_token: 'fractional-count-token',
      title: 'Bad count',
      item_count: 1.5,
      first_opened_at: '2026-07-01T00:00:00.000Z',
      last_accessed_at: '2026-07-02T00:00:00.000Z',
      status: 'available',
      room_updated_at: null,
    },
  ]);
  assert.equal(rooms.length, 0);
});

test('unavailable list rows cannot surface room metadata even from a malformed payload', () => {
  const svc = loadService(createMockClient());
  const [room] = svc.normalizeSharedRoomMembershipListRows([{
    share_token: 'inactive-token',
    title: 'Must not leak',
    item_count: 99,
    first_opened_at: '2026-07-01T00:00:00.000Z',
    last_accessed_at: '2026-07-02T00:00:00.000Z',
    status: 'unavailable',
    room_updated_at: '2026-07-03T00:00:00.000Z',
  }]);

  assert.equal(room.title, null);
  assert.equal(room.itemCount, 0);
  assert.equal(room.updatedAt, null);
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
      share_id: 'secret-share',
      membership_id: 'secret-membership',
      item_ids: ['secret-item'],
      items: [{ id: 'secret-item' }],
      storage_bucket: 'secret-bucket',
      storage_path: 'secret/path',
      signed_url: 'https://secret.example/item',
      messages: [{ body: 'secret-message' }],
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

test('list calls the zero-argument RPC and rejects malformed top-level payloads', async () => {
  const validClient = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => ({ data: [], error: null }),
  });
  const validService = loadService(validClient);
  const validResult = await validService.listSharedRoomsForCurrentUser();
  assert.equal(validResult.ok, true);
  assert.equal(validResult.rooms.length, 0);
  assert.equal(validClient.rpcCalls.length, 1);
  assert.equal(validClient.rpcCalls[0].name, 'list_shared_rooms_for_me');
  assert.equal(validClient.rpcCalls[0].params, undefined);

  const malformedService = loadService(createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => ({ data: { rows: [] }, error: null }),
  }));
  const malformedResult = await malformedService.listSharedRoomsForCurrentUser();
  assert.equal(malformedResult.ok, false);
  assert.equal(malformedResult.reason, 'temporary_failure');
});

test('list maps missing RPC, network, and thrown failures to temporary_failure', async () => {
  for (const rpcImpl of [
    async () => ({ data: null, error: { code: 'PGRST202', message: 'missing function' } }),
    async () => ({ data: null, error: { message: 'fetch failed' } }),
    async () => {
      throw new Error('raw network failure');
    },
  ]) {
    const result = await loadService(createMockClient({
      session: { user: { id: 'user-1' } },
      rpcImpl,
    })).listSharedRoomsForCurrentUser();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'temporary_failure');
  }
});

test('one malformed list row does not discard valid rows', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => ({
      data: [
        { share_token: 'broken', status: 'available' },
        {
          share_token: 'active-token-a',
          title: null,
          item_count: 0,
          first_opened_at: '2026-07-01T00:00:00.000Z',
          last_accessed_at: '2026-07-02T00:00:00.000Z',
          status: 'empty',
          shared_at: '2026-06-30T00:00:00.000Z',
          room_updated_at: null,
        },
      ],
      error: null,
    }),
  });
  const result = await loadService(client).listSharedRoomsForCurrentUser();
  assert.equal(result.ok, true);
  assert.equal(result.rooms.length, 1);
  assert.equal(result.rooms[0].shareToken, 'active-token-a');
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
  assert.equal(touchClient.rpcCalls.length, 2);
  assert.equal(touchClient.rpcCalls[0].name, 'touch_shared_room_for_me');
  assert.equal(touchClient.rpcCalls[0].params.p_share_token, 'active-token-a');
  assert.equal(touchClient.rpcCalls[1].name, 'remove_shared_room_for_me');
  assert.equal(touchClient.rpcCalls[1].params.p_share_token, 'active-token-a');
});

test('touch and remove normalize every status documented by their RPCs', async () => {
  for (const status of ['touched', 'unavailable', 'unauthenticated', 'malformed']) {
    const result = await loadService(createMockClient({
      session: { user: { id: 'user-1' } },
      rpcImpl: async () => ({ data: { status }, error: null }),
    })).touchSharedRoomForCurrentUser('active-token-a');
    assert.equal(result.status, status);
  }

  for (const status of ['removed', 'unauthenticated', 'malformed']) {
    const result = await loadService(createMockClient({
      session: { user: { id: 'user-1' } },
      rpcImpl: async () => ({ data: { status }, error: null }),
    })).removeSharedRoomForCurrentUser('active-token-a');
    assert.equal(result.status, status);
  }
});

test('touch and remove map malformed payloads and thrown failures to temporary_failure', async () => {
  const malformedService = loadService(createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => ({ data: { status: 'undocumented' }, error: null }),
  }));
  assert.equal(
    (await malformedService.touchSharedRoomForCurrentUser('active-token-a')).status,
    'temporary_failure',
  );

  const thrownService = loadService(createMockClient({
    session: { user: { id: 'user-1' } },
    rpcImpl: async () => {
      throw new Error('raw transport detail');
    },
  }));
  assert.equal(
    (await thrownService.removeSharedRoomForCurrentUser('active-token-a')).status,
    'temporary_failure',
  );
});

test('touch malformed token does not call RPC', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const result = await svc.touchSharedRoomForCurrentUser('!!!');
  assert.equal(result.status, 'malformed');
  assert.equal(client.rpcCalls.length, 0);
});
