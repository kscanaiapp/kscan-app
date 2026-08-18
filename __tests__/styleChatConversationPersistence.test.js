// Fix #8 — StyleChat conversation persistence lifecycle.
//
// Locks the contract that a user's conversation survives leaving StyleChat,
// returning, and restarting the app — without duplicating sessions/messages,
// without leaking across users, and without replaying speech for history.
//
// The Supabase fake below enforces owner-scoped access on every read and write
// the way RLS does, so the ownership tests exercise a real denial rather than a
// client-side filter the production policy might not actually back.

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

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

// ── In-memory Supabase stand-in ───────────────────────────────────────────────

function createBackend() {
  const state = {
    tables: { style_chat_sessions: [], style_chat_messages: [] },
    authUserId: USER_A,
    offline: false,
    clock: 0,
    seq: 0,
  };

  const nextTimestamp = () => {
    state.clock += 1000;
    return new Date(Date.UTC(2026, 0, 1) + state.clock).toISOString();
  };
  const nextId = (prefix) => `${prefix}-${++state.seq}`;

  // Stands in for RLS: rows are only visible/writable to their owner.
  const visible = (row) => state.authUserId != null && row.user_id === state.authUserId;

  function matches(row, filters) {
    return filters.every(([column, value]) => row[column] === value);
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.op = 'select';
      this.filters = [];
      this.orderBy = null;
      this.ascending = true;
      this.limitCount = null;
      this.payload = null;
    }

    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    order(column, options) {
      this.orderBy = column;
      this.ascending = options?.ascending !== false;
      return this;
    }
    limit(count) { this.limitCount = count; return this; }
    insert(row) { this.op = 'insert'; this.payload = row; return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    delete() { this.op = 'delete'; return this; }

    rows() {
      const found = state.tables[this.table]
        .filter(visible)
        .filter((row) => matches(row, this.filters));
      if (this.orderBy) {
        found.sort((left, right) => {
          const a = left[this.orderBy];
          const b = right[this.orderBy];
          if (a === b) return 0;
          return (a < b ? -1 : 1) * (this.ascending ? 1 : -1);
        });
      }
      return this.limitCount == null ? found : found.slice(0, this.limitCount);
    }

    run() {
      if (state.offline) return { data: null, error: new Error('Network request failed') };

      if (this.op === 'insert') {
        const row = { ...this.payload };
        if (row.user_id !== state.authUserId) {
          return {
            data: null,
            error: new Error('new row violates row-level security policy'),
          };
        }
        // Mirrors the partial unique index style_chat_assistant_source_message_unique
        // on (user_id, session_id, sender, source_message_id): one assistant reply
        // per originating user message, so a resumed generation cannot append a
        // second copy of the same answer.
        if (row.sender === 'assistant' && row.source_message_id) {
          const clash = state.tables.style_chat_messages.find(
            (existing) =>
              existing.user_id === row.user_id &&
              existing.session_id === row.session_id &&
              existing.sender === 'assistant' &&
              existing.source_message_id === row.source_message_id,
          );
          if (clash) {
            return {
              data: null,
              error: new Error(
                'duplicate key value violates unique constraint "style_chat_assistant_source_message_unique"',
              ),
            };
          }
        }
        const created = nextTimestamp();
        const inserted = {
          id: nextId(this.table === 'style_chat_sessions' ? 'session' : 'message'),
          title: '',
          mode: 'general',
          sender: 'assistant',
          content: '',
          referenced_scan_ids: [],
          referenced_saved_item_ids: [],
          referenced_dressing_room_ids: [],
          referenced_catalog_items: [],
          ui_blocks: [],
          source_message_id: null,
          provider: null,
          model: null,
          token_estimate: 0,
          ...row,
          created_at: created,
          updated_at: created,
        };
        state.tables[this.table].push(inserted);
        return { data: inserted, error: null };
      }

      if (this.op === 'update') {
        const targets = this.rows();
        targets.forEach((row) => Object.assign(row, this.payload));
        return { data: targets, error: null };
      }

      if (this.op === 'delete') {
        const doomed = new Set(this.rows());
        state.tables[this.table] = state.tables[this.table].filter((row) => !doomed.has(row));
        return { data: null, error: null };
      }

      return { data: this.rows(), error: null };
    }

    async single() {
      const { data, error } = this.run();
      if (error) return { data: null, error };
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { data: null, error: new Error('No rows returned') };
      return { data: row, error: null };
    }

    async maybeSingle() {
      const { data, error } = this.run();
      if (error) return { data: null, error };
      const row = Array.isArray(data) ? data[0] : data;
      return { data: row ?? null, error: null };
    }

    then(resolve, reject) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }

  const client = {
    auth: {
      getSession: async () => ({
        data: { session: state.authUserId ? { user: { id: state.authUserId } } : null },
        error: null,
      }),
    },
    from: (table) => new Query(table),
    rpc: async () => ({ data: [{ messages_used: 0, messages_limit: 25 }], error: null }),
  };

  return { state, client };
}

