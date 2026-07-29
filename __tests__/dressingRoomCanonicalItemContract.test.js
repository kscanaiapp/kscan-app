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

// ── Canonical Closet item identity (Build 3 Phase 1, Stage 2) ────────────────
//
// The Build 2 device Closet is the authority for owned garments. A
// `closet_item` therefore carries `closetItemId` and NOT a synthesized
// `savedScanId` — the saved scan it was promoted from (if any) is lineage, not
// identity.

test('closet_item preserves closetItemId from sourceId', () => {
  const source = contract.buildCanonicalSource({
    sourceType: 'closet_item',
    sourceId: 'closet-abc',
  });
  assert.equal(source.kind, 'closet_item');
  assert.equal(source.closetItemId, 'closet-abc');
});

test('closet_item preserves an explicitly supplied closetItemId', () => {
  const source = contract.buildCanonicalSource({
    kind: 'closet_item',
    sourceId: 'ignored-source-id',
    closetItemId: 'closet-explicit',
  });
  assert.equal(source.closetItemId, 'closet-explicit');
});

test('closet_item does NOT synthesize a savedScanId', () => {
  const source = contract.buildCanonicalSource({
    sourceType: 'closet_item',
    sourceId: 'closet-abc',
  });
  assert.equal(source.savedScanId, null);
});

test('a closet_item promoted from a saved scan keeps both, identity stays Closet', () => {
  const source = contract.buildCanonicalSource({
    sourceType: 'closet_item',
    sourceId: 'closet-abc',
    savedScanId: 'saved-lineage-1',
  });
  assert.equal(source.closetItemId, 'closet-abc');
  assert.equal(source.savedScanId, 'saved-lineage-1');
  const key = dedupe.computeDressingRoomDedupeKey({ dressingRoomId: 'room-1', source });
  assert.equal(key.key, 'closet:closet-abc:room:room-1');
  assert.equal(key.strategy, 'closet_item_id+room');
});

test('saved_scan retains its savedScanId fallback behavior', () => {
  const source = contract.buildCanonicalSource({
    sourceType: 'style_library_scan',
    sourceId: 'saved-1',
  });
  assert.equal(source.kind, 'saved_scan');
  assert.equal(source.savedScanId, 'saved-1');
  assert.equal(source.closetItemId, null);
});

test('product and inspiration identities are unchanged', () => {
  const product = contract.buildCanonicalSource({
    sourceType: 'product_match',
    sourceId: 'prod-1',
  });
  assert.equal(product.kind, 'catalog_product');
  assert.equal(product.providerProductId, 'prod-1');
  assert.equal(product.closetItemId, null);
  assert.equal(product.savedScanId, null);

  const inspiration = contract.buildCanonicalSource({
    sourceType: 'upload_inspiration',
    sourceId: 'insp-1',
  });
  assert.equal(inspiration.kind, 'inspiration_item');
  assert.equal(inspiration.inspirationItemId, 'insp-1');
  assert.equal(inspiration.closetItemId, null);
});

test('scanner identities are unchanged', () => {
  const scan = contract.buildCanonicalSource({
    sourceType: 'live_scan',
    sourceId: 'scan-1',
  });
  assert.equal(scan.kind, 'scanner_single');
  assert.equal(scan.scanId, 'scan-1');
  assert.equal(scan.closetItemId, null);
});

test('malformed closet identity fails closed', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}, []]) {
    const source = contract.buildCanonicalSource({
      sourceType: 'closet_item',
      sourceId: bad,
      closetItemId: bad,
    });
    assert.equal(source.closetItemId, null, `expected null for ${JSON.stringify(bad)}`);
    assert.equal(source.savedScanId, null);
    const key = dedupe.computeDressingRoomDedupeKey({ dressingRoomId: 'room-1', source });
    assert.equal(key.key, null);
    assert.equal(key.strategy, null);
  }
});

