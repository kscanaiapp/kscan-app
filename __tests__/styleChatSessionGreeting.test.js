const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

// Metro asset stubs so constants/stylistIdentity.ts can be required.
require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;

const greetingSource = fs.readFileSync(
  path.join(ROOT, 'services', 'style-chat', 'styleChatGreeting.ts'),
  'utf8',
);

function loadGreeting(repository) {
  const output = ts.transpileModule(greetingSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const mod = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', output);
  evaluate((specifier) => {
    if (specifier === './styleChatRepository') return repository;
    if (specifier === '../stylistGreeting') return require('../services/stylistGreeting.ts');
    if (specifier === '../userFirstName') return require('../services/userFirstName.ts');
    if (specifier === '../../constants/stylistIdentity') {
      return require('../constants/stylistIdentity.ts');
    }
    if (specifier === '@supabase/supabase-js') return {};
    throw new Error(`Unexpected styleChatGreeting import: ${specifier}`);
  }, mod, mod.exports);
  return mod.exports;
}

function createMockRepository(initialMessages = []) {
  let messages = [...initialMessages];
  let counter = 0;
  return {
    listStyleChatMessages: async () => messages,
    saveStyleChatMessage: async (input) => {
      counter += 1;
      const saved = {
        id: `msg-${counter}`,
        sessionId: input.sessionId,
        sender: input.sender,
        content: input.content,
        uiBlocks: input.uiBlocks || [],
        provider: input.provider || 'mock',
        tokenEstimate: input.tokenEstimate ?? 0,
        createdAt: new Date().toISOString(),
        referencedScanIds: [],
        referencedSavedItemIds: [],
        referencedDressingRoomIds: [],
        referencedCatalogItems: [],
      };
      messages.push(saved);
      return saved;
    },
    _messages() {
      return messages;
    },
    _reset(next = []) {
      messages = next;
      counter = 0;
    },
  };
}

test('getGreetingTextForUser uses first name and stylist identity', () => {
  const { getGreetingTextForUser } = loadGreeting(createMockRepository());
  const user = { id: 'u1', user_metadata: { first_name: 'Kathleen' } };
  const identity = { displayName: 'Elise', avatarId: 'elise_default' };
  assert.equal(getGreetingTextForUser(user, identity), 'Hi, Kathleen. I’m Elise. How can I help style you today?');
});

test('getGreetingTextForUser falls back when first name is missing', () => {
  const { getGreetingTextForUser } = loadGreeting(createMockRepository());
  const identity = { displayName: 'Ava', avatarId: 'elise_default' };
  assert.equal(
    getGreetingTextForUser(null, identity),
    'Hey, I’m Ava. Show me what you’re working with, and we’ll figure it out together.',
  );
});

test('isGreetingMessage recognizes the greeting uiBlocks marker', () => {
  const { isGreetingMessage } = loadGreeting(createMockRepository());
  assert.equal(
    isGreetingMessage({
      id: 'm1',
      sender: 'assistant',
      content: 'Hi',
      uiBlocks: [{ type: 'greeting' }],
    }),
    true,
  );
  assert.equal(
    isGreetingMessage({
      id: 'm2',
      sender: 'assistant',
      content: 'Hi',
      uiBlocks: [{ type: 'why_this_works', body: 'x' }],
    }),
    false,
  );
  assert.equal(
    isGreetingMessage({
      id: 'm3',
      sender: 'user',
      content: 'Hi',
      uiBlocks: [{ type: 'greeting' }],
    }),
    false,
  );
});

test('ensureSessionGreeting persists a greeting in an empty session', async () => {
  const repo = createMockRepository();
  const { ensureSessionGreeting, resetGreetingDedupeForTests } = loadGreeting(repo);
  resetGreetingDedupeForTests();

  const result = await ensureSessionGreeting('actor-1', 'session-1', 'Hi, I’m Elise.');

  assert.ok(result.message);
  assert.equal(result.inserted, true);
  assert.equal(result.message.content, 'Hi, I’m Elise.');
  assert.equal(result.message.sender, 'assistant');
  assert.deepEqual(result.message.uiBlocks, [{ type: 'greeting' }]);
  assert.equal(result.message.provider, 'greeting');
  assert.equal(repo._messages().length, 1);
});

test('ensureSessionGreeting returns an existing greeting without inserting a duplicate', async () => {
  const repo = createMockRepository();
  const { ensureSessionGreeting, resetGreetingDedupeForTests } = loadGreeting(repo);
  resetGreetingDedupeForTests();

  const first = await ensureSessionGreeting('actor-1', 'session-1', 'Hi, I’m Elise.');
  const second = await ensureSessionGreeting('actor-1', 'session-1', 'Different text.');

  assert.equal(second.message.id, first.message.id);
  assert.equal(second.inserted, false);
  assert.equal(repo._messages().length, 1);
});

test('ensureSessionGreeting does not seed a pre-existing session that lacks a greeting marker', async () => {
  const repo = createMockRepository([
    {
      id: 'existing',
      sessionId: 'session-1',
      sender: 'user',
      content: 'Hello',
      uiBlocks: [],
      provider: 'client',
      tokenEstimate: 0,
      createdAt: new Date().toISOString(),
      referencedScanIds: [],
      referencedSavedItemIds: [],
      referencedDressingRoomIds: [],
      referencedCatalogItems: [],
    },
  ]);
  const { ensureSessionGreeting, resetGreetingDedupeForTests } = loadGreeting(repo);
  resetGreetingDedupeForTests();

  const result = await ensureSessionGreeting('actor-1', 'session-1', 'Hi, I’m Elise.');

  assert.equal(result.message, null);
  assert.equal(result.inserted, false);
  assert.equal(repo._messages().length, 1);
});

test('ensureSessionGreeting deduplicates concurrent calls', async () => {
  const repo = createMockRepository();
  const { ensureSessionGreeting, resetGreetingDedupeForTests } = loadGreeting(repo);
  resetGreetingDedupeForTests();

  const [a, b] = await Promise.all([
    ensureSessionGreeting('actor-1', 'session-1', 'Hi, I’m Elise.'),
    ensureSessionGreeting('actor-1', 'session-1', 'Hi, I’m Elise.'),
  ]);

  assert.equal(a.message.id, b.message.id);
  assert.equal(repo._messages().length, 1);
});

test('markSessionGreeted and isSessionGreeted track process-scoped greeting completion', () => {
  const { markSessionGreeted, isSessionGreeted, resetGreetingDedupeForTests } =
    loadGreeting(createMockRepository());
  resetGreetingDedupeForTests();

  assert.equal(isSessionGreeted('actor-a', 'session-a'), false);
  markSessionGreeted('actor-a', 'session-a');
  assert.equal(isSessionGreeted('actor-a', 'session-a'), true);
  assert.equal(isSessionGreeted('actor-a', 'session-b'), false);
  assert.equal(isSessionGreeted('actor-b', 'session-a'), false);
});

test('greeting insertion lock releases after a repository failure', async () => {
  const repo = createMockRepository();
  const originalList = repo.listStyleChatMessages;
  let attempts = 0;
  repo.listStyleChatMessages = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    return originalList();
  };
  const { ensureSessionGreeting, resetGreetingDedupeForTests } = loadGreeting(repo);
  resetGreetingDedupeForTests();

  await assert.rejects(
    ensureSessionGreeting('actor-1', 'session-1', 'Hi, I’m Elise.'),
    /offline/,
  );
  const retry = await ensureSessionGreeting('actor-1', 'session-1', 'Hi, I’m Elise.');

  assert.equal(retry.inserted, true);
  assert.equal(repo._messages().length, 1);
});