function loadRepository(client) {
  return loadTsModule('services/style-chat/styleChatRepository.ts', {
    '../supabaseClient': { __esModule: true, supabase: client },
    './types': {},
  });
}

function loadGreeting(client, repository) {
  return loadTsModule('services/style-chat/styleChatGreeting.ts', {
    '@supabase/supabase-js': {},
    './styleChatRepository': repository,
    './types': {},
    '../stylistGreeting': {
      buildStylistGreeting: ({ userFirstName, stylistName }) => ({
        text: `Hello ${userFirstName || 'there'}, I'm ${stylistName}.`,
      }),
    },
    '../userFirstName': { resolveUserFirstName: (user) => ({ firstName: user?.firstName ?? '' }) },
    '../../constants/stylistIdentity': {},
    '../supabaseClient': { __esModule: true, supabase: client },
  });
}

const loadGuard = () => loadTsModule('services/style-chat/sessionLaunchGuard.ts');

function createHarness() {
  const backend = createBackend();
  const repository = loadRepository(backend.client);
  return { ...backend, repository, greeting: loadGreeting(backend.client, repository) };
}

// Resume-or-create exactly as Home wires it.
async function launchFromHome(harness, guard) {
  const { launchStyleChatSession } = loadGuard();
  const navigations = [];
  const result = await launchStyleChatSession({
    guard,
    createSession: () => harness.repository.createStyleChatSession({}),
    resolveExistingSessionId: async () => {
      const latest = await harness.repository.getLatestStyleChatSession();
      return latest?.id ?? null;
    },
    navigate: (sessionId) => navigations.push(sessionId),
  });
  return { result, navigations };
}

// ── 1. First session ─────────────────────────────────────────────────────────

test('FIRST_SESSION: a user with no conversation gets one created, and messages persist', async () => {
  const harness = createHarness();
  const { createStyleChatSessionLaunchGuard } = loadGuard();

  const { result, navigations } = await launchFromHome(harness, createStyleChatSessionLaunchGuard());

  assert.equal(result.status, 'navigated');
  assert.equal(navigations.length, 1);
  assert.equal(harness.state.tables.style_chat_sessions.length, 1);

  const sessionId = navigations[0];
  await harness.repository.saveStyleChatMessage({ sessionId, sender: 'user', content: 'What should I wear?' });
  await harness.repository.saveStyleChatMessage({ sessionId, sender: 'assistant', content: 'Try the navy blazer.' });

  const persisted = await harness.repository.listStyleChatMessages(sessionId);
  assert.deepEqual(persisted.map((m) => m.content), ['What should I wear?', 'Try the navy blazer.']);
});

// ── 2. Return to StyleChat ───────────────────────────────────────────────────

