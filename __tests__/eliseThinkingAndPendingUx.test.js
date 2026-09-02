// Elise "thinking" escalation and optimistic-send affordance (UX addendum 4, 5).
//
// Both exist to stop the UI from claiming something it has not delivered:
//   - a turn that has run long stops repeating the optimistic first line;
//   - a user bubble that the server has not acknowledged does not look
//     identical to one that it has.
//
// The pure decision functions are executed here, so the contract holds without
// mounting a renderer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsxModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
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
      Object,
      Array,
      String,
      Number,
      Boolean,
      Math,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

/** React Native / React are never invoked: only the pure exports are called. */
const RN_STUB = {
  Animated: { Value: class {}, View: 'Animated.View', timing: () => ({}), loop: () => ({}) },
  Easing: { linear: null },
  StyleSheet: { create: (styles) => styles, flatten: (s) => s },
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  TouchableOpacity: 'TouchableOpacity',
};

const REACT_STUB = {
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  createElement: () => null,
  default: {},
};

const indicator = loadTsxModule('components/style-chat/StyleChatThinkingIndicator.tsx', {
  react: REACT_STUB,
  'react-native': RN_STUB,
  '../../constants/theme': {
    LUXURY: { colors: {}, typography: { bodyStrong: {}, caption: {} } },
    RADIUS: {},
    SPACING: {},
  },
  '../../constants/elise': require('./helpers/eliseLoadingCopy'),
  '../../hooks/useReducedMotion': { useReducedMotion: () => true },
});

test('the thinking state stays optimistic below the escalation threshold', () => {
  assert.equal(indicator.resolveThinkingPhase(0), 'thinking');
  assert.equal(
    indicator.resolveThinkingPhase(indicator.ELISE_THINKING_ESCALATION_MS - 1),
    'thinking',
  );
});

test('a long turn escalates to honest copy rather than repeating the first line', () => {
  assert.equal(
    indicator.resolveThinkingPhase(indicator.ELISE_THINKING_ESCALATION_MS),
    'taking_longer',
  );
  assert.equal(indicator.resolveThinkingPhase(30_000), 'taking_longer');

  const quick = indicator.thinkingCopyForPhase('thinking');
  const slow = indicator.thinkingCopyForPhase('taking_longer');

  assert.notEqual(slow.title, quick.title, 'the escalated state must actually read differently');
  assert.ok(slow.title.trim().length > 0);
  assert.ok(slow.subtitle.trim().length > 0);

  // It must manage expectations, never report a failure: nothing has gone wrong.
  const failureWords = /error|failed|failure|unavailable|problem|wrong|sorry/i;
  assert.equal(
    failureWords.test(`${slow.title} ${slow.subtitle}`),
    false,
    'a slow turn is not an error and must not be worded as one',
  );
});

test('the escalation threshold is the 5 seconds the contract asks for', () => {
  assert.equal(indicator.ELISE_THINKING_ESCALATION_MS, 5_000);
});

// ── Optimistic send affordance ────────────────────────────────────────────────

const bubble = loadTsxModule('services/style-chat/styleChatMessageState.ts');

function userMessage(id) {
  return { id, sender: 'user', content: 'Style this for me.', uiBlocks: [], sessionId: 's' };
}

test('an unacknowledged user bubble is marked pending', () => {
  assert.equal(bubble.isPendingUserMessage(userMessage('optimistic-user-1725000000000')), true);
});

test('a server-acknowledged user bubble is not marked pending', () => {
  assert.equal(
    bubble.isPendingUserMessage(userMessage('7f1c4c2a-0000-4000-8000-000000000001')),
    false,
  );
});

test('an assistant bubble is never marked as a pending user send', () => {
  assert.equal(
    bubble.isPendingUserMessage({
      id: 'optimistic-assistant-1725000000000',
      sender: 'assistant',
      content: 'Try the navy blazer.',
      uiBlocks: [],
      sessionId: 's',
    }),
    false,
  );
});
