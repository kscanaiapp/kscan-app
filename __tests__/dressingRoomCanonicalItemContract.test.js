const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadModule(relPath, mocks = {}) {
  const filename = path.join(ROOT, relPath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.ts`)) resolved = `${resolved}.ts`;
      if (resolved.endsWith('.ts') || fs.existsSync(resolved)) {
        const rel = path.relative(ROOT, resolved).replace(/\\/g, '/');
        return loadModule(rel, mocks);
      }
    }
    if (specifier.includes('canonicalDressingRoomItem')) {
      return loadModule('types/canonicalDressingRoomItem.ts', mocks);
    }
    if (specifier.includes('featureFlags')) {
      return {
        DRESSING_ROOM_CANONICAL_ITEM_V1: false,
        DRESSING_ROOM_COMMERCE_PRESERVATION_V1: false,
        DRESSING_ROOM_DEDUPE_V1: false,
        SAVED_SCAN_CLOUD_IMAGES_V1: false,
      };
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    require: localRequire,
    console,
    URL,
    URLSearchParams,
  }, { filename });
  return mod.exports;
}

const commerce = loadModule('services/dressingRoomCommerce.ts');
const dedupe = loadModule('services/dressingRoomDedupe.ts');
const contract = loadModule('services/dressingRoomItemContract.ts');

test('DR-1 flags default OFF (source contract)', () => {
  const flagsSource = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
  assert.match(flagsSource, /DRESSING_ROOM_CANONICAL_ITEM_V1[\s\S]*===\s*'true'/);
  assert.match(flagsSource, /DRESSING_ROOM_COMMERCE_PRESERVATION_V1[\s\S]*===\s*'true'/);
  assert.match(flagsSource, /DRESSING_ROOM_DEDUPE_V1[\s\S]*===\s*'true'/);
  assert.match(flagsSource, /SAVED_SCAN_CLOUD_IMAGES_V1[\s\S]*===\s*'true'/);
});

test('commerce normalizer preserves retailer order and drops exact duplicates', () => {
  const options = commerce.normalizePurchaseOptions([
    { title: 'Coat A', retailer: 'Alpha', productUrl: 'https://a.example/1', price: '120' },
    { title: 'Coat A', retailer: 'Alpha', product_url: 'https://a.example/1', price: '120' },
    { title: 'Coat B', retailer: 'Beta', affiliateUrl: 'https://b.example/2', price: '99' },
    { title: '', productUrl: null },
    { title: 'Bad', productUrl: 'javascript:alert(1)' },
  ]);
  assert.equal(options.length, 2);
  assert.equal(options[0].retailer, 'Alpha');
  assert.equal(options[1].retailer, 'Beta');
});

test('commerce collector accepts Scanner aliases', () => {
  const raw = commerce.collectRawPurchaseOptions({
    purchase_options: [{ title: 'X', productUrl: 'https://x.example/1' }],
  });
  assert.equal(commerce.normalizePurchaseOptions(raw).length, 1);
});

test('empty and malformed commerce fail open to empty array', () => {
  assert.equal(commerce.normalizePurchaseOptions(null).length, 0);
  assert.equal(commerce.normalizePurchaseOptions('nope').length, 0);
  assert.equal(commerce.normalizePurchaseOptions([{ foo: 1 }]).length, 0);
});

test('dedupe prefers scan+selected item, then saved scan, then product', () => {
  const a = dedupe.computeDressingRoomDedupeKey({
    dressingRoomId: 'room-1',
    source: { kind: 'scanner_selected_item', scanId: 'scan-1', selectedItemId: 'item-9' },
  });
  assert.match(a.key, /scan:scan-1:item:item-9:room:room-1/);
  const b = dedupe.computeDressingRoomDedupeKey({
    dressingRoomId: 'room-1',
    source: { kind: 'saved_scan', savedScanId: 'saved-1' },
  });
  assert.match(b.key, /saved_scan:saved-1:room:room-1/);
});

test('canonical extension embeds provenance and optional commerce', () => {
  const extension = contract.buildCanonicalSnapshotExtension({
    dressingRoomId: '11111111-1111-4111-8111-111111111111',
    sourceType: 'style_library_scan',
    sourceId: '22222222-2222-4222-8222-222222222222',
    commerceSource: {
      purchaseOptions: [
        { title: 'Shoe', retailer: 'Shop', productUrl: 'https://shop.example/s' },
      ],
    },
    includeCommerce: true,
    includeDedupe: true,
  });
  assert.equal(extension.schemaVersion, 1);
  assert.equal(extension.source.kind, 'saved_scan');
  assert.equal(extension.purchaseOptions.length, 1);
  assert.ok(extension.dedupeKey);
});

test('signed Supabase URLs are rejected as durable remote identity', () => {
  const source = contract.resolveDressingRoomImageSource({
    imageUrl: 'https://xyz.supabase.co/storage/v1/object/sign/style-library-images/a.jpg?token=abc',
  });
  assert.equal(source.kind, 'none');
});

test('ordinary https product images remain remote identity', () => {
  const source = contract.resolveDressingRoomImageSource({
    imageUrl: 'https://cdn.retailer.example/product.jpg',
  });
  assert.equal(source.kind, 'remote');
});

test('legacy image contract tests still hold for storage preference', () => {
  const source = contract.resolveDressingRoomImageSource({
    storageBucket: 'style-library-images',
    storagePath: 'user-1/scans/a.jpg',
    localUri: 'file:///tmp/a.jpg',
  });
  assert.equal(source.kind, 'storage');
});