test('RETURN_TO_STYLECHAT: the stylist entry point resumes the existing conversation', async () => {
  const harness = createHarness();
  const { createStyleChatSessionLaunchGuard } = loadGuard();

  const first = await launchFromHome(harness, createStyleChatSessionLaunchGuard());
  const sessionId = first.navigations[0];
  await harness.repository.saveStyleChatMessage({ sessionId, sender: 'user', content: 'Hi' });

  // Leaving Home and returning constructs a fresh guard, exactly as focus does.
  const second = await launchFromHome(harness, createStyleChatSessionLaunchGuard());
  const third = await launchFromHome(harness, createStyleChatSessionLaunchGuard());

  assert.equal(second.navigations[0], sessionId);
  assert.equal(third.navigations[0], sessionId);
  assert.equal(
    harness.state.tables.style_chat_sessions.length,
    1,
    'Re-entering StyleChat must not create session B and session C',
  );
});

test('NEW_SESSION_STILL_EXPLICIT: omitting the resume resolver still creates a new conversation', async () => {
  const harness = createHarness();
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadGuard();
  await launchFromHome(harness, createStyleChatSessionLaunchGuard());

  // The conversations list's "New Session" affordance passes no resolver.
  const result = await launchStyleChatSession({
    guard: createStyleChatSessionLaunchGuard(),
    createSession: () => harness.repository.createStyleChatSession({}),
    navigate: () => {},
  });

  assert.equal(result.status, 'navigated');
  assert.equal(harness.state.tables.style_chat_sessions.length, 2);
});

// ── 3 & 5. History renders after reload, without duplication ─────────────────

test('MESSAGE_HISTORY: prior messages are returned when the conversation is reopened', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'user', content: 'One' });
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'assistant', content: 'Two' });

  const reopened = await harness.repository.listStyleChatMessages(session.id);
  assert.equal(reopened.length, 2);
  assert.equal(reopened[0].sender, 'user');
  assert.equal(reopened[1].sender, 'assistant');
});

test('NO_DUPLICATES: repeated hydration returns N messages, never 2N', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  for (const content of ['a', 'b', 'c']) {
    await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'user', content });
  }

  const first = await harness.repository.listStyleChatMessages(session.id);
  const second = await harness.repository.listStyleChatMessages(session.id);
  const third = await harness.repository.listStyleChatMessages(session.id);

  assert.equal(first.length, 3);
  assert.equal(second.length, 3);
  assert.equal(third.length, 3);
  assert.deepEqual(second.map((m) => m.id), first.map((m) => m.id));
});

test('HYDRATION_REPLACES: the load path assigns server truth rather than merging into stale state', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  // A merge would re-append history on every reopen; a replace cannot.
  assert.match(hook, /const msgs = await listStyleChatMessages\(sessionId, actorId\);\s*\n\s*if \(!cancelled\) setMessages\(msgs\);/);
});

// ── 4. App restart ───────────────────────────────────────────────────────────

test('APP_RESTART: history survives a fresh process with no in-memory state', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'user', content: 'Before restart' });
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'assistant', content: 'Noted.' });

  // Relaunch: new module instances, same backing store.
  const restarted = loadRepository(harness.client);
  const afterRestart = await restarted.listStyleChatMessages(session.id);
  const latest = await restarted.getLatestStyleChatSession();

  assert.deepEqual(afterRestart.map((m) => m.content), ['Before restart', 'Noted.']);
  assert.equal(latest.id, session.id, 'Relaunching must resume the same conversation');
});

// ── 6. Ordering ──────────────────────────────────────────────────────────────

test('ORDERING: history reloads in send order, not insertion-scan order', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  const expected = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'];
  for (const content of expected) {
    await harness.repository.saveStyleChatMessage({
      sessionId: session.id,
      sender: content.startsWith('u') ? 'user' : 'assistant',
      content,
    });
  }

  // Shuffle the stored rows: order must come from created_at, not array order.
  harness.state.tables.style_chat_messages.reverse();

  const reloaded = await harness.repository.listStyleChatMessages(session.id);
  assert.deepEqual(reloaded.map((m) => m.content), expected);
});

// ── 7. New messages after hydration ──────────────────────────────────────────

test('NEW_MESSAGE: sends append after hydration without disturbing history', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'user', content: 'old' });

  const hydrated = await harness.repository.listStyleChatMessages(session.id);
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'user', content: 'new' });
  const afterSend = await harness.repository.listStyleChatMessages(session.id);

  assert.equal(hydrated.length, 1);
  assert.deepEqual(afterSend.map((m) => m.content), ['old', 'new']);
});

