const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    console,
    setTimeout,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require: ${id}`);
    },
  };

  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

test('deterministic mock result for jacket-black trigger', async () => {
  const types = loadTsModule('types/glasses.ts');
  const service = loadTsModule('services/glasses/mockGlassesService.ts', {
    '../../types/glasses': types,
  });

  const result = await service.analyze({ mockTriggerId: 'jacket-black' });

  assert.strictEqual(result.title, 'Oversized Black Jacket');
  assert.strictEqual(result.category, 'jacket');
  assert.strictEqual(result.color, 'black');
  assert.strictEqual(result.silhouette, 'oversized');
  assert.ok(result.confidence > 0.9);
  assert.strictEqual(result.privacyStatus, 'local_only');
});

test('default mock result for unknown trigger', async () => {
  const types = loadTsModule('types/glasses.ts');
  const service = loadTsModule('services/glasses/mockGlassesService.ts', {
    '../../types/glasses': types,
  });

  const result = await service.analyze({});

  assert.strictEqual(result.title, 'Fashion Item Detected');
  assert.strictEqual(result.category, 'unknown');
  assert.strictEqual(result.privacyStatus, 'local_only');
});

test('analyze returns unique id per call', async () => {
  const types = loadTsModule('types/glasses.ts');
  const service = loadTsModule('services/glasses/mockGlassesService.ts', {
    '../../types/glasses': types,
  });

  const result1 = await service.analyze({ mockTriggerId: 'jacket-black' });
  const result2 = await service.analyze({ mockTriggerId: 'jacket-black' });

  assert.notStrictEqual(result1.id, result2.id);
});

test('analyzeWithError rejects with safe error', async () => {
  const types = loadTsModule('types/glasses.ts');
  const service = loadTsModule('services/glasses/mockGlassesService.ts', {
    '../../types/glasses': types,
  });

  await assert.rejects(service.analyzeWithError(), (err) => {
    const parsed = JSON.parse(err.message);
    assert.strictEqual(parsed.code, 'GLASSES_ANALYZE_ERROR');
    assert.ok(parsed.message.includes('could not be analyzed'));
    return true;
  });
});

test('privacy status is always local_only', async () => {
  const types = loadTsModule('types/glasses.ts');
  const service = loadTsModule('services/glasses/mockGlassesService.ts', {
    '../../types/glasses': types,
  });

  const result = await service.analyze({ mockTriggerId: 'dress-red' });
  assert.strictEqual(result.privacyStatus, 'local_only');
});
