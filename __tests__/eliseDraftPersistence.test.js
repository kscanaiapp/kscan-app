// Durable Elise composer drafts (UX addendum 2).
//
// The feature exists so a crash or force-quit does not throw away a long
// styling question. The RISK it introduces is that unsent words now sit on the
// device, so the actor binding is the part that has to be airtight:
//
//   - a draft is written only for a signed-in actor;
//   - a read requires the expected actor and fails closed on any mismatch;
//   - the actor transition clears the store outright;
//   - and the read check is independently load-bearing, because that clear is
//     fire-and-forget and a restore can race it.
//
// The module is executed against an in-memory AsyncStorage stand-in, so these
// are assertions about what is actually stored and returned.

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
  vm.runInNewContext(
    output,
    {
      exports: module.exports,
      module,
      console,
      Date,
      JSON,
      Number,
      Array,
      Object,
      String,
      Boolean,
      Promise,
      Error,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

const ACTOR_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_B = '22222222-2222-2222-2222-222222222222';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    impl: {
      __esModule: true,
      default: {
        getItem: async (key) => (store.has(key) ? store.get(key) : null),
        setItem: async (key, value) => {
          store.set(key, value);
        },
        removeItem: async (key) => {
          store.delete(key);
        },
      },
    },
  };
}

function loadDrafts(storage) {
  return loadTsModule('services/style-chat/styleChatDraftPersistence.ts', {
    '@react-native-async-storage/async-storage': storage.impl,
  });
}

test('a draft written by an actor is restored for that same actor and session', async () => {
  const storage = createStorage();
  const drafts = loadDrafts(storage);

  await drafts.persistStyleChatDraft({
    actorId: ACTOR_A,
    sessionId: SESSION_A,
    text: 'What should I wear to a gallery opening in Lisbon?',
  });

  assert.equal(
    await drafts.readStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A }),
    'What should I wear to a gallery opening in Lisbon?',
  );
});

test("a draft is never restored for a different actor", async () => {
  const storage = createStorage();
  const drafts = loadDrafts(storage);

  await drafts.persistStyleChatDraft({
    actorId: ACTOR_A,
    sessionId: SESSION_A,
    text: 'Actor A private styling question',
  });

  assert.equal(
    await drafts.readStyleChatDraft({ actorId: ACTOR_B, sessionId: SESSION_A }),
    '',
    'the arriving actor must not inherit the departed actor’s unsent words',
  );
});

test('a draft is never restored into a different conversation', async () => {
  const storage = createStorage();
  const drafts = loadDrafts(storage);

  await drafts.persistStyleChatDraft({
    actorId: ACTOR_A,
    sessionId: SESSION_A,
    text: 'Question for conversation A',
  });

  assert.equal(await drafts.readStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_B }), '');
});

test('a signed-out composer neither writes nor reads a durable draft', async () => {
  const storage = createStorage();
  const drafts = loadDrafts(storage);

  await drafts.persistStyleChatDraft({
    actorId: null,
    sessionId: SESSION_A,
    text: 'ownerless words',
  });
  assert.equal(storage.store.size, 0, 'an ownerless draft must never be stored');
  assert.equal(await drafts.readStyleChatDraft({ actorId: null, sessionId: SESSION_A }), '');
});

test('the actor transition clears every durable draft', async () => {
  const storage = createStorage();
  const drafts = loadDrafts(storage);

  await drafts.persistStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A, text: 'one' });
  await drafts.persistStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_B, text: 'two' });
  assert.equal(storage.store.size, 1);

  await drafts.clearStyleChatDrafts();

  assert.equal(storage.store.size, 0);
  assert.equal(await drafts.readStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A }), '');
});

test('an arriving actor’s first write replaces the file rather than merging into it', async () => {
  const storage = createStorage();
  const drafts = loadDrafts(storage);

  await drafts.persistStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A, text: 'A words' });
  // Simulates the clear having failed or not yet run.
  await drafts.persistStyleChatDraft({ actorId: ACTOR_B, sessionId: SESSION_B, text: 'B words' });

  const raw = storage.store.get(drafts.STYLE_CHAT_DRAFTS_KEY);
  assert.equal(raw.includes('A words'), false, 'no row of the previous actor may survive');
  assert.equal(await drafts.readStyleChatDraft({ actorId: ACTOR_B, sessionId: SESSION_B }), 'B words');
  assert.equal(await drafts.readStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A }), '');
});

test('clearing the composer removes the durable draft instead of storing a blank', async () => {
  const storage = createStorage();
  const drafts = loadDrafts(storage);

  await drafts.persistStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A, text: 'typed' });
  await drafts.persistStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A, text: '   ' });

  assert.equal(storage.store.size, 0, 'an emptied composer leaves nothing behind');
});

test('durable drafts are bounded in count and length', async () => {
  const storage = createStorage();
  const drafts = loadDrafts(storage);

  for (let i = 0; i < drafts.MAX_PERSISTED_DRAFTS + 5; i += 1) {
    await drafts.persistStyleChatDraft({
      actorId: ACTOR_A,
      sessionId: `session-${i}`,
      text: `draft ${i}`,
    });
  }
  const parsed = JSON.parse(storage.store.get(drafts.STYLE_CHAT_DRAFTS_KEY));
  assert.equal(parsed.drafts.length, drafts.MAX_PERSISTED_DRAFTS);

  await drafts.persistStyleChatDraft({
    actorId: ACTOR_A,
    sessionId: SESSION_A,
    text: 'x'.repeat(drafts.MAX_PERSISTED_DRAFT_CHARS + 500),
  });
  const restored = await drafts.readStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A });
  assert.equal(restored.length, drafts.MAX_PERSISTED_DRAFT_CHARS);
});

test('a corrupt or foreign-shaped record is ignored rather than trusted', async () => {
  for (const raw of ['not json', '{}', '{"version":2,"actorId":"a","drafts":[]}', 'null', '[]']) {
    const storage = createStorage({ '@style_chat_v1/composer/drafts': raw });
    const drafts = loadDrafts(storage);
    assert.equal(
      await drafts.readStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A }),
      '',
      `record ${raw} must not produce a draft`,
    );
  }
});

test('no attachment or local media reference is ever persisted', async () => {
  const storage = createStorage();
  const drafts = loadDrafts(storage);

  await drafts.persistStyleChatDraft({
    actorId: ACTOR_A,
    sessionId: SESSION_A,
    text: 'Style this jacket',
  });

  const parsed = JSON.parse(storage.store.get(drafts.STYLE_CHAT_DRAFTS_KEY));
  assert.deepEqual(Object.keys(parsed).sort(), ['actorId', 'drafts', 'version']);
  for (const entry of parsed.drafts) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['sessionId', 'text', 'updatedAt'],
      'a durable draft carries text only — never attachments or file:// URIs',
    );
  }
});

test('a storage failure loses the recovery copy, never the send path', async () => {
  const drafts = loadTsModule('services/style-chat/styleChatDraftPersistence.ts', {
    '@react-native-async-storage/async-storage': {
      __esModule: true,
      default: {
        getItem: async () => {
          throw new Error('storage unavailable');
        },
        setItem: async () => {
          throw new Error('storage unavailable');
        },
        removeItem: async () => {
          throw new Error('storage unavailable');
        },
      },
    },
  });

  await drafts.persistStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A, text: 'typed' });
  assert.equal(await drafts.readStyleChatDraft({ actorId: ACTOR_A, sessionId: SESSION_A }), '');
  await drafts.clearStyleChatDrafts();
});
