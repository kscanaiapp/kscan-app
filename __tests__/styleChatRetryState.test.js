const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadRetryState() {
  const filename = path.join(ROOT, 'services/style-chat/styleChatRetryState.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module }, { filename });
  return module.exports.createStyleChatRetryState;
}

test('attachment rejection retry preserves the exact immutable send and consumes it once', () => {
  const retryState = loadRetryState()();
  const attachments = Object.freeze({ references: Object.freeze([{ sourceId: 'owned-1' }]) });

  retryState.remember({ content: 'Style this jacket', userMessageId: null, attachments });

  const retry = retryState.consume();
  assert.equal(retry.content, 'Style this jacket');
  assert.equal(retry.userMessageId, null);
  assert.equal(retry.attachments, attachments);
  assert.equal(retryState.consume(), null);
});
