// Outfit decision safe-error contract.
//
// WHY THIS EXISTS: services/styleObjects.ts already enforces (and is covered by
// styleObjectsContract.test.js) that a Dressing Room service must convert a
// database error into neutral user copy and must never forward the raw
// PostgREST/Postgres message. services/outfitDecisions.ts carries a same-named
// safeError helper that reached the user surface instead: OutfitDecisionSection
// puts the thrown message straight into React state and renders it in an
// InlineNotice, so an RLS rejection (SQLSTATE 42501) surfaced text such as
// `permission denied for function cast_outfit_decision_vote` — leaking table,
// function and policy names to an ordinary user.
//
// These are behavioural tests: the service is transpiled and executed against a
// mock supabase client, so they fail if the raw message is ever forwarded again,
// regardless of how the helper is spelled.

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

/** A representative Postgres RLS rejection as PostgREST surfaces it. */
function rlsError(message) {
  return {
    code: '42501',
    message,
    details: 'internal detail that must never reach the user',
    hint: 'internal hint that must never reach the user',
  };
}

const LEAKY_MESSAGES = [
  'permission denied for function cast_outfit_decision_vote',
  'new row violates row-level security policy for table "outfit_decision_votes"',
  'permission denied for table outfit_decision_groups',
];

/** Every string the database side may hand back that must not be echoed. */
function assertNoInternalDisclosure(message) {
  assert.equal(typeof message, 'string');
  const lowered = message.toLowerCase();
  for (const forbidden of [
    'permission denied',
    'row-level security',
    'row level security',
    '42501',
    'pgrst',
    'outfit_decision',
    'internal detail',
    'internal hint',
  ]) {
    assert.equal(
      lowered.includes(forbidden),
      false,
      `user-facing copy must not contain ${JSON.stringify(forbidden)}; got: ${message}`,
    );
  }
}

function createMockClient({ rpcImpl, fromImpl } = {}) {
  const client = {
    rpc: async (name, args) => (rpcImpl ? rpcImpl(name, args) : { data: null, error: null }),
    from: (table) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => (fromImpl ? fromImpl(table) : { data: [], error: null }),
      };
      return builder;
    },
  };
  return client;
}

function loadService(mockClient) {
  return loadTsModule('services/outfitDecisions.ts', {
    './supabaseClient': { __esModule: true, supabase: mockClient },
    // Guideline 1.2 denylist lives in roomMessages; these tests cover error
    // hygiene, not content filtering, so a permissive stub keeps them focused.
    './roomMessages': { __esModule: true, containsBlockedMessageContent: () => false },
  });
}

test('outfitDecisions: castOutfitDecisionVote never forwards a raw RLS message', async () => {
  for (const leaky of LEAKY_MESSAGES) {
    const service = loadService(
      createMockClient({ rpcImpl: () => ({ data: null, error: rlsError(leaky) }) }),
    );
    await assert.rejects(
      () => service.castOutfitDecisionVote('group-1', 'option-1'),
      (err) => {
        assertNoInternalDisclosure(err.message);
        assert.equal(err.message, 'Unable to save your vote. Please try again.');
        return true;
      },
    );
  }
});

test('outfitDecisions: owner decision-state actions never forward a raw RLS message', async () => {
  const service = loadService(
    createMockClient({ rpcImpl: () => ({ data: null, error: rlsError(LEAKY_MESSAGES[0]) }) }),
  );

  for (const invoke of [
    () => service.chooseOutfitDecisionWinner('group-1', 'option-1'),
    () => service.confirmWearingOutfitDecision('group-1'),
    () => service.setOutfitDecisionOpenState('group-1', false),
  ]) {
    await assert.rejects(invoke, (err) => {
      assertNoInternalDisclosure(err.message);
      assert.equal(err.message, 'Unable to update this decision. Please try again.');
      return true;
    });
  }
});

test('outfitDecisions: shareLooksToRoom never forwards a raw RLS message', async () => {
  const service = loadService(
    createMockClient({
      rpcImpl: () => ({ data: null, error: rlsError('permission denied for function share_looks_to_outfit_decision') }),
    }),
  );

  await assert.rejects(
    () =>
      service.shareLooksToRoom({
        roomId: 'room-1',
        lookIds: ['look-1'],
        question: 'Should I wear this?',
      }),
    (err) => {
      assertNoInternalDisclosure(err.message);
      assert.equal(err.message, 'Unable to share to this Dressing Room. Please try again.');
      return true;
    },
  );
});

test('outfitDecisions: listRoomOutfitDecisions never forwards a raw RLS message', async () => {
  const service = loadService(
    createMockClient({
      fromImpl: () => ({ data: null, error: rlsError('permission denied for table outfit_decision_groups') }),
    }),
  );

  await assert.rejects(
    () => service.listRoomOutfitDecisions('room-1'),
    (err) => {
      assertNoInternalDisclosure(err.message);
      assert.equal(err.message, 'Unable to load outfit decisions.');
      return true;
    },
  );
});

test('outfitDecisions: deliberate client-side validation copy is preserved', async () => {
  const service = loadService(createMockClient({}));

  // These are authored user-facing messages, not database text: the safe-error
  // repair must not flatten them into a generic string.
  await assert.rejects(
    () => service.shareLooksToRoom({ roomId: 'r', lookIds: ['l'], question: '   ' }),
    /Add a question for your room\./,
  );
  await assert.rejects(
    () => service.shareLooksToRoom({ roomId: 'r', lookIds: [], question: 'ok?' }),
    /Share between 1 and 3 Looks\./,
  );
});