// ── 8. Historical assistant messages must not speak ──────────────────────────

test('HISTORICAL_ASSISTANT_SPEECH: reopening a greeted conversation reports no fresh insert', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});

  // First entry: the greeting is inserted, which is what makes it speak.
  const inserted = await harness.greeting.ensureSessionGreeting(USER_A, session.id, 'Hello, I am Elise.');
  assert.equal(inserted.inserted, true);

  // Relaunch the app, then reopen the same conversation.
  const restartedGreeting = loadGreeting(harness.client, loadRepository(harness.client));
  const reopened = await restartedGreeting.ensureSessionGreeting(USER_A, session.id, 'Hello, I am Elise.');

  assert.equal(reopened.inserted, false, 'A persisted greeting must not be re-inserted');
  assert.ok(reopened.message, 'The persisted greeting is still returned for rendering');
  assert.equal(reopened.message.id, inserted.message.id);
  assert.equal(
    (await harness.repository.listStyleChatMessages(session.id)).length,
    1,
    'Reopening must not append a second greeting',
  );
});

test('HISTORICAL_ASSISTANT_SPEECH: the welcome speaks only on a fresh insert', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  // `result.inserted` is false for a rehydrated greeting, so reopening a
  // conversation cannot re-speak its welcome.
  assert.match(hook, /if \(result\.inserted && canSpeakNewMessages\) \{\s*\n\s*void speakAvatarMessage\(\{/);
});

test('HISTORICAL_ASSISTANT_SPEECH: a conversation with replies is never retro-greeted or spoken', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'user', content: 'hi' });
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'assistant', content: 'Wear the coat.' });

  const result = await harness.greeting.ensureSessionGreeting(USER_A, session.id, 'Hello again.');

  assert.equal(result.inserted, false);
  assert.equal(result.message, null);
  assert.equal((await harness.repository.listStyleChatMessages(session.id)).length, 2);
});

test('HISTORICAL_ASSISTANT_SPEECH: the message load path contains no speech call', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  const loader = hook.slice(
    hook.indexOf('async function loadMessages()'),
    hook.indexOf('async function loadDailyUsage()'),
  );
  assert.ok(loader.length > 0, 'loadMessages must remain the hydration authority');
  assert.doesNotMatch(loader, /speakAvatarMessage/);
});

// ── 9. New assistant replies stay speech-eligible (Fix #3 compatibility) ─────

test('NEW_ASSISTANT_SPEECH: a freshly persisted assistant reply is still handed to Fix #3', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  const sendTail = hook.slice(hook.indexOf('const savedAssistant = await saveStyleChatMessage('));
  assert.match(sendTail, /if \(canSpeakNewMessages\) \{[\s\S]*?speakAvatarMessage\(\{[\s\S]*?messageId: savedAssistant\.id/);
  assert.match(sendTail, /source: 'message'/);
});

// ── 10. Logout ───────────────────────────────────────────────────────────────

test('LOGOUT: the next user on the device cannot read the previous user\'s conversation', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'user', content: 'private' });

  harness.state.authUserId = USER_B;

  assert.deepEqual(await harness.repository.listStyleChatSessions(), []);
  assert.equal(await harness.repository.getLatestStyleChatSession(), null);
  assert.deepEqual(await harness.repository.listStyleChatMessages(session.id), []);
});

test('LOGOUT: greeting state is clearable at the auth boundary', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.greeting.ensureSessionGreeting(USER_A, session.id, 'Hello.');
  harness.greeting.markSessionGreeted(USER_A, session.id);

  harness.greeting.resetStyleChatGreetingState();

  assert.equal(harness.greeting.isSessionGreeted(USER_A, session.id), false);
});

test('LOGOUT: the auth boundary clears StyleChat greeting state', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'contexts', 'AuthSessionContext.tsx'), 'utf8');
  assert.match(auth, /resetStyleChatGreetingState\(\)/);
});

