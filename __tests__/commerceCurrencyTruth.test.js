const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadModule(relativePath, mocks = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import: ${specifier}`);
    },
    Intl,
    URL,
    URLSearchParams,
  }, { filename });
  return mod.exports;
}

const commerce = loadModule('services/dressingRoomCommerce.ts', {
  '../types/canonicalDressingRoomItem': {},
});
const scanTypes = loadModule('components/scan-results/types.ts', {
  '../../services/scanTitleBuilder': { buildScanTitle: () => 'Scan' },
  '../../constants/build': { SCAN_IDENTITY_DEBUG: false },
  '../../constants/featureFlags': { SCAN_RESULTS_DEMO_UI_ENABLED: false },
  '../../services/outfitConfirmation/outfitDetectionBridge': {},
  '../../services/vto/vtoCommerceGarment': { buildVtoGarmentFromCommerceRecord: () => null },
  '../../types/vto': {},
});

test('RP-110: known USD, EUR, and GBP amounts display in their supplied currency', () => {
  assert.equal(commerce.formatCommercePrice(29.99, 'USD'), '$29.99');
  assert.equal(commerce.formatCommercePrice(29.99, 'EUR'), '€29.99');
  assert.equal(commerce.formatCommercePrice(29.99, 'GBP'), '£29.99');
});

test('RP-110 negative control: a numeric amount with no trusted currency never renders as USD', () => {
  assert.equal(commerce.formatCommercePrice(29.99, null), null);
  assert.equal(commerce.formatCommercePrice('29.99', undefined), null);
  assert.equal(commerce.formatCommercePrice(29.99, 'dollars'), null);
  assert.equal(commerce.formatCommercePrice(29.99, 'WAT'), null);
});

test('RP-110: the shipped Scanner mapper applies the same known-currency boundary', () => {
  assert.equal(
    scanTypes.mapRawProductToPurchaseOption({ price: 29.99, currency: 'EUR' }).priceLabel,
    '€29.99',
  );
  assert.equal(
    scanTypes.mapRawProductToPurchaseOption({ price: 29.99 }).priceLabel,
    undefined,
  );
  assert.equal(
    scanTypes.mapRawProductToPurchaseOption({ price: 29.99, currency: 'WAT' }).priceLabel,
    undefined,
  );
});

test('RP-110: a display string still needs a supplied trusted currency', () => {
  assert.equal(commerce.formatCommercePrice('$29.99', null), null);
  assert.equal(commerce.formatCommercePrice('EUR 29.99', 'EUR'), 'EUR 29.99');
});

test('RP-110: persistence retains valid currency and drops malformed currency', () => {
  const options = commerce.normalizePurchaseOptions([
    { title: 'EUR Jacket', retailer: 'Retailer', productUrl: 'https://retailer.example/eur', price: 29.99, currency: ' eur ' },
    { title: 'Unknown Jacket', retailer: 'Retailer', productUrl: 'https://retailer.example/unknown', price: 29.99, currency: 'dollars' },
  ]);
  assert.equal(options[0].currency, 'EUR');
  assert.equal(options[0].price, '29.99');
  assert.equal(options[1].currency, null);
  assert.equal(commerce.formatCommercePrice(options[1].price, options[1].currency), null);
});
