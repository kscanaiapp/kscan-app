// Track B regression: malformed persisted Signature Style must not reach Elise.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(rel, requireMap = {}) {
  const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, {
    console, exports: module.exports, module, Date, Math, Number, Object, Array, JSON, String, Boolean,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require in ${rel}: ${id}`);
    },
  }, { filename: rel });
  return module.exports;
}

const types = loadTsModule('supabase/functions/_shared/signatureStyle/signatureStyleProfileTypes.ts');
const promptHardening = loadTsModule('supabase/functions/stylechat-generate/promptHardening.ts');
const signatureStyleContext = loadTsModule('supabase/functions/stylechat-generate/signatureStyleContext.ts', {
  './promptHardening.ts': promptHardening,
  '../_shared/signatureStyle/signatureStyleProfileTypes.ts': types,
});

function validProfile(overrides = {}) {
  return {
    evidenceCount: 3,
    colorFrequency: [{ value: 'black', count: 3 }],
    categoryFrequency: [{ value: 'outerwear', count: 2 }],
    garmentTypeFrequency: [{ value: 'jacket', count: 2 }],
    brandFrequency: [{ value: 'Acme', count: 1 }],
    materialFrequency: [{ value: 'nylon', count: 1 }],
    ...overrides,
  };
}

test('malformed stored profiles are rejected and cannot throw from the prompt builder', () => {
  for (const malformed of [
    { evidenceCount: 9999 }, validProfile({ colorFrequency: 'black' }),
    validProfile({ materialFrequency: [null] }), validProfile({ evidenceCount: -1 }), [], null,
  ]) {
    assert.equal(types.isSignatureStyleProfileDataV1(malformed), false);
    assert.doesNotThrow(() => signatureStyleContext.buildServerSignatureStyleProfileBlock(malformed));
    assert.equal(signatureStyleContext.buildServerSignatureStyleProfileBlock(malformed), null);
  }
});

test('a well-formed derived profile remains advisory prompt context', () => {
  assert.equal(types.isSignatureStyleProfileDataV1(validProfile()), true);
  const block = signatureStyleContext.buildServerSignatureStyleProfileBlock(validProfile());
  assert.match(block, /Signature Style/);
  assert.match(block, /Frequent colors: "black"/);
});

test('the call site builds a safe block before it can reach prompt assembly', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/stylechat-generate/index.ts'), 'utf8');
  assert.match(source, /buildServerSignatureStyleProfileBlock/);
  assert.doesNotMatch(source, /\.profileData\.evidenceCount\s*>\s*0/);
});
