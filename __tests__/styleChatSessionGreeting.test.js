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
  assert.equal(getGreetingTextForUser(user, identity), 'Hi, Kathleen. I am Elise. How can I help style you today?');
});

test('getGreetingTextForUser falls back when first name is missing', () => {
  const { getGreetingTextForUser } = loadGreeting(createMockRepository());
  const identity = { displayName: 'Ava', avatarId: 'elise_default' };
  assert.equal(getGreetingTextForUser(null, identity), 'Hi, I’m Ava. How can I style you today?');
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

  const result = await ensureSessionGreeting('session-1', 'Hi, I’m Elise.');

  assert.ok(result);
  assert.equal(result.content, 'Hi, I’m Elise.');
  assert.equal(result.sender, 'assistant');
  assert.deepEqual(result.uiBlocks, [{ type: 'greeting' }]);
  assert.equal(result.provider, 'greeting');
  assert.equal(repo._messages().length, 1);
});

test('ensureSessionGreeting returns an existing greeting without inserting a duplicate', async () => {
  const repo = createMockRepository();
  const { ensureSessionGreeting, resetGreetingDedupeForTests } = loadGreeting(repo);
  resetGreetingDedupeForTests();

  const first = await ensureSessionGreeting('session-1', 'Hi, I’m Elise.');
  const second = await ensureSessionGreeting('session-1', 'Different text.');

  assert.equal(second.id, first.id);
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

  const result = await ensureSessionGreeting('session-1', 'Hi, I’m Elise.');

  assert.equal(result, null);
  assert.equal(repo._messages().length, 1);
});

test('ensureSessionGreeting deduplicates concurrent calls', async () => {
  const repo = createMockRepository();
  const { ensureSessionGreeting, resetGreetingDedupeForTests } = loadGreeting(repo);
  resetGreetingDedupeForTests();

  const [a, b] = await Promise.all([
    ensureSessionGreeting('session-1', 'Hi, I’m Elise.'),
    ensureSessionGreeting('session-1', 'Hi, I’m Elise.'),
  ]);

  assert.equal(a.id, b.id);
  assert.equal(repo._messages().length, 1);
});

test('markSessionGreeted and isSessionGreeted track process-scoped greeting completion', () => {
  const { markSessionGreeted, isSessionGreeted, resetGreetingDedupeForTests } =
    loadGreeting(createMockRepository());
  resetGreetingDedupeForTests();

  assert.equal(isSessionGreeted('session-a'), false);
  markSessionGreeted('session-a');
  assert.equal(isSessionGreeted('session-a'), true);
  assert.equal(isSessionGreeted('session-b'), false);
});
