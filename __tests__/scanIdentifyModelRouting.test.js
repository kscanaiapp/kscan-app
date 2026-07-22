const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const EDGE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/scan-identify/index.ts'),
  'utf8',
);
const ROUTING_SOURCE = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/scan-identify/modelRouting.ts'),
  'utf8',
);

function loadModelRouting() {
  const filename = path.join(ROOT, 'supabase/functions/scan-identify/modelRouting.ts');
  const output = ts.transpileModule(ROUTING_SOURCE, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    exports: mod.exports,
    module: mod,
    require: (id) => {
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename });
  return mod.exports;
}

const routing = loadModelRouting();

// â”€â”€ Model routing selection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('routing: image mode selects gemini-3.6-flash by default', () => {
  const models = routing.resolveWorkloadModels(() => undefined);
  assert.equal(models.scannerModel, 'gemini-3.6-flash');
  assert.equal(models.scannerFallbackModel, 'gemini-3.5-flash-lite');
});

test('routing: TextScan selects gemini-3.5-flash-lite by default', () => {
  const models = routing.resolveWorkloadModels(() => undefined);
  assert.equal(models.textScanModel, 'gemini-3.5-flash-lite');
});

test('routing: empty and whitespace env values use approved defaults', () => {
  const env = {
    SCAN_GEMINI_MODEL: '   ',
    SCAN_GEMINI_FALLBACK_MODEL: '',
    TEXTSCAN_GEMINI_MODEL: '\t',
  };
  const models = routing.resolveWorkloadModels((key) => env[key]);
  assert.equal(models.scannerModel, 'gemini-3.6-flash');
  assert.equal(models.scannerFallbackModel, 'gemini-3.5-flash-lite');
  assert.equal(models.textScanModel, 'gemini-3.5-flash-lite');
});

test('routing: unsupported and retired env values fall back to allowlisted defaults', () => {
  const env = {
    SCAN_GEMINI_MODEL: 'gemini-1.5-flash',
    SCAN_GEMINI_FALLBACK_MODEL: 'gemini-2.0-flash',
    TEXTSCAN_GEMINI_MODEL: 'gemini-2.5-flash',
  };
  const models = routing.resolveWorkloadModels((key) => env[key]);
  assert.equal(models.scannerModel, 'gemini-3.6-flash');
  assert.equal(models.scannerFallbackModel, 'gemini-3.5-flash-lite');
  assert.equal(models.textScanModel, 'gemini-3.5-flash-lite');
});

test('routing: allowlisted overrides are accepted', () => {
  const env = {
    SCAN_GEMINI_MODEL: 'gemini-3.5-flash-lite',
    SCAN_GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite',
    TEXTSCAN_GEMINI_MODEL: 'gemini-3.5-flash-lite',
  };
  const models = routing.resolveWorkloadModels((key) => env[key]);
  assert.equal(models.scannerModel, 'gemini-3.5-flash-lite');
  assert.equal(models.scannerFallbackModel, 'gemini-3.5-flash-lite');
  assert.equal(models.textScanModel, 'gemini-3.5-flash-lite');
});

test('routing: generic GEMINI_MODEL does not control scan-identify', () => {
  assert.equal(EDGE_SOURCE.includes("readTrimmedEnv('GEMINI_MODEL')"), false);
  assert.equal(EDGE_SOURCE.includes("Deno.env.get('GEMINI_MODEL')"), false);
  assert.equal(ROUTING_SOURCE.includes("get('GEMINI_MODEL')"), false);
  assert.equal(ROUTING_SOURCE.includes("'GEMINI_MODEL'"), false);
  const models = routing.resolveWorkloadModels((key) =>
    key === 'GEMINI_MODEL' ? 'gemini-1.5-flash' : undefined,
  );
  assert.equal(models.scannerModel, 'gemini-3.6-flash');
  assert.equal(models.textScanModel, 'gemini-3.5-flash-lite');
});

test('routing: retired model guard fails when active routing references retired prefixes', () => {
  assert.equal(routing.isRetiredModelId('gemini-1.5-flash'), true);
  assert.equal(routing.isRetiredModelId('gemini-2.0-flash'), true);
  assert.equal(routing.isRetiredModelId('gemini-2.5-flash'), true);
  assert.equal(routing.isRetiredModelId('gemini-3.6-flash'), false);

  // Active defaults / selection targets must not be retired.
  assert.equal(routing.SCANNER_PRIMARY_MODEL.startsWith('gemini-1.5-'), false);
  assert.equal(routing.SCANNER_PRIMARY_MODEL.startsWith('gemini-2.0-'), false);
  assert.equal(routing.SCANNER_PRIMARY_MODEL.startsWith('gemini-2.5-'), false);
  assert.equal(routing.TEXTSCAN_PRIMARY_MODEL, 'gemini-3.5-flash-lite');

  // Executable index must not hardcode retired model IDs as selectable defaults.
  assert.equal(/DEFAULT_MODEL\s*=\s*'gemini-1\.5-/.test(EDGE_SOURCE), false);
  assert.equal(/['"]gemini-1\.5-[^'"]*['"]/.test(EDGE_SOURCE), false);
  assert.equal(/['"]gemini-2\.0-[^'"]*['"]/.test(EDGE_SOURCE), false);
  assert.equal(/['"]gemini-2\.5-[^'"]*['"]/.test(EDGE_SOURCE), false);
});

// â”€â”€ Request mode aliases (evidence-based) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('mode: absent mode resolves to image (Scanner client omits mode)', () => {
  assert.equal(routing.resolveVerifiedRequestMode(undefined), 'image');
  assert.equal(routing.resolveVerifiedRequestMode(null), 'image');
});

