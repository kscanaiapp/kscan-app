// StyleChat retry must not persist a second copy of an already-stored turn.
//
// retryLastMessage() removed the last user message from local state and called
// sendMessage() again. sendMessage() always inserted a user row, so retrying a
// turn that had already been saved (the common case: the message persisted,
// then the model call failed) left two identical user messages in the
// conversation, visible on every reload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * Render useStyleChat once inside a VM with stubbed React hooks and repository.
 *
 * @param {object} opts
 * @param {Array} opts.initialMessages - seeds the `messages` state slot
 * @param {object} opts.generateReplyResult - what the edge provider returns
 */
function renderUseStyleChat({ initialMessages, generateReplyResult }) {
  const filename = path.join(ROOT, 'hooks', 'useStyleChat.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const savedMessages = [];
  const generateReplyCalls = [];
  let savedCounter = 0;

  // useState slot order in the hook:
  // 0 session | 1 messages | 2 loadingSession | 3 loadingMessages
  // 4 isSending | 5 error | 6 messagesUsed | 7 messagesLimit
  const slots = [];
  let slotIndex = 0;
  slots[1] = { value: initialMessages };

  const react = {
    useState: (initialValue) => {
      const index = slotIndex;
      slotIndex += 1;
      if (!slots[index]) slots[index] = { value: initialValue };
      const slot = slots[index];
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next;
        },
      ];
    },
    useCallback: (callback) => callback,
    useEffect: () => {},
  };

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    Date,
    Math,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    Number,
    Promise,
    Error,
    require: (id) => {
      if (id === 'react') return react;
      if (id === '../services/style-chat/providers/edgeStyleChatProvider') {
        return {
          EdgeStyleChatProvider: class {
            async generateReply(input) {
              generateReplyCalls.push(input);
              return generateReplyResult;
            }
          },
        };
      }
      if (id === '../services/style-chat/styleChatRepository') {
        return {
          getStyleChatSession: async () => null,
          listStyleChatMessages: async () => [],
          readStyleChatDailyUsage: async () => ({ messagesUsed: 0, messagesLimit: 25 }),
          saveStyleChatMessage: async (payload) => {
            savedMessages.push(payload);
            savedCounter += 1;
            return {
              ...payload,
              id: `saved-${savedCounter}`,
              createdAt: new Date().toISOString(),
            };
          },
        };
      }
      if (id === '../constants/styleChat') {
        return {
          STYLE_CHAT_DAILY_MESSAGE_LIMIT: 25,
          STYLE_CHAT_COPY: {
            systemLimitNotice: 'limit',
            burstLimitNotice: 'burst',
            errorGeneric: 'error',
          },
        };
      }
      throw new Error(`Unexpected require: ${id}`);
    },
  };

  vm.runInNewContext(output, sandbox, { filename });

  const hook = mod.exports.useStyleChat('session-1');
  return { hook, savedMessages, generateReplyCalls, readMessages: () => slots[1].value };
}

const SUCCESS_REPLY = {
  status: 'success',
  message: { sender: 'assistant', content: 'Try it with a slim trouser.', model: 'gemini', tokenEstimate: 12 },
  usage: { messagesUsed: 3, messagesLimit: 25 },
};

function persistedUserMessage() {
  return {
    id: 'msg-already-stored',
    sessionId: 'session-1',
    sender: 'user',
    content: 'What goes with this jacket?',
    referencedScanIds: [],
    referencedSavedItemIds: [],
    referencedDressingRoomIds: [],
    referencedCatalogItems: [],
    uiBlocks: [],
    provider: 'client',
    tokenEstimate: 0,
    createdAt: '2026-09-18T00:00:00.000Z',
  };
}

test('retrying an already-stored turn does not insert a second user message', async () => {
  const { hook, savedMessages } = renderUseStyleChat({
    initialMessages: [persistedUserMessage()],
    generateReplyResult: SUCCESS_REPLY,
  });

  hook.retryLastMessage();
  await new Promise((resolve) => setImmediate(resolve));

  const savedUserRows = savedMessages.filter((m) => m.sender === 'user');
  assert.equal(
    savedUserRows.length,
    0,
    'the stored row must be reused, not duplicated',
  );

  const savedAssistantRows = savedMessages.filter((m) => m.sender === 'assistant');
  assert.equal(savedAssistantRows.length, 1, 'the retry must still produce a reply');
});

test('the retried turn is still sent to the model with its original content', async () => {
  const { hook, generateReplyCalls } = renderUseStyleChat({
    initialMessages: [persistedUserMessage()],
    generateReplyResult: SUCCESS_REPLY,
  });

  hook.retryLastMessage();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(generateReplyCalls.length, 1, 'skipping the insert must not skip the model call');
  assert.equal(generateReplyCalls[0].sessionId, 'session-1');
  assert.equal(generateReplyCalls[0].message, 'What goes with this jacket?');
});

test('retrying a turn that was never stored does persist it', async () => {
  const neverStored = {
    ...persistedUserMessage(),
    id: 'optimistic-user-1758153600000',
  };

  const { hook, savedMessages } = renderUseStyleChat({
    initialMessages: [neverStored],
    generateReplyResult: SUCCESS_REPLY,
  });

  hook.retryLastMessage();
  await new Promise((resolve) => setImmediate(resolve));

  const savedUserRows = savedMessages.filter((m) => m.sender === 'user');
  assert.equal(
    savedUserRows.length,
    1,
    'an optimistic id means the message was never stored, so the retry must store it',
  );
  assert.equal(savedUserRows[0].content, 'What goes with this jacket?');
});

test('a first-time send still persists the user message', async () => {
  const { hook, savedMessages } = renderUseStyleChat({
    initialMessages: [],
    generateReplyResult: SUCCESS_REPLY,
  });

  await hook.sendMessage('Style this for a dinner.');

  const savedUserRows = savedMessages.filter((m) => m.sender === 'user');
  assert.equal(savedUserRows.length, 1);
  assert.equal(savedUserRows[0].content, 'Style this for a dinner.');
});

test('retryLastMessage is a no-op when there is no user message', async () => {
  const { hook, savedMessages } = renderUseStyleChat({
    initialMessages: [],
    generateReplyResult: SUCCESS_REPLY,
  });

  hook.retryLastMessage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(savedMessages.length, 0);
});