// ── 11. Cross-user isolation ─────────────────────────────────────────────────

test('CROSS_USER_ISOLATION: reads and writes against another user\'s session fail closed', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'user', content: 'mine' });

  harness.state.authUserId = USER_B;

  assert.equal(await harness.repository.getStyleChatSession(session.id), null);
  assert.deepEqual(await harness.repository.listStyleChatMessages(session.id), []);

  // A write lands under USER_B and is therefore invisible to USER_A's history.
  await harness.repository.saveStyleChatMessage({ sessionId: session.id, sender: 'user', content: 'intruder' });
  harness.state.authUserId = USER_A;
  const ownerView = await harness.repository.listStyleChatMessages(session.id);
  assert.deepEqual(ownerView.map((m) => m.content), ['mine']);
});

test('CROSS_USER_ISOLATION: an actor change mid-read is rejected before any row is returned', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  harness.state.authUserId = USER_B;

  await assert.rejects(
    () => harness.repository.listStyleChatMessages(session.id, USER_A),
    /Authenticated user changed/,
  );
});

test('CROSS_USER_ISOLATION: signed-out access is refused', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  harness.state.authUserId = null;

  await assert.rejects(() => harness.repository.listStyleChatMessages(session.id), /Sign in/);
  await assert.rejects(() => harness.repository.getLatestStyleChatSession(), /Sign in/);
});

// ── 12. Network failure ──────────────────────────────────────────────────────

test('NETWORK_FAIL_SOFT: a failed resume surfaces a retryable failure instead of a duplicate session', async () => {
  const harness = createHarness();
  const { createStyleChatSessionLaunchGuard } = loadGuard();
  await launchFromHome(harness, createStyleChatSessionLaunchGuard());
  assert.equal(harness.state.tables.style_chat_sessions.length, 1);

  harness.state.offline = true;
  const offline = await launchFromHome(harness, createStyleChatSessionLaunchGuard());
  assert.equal(offline.result.status, 'failed');
  assert.deepEqual(offline.navigations, []);
  assert.equal(
    harness.state.tables.style_chat_sessions.length,
    1,
    'A lookup failure must not strand the conversation behind a new one',
  );

  harness.state.offline = false;
  const recovered = await launchFromHome(harness, createStyleChatSessionLaunchGuard());
  assert.equal(recovered.result.status, 'navigated');
  assert.equal(harness.state.tables.style_chat_sessions.length, 1);
});

test('NETWORK_FAIL_SOFT: a failed history load never overwrites messages with an empty list', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  const loader = hook.slice(
    hook.indexOf('async function loadMessages()'),
    hook.indexOf('async function loadDailyUsage()'),
  );
  const failurePath = loader.slice(loader.indexOf('catch'));
  assert.doesNotMatch(failurePath, /setMessages/);
});

// ── 13. Navigating away during generation ────────────────────────────────────

test('PENDING_GENERATION: a reply that lands after navigating away is kept exactly once', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.repository.saveStyleChatMessage({
    sessionId: session.id,
    sender: 'user',
    content: 'Style this for me',
  });

  // The assistant row is written before the send-scope guard is consulted, so a
  // generation that completed still lands even though the user left the screen.
  await harness.repository.saveStyleChatMessage({
    sessionId: session.id,
    sender: 'assistant',
    content: 'Here is the look.',
  });

  const history = await harness.repository.listStyleChatMessages(session.id);
  assert.deepEqual(history.map((m) => m.sender), ['user', 'assistant']);
  assert.equal(history.filter((m) => m.sender === 'user').length, 1);
});

test('PENDING_GENERATION: navigating away suppresses the reply\'s state update and speech', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  const afterSave = hook.slice(hook.indexOf('const savedAssistant = await saveStyleChatMessage('));
  const guardIndex = afterSave.indexOf('if (!isCurrentSend()) return;');
  const speechIndex = afterSave.indexOf('speakAvatarMessage');
  assert.ok(guardIndex > -1, 'the send-scope guard must remain after the assistant save');
  assert.ok(
    guardIndex < speechIndex,
    'a reply for a session the user has left must not speak',
  );
});