test('bounded greeting wait lets the first user message path continue on timeout', async () => {
  const { waitForSessionGreeting } = loadGreeting(createMockRepository());
  const result = await waitForSessionGreeting(new Promise(() => {}), 5);
  assert.equal(result, null);
});

test('two legacy greeting rows are reused without inserting a third', async () => {
  const greeting = (id) => ({
    id,
    sessionId: 'session-1',
    sender: 'assistant',
    content: 'Hello',
    uiBlocks: [{ type: 'greeting' }],
    provider: 'greeting',
    tokenEstimate: 0,
    createdAt: new Date().toISOString(),
    referencedScanIds: [],
    referencedSavedItemIds: [],
    referencedDressingRoomIds: [],
    referencedCatalogItems: [],
  });
  const repo = createMockRepository([greeting('legacy-1'), greeting('legacy-2')]);
  const { ensureSessionGreeting, resetGreetingDedupeForTests } = loadGreeting(repo);
  resetGreetingDedupeForTests();

  const result = await ensureSessionGreeting('actor-1', 'session-1', 'Different text');

  assert.equal(result.message.id, 'legacy-1');
  assert.equal(result.inserted, false);
  assert.equal(repo._messages().length, 2);
});

test('malformed uiBlocks never masquerade as a greeting', () => {
  const { isGreetingMessage } = loadGreeting(createMockRepository());
  for (const uiBlocks of [null, {}, 'greeting', [null, 'greeting', 1]]) {
    assert.equal(isGreetingMessage({ sender: 'assistant', uiBlocks }), false);
  }
});

test('a process restart reuses the persisted greeting without replay eligibility', async () => {
  const repo = createMockRepository();
  const firstModule = loadGreeting(repo);
  firstModule.resetGreetingDedupeForTests();
  const first = await firstModule.ensureSessionGreeting(
    'actor-1',
    'session-1',
    'Hi, I’m Elise.',
  );

  const restartedModule = loadGreeting(repo);
  restartedModule.resetGreetingDedupeForTests();
  const reopened = await restartedModule.ensureSessionGreeting(
    'actor-1',
    'session-1',
    'Different greeting',
  );

  assert.equal(first.inserted, true);
  assert.equal(reopened.inserted, false);
  assert.equal(reopened.message.id, first.message.id);
  assert.equal(repo._messages().length, 1);
});

test('useStyleChat keeps the draft until the send is known to have succeeded', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  const screen = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'), 'utf8');
  assert.match(source, /waitForSessionGreeting/);
  assert.match(source, /onUserMessagePersisted\?\.\(\)/);
  // The composer draft is only cleared after sendMessage's returned promise
  // resolves true (a fully successful send) — never optimistically, and
  // never merely on persistence, so a downstream failure (burst limit,
  // operational error) leaves the user's text intact for retry.
  //
  // The PROPERTY is what this pins, not the exact expression. The follow-up
  // loop routes the composer and its chips through one `submitMessage`, so the
  // clear now sits behind the caller's `clearComposer` intent as well — a chip
  // must not wipe text the user typed — but it still happens only after `sent`.
  assert.match(
    screen,
    /if \(!sent\) return;\s*\n\s*if \(clearComposer\) setComposerText\(''\);/,
  );
  assert.match(screen, /if \(!sentWithVisual\) return;/);
  assert.doesNotMatch(screen, /void sendMessage\(text\);\s*setComposerText\(''\)/);
});

test('actor and session switches invalidate loading, greeting, and send state', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  assert.match(source, /getStyleChatSession\(sessionId, actorId\)/);
  assert.match(source, /listStyleChatMessages\(sessionId, actorId\)/);
  assert.match(source, /sendScopeVersionRef/);
  assert.match(source, /\}, \[actorId, sessionId\]\);/);
  assert.match(source, /ensureSessionGreeting\(actorId, sessionId, greetingText\)/);
});