test('mode: verified aliases image and text are accepted', () => {
  assert.equal(routing.resolveVerifiedRequestMode('image'), 'image');
  assert.equal(routing.resolveVerifiedRequestMode('IMAGE'), 'image');
  assert.equal(routing.resolveVerifiedRequestMode('text'), 'text');
  assert.equal(routing.resolveVerifiedRequestMode('Text'), 'text');
});

test('mode: unknown modes do not silently become image', () => {
  assert.equal(routing.resolveVerifiedRequestMode('vision'), null);
  assert.equal(routing.resolveVerifiedRequestMode('textscan'), null);
  assert.equal(routing.resolveVerifiedRequestMode(''), null);
  assert.equal(routing.resolveVerifiedRequestMode('   '), null);
  assert.equal(routing.resolveVerifiedRequestMode(123), null);
  assert.ok(EDGE_SOURCE.includes("code: 'UNSUPPORTED_MODE'"));
});

test('mode: TextScan is not inferred from textQuery presence alone', () => {
  // Source must require mode === 'text' (or verified alias), not textQuery existence.
  assert.ok(EDGE_SOURCE.includes('resolveVerifiedRequestMode(body.mode)'));
  assert.equal(EDGE_SOURCE.includes("textQuery && !imageBase64"), false);
  assert.ok(EDGE_SOURCE.includes("mode === 'text'"));
});

test('mode: client model override is ignored', () => {
  assert.ok(EDGE_SOURCE.includes('client_model_override_ignored'));
});

// â”€â”€ Fallback / retry policy matrix â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('fallback: image operational failures go directly to Lite', () => {
  for (const kind of ['timeout', 'network', 'http_429', 'http_5xx', 'http_unavailable']) {
    assert.equal(routing.isDirectImageFallbackFailure(kind), true);
    assert.equal(routing.isImageRepairableFailure(kind), false);
  }
});

test('fallback: empty/malformed responses are repairable then Lite', () => {
  for (const kind of ['empty_response', 'malformed_envelope', 'unparseable_json']) {
    assert.equal(routing.isImageRepairableFailure(kind), true);
    assert.equal(routing.isDirectImageFallbackFailure(kind), false);
  }
});

test('fallback: policy block never falls back', () => {
  assert.equal(routing.shouldNeverFallback('policy_block'), true);
  assert.ok(EDGE_SOURCE.includes("providerResult.kind === 'policy_block'"));
  assert.ok(EDGE_SOURCE.includes('image_fallback'));
});

test('fallback: TextScan retries same model once for eligible failures', () => {
  for (const kind of [
    'timeout',
    'network',
    'http_429',
    'http_5xx',
    'http_unavailable',
    'empty_response',
    'malformed_envelope',
    'unparseable_json',
  ]) {
    assert.equal(routing.isRetryableTextScanFailure(kind), true);
  }
  assert.equal(routing.isRetryableTextScanFailure('policy_block'), false);
  assert.ok(EDGE_SOURCE.includes('textscan_retry'));
  // TextScan must not route to 3.6 in Step 1 primary path.
  assert.ok(EDGE_SOURCE.includes('isTextScan ? textScanModel : scannerModel'));
});

test('fallback: source wires Lite fallback and telemetry fields', () => {
  assert.ok(EDGE_SOURCE.includes('scannerFallbackModel'));
  assert.ok(EDGE_SOURCE.includes('routing_telemetry'));
  assert.ok(EDGE_SOURCE.includes('served_model='));
  assert.ok(EDGE_SOURCE.includes('fallback_used='));
  assert.ok(EDGE_SOURCE.includes('attempt_count='));
});

test('contract: no thinking config introduced in Step 1', () => {
  assert.equal(/thinkingConfig|thinking_config|thinkingLevel|thinking_level|thinkingBudget|thinking_budget/
    .test(EDGE_SOURCE), false);
});

test('contract: image requestMode aliases remain selected_item and multi_item_detection', () => {
  assert.ok(EDGE_SOURCE.includes("body.requestMode === 'selected_item'"));
  assert.ok(EDGE_SOURCE.includes("body.requestMode === 'multi_item_detection'"));
  assert.ok(EDGE_SOURCE.includes("'legacy_single_item'"));
});