// ── 14. Attachments ──────────────────────────────────────────────────────────

test('ATTACHMENTS_REHYDRATE: attachment ui_blocks and references survive reload', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  const uiBlocks = [{ type: 'attachments', items: [{ draftId: 'd1', title: 'Navy blazer' }] }];

  await harness.repository.saveStyleChatMessage({
    sessionId: session.id,
    sender: 'user',
    content: 'How do I wear this?',
    uiBlocks,
    referencedSavedItemIds: ['saved-1'],
    referencedScanIds: ['scan-1'],
  });

  const [reloaded] = await harness.repository.listStyleChatMessages(session.id);
  assert.deepEqual(reloaded.uiBlocks, uiBlocks);
  assert.deepEqual(reloaded.referencedSavedItemIds, ['saved-1']);
  assert.deepEqual(reloaded.referencedScanIds, ['scan-1']);
});

test('ATTACHMENTS_REHYDRATE: persisted history carries no image bytes', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.repository.saveStyleChatMessage({
    sessionId: session.id,
    sender: 'user',
    content: 'look at this',
    uiBlocks: [{ type: 'attachments', items: [{ draftId: 'd1', title: 'Coat' }] }],
  });

  const stored = JSON.stringify(harness.state.tables.style_chat_messages);
  assert.doesNotMatch(stored, /base64|data:image/i);
});

// ── 15. Stylist identity ─────────────────────────────────────────────────────

test('CUSTOM_STYLIST_IDENTITY: conversations store no stylist identity to drift out of date', async () => {
  const harness = createHarness();
  const session = await harness.repository.createStyleChatSession({});
  await harness.repository.saveStyleChatMessage({
    sessionId: session.id,
    sender: 'assistant',
    content: 'Henry here — try the loafers.',
  });

  const [row] = harness.state.tables.style_chat_sessions;
  assert.ok(!('stylist_id' in row) && !('avatar_id' in row) && !('persona' in row));

  // Reload returns the message verbatim; the rendered name comes from the
  // user's current identity, which Fix #6 keeps authoritative.
  const [message] = await harness.repository.listStyleChatMessages(session.id);
  assert.equal(message.content, 'Henry here — try the loafers.');
});

test('CUSTOM_STYLIST_IDENTITY: resume is scoped by owner only, never by stylist', () => {
  const repository = fs.readFileSync(
    path.join(ROOT, 'services', 'style-chat', 'styleChatRepository.ts'),
    'utf8',
  );
  const latest = repository.slice(
    repository.indexOf('export async function getLatestStyleChatSession'),
    repository.indexOf('export async function createStyleChatSession'),
  );
  assert.match(latest, /\.eq\('user_id', userId\)/);
  assert.doesNotMatch(latest, /stylist|avatar|persona/i);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('HOME_WIRING: the stylist CTA resumes the latest conversation before creating one', () => {
  const home = fs.readFileSync(path.join(ROOT, 'components', 'home', 'HomeLuxuryTechV1.tsx'), 'utf8');
  assert.match(home, /resolveExistingSessionId: getLatestSessionId/);
  assert.match(home, /const \{ createSession, getLatestSessionId \} = useStyleChatSessions\(\)/);
});

test('HOME_WIRING: the conversations list keeps creating a new session on request', () => {
  const index = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', 'index.tsx'), 'utf8');
  assert.match(index, /launchStyleChatSession\(\{/);
  assert.doesNotMatch(index, /resolveExistingSessionId/);
});

test('SINGLE_AUTHORITY: resume flows through the existing launch guard, not a parallel path', () => {
  const guard = fs.readFileSync(
    path.join(ROOT, 'services', 'style-chat', 'sessionLaunchGuard.ts'),
    'utf8',
  );
  // The resolved session is remembered so a retry cannot create a duplicate.
  assert.match(guard, /if \(existingSessionId\) \{\s*\n\s*sessionId = existingSessionId;\s*\n\s*guard\.rememberSession\(sessionId\);/);
});
