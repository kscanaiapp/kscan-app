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
function run(rel, env = {}) {
  const module = { exports: {} };
  const sandbox = { console, process: { env }, exports: module.exports, module,
    require: (id) => { throw new Error('Unexpected require: ' + id); } };
  vm.runInNewContext(transpile(rel), sandbox, { filename: rel });
  return module.exports;
}
const REL = 'services/style-dna/styleDnaContext.ts';

test('flag disabled by default: env unset omits context (module flag)', () => {
  const m = run(REL, {}); // EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED unset
  assert.equal(m.STYLE_DNA_CONTEXT_ENABLED, false);
  const ctx = m.buildStyleDnaContext({ helpfulCount: 5, notMyStyleCount: 3, totalSignals: 8 });
  assert.equal(ctx, null);
});

test('explicit enabled:false omits context even with plenty of signal', () => {
  const m = run(REL, {});
  assert.equal(m.buildStyleDnaContext({ helpfulCount: 9, notMyStyleCount: 0, totalSignals: 9 }, { enabled: false }), null);
});

test('omitted below 3 signals (null, not empty object)', () => {
  const m = run(REL, {});
  for (const n of [0, 1, 2]) {
    const ctx = m.buildStyleDnaContext({ helpfulCount: n, notMyStyleCount: 0, totalSignals: n }, { enabled: true });
    assert.equal(ctx, null, `expected null at ${n} signals`);
  }
});

test('present at exactly 3 signals with low confidence', () => {
  const m = run(REL, {});
  const ctx = m.buildStyleDnaContext({ helpfulCount: 2, notMyStyleCount: 1, totalSignals: 3 }, { enabled: true });
  // Field-wise (the module runs in a separate vm realm, so its objects have a
  // foreign prototype that trips deepStrictEqual's cross-realm reference check).
  assert.equal(ctx.enabled, true);
  assert.equal(ctx.signalCount, 3);
  assert.equal(ctx.helpfulCount, 2);
  assert.equal(ctx.notMyStyleCount, 1);
  assert.equal(ctx.confidence, 'low');
});

test('confidence low for 3–5 signals', () => {
  const m = run(REL, {});
  for (const n of [3, 4, 5]) {
    const ctx = m.buildStyleDnaContext({ helpfulCount: n, notMyStyleCount: 0, totalSignals: n }, { enabled: true });
    assert.equal(ctx.confidence, 'low', `expected low at ${n}`);
  }
});

test('confidence medium for 6+ signals', () => {
  const m = run(REL, {});
  for (const n of [6, 7, 20]) {
    const ctx = m.buildStyleDnaContext({ helpfulCount: n, notMyStyleCount: 0, totalSignals: n }, { enabled: true });
    assert.equal(ctx.confidence, 'medium', `expected medium at ${n}`);
  }
});

test('env "true" enables the module flag', () => {
  const m = run(REL, { EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED: 'true' });
  assert.equal(m.STYLE_DNA_CONTEXT_ENABLED, true);
  const ctx = m.buildStyleDnaContext({ helpfulCount: 4, notMyStyleCount: 2, totalSignals: 6 });
  assert.equal(ctx.confidence, 'medium');
});

test('context is data-only: no prose/text keys, only the 5 declared fields', () => {
  const m = run(REL, {});
  const ctx = m.buildStyleDnaContext({ helpfulCount: 3, notMyStyleCount: 1, totalSignals: 4 }, { enabled: true });
  assert.deepEqual(Object.keys(ctx).sort(), ['confidence', 'enabled', 'helpfulCount', 'notMyStyleCount', 'signalCount']);
  assert.equal(JSON.stringify(ctx).includes('message'), false);
});

test('junk counts are floored to safe integers', () => {
  const m = run(REL, {});
  const ctx = m.buildStyleDnaContext({ helpfulCount: NaN, notMyStyleCount: -4, totalSignals: 3.9 }, { enabled: true });
  assert.equal(ctx.signalCount, 3);
  assert.equal(ctx.helpfulCount, 0);
  assert.equal(ctx.notMyStyleCount, 0);
});
