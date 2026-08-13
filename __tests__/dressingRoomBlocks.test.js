/**
 * services/dressingRoomBlocks.ts — Dressing Room account-level blocking client.
 *
 * Covers DEF-B29-IOS-02A (the client was missing from the Build 29 staging
 * line entirely) at the service layer: correct RPC name, correct argument
 * shape, exactly one invocation per action, and neutral errors that never
 * leak Postgres/RLS detail or block direction.
 */
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

const SELF_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

function createMockClient({ session = { user: { id: SELF_ID } }, rpcResult } = {}) {
  const calls = [];
  return {
    _calls: calls,
    auth: {
      getSession: async () => ({ data: { session } }),
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      const result = typeof rpcResult === 'function' ? rpcResult(name, args) : rpcResult;
      return result ?? { data: { ok: true }, error: null };
    },
  };
}

function loadBlocks(client) {
  return loadTsModule('services/dressingRoomBlocks.ts', { './supabaseClient': { supabase: client } });
}

test('block invokes block_dressing_room_user exactly once with the target auth id', async () => {
  const client = createMockClient();
  const blocks = loadBlocks(client);

  const result = await blocks.blockDressingRoomUser(TARGET_ID);

  assert.equal(result.ok, true);
  assert.equal(client._calls.length, 1);
  assert.equal(client._calls[0].name, 'block_dressing_room_user');
  assert.equal(client._calls[0].args.p_target_user_id, TARGET_ID);
  assert.deepEqual(Object.keys(client._calls[0].args), ['p_target_user_id']);
});

test('unblock invokes unblock_dressing_room_user exactly once and reports removal', async () => {
  const client = createMockClient({ rpcResult: { data: { ok: true, removed: true }, error: null } });
  const blocks = loadBlocks(client);

  const result = await blocks.unblockDressingRoomUser(TARGET_ID);

  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(client._calls.length, 1);
  assert.equal(client._calls[0].name, 'unblock_dressing_room_user');
  assert.equal(client._calls[0].args.p_target_user_id, TARGET_ID);
  assert.deepEqual(Object.keys(client._calls[0].args), ['p_target_user_id']);
});

test('list maps the RPC row shape to the client shape', async () => {
  const client = createMockClient({
    rpcResult: {
      data: [{ blocked_user_id: TARGET_ID, created_at: '2026-08-01T00:00:00Z' }],
      error: null,
    },
  });
  const blocks = loadBlocks(client);

  const rows = await blocks.listDressingRoomBlockedUsers();

  assert.equal(client._calls[0].name, 'list_dressing_room_blocked_users');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blockedUserId, TARGET_ID);
  assert.equal(rows[0].createdAt, '2026-08-01T00:00:00Z');
});

test('list drops malformed rows rather than surfacing partial records', async () => {
  const client = createMockClient({
    rpcResult: {
      data: [{ blocked_user_id: TARGET_ID }, { created_at: '2026-08-01T00:00:00Z' }, null],
      error: null,
    },
  });
  const blocks = loadBlocks(client);

  assert.equal((await blocks.listDressingRoomBlockedUsers()).length, 0);
});

test('a self-block is refused client-side and never reaches the backend', async () => {
  const client = createMockClient();
  const blocks = loadBlocks(client);

  await assert.rejects(() => blocks.blockDressingRoomUser(SELF_ID), {
    message: blocks.DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR,
  });
  assert.equal(client._calls.length, 0);
});

test('a non-uuid target is refused client-side and never reaches the backend', async () => {
  const client = createMockClient();
  const blocks = loadBlocks(client);

  await assert.rejects(() => blocks.blockDressingRoomUser('not-a-uuid'), {
    message: blocks.DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR,
  });
  assert.equal(client._calls.length, 0);
});

test('block without a signed-in session never reaches the backend', async () => {
  const client = createMockClient({ session: null });
  const blocks = loadBlocks(client);

  await assert.rejects(() => blocks.blockDressingRoomUser(TARGET_ID), {
    message: blocks.DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR,
  });
  assert.equal(client._calls.length, 0);
});

test('a raw Postgres/RLS error is never surfaced to the user', async () => {
  const client = createMockClient({
    rpcResult: {
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy for table X' },
    },
  });
  const blocks = loadBlocks(client);

  await assert.rejects(() => blocks.blockDressingRoomUser(TARGET_ID), (err) => {
    assert.ok(!/row-level security|42501|policy|table/i.test(err.message), err.message);
    assert.equal(err.message, blocks.DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR);
    return true;
  });
});

test('an RPC that resolves without ok:true is treated as failure, not success', async () => {
  const client = createMockClient({ rpcResult: { data: { ok: false }, error: null } });
  const blocks = loadBlocks(client);

  await assert.rejects(() => blocks.blockDressingRoomUser(TARGET_ID));
});