test('same Closet item in the same room dedupes to one key', () => {
  const source = contract.buildCanonicalSource({
    sourceType: 'closet_item',
    sourceId: 'closet-abc',
  });
  const a = dedupe.computeDressingRoomDedupeKey({ dressingRoomId: 'room-1', source });
  const b = dedupe.computeDressingRoomDedupeKey({ dressingRoomId: 'room-1', source });
  assert.equal(a.key, b.key);
  assert.equal(a.key, 'closet:closet-abc:room:room-1');
});

test('same Closet item in different rooms stays room-scoped', () => {
  const source = contract.buildCanonicalSource({
    sourceType: 'closet_item',
    sourceId: 'closet-abc',
  });
  const a = dedupe.computeDressingRoomDedupeKey({ dressingRoomId: 'room-1', source });
  const b = dedupe.computeDressingRoomDedupeKey({ dressingRoomId: 'room-2', source });
  assert.notEqual(a.key, b.key);
  assert.equal(b.key, 'closet:closet-abc:room:room-2');
});

test('Closet and saved-scan identities sharing an id do not collide', () => {
  const closet = contract.buildCanonicalSource({
    sourceType: 'closet_item',
    sourceId: 'shared-id',
  });
  const saved = contract.buildCanonicalSource({
    sourceType: 'style_library_scan',
    sourceId: 'shared-id',
  });
  const closetKey = dedupe.computeDressingRoomDedupeKey({ dressingRoomId: 'room-1', source: closet });
  const savedKey = dedupe.computeDressingRoomDedupeKey({ dressingRoomId: 'room-1', source: saved });
  assert.notEqual(closetKey.key, savedKey.key);
  assert.equal(closetKey.key, 'closet:shared-id:room:room-1');
  assert.equal(savedKey.key, 'saved_scan:shared-id:room:room-1');
});

test('existing product and inspiration dedupe keys remain stable', () => {
  const product = dedupe.computeDressingRoomDedupeKey({
    dressingRoomId: 'room-1',
    source: { kind: 'catalog_product', providerProductId: 'prod-1' },
  });
  assert.equal(product.key, 'product:prod-1:room:room-1');
  assert.equal(product.strategy, 'provider_product_id+room');

  const inspiration = dedupe.computeDressingRoomDedupeKey({
    dressingRoomId: 'room-1',
    source: { kind: 'inspiration_item', inspirationItemId: 'insp-1' },
  });
  assert.equal(inspiration.key, 'inspiration:insp-1:room:room-1');
  assert.equal(inspiration.strategy, 'inspiration_item_id+room');
});

test('a missing Closet id falls through to the pre-existing strategies', () => {
  const scan = dedupe.computeDressingRoomDedupeKey({
    dressingRoomId: 'room-1',
    source: { kind: 'closet_item', closetItemId: null, scanId: 'scan-1', selectedItemId: 'item-9' },
  });
  assert.equal(scan.key, 'scan:scan-1:item:item-9:room:room-1');
  assert.equal(scan.strategy, 'scan_id+selected_item_id+room');
});

test('a Closet item without a room id yields no key', () => {
  const source = contract.buildCanonicalSource({
    sourceType: 'closet_item',
    sourceId: 'closet-abc',
  });
  const key = dedupe.computeDressingRoomDedupeKey({ dressingRoomId: '', source });
  assert.equal(key.key, null);
  assert.equal(key.strategy, null);
});

test('collaborative add-to-room extension still builds for a Closet item', () => {
  const extension = contract.buildCanonicalSnapshotExtension({
    dressingRoomId: 'room-1',
    sourceType: 'closet_item',
    sourceId: 'closet-abc',
    includeCommerce: false,
    includeDedupe: true,
  });
  assert.equal(extension.schemaVersion, 1);
  assert.equal(extension.source.kind, 'closet_item');
  assert.equal(extension.source.closetItemId, 'closet-abc');
  assert.equal(extension.source.savedScanId, null);
  assert.equal(extension.dedupeKey, 'closet:closet-abc:room:room-1');
  assert.equal(extension.dedupeStrategy, 'closet_item_id+room');
});
