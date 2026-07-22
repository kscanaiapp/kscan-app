const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const EDGE = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/stylechat-generate/index.ts'),
  'utf8',
);
const ROUTING = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/stylechat-generate/modelRouting.ts'),
  'utf8',
);
const SIG = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/stylechat-generate/signatureStyleContext.ts'),
  'utf8',
);

function loadTs(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(
    output,
    { exports: mod.exports, module: mod, require: () => { throw new Error('no require'); } },
    { filename },
  );
  return mod.exports;
}

const routing = loadTs('supabase/functions/stylechat-generate/modelRouting.ts');
const signature = loadTs('supabase/functions/stylechat-generate/signatureStyleContext.ts');

test('elise routing: primary defaults to gemini-3.6-flash', () => {
  const models = routing.resolveEliseModels(() => undefined);
  assert.equal(models.primaryModel, 'gemini-3.6-flash');
  assert.equal(models.fallbackModel, 'gemini-3.5-flash-lite');
});

test('elise routing: empty/whitespace env uses defaults', () => {
  const env = {
    STYLECHAT_GEMINI_MODEL: '  ',
    STYLECHAT_GEMINI_FALLBACK_MODEL: '',
  };
  const models = routing.resolveEliseModels((k) => env[k]);
  assert.equal(models.primaryModel, 'gemini-3.6-flash');
  assert.equal(models.fallbackModel, 'gemini-3.5-flash-lite');
});

test('elise routing: GEMINI_MODEL does not control Elise', () => {
  assert.equal(EDGE.includes("readTrimmedEnv('GEMINI_MODEL')"), false);
  assert.equal(ROUTING.includes("'GEMINI_MODEL'"), false);
  const models = routing.resolveEliseModels((k) =>
    k === 'GEMINI_MODEL' ? 'gemini-2.5-flash' : undefined,
  );
  assert.equal(models.primaryModel, 'gemini-3.6-flash');
});

test('elise routing: retired models rejected', () => {
  const env = {
    STYLECHAT_GEMINI_MODEL: 'gemini-2.5-flash',
    STYLECHAT_GEMINI_FALLBACK_MODEL: 'gemini-1.5-flash',
  };
  const models = routing.resolveEliseModels((k) => env[k]);
  assert.equal(models.primaryModel, 'gemini-3.6-flash');
  assert.equal(models.fallbackModel, 'gemini-3.5-flash-lite');
  assert.equal(/['"]gemini-1\.5-[^'"]*['"]/.test(EDGE), false);
  assert.equal(/['"]gemini-2\.0-[^'"]*['"]/.test(EDGE), false);
  assert.equal(/['"]gemini-2\.5-[^'"]*['"]/.test(EDGE), false);
});

test('elise routing: client model override ignored', () => {
  assert.ok(EDGE.includes('client_model_override_ignored'));
});

test('elise routing: fallback and completeness paths wired', () => {
  assert.ok(EDGE.includes('elise_fallback'));
  assert.ok(EDGE.includes('consume_stylechat_request_quota'));
  assert.ok(EDGE.includes('refund_stylechat_request_quota'));
  assert.ok(EDGE.includes('routing_telemetry'));
  assert.equal(routing.isDirectFallbackFailure('http_429'), true);
  assert.equal(routing.isRepairableFailure('incomplete'), true);
  assert.equal(routing.isDirectFallbackFailure('incomplete'), false);
});

test('signature style: builds bounded preference context', () => {
  const block = signature.buildSignatureStyleContextBlock({
    brands: ['Nike', 'Nike', 'Adidas', 'Puma', 'Reebok', 'New Balance', 'Asics'],
    colors: ['black', 'navy'],
    categories: ['sneakers', 'jackets'],
    budgetMin: 40,
    budgetMax: 200,
  });
  assert.ok(block.text);
  assert.ok(block.text.includes('SIGNATURE STYLE CONTEXT'));
  assert.ok(block.text.includes('Preferred brands:'));
  assert.ok(block.signalCount >= 3);
  assert.ok(block.text.length <= signature.SIGNATURE_STYLE_MAX_CHARS);
  // Max 5 brands
  assert.equal((block.text.match(/Nike|Adidas|Puma|Reebok|New Balance|Asics/g) || []).length <= 5, true);
});

test('signature style: empty signals produce null', () => {
  const block = signature.buildSignatureStyleContextBlock({
    brands: [],
    colors: [],
    categories: [],
    budgetMin: null,
    budgetMax: null,
  });
  assert.equal(block.text, null);
  assert.equal(block.signalCount, 0);
});

test('signature style: deterministic truncation under char budget', () => {
  const longBrand = 'X'.repeat(80);
  const brands = Array.from({ length: 5 }, (_, i) => `${longBrand}${i}`);
  const block = signature.buildSignatureStyleContextBlock({
    brands,
    colors: brands,
    categories: brands,
    budgetMin: 1,
    budgetMax: 9999,
  });
  if (block.text) {
    assert.ok(block.text.length <= signature.SIGNATURE_STYLE_MAX_CHARS);
  }
});

test('signature style: wired separately from StyleDNA', () => {
  assert.ok(EDGE.includes('buildSignatureStyleContextBlock'));
  assert.ok(EDGE.includes('styleDnaGuidance'));
  assert.ok(EDGE.includes('styleDnaContext: styleDnaGuidance'));
  assert.equal(EDGE.includes('signatureStyleContext = styleDnaContext'), false);
  const dna = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/stylechat-generate/styleDnaContext.ts'),
    'utf8',
  );
  assert.ok(dna.includes('StyleDNA'));
  assert.ok(dna.includes('[Optional StyleDNA Context]'));
});

test('thinking config deferred; generation temperature removed', () => {
  assert.equal(/thinkingConfig|thinking_level|thinkingBudget/.test(EDGE), false);
  assert.equal(EDGE.includes('temperature: 0.7'), false);
});

test('quota migration file present', () => {
  const mig = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260722000001_stylechat_request_quota_events.sql'),
    'utf8',
  );
  assert.ok(mig.includes('consume_stylechat_request_quota'));
  assert.ok(mig.includes('refund_stylechat_request_quota'));
  assert.ok(mig.includes('stylechat_quota_events'));
  assert.ok(mig.includes("'consumed'"));
  assert.ok(mig.includes("'refunded'"));
});
