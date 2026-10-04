const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

function load() {
  const filename = path.join(__dirname, '..', 'services', 'latestIntentMutationQueue.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { module: mod, exports: mod.exports, Map, Promise }, { filename });
  return mod.exports;
}
const { createLatestIntentQueue } = load();

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('rapid same-key intents collapse to the in-flight call plus the latest trailing intent', async () => {
  const queue = createLatestIntentQueue();
  const gate = deferred();
  const calls = [];
  queue.submit('item', 'love', async (payload, isSuperseded) => {
    calls.push(['start', payload, isSuperseded()]);
    await gate.promise;
    calls.push(['end', payload, isSuperseded()]);
  });
  queue.submit('item', 'like', async (payload) => calls.push(['stale', payload]));
  queue.submit('item', 'looking', async (payload) => calls.push(['trailing', payload]));
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['start','love',false], ['end','love',true], ['trailing','looking'],
  ]);
});

test('different keys drain independently', async () => {
  const queue = createLatestIntentQueue();
  const gate = deferred();
  const seen = [];
  queue.submit('a', 1, async () => { await gate.promise; seen.push('a'); });
  queue.submit('b', 2, async () => { seen.push('b'); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), ['b']);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), ['b','a']);
});

test('a failed runner does not wedge later intent', async () => {
  const queue = createLatestIntentQueue();
  queue.submit('item', 1, async () => { throw new Error('network'); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let ran = false;
  queue.submit('item', 2, async () => { ran = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ran, true);
});
