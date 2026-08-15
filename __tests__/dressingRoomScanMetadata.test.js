const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadModule() {
  const filename = path.join(ROOT, 'services', 'dressingRoomScanMetadata.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = { exports: mod.exports, module: mod, require: () => ({}) };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const metadata = loadModule();

test('canonical Closet metadata reaches the Dressing Room snapshot without loss', () => {
  const result = metadata.buildDressingRoomScanSnapshotMetadata(
    {
      category: ' Outerwear ',
      subcategory: ' cropped blazer ',
      color: 'Ink',
      secondaryColors: ['Silver', 'Ink', 'Silver'],
      materials: ['Wool blend', 'Silk'],
      silhouette: 'Cropped',
      pattern: 'Pinstripe',
      fit: 'Tailored',
      brand: 'Maison V2',
      brandEvidence: [
        { type: 'visible_brand_text', value: 'MAISON V2', confidence: 0.94 },
        { type: 'brand_guess', value: 'Maison', confidence: 0.6 },
      ],
    },
    '2026-08-14T12:00:00Z',
  );

  assert.equal(result.category, 'Outerwear');
  assert.equal(result.subcategory, 'cropped blazer');
  assert.deepEqual(Array.from(result.colors), ['Ink', 'Silver']);
  assert.deepEqual(Array.from(result.materials), ['Wool blend', 'Silk']);
  assert.equal(result.pattern, 'Pinstripe');
  assert.equal(result.fit, 'Tailored');
  assert.equal(result.brand, 'Maison V2');
  assert.deepEqual(
    Array.from(result.brandEvidence).map((entry) => entry.type),
    ['visible_brand_text', 'brand_guess'],
  );
});

test('brand_guess remains evidence and cannot synthesize a scalar brand', () => {
  const result = metadata.buildDressingRoomScanSnapshotMetadata({
    brand: null,
    brandEvidence: [{ type: 'brand_guess', value: 'Guess House', confidence: 0.55 }],
  });
  assert.equal(result.brand, null);
  assert.equal(result.brandEvidence[0].type, 'brand_guess');
  assert.equal(result.brandEvidence[0].value, 'Guess House');
});

test('snapshot metadata is bounded and malformed evidence is dropped', () => {
  const result = metadata.buildDressingRoomScanSnapshotMetadata({
    secondaryColors: Array.from({ length: 20 }, (_, index) => `Color ${index}`),
    materials: ['Wool', '', 'Wool', 'Silk'],
    brandEvidence: [null, { value: 'missing type' }, { type: 'logo_detected' }],
  });
  assert.equal(result.colors.length, 8);
  assert.deepEqual(Array.from(result.materials), ['Wool', 'Silk']);
  assert.equal(result.brandEvidence.length, 1);
  assert.equal(result.brandEvidence[0].type, 'logo_detected');
});
