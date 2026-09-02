// ELISE-NC-001 — the client-side actor filter on Elise conversation retrieval.
//
// styleChatRepository calls it "belt-and-suspenders: RLS also enforces this".
// That is the whole point of a defence-in-depth layer, and it is exactly why it
// needs its own test: an RLS-enforcing backend stand-in cannot tell whether the
// client filter is present, so the existing persistence suite stayed green with
// `.eq('user_id', userId)` deleted.
//
// The store below is a faithful mini-database that honours the filters it is
// GIVEN and enforces nothing on its own — i.e. a server whose policy is missing
// or misconfigured. Against it, only the client's own query narrows the result,
// so these assertions are a behavioural test of the client filter.

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
    Date,
    Error,
    Promise,
    Array,
    Object,
    JSON,
    Number,
    String,
    Boolean,
    RegExp,
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

const ACTOR_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_B = '22222222-2222-2222-2222-222222222222';
const SHARED_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * A store with NO row-level security: it applies only the predicates the caller
 * supplies. This is the "RLS is missing" world the client filter exists for.
 */
function createUnsecuredStore(tables, sessionUserId) {
  function query(rows) {
    const predicates = [];
    const builder = {
      select: () => builder,
      eq: (column, value) => {
        predicates.push((row) => row[column] === value);
        return builder;
      },
      is: (column, value) => {
        predicates.push((row) => row[column] === value);
        return builder;
      },
      in: (column, values) => {
        predicates.push((row) => values.includes(row[column]));
        return builder;
      },
      order: () => builder,
      limit: (n) => {
        builder._limit = n;
        return builder;
      },
      then: undefined,
      async maybeSingle() {
        const matched = builder._resolve();
        return { data: matched[0] ?? null, error: null };
      },
      async single() {
        const matched = builder._resolve();
        return matched.length === 1
          ? { data: matched[0], error: null }
          : { data: null, error: { message: 'not found' } };
      },
      _resolve() {
        let matched = rows.filter((row) => predicates.every((p) => p(row)));
        if (typeof builder._limit === 'number') matched = matched.slice(0, builder._limit);
        return matched;
      },
    };
    // Awaiting the builder directly resolves the whole result set.
    builder.then = (onFulfilled, onRejected) =>
      Promise.resolve({ data: builder._resolve(), error: null }).then(onFulfilled, onRejected);
    return builder;
  }

  return {
    auth: {
      getSession: async () => ({
        data: { session: sessionUserId ? { user: { id: sessionUserId } } : null },
      }),
    },
    from: (table) => query(tables[table] ?? []),
    rpc: async () => ({ data: null, error: null }),
  };
}

function message(id, userId) {
  return {
    id,
    session_id: SHARED_SESSION_ID,
    user_id: userId,
    sender: 'user',
    content: `message from ${userId}`,
    referenced_scan_ids: [],
    referenced_saved_item_ids: [],
    referenced_dressing_room_ids: [],
    referenced_catalog_items: [],
    ui_blocks: [],
    provider: 'gemini',
    model: null,
    token_estimate: 0,
    created_at: '2026-09-02T00:00:00.000Z',
    source_message_id: null,
  };
}

function loadRepository(client) {
  return loadTsModule('services/style-chat/styleChatRepository.ts', {
    '../supabaseClient': { __esModule: true, supabase: client },
  });
}

test('ELISE-NC-001: with no server-side scoping, message retrieval still returns only the caller’s rows', async () => {
  const client = createUnsecuredStore(
    {
      style_chat_messages: [
        message('a-1', ACTOR_A),
        message('b-1', ACTOR_B),
        message('a-2', ACTOR_A),
        message('b-2', ACTOR_B),
      ],
    },
    ACTOR_A,
  );
  const { listStyleChatMessages } = loadRepository(client);

  const messages = await listStyleChatMessages(SHARED_SESSION_ID, ACTOR_A);

  assert.deepEqual(
    messages.map((m) => m.id).sort(),
    ['a-1', 'a-2'],
    'the client must narrow to the caller even when the server narrows nothing',
  );
  assert.equal(
    messages.some((m) => m.content.includes(ACTOR_B)),
    false,
    'no other actor’s Elise message may be returned',
  );
});

test('ELISE-NC-001: with no server-side scoping, session lookup still refuses a foreign session', async () => {
  const client = createUnsecuredStore(
    {
      style_chat_sessions: [
        {
          id: SHARED_SESSION_ID,
          user_id: ACTOR_B,
          title: 'Actor B conversation',
          mode: 'general',
          created_at: '2026-09-02T00:00:00.000Z',
          updated_at: '2026-09-02T00:00:00.000Z',
        },
      ],
    },
    ACTOR_A,
  );
  const { getStyleChatSession } = loadRepository(client);

  const session = await getStyleChatSession(SHARED_SESSION_ID, ACTOR_A);
  assert.equal(session, null, 'a session owned by another actor must not resolve');
});

test('ELISE-NC-001: with no server-side scoping, the session list still excludes other actors', async () => {
  const client = createUnsecuredStore(
    {
      style_chat_sessions: [
        {
          id: SHARED_SESSION_ID,
          user_id: ACTOR_B,
          title: 'Actor B conversation',
          mode: 'general',
          created_at: '2026-09-02T00:00:00.000Z',
          updated_at: '2026-09-02T00:00:00.000Z',
        },
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          user_id: ACTOR_A,
          title: 'Actor A conversation',
          mode: 'general',
          created_at: '2026-09-02T00:00:00.000Z',
          updated_at: '2026-09-02T00:00:00.000Z',
        },
      ],
    },
    ACTOR_A,
  );
  const { listStyleChatSessions } = loadRepository(client);

  const sessions = await listStyleChatSessions();
  assert.deepEqual(sessions.map((s) => s.title), ['Actor A conversation']);
});

test('ELISE-NC-001: an authenticated user who is not the expected actor is refused outright', async () => {
  // The account changed between opening the screen and the read landing.
  const client = createUnsecuredStore(
    { style_chat_messages: [message('a-1', ACTOR_A)] },
    ACTOR_B,
  );
  const { listStyleChatMessages } = loadRepository(client);

  await assert.rejects(
    () => listStyleChatMessages(SHARED_SESSION_ID, ACTOR_A),
    /Authenticated user changed/,
    'a mismatched live session must fail closed rather than read as the new actor',
  );
});
