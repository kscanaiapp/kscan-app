const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
function run(rel, requireMap = {}) {
  const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, { console, exports: module.exports, module,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Map, Set,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require in ${rel}: ${id}`);
    } }, { filename: rel });
  return module.exports;
}
// Build 34 / Track B / Phase B5 added a real (pure, Deno/network-free)
// dependency on promptHardening.ts for buildServerStyleDnaProfileBlock; this
// pre-existing harness predates that and needs the real module wired in, not
// a stub, since these tests exercise no server-derived-profile behavior that
// would need faking.
const promptHardening = run('supabase/functions/stylechat-generate/promptHardening.ts');
const m = run('supabase/functions/stylechat-generate/styleDnaContext.ts', {
  './promptHardening.ts': promptHardening,
});

test('old request (missing styleDnaContext) is a no-op', () => {
  assert.equal(m.parseStyleDnaContext(undefined), null);
  assert.equal(m.parseStyleDnaContext(null), null);
});

test('malformed styleDnaContext is ignored (never throws)', () => {
  assert.equal(m.parseStyleDnaContext('nope'), null);
  assert.equal(m.parseStyleDnaContext(42), null);
  assert.equal(m.parseStyleDnaContext([]), null);
  assert.equal(m.parseStyleDnaContext({}), null);
  assert.equal(m.parseStyleDnaContext({ enabled: false, signalCount: 9, confidence: 'medium' }), null);
});

test('below-threshold context is ignored server-side even if client sent it', () => {
  assert.equal(m.parseStyleDnaContext({ enabled: true, signalCount: 2, confidence: 'low' }), null);
});

test('missing/invalid confidence is ignored', () => {
  assert.equal(m.parseStyleDnaContext({ enabled: true, signalCount: 5 }), null);
  assert.equal(m.parseStyleDnaContext({ enabled: true, signalCount: 5, confidence: 'high' }), null);
});

test('valid low context (3-5) parses', () => {
  const c = m.parseStyleDnaContext({ enabled: true, signalCount: 4, helpfulCount: 3, notMyStyleCount: 1, confidence: 'low' });
  assert.equal(c.signalCount, 4);
  assert.equal(c.confidence, 'low');
});

test('valid medium context (6+) parses', () => {
  const c = m.parseStyleDnaContext({ enabled: true, signalCount: 7, helpfulCount: 5, notMyStyleCount: 2, confidence: 'medium' });
  assert.equal(c.confidence, 'medium');
});

test('guidance block wording differs by confidence and is clearly delimited', () => {
  const low = m.buildStyleDnaContextBlock({ signalCount: 3, helpfulCount: 2, notMyStyleCount: 1, confidence: 'low' });
  const med = m.buildStyleDnaContextBlock({ signalCount: 8, helpfulCount: 6, notMyStyleCount: 2, confidence: 'medium' });
  assert.ok(low.startsWith('[Optional Signature Style Context]'));
  assert.ok(low.includes('[/Optional Signature Style Context]'));
  assert.ok(low.includes('small number'));
  assert.ok(med.includes('several'));
  // no raw counts leaked into the prompt text
  assert.equal(/\b\d+\b/.test(low), false);
  assert.equal(/\b\d+\b/.test(med), false);
});
