// B34-FE-DR-001 — anonymous Dressing Room reaction counts require p_share_token.
//
// Frozen backend contract (verified against K Scan AI Staging at audit time):
//
//   get_item_reaction_counts(p_item_ids uuid[], p_share_token text DEFAULT NULL)
//   RETURNS TABLE(item_id uuid, reaction_type text, count integer)
//   SECURITY DEFINER
//
//   when auth.uid() IS NULL:
//     rows are returned only if p_share_token matches a room_shares row that is
//     is_active, not revoked, and not expired
//   otherwise:
//     authorization resolves from membership / room ownership
//
// Because p_share_token has a DEFAULT, omitting it does NOT raise. The call
// succeeds and returns zero rows, so the failure mode is silent all-zero counts
// on every public share — not an error the UI could surface. These tests pin the
// client side of that contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * Load services/styleObjects.ts with a recording Supabase stub.
 * @param {(fn: string, args: object) => {data: unknown, error: unknown}} onRpc
 */
function loadStyleObjects(onRpc) {
  const filename = path.join(ROOT, 'services', 'styleObjects.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const noop = new Proxy({}, { get: () => () => undefined });

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    __DEV__: false,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    Set,
    Map,
    Promise,
    Error,
    require: (id) => {
      if (id === './supabaseClient') {
        return { supabase: { rpc: async (fn, args) => onRpc(fn, args) } };
      }
      if (id === 'expo-file-system/legacy' || id === 'expo-image-manipulator') {
        return noop;
      }
      throw new Error(`Unexpected require: ${id}`);
    },
  };

  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';

function recorder(rows = []) {
  const calls = [];
  const api = loadStyleObjects((fn, args) => {
    calls.push({ fn, args });
    return { data: rows, error: null };
  });
  return { api, calls };
}

// ── Anonymous public path ────────────────────────────────────────────────────

test('anonymous public path forwards a valid live share token', async () => {
  const { api, calls } = recorder();
  await api.getItemReactionCounts([ITEM_A], 'live-token-abc');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'get_item_reaction_counts');
  assert.equal(
    calls[0].args.p_share_token,
    'live-token-abc',
    'the share token is the only thing authorizing an anonymous reader',
  );
});

test('a wrong token is forwarded verbatim for the server to reject', async () => {
  const { api, calls } = recorder([]);
  const counts = await api.getItemReactionCounts([ITEM_A], 'not-the-right-token');

  assert.equal(calls[0].args.p_share_token, 'not-the-right-token');
  // Authorization is the function's decision, never the client's.
  assert.deepEqual(Array.from(counts), []);
});

test('a revoked or expired share returns no rows without throwing', async () => {
  // A revoked/expired/inactive share fails the room_shares predicate, so the
  // SECURITY DEFINER function returns an empty set rather than an error.
  const { api } = recorder([]);
  const counts = await api.getItemReactionCounts([ITEM_A, ITEM_B], 'revoked-token');
  assert.deepEqual(Array.from(counts), [], 'the viewer sees zero counts, not a crash');
});

test('the token is trimmed before it reaches the RPC', async () => {
  const { api, calls } = recorder();
  await api.getItemReactionCounts([ITEM_A], '  padded-token  ');
  assert.equal(calls[0].args.p_share_token, 'padded-token');
});

test('a blank token normalizes to null rather than an empty string', async () => {
  const { api, calls } = recorder();
  await api.getItemReactionCounts([ITEM_A], '   ');
  assert.equal(calls[0].args.p_share_token, null);
});

// ── Authenticated owner / member path ────────────────────────────────────────

test('authenticated callers send an explicit null token and resolve by uid', async () => {
  const { api, calls } = recorder();
  await api.getItemReactionCounts([ITEM_A]);

  assert.equal(calls.length, 1);
  assert.ok(
    'p_share_token' in calls[0].args,
    'p_share_token must always be supplied so the argument set is unambiguous',
  );
  assert.equal(calls[0].args.p_share_token, null);
});

// ── Batching ─────────────────────────────────────────────────────────────────

test('every batch of a large request carries the share token', async () => {
  const manyItems = Array.from({ length: 205 }, (_, i) =>
    `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
  );

  const { api, calls } = recorder();
  await api.getItemReactionCounts(manyItems, 'live-token-abc');

  assert.ok(calls.length > 1, 'this request must span multiple batches');
  for (const call of calls) {
    assert.equal(
      call.args.p_share_token,
      'live-token-abc',
      'a batch that drops the token would silently return zeros for its slice',
    );
  }
});

test('an empty item list short-circuits without calling the RPC', async () => {
  const { api, calls } = recorder();
  const counts = await api.getItemReactionCounts([], 'live-token-abc');
  assert.deepEqual(Array.from(counts), []);
  assert.equal(calls.length, 0);
});

// ── Call-site wiring ─────────────────────────────────────────────────────────

test('the public shared-room screen passes its route token', () => {
  const screen = fs.readFileSync(
    path.join(ROOT, 'app', '(public)', 'rooms', '[token].tsx'),
    'utf8',
  );
  assert.match(
    screen,
    /getItemReactionCounts\(\s*itemIds\s*,\s*shareTokenForCounts\s*\)/,
    'the anonymous screen must pass the share token it was opened with',
  );
});

test('the RPC is never called without an explicit p_share_token argument', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'styleObjects.ts'), 'utf8');
  const callSites = source.match(/rpc\(\s*'get_item_reaction_counts'[\s\S]*?\}\)/g) ?? [];

  assert.ok(callSites.length > 0, 'expected at least one reaction-count call site');
  for (const site of callSites) {
    assert.match(
      site,
      /p_share_token/,
      'omitting p_share_token silently returns zero rows for anonymous viewers',
    );
  }
});
