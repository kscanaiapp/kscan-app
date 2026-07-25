// Executable unit tests for the Dressing Room product-save policy.
//
// Locks the verified behavior of buildProductMatchSnapshot (services/styleObjects.ts):
//   - Product saves REQUIRE a remote (http/https) image; missing/non-remote → throws
//     UnsupportedStyleObjectItemError (deliberate product policy; the DB allows
//     image_url NULL only for the separate uploaded-scan-image path).
//   - Field resolution accepts BOTH camelCase and snake_case so a product that
//     ProductShelf marks saveable (its getProductImageUrl reads both shapes) can
//     actually be saved.
//
// The module is transpiled in-process and run in a VM sandbox; expo/supabase
// imports are stubbed because they are only used inside other functions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadStyleObjects() {
  const filename = path.join(ROOT, 'services', 'styleObjects.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    Promise,
    Set,
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      // Stub app/runtime deps — only used inside functions we are not calling here.
      if (id === './supabaseClient') return { supabase: {} };
      if (id === './privacy/privacyBoundary') {
        // Snapshot-policy tests never dispatch images; stub the gate open so
        // module load succeeds. Closed-gate behavior is covered by
        // privacyBoundaryEnforcement.test.js.
        return {
          isImageDispatchAllowed: () => true,
          PrivacyDispatchBlockedError: class extends Error {},
        };
      }
      if (id === 'expo-file-system/legacy') return {};
      if (id === 'expo-image-manipulator') return {};
      if (id === './dressingRoomItemContract') {
        // Stub the canonical image-source contract so buildProductMatchSnapshot
        // can run in this isolated VM. Only isRemoteImageUrl is exercised here;
        // the rest are no-ops sufficient for module load.
        return {
          isRemoteImageUrl: (value) => /^https?:\/\//i.test(String(value ?? '').trim()),
          isLocalImageUri: () => false,
          resolveDressingRoomImageSource: () => ({ kind: 'none' }),
          hasUsableDressingRoomImageSource: () => false,
          describeMissingImageReason: () => "This item's image isn't available right now.",
          buildCanonicalSnapshotExtension: () => ({ schemaVersion: 1, source: { kind: 'catalog_product' } }),
          readSnapshotDedupeKey: () => null,
        };
      }
      if (id === '../constants/featureFlags') {
        return {
          DRESSING_ROOM_CANONICAL_ITEM_V1: false,
          DRESSING_ROOM_COMMERCE_PRESERVATION_V1: false,
          DRESSING_ROOM_DEDUPE_V1: false,
          SAVED_SCAN_CLOUD_IMAGES_V1: false,
          DRESSING_ROOM_COLLABORATION_V1: false,
          DRESSING_ROOM_REACTIONS_V1: false,
        };
      }
      if (id === './dressingRoomCollaboration') {
        return {
          createCollabRequestId: () => '00000000-0000-4000-8000-000000000099',
          getCollabActorGeneration: () => 1,
          isCurrentCollabGeneration: () => true,
          setItemReactionDesiredState: async () => ({ ok: true }),
          bumpCollabActorGeneration: () => 1,
        };
      }
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const styleObjects = loadStyleObjects();
const { buildProductMatchSnapshot, UnsupportedStyleObjectItemError, isRemoteImageUrl } = styleObjects;

// ── DR-1 regression: Scan Result Object provenance must not be mislabeled ─────
//
// buildProductMatchSnapshot is the shared write path for BOTH:
//   - genuine Catalog/ProductShelf saves (no scan involved), and
//   - Scan Result Object primary-match saves (services/scanResultDressingRoom.ts),
//     which set `scanId` + `kind: 'scanner_single'` on the source object.
// Before the DR-1 repair, the canonical extension always hardcoded
// kind: 'catalog_product' and never received a scanId, so a Scanner-originated
// item was indistinguishable from a browsed catalog product to Elise/dedupe.
// This loader captures the exact arguments forwarded to
// buildCanonicalSnapshotExtension so both cases can be locked in.
function loadStyleObjectsWithExtensionCapture(flagOverrides) {
  const filename = path.join(ROOT, 'services', 'styleObjects.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const calls = [];
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    Promise,
    Set,
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      if (id === './supabaseClient') return { supabase: {} };
      if (id === './privacy/privacyBoundary') {
        // Snapshot-policy tests never dispatch images; stub the gate open so
        // module load succeeds. Closed-gate behavior is covered by
        // privacyBoundaryEnforcement.test.js.
        return {
          isImageDispatchAllowed: () => true,
          PrivacyDispatchBlockedError: class extends Error {},
        };
      }
      if (id === 'expo-file-system/legacy') return {};
      if (id === 'expo-image-manipulator') return {};
      if (id === './dressingRoomItemContract') {
        return {
          isRemoteImageUrl: (value) => /^https?:\/\//i.test(String(value ?? '').trim()),
          isLocalImageUri: () => false,
          resolveDressingRoomImageSource: () => ({ kind: 'none' }),
          hasUsableDressingRoomImageSource: () => false,
          describeMissingImageReason: () => "This item's image isn't available right now.",
          buildCanonicalSnapshotExtension: (input) => {
            calls.push(input);
            return { schemaVersion: 1, source: { kind: input.kind ?? 'catalog_product', scanId: input.scanId ?? null } };
          },
          readSnapshotDedupeKey: () => null,
        };
      }
      if (id === '../constants/featureFlags') {
        return {
          DRESSING_ROOM_CANONICAL_ITEM_V1: false,
          DRESSING_ROOM_COMMERCE_PRESERVATION_V1: false,
          DRESSING_ROOM_DEDUPE_V1: false,
          SAVED_SCAN_CLOUD_IMAGES_V1: false,
          DRESSING_ROOM_COLLABORATION_V1: false,
          DRESSING_ROOM_REACTIONS_V1: false,
          ...flagOverrides,
        };
      }
      if (id === './dressingRoomCollaboration') {
        return {
          createCollabRequestId: () => '00000000-0000-4000-8000-000000000099',
          getCollabActorGeneration: () => 1,
          isCurrentCollabGeneration: () => true,
          setItemReactionDesiredState: async () => ({ ok: true }),
          bumpCollabActorGeneration: () => 1,
        };
      }
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return { exports: mod.exports, calls };
}

test('buildProductMatchSnapshot: genuine catalog save stays catalog_product with no scanId', () => {
  const { exports: mod, calls } = loadStyleObjectsWithExtensionCapture({ DRESSING_ROOM_CANONICAL_ITEM_V1: true });
  mod.buildProductMatchSnapshot({
    id: 'catalog-1',
    title: 'Catalog Blazer',
    imageUrl: 'https://example.com/blazer.jpg',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'catalog_product');
  assert.equal(calls[0].scanId, null);
});

test('buildProductMatchSnapshot: Scan Result Object save is tagged scanner_single with scanId preserved', () => {
  const { exports: mod, calls } = loadStyleObjectsWithExtensionCapture({ DRESSING_ROOM_CANONICAL_ITEM_V1: true });
  mod.buildProductMatchSnapshot({
    id: 'matched-product-1',
    title: 'Scanned Jacket Match',
    imageUrl: 'https://example.com/jacket.jpg',
    // Set by services/scanResultDressingRoom.ts::buildDressingRoomSaveSource.
    scanId: 'scan-result-object-42',
    kind: 'scanner_single',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'scanner_single');
  assert.equal(calls[0].scanId, 'scan-result-object-42');
  // providerProductId still tracks the matched catalog product for dedupe.
  assert.equal(calls[0].providerProductId, 'matched-product-1');
});

test('buildProductMatchSnapshot: a stray "kind" without "scanId" cannot spoof scanner_single', () => {
  const { exports: mod, calls } = loadStyleObjectsWithExtensionCapture({ DRESSING_ROOM_CANONICAL_ITEM_V1: true });
  mod.buildProductMatchSnapshot({
    id: 'catalog-2',
    title: 'Not Actually Scanned',
    imageUrl: 'https://example.com/x.jpg',
    kind: 'scanner_single',
    // scanId intentionally omitted.
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'catalog_product');
});

// ── isRemoteImageUrl ──────────────────────────────────────────────────────────

test('isRemoteImageUrl: accepts http/https, rejects everything else', () => {
  assert.equal(isRemoteImageUrl('https://placehold.co/x.png'), true);
  assert.equal(isRemoteImageUrl('http://example.com/x.jpg'), true);
  assert.equal(isRemoteImageUrl('file:///local/x.jpg'), false);
  assert.equal(isRemoteImageUrl('/relative/x.jpg'), false);
  assert.equal(isRemoteImageUrl(''), false);
  assert.equal(isRemoteImageUrl(null), false);
  assert.equal(isRemoteImageUrl(undefined), false);
});

// ── Image-save policy: remote image required ──────────────────────────────────

test('buildProductMatchSnapshot: remote https image (camelCase) succeeds', () => {
  const snap = buildProductMatchSnapshot({
    id: 'p1',
    title: 'Black Blazer',
    retailer: 'K Scan Demo Catalog',
    imageUrl: 'https://placehold.co/400x600?text=Blazer',
    productUrl: 'https://kscan.app/?test_product=black-blazer',
    imageCategory: 'outerwear',
    price: '$199',
  });
  assert.equal(snap.sourceType, 'product_match');
  assert.equal(snap.sourceId, 'p1');
  assert.equal(snap.title, 'Black Blazer');
  assert.equal(snap.imageUrl, 'https://placehold.co/400x600?text=Blazer');
  assert.equal(snap.brand, 'K Scan Demo Catalog');
  assert.equal(snap.category, 'outerwear');
  assert.equal(snap.productUrl, 'https://kscan.app/?test_product=black-blazer');
  assert.equal(snap.snapshotVersion, 1);
});

test('buildProductMatchSnapshot: http image is accepted', () => {
  const snap = buildProductMatchSnapshot({
    id: 'p2',
    name: 'Sneaker',
    imageUrl: 'http://example.com/s.jpg',
  });
  assert.equal(snap.imageUrl, 'http://example.com/s.jpg');
});

test('buildProductMatchSnapshot: missing image throws UnsupportedStyleObjectItemError', () => {
  assert.throws(
    () => buildProductMatchSnapshot({ id: 'p3', title: 'No Image' }),
    (err) => {
      assert.ok(err instanceof UnsupportedStyleObjectItemError);
      assert.equal(err.name, 'UnsupportedStyleObjectItemError');
      return true;
    },
  );
});

test('buildProductMatchSnapshot: non-remote image (file/relative) throws', () => {
  assert.throws(
    () => buildProductMatchSnapshot({ id: 'p4', title: 'Local', imageUrl: 'file:///x.jpg' }),
    UnsupportedStyleObjectItemError,
  );
  assert.throws(
    () => buildProductMatchSnapshot({ id: 'p5', title: 'Rel', imageUrl: '/img/1.jpg' }),
    UnsupportedStyleObjectItemError,
  );
});

// ── snake_case / camelCase resolution (save-shape consistency) ────────────────

test('buildProductMatchSnapshot: resolves snake_case image_url (catalog row shape)', () => {
  // A catalog row carrying only snake_case fields — what ProductShelf marks
  // saveable via getProductImageUrl — must also succeed at save time.
  const snap = buildProductMatchSnapshot({
    id: 'bag-1',
    product_name: 'Leather Tote Bag',
    retailer: 'K Scan Demo Catalog',
    image_url: 'https://placehold.co/400x600?text=Tote',
    product_url: 'https://kscan.app/?test_product=leather-tote-bag',
    canonical_category: 'bag',
    price: '$0',
  });
  assert.equal(snap.imageUrl, 'https://placehold.co/400x600?text=Tote');
  assert.equal(snap.title, 'Leather Tote Bag'); // from product_name
  assert.equal(snap.brand, 'K Scan Demo Catalog');
  assert.equal(snap.category, 'bag'); // from canonical_category
  assert.equal(snap.productUrl, 'https://kscan.app/?test_product=leather-tote-bag');
});

test('buildProductMatchSnapshot: camelCase takes precedence over snake_case', () => {
  const snap = buildProductMatchSnapshot({
    id: 'p6',
    title: 'Preferred Title',
    product_name: 'Fallback Title',
    imageUrl: 'https://example.com/a.jpg',
    image_url: 'https://example.com/b.jpg',
  });
  assert.equal(snap.title, 'Preferred Title');
  assert.equal(snap.imageUrl, 'https://example.com/a.jpg');
});

test('buildProductMatchSnapshot: title falls back to "Untitled item" when no name fields', () => {
  const snap = buildProductMatchSnapshot({
    id: 'p7',
    imageUrl: 'https://example.com/x.jpg',
  });
  assert.equal(snap.title, 'Untitled item');
});

test('buildProductMatchSnapshot: resolves alternate image aliases (thumbnail)', () => {
  const snap = buildProductMatchSnapshot({
    id: 'p8',
    title: 'Thumb',
    thumbnail: 'https://example.com/thumb.jpg',
  });
  assert.equal(snap.imageUrl, 'https://example.com/thumb.jpg');
});
