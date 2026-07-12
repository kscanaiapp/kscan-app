const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadShareGuard() {
  const filename = path.join(ROOT, 'components/looks/askMyRoomShareGuard.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module }, { filename });
  return module.exports.createAskMyRoomShareGuard;
}

test('room share guard blocks rapid taps and retains success lock until reset', () => {
  const guard = loadShareGuard()();

  assert.equal(guard.tryBegin(), true);
  assert.equal(guard.tryBegin(), false);
  guard.reset();
  assert.equal(guard.tryBegin(), true);
});

test('failed share retry reuses a room created by the same title', () => {
  const guard = loadShareGuard()();

  assert.equal(guard.tryBegin(), true);
  guard.rememberCreatedRoom('Audit Room', 'room-1');
  guard.releaseForRetry();

  assert.equal(guard.tryBegin(), true);
  assert.equal(guard.getCreatedRoomId('Audit Room'), 'room-1');
  assert.equal(guard.getCreatedRoomId('Renamed Room'), null);
});
