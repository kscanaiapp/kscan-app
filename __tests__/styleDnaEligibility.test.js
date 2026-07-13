const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

const mod = { exports: {} };
const sandbox = { console, exports: mod.exports, module: mod, require: () => { throw new Error('Unexpected require'); } };
vm.runInNewContext(transpile('services/style-dna/styleDnaEligibility.ts'), sandbox, { filename: 'services/style-dna/styleDnaEligibility.ts' });
const { isEligibleForStyleFeedback } = mod.exports;

function makeMessage(overrides = {}) {
  return {
    id: 'msg-uuid-1',
    sessionId: 'session-1',
    sender: 'assistant',
    content: 'Try this outfit with the camel coat and black boots.',
    referencedScanIds: [],
    referencedSavedItemIds: [],
    referencedDressingRoomIds: [],
    referencedCatalogItems: [],
    uiBlocks: [{ type: 'why_this_works', body: 'The proportion balances the silhouette.' }],
    provider: 'gemini',
    tokenEstimate: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const USER_KEY = 'user:abc';

test('assistant recommendation with structured explanation metadata is eligible', () => {
  assert.equal(isEligibleForStyleFeedback({ message: makeMessage(), userKey: USER_KEY }), true);
});

test('user messages are ineligible', () => {
  assert.equal(
    isEligibleForStyleFeedback({ message: makeMessage({ sender: 'user' }), userKey: USER_KEY }),
    false,
  );
});

test('error bubbles are ineligible', () => {
  assert.equal(
    isEligibleForStyleFeedback({ message: makeMessage(), userKey: USER_KEY, isError: true }),
    false,
  );
});

test('messages without userKey are ineligible', () => {
  assert.equal(isEligibleForStyleFeedback({ message: makeMessage(), userKey: null }), false);
});

test('empty content is ineligible', () => {
  assert.equal(
    isEligibleForStyleFeedback({ message: makeMessage({ content: '   ' }), userKey: USER_KEY }),
    false,
  );
});

test('optimistic assistant ids are ineligible', () => {
  assert.equal(
    isEligibleForStyleFeedback({
      message: makeMessage({ id: `optimistic-assistant-${Date.now()}` }),
      userKey: USER_KEY,
    }),
    false,
  );
});

test('system messages are ineligible', () => {
  assert.equal(
    isEligibleForStyleFeedback({ message: makeMessage({ sender: 'system' }), userKey: USER_KEY }),
    false,
  );
});

test('general chat and greetings without recommendation metadata are ineligible', () => {
  assert.equal(
    isEligibleForStyleFeedback({
      message: makeMessage({ content: 'Hi! How can I help?', uiBlocks: [] }),
      userKey: USER_KEY,
    }),
    false,
  );
});

test('weather-only assistant responses are ineligible', () => {
  assert.equal(
    isEligibleForStyleFeedback({
      message: makeMessage({ content: 'It is 72 degrees and sunny.', uiBlocks: [] }),
      userKey: USER_KEY,
    }),
    false,
  );
});

test('style tips and preview blocks alone are not recommendation metadata', () => {
  assert.equal(
    isEligibleForStyleFeedback({
      message: makeMessage({ uiBlocks: [{ type: 'style_tip', body: 'Try layers.' }] }),
      userKey: USER_KEY,
    }),
    false,
  );
});

test('validated recommendation actions are eligible without an explanation', () => {
  assert.equal(
    isEligibleForStyleFeedback({
      message: makeMessage({
        uiBlocks: [{ type: 'stylechat_actions', actions: [{ type: 'open_stylist' }] }],
      }),
      userKey: USER_KEY,
    }),
    true,
  );
});

test('persisted item references are structured recommendation metadata', () => {
  assert.equal(
    isEligibleForStyleFeedback({
      message: makeMessage({ uiBlocks: [], referencedSavedItemIds: ['saved-1'] }),
      userKey: USER_KEY,
    }),
    true,
  );
});

test('empty recommendation blocks are ineligible', () => {
  assert.equal(
    isEligibleForStyleFeedback({
      message: makeMessage({ uiBlocks: [{ type: 'why_this_works', body: '   ' }] }),
      userKey: USER_KEY,
    }),
    false,
  );
  assert.equal(
    isEligibleForStyleFeedback({
      message: makeMessage({ uiBlocks: [{ type: 'stylechat_actions', actions: [] }] }),
      userKey: USER_KEY,
    }),
    false,
  );
});

test('synthetic fallback assistant messages are ineligible', () => {
  assert.equal(
    isEligibleForStyleFeedback({
      message: makeMessage({ provider: 'fallback', model: 'fallback' }),
      userKey: USER_KEY,
    }),
    false,
  );
});
