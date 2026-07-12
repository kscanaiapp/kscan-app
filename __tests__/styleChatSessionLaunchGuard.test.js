const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadGuard() {
  const filename = path.join(ROOT, 'services/style-chat/sessionLaunchGuard.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module }, { filename });
  return module.exports.createStyleChatSessionLaunchGuard;
}

test('guard blocks every rapid retry until navigation leaves the session list', () => {
  const guard = loadGuard()();

  assert.equal(guard.tryBegin(), true);
  guard.rememberSession('session-1');
  assert.equal(guard.tryBegin(), false);
  assert.equal(guard.tryBegin(), false);
  assert.equal(guard.getPendingSessionId(), 'session-1');
});

test('navigation failure retries the remembered session without creating another', () => {
  const guard = loadGuard()();

  assert.equal(guard.tryBegin(), true);
  guard.rememberSession('session-1');
  guard.releaseForRetry();

  assert.equal(guard.tryBegin(), true);
  assert.equal(guard.getPendingSessionId(), 'session-1');
});

test('returning focus clears the completed navigation guard for a new session', () => {
  const guard = loadGuard()();

  assert.equal(guard.tryBegin(), true);
  guard.rememberSession('session-1');
  guard.resetOnFocus();

  assert.equal(guard.getPendingSessionId(), null);
  assert.equal(guard.tryBegin(), true);
});
