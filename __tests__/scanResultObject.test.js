// Unit tests for the Scan Result Object + Style Memory foundation (Part 1).
//
// Mirrors __tests__/scanIdentification.test.js: TS modules are transpiled
// in-process and run in a VM sandbox. services/scanResultObject.ts has only
// TYPE-ONLY imports, so (like the mapper) it loads with no requireMap.
//
// Cross-realm note: arrays/objects created inside the VM use that realm's
// prototypes, so deepStrictEqual against host literals fails on prototype
// identity. We assert on primitives, lengths, and indexed values instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

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

  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    Set,
    RegExp,
    String,
    Boolean,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

// Type-only imports → erased on transpile → no requireMap needed.
const sro = loadTsModule('services/scanResultObject.ts');

function assertEmptyArray(value) {
  assert.ok(Array.isArray(value), 'expected an array');
  assert.equal(value.length, 0, 'expected an empty array');
}

// ── Mock builders (shaped like ScanIdentifyResponse) ──────────────────────────

function strongScan() {
  return {
    scanId: 'scan-strong-1',
    status: 'completed',
    source: 'live_scan',
    identification: {
      visual_observation: 'A black leather biker jacket.',
      item_type: 'jacket',
      subtype: 'biker jacket',
      primary_color: 'Black',
      secondary_colors: ['Charcoal'],
      material_estimate: 'Leather',
      pattern: 'Solid',
      silhouette: 'Fitted',
      fit: 'Slim',
      style_tags: ['edgy', 'minimalist', 'outerwear'],
      occasion_tags: ['night out'],
      brand_guess: 'AllSaints',
      logo_detected: true,
      confidence_score: 0.91,
    },
    displayResult: { confidenceLabel: 'high' },
    recommendedProducts: [
      {
        id: 'p1',
        name: 'Leather Biker Jacket',
        imageUrl: 'https://cdn.example.com/p1.jpg',
        productUrl: 'https://shop.example.com/p1',
        matchScore: 0.92,
      },
      { id: 'p2', name: 'Moto Jacket', image_url: 'https://cdn.example.com/p2.jpg' },
      { id: 'p3', name: 'Biker Coat', thumbnail: 'https://cdn.example.com/p3.jpg' },
    ],
  };
}

function weakScan() {
  return {
    status: 'completed',
    identification: {
      item_type: '',
      confidence_score: 0.18,
    },
    recommendedProducts: [],
  };
}

// ── 1. Strong scan → structured object ────────────────────────────────────────

test('strong scan becomes a structured ScanResultObject', () => {
  const out = sro.createScanResultObject(strongScan());
  assert.equal(out.item.category, 'jacket');
  assert.equal(out.item.subcategory, 'biker jacket');
  assert.equal(out.item.material, 'Leather');
  assert.equal(out.item.color, 'Black, Charcoal');
  assert.equal(out.item.fit, 'Slim');
  assert.equal(out.item.confidence, 0.91);
  assert.equal(out.explainability.confidenceLabel, 'high');
  assert.equal(out.source, 'camera');
  assert.ok(out.id.length > 0);
  assert.ok(out.createdAt.length > 0);
  assert.equal(out.item.styleTags.length, 3);
});

// ── 2. Weak / partial scan does not crash ─────────────────────────────────────

test('weak/partial scan does not crash and stays low/exploratory', () => {
  const out = sro.createScanResultObject(weakScan());
  assert.ok(out);
  assert.equal(out.item.category, '');
  assert.ok(['low', 'exploratory'].includes(out.explainability.confidenceLabel));
  assert.ok(out.explainability.missingSignals.length > 0);
  assert.equal(out.visual.cardTitle, 'Style match found');
});

test('empty/garbage input does not crash', () => {
  assert.ok(sro.createScanResultObject({}));
  assert.ok(sro.createScanResultObject(null));
  assert.ok(sro.createScanResultObject(undefined));
});

// ── 3. Empty recommendedProducts → still usable card ──────────────────────────

test('empty recommendedProducts still produces a usable result card', () => {
  const input = strongScan();
  input.recommendedProducts = [];
  const out = sro.createScanResultObject(input);
  const card = sro.createResultCardViewModel(out);
  assert.equal(card.matchCount, 0);
  assert.equal(card.primaryMatch, null);
  assert.ok(card.title.length > 0);
  assert.ok(card.subtitle.length > 0);
  assert.equal(card.heroImageUrl, null);
});

// ── 4. heroImageUrl from first recommended product ────────────────────────────

test('heroImageUrl comes from the first recommended product image', () => {
  const out = sro.createScanResultObject(strongScan());
  assert.equal(out.visual.heroImageUrl, 'https://cdn.example.com/p1.jpg');
});

test('heroImageUrl falls back across safe catalog image aliases', () => {
  const input = strongScan();
  input.recommendedProducts = [{ id: 'x', image_url: 'https://cdn.example.com/alias.jpg' }];
  const out = sro.createScanResultObject(input);
  assert.equal(out.visual.heroImageUrl, 'https://cdn.example.com/alias.jpg');
});

// ── 5. heroImageUrl never uses raw/local scan image fields ─────────────────────

test('heroImageUrl never uses raw/local scan image fields', () => {
  const input = strongScan();
  input.recommendedProducts = [
    {
      id: 'leaky',
      localImageUri: 'file:///data/user/0/camera/raw.jpg',
      capturedImageUri: 'file:///captured.jpg',
      rawImageUri: 'file:///raw.jpg',
      uri: 'file:///local.jpg',
    },
  ];
  const out = sro.createScanResultObject(input);
  assert.equal(out.visual.heroImageUrl, null);
});

test('safe image is chosen even when a blocked field is also present', () => {
  const input = strongScan();
  input.recommendedProducts = [
    {
      id: 'mixed',
      localImageUri: 'file:///raw.jpg',
      imageUrl: 'https://cdn.example.com/safe.jpg',
    },
  ];
  const out = sro.createScanResultObject(input);
  assert.equal(out.visual.heroImageUrl, 'https://cdn.example.com/safe.jpg');
});

// ── 6 & 7. privacy defaults ───────────────────────────────────────────────────

test('privacy.rawImageStored defaults to false', () => {
  const out = sro.createScanResultObject(strongScan());
  assert.equal(out.privacy.rawImageStored, false);
});

test('privacy.cloudPhotoStorage defaults to false', () => {
  const out = sro.createScanResultObject(strongScan());
  assert.equal(out.privacy.cloudPhotoStorage, false);
  assert.equal(out.privacy.piiMasked, true);
});

// ── 8. ResultCardViewModel completeness ───────────────────────────────────────

test('ResultCardViewModel has title, subtitle, badges, matchCount, confidenceLabel', () => {
  const out = sro.createScanResultObject(strongScan());
  const card = sro.createResultCardViewModel(out);
  assert.equal(typeof card.title, 'string');
  assert.equal(typeof card.subtitle, 'string');
  assert.ok(Array.isArray(card.badges));
  assert.equal(card.matchCount, 3);
  assert.equal(card.confidenceLabel, 'high');
  assert.equal(card.primaryMatch.id, 'p1');
  assert.equal(card.privacyCaption, 'Saved as style metadata, not a raw photo.');
  assert.equal(card.resultType, 'exact');
  assert.equal(card.matchQualityLabel, 'Exact match candidate');
  assert.equal(card.subtitle, 'Matched on category, color, material, and silhouette.');
  assert.ok(card.primaryReason.includes('Matched on category'));
  assert.ok(card.signalsFound.some((signal) => signal.label === 'Category' && signal.value === 'Jacket'));
  assert.ok(card.signalsFound.some((signal) => signal.label === 'Color' && signal.value === 'Black, Charcoal'));
  assert.equal(card.saveEnabled, true);
  assert.equal(card.shareEnabled, true);
  assert.equal(card.compareEnabled, true);
});

// ── 9. StyleMemoryItem is metadata-only ───────────────────────────────────────

test('createStyleMemoryItem creates a metadata-only memory item', () => {
  const out = sro.createScanResultObject(strongScan());
  const mem = sro.createStyleMemoryItem(out, { userTags: ['fall', 'fall', 'work'] });
  assert.equal(mem.source, 'scan');
  assert.equal(mem.scanResultId, out.id);
  assert.equal(mem.savedToDressingRoomId, null);
  assert.equal(mem.item.category, 'jacket');
  assert.equal(mem.privacy.rawImageStored, false);
  // userTags deduped
  assert.equal(mem.userTags.length, 2);
  // metadata-only: no raw image / uri keys anywhere on the item
  const serialized = JSON.stringify(mem);
  assert.ok(!serialized.includes('file://'));
  assert.ok(!/localImageUri|capturedImageUri|rawImageUri/.test(serialized));
});

// ── 10. compareScanResults ────────────────────────────────────────────────────

test('compareScanResults returns similarity score and differences', () => {
  const a = sro.createScanResultObject(strongScan());
  const bInput = strongScan();
  bInput.scanId = 'scan-strong-2';
  bInput.identification.primary_color = 'Tan';
  bInput.identification.secondary_colors = [];
  bInput.identification.material_estimate = 'Suede';
  const b = sro.createScanResultObject(bInput);

  const cmp = sro.compareScanResults(a, b);
  assert.equal(typeof cmp.similarityScore, 'number');
  assert.ok(cmp.similarityScore >= 0 && cmp.similarityScore <= 1);
  assert.ok(cmp.sharedCategories.length > 0);
  assert.ok(cmp.sharedStyleTags.length > 0);
  assert.ok(cmp.differences.some((d) => d.startsWith('color')));
  assert.ok(cmp.differences.some((d) => d.startsWith('material')));
  assert.equal(typeof cmp.summary, 'string');
  assert.ok(cmp.summary.length > 0);
});

test('compareScanResults is robust to empty objects', () => {
  const a = sro.createScanResultObject({});
  const b = sro.createScanResultObject({});
  const cmp = sro.compareScanResults(a, b);
  assert.equal(cmp.similarityScore, 0);
  assertEmptyArray(cmp.sharedCategories);
});

// ── 11 & 12. share-ready payload exclusions ───────────────────────────────────

test('createShareReadyPayload excludes userId and PII/raw fields', () => {
  const out = sro.createScanResultObject(strongScan(), { userId: 'user-abc-123' });
  const payload = sro.createShareReadyPayload(out);
  assert.equal(payload.id, out.id);
  assert.ok(payload.item);
  assert.ok(payload.visual);
  assert.ok(Array.isArray(payload.matches));

  const keys = Object.keys(payload);
  assert.ok(!keys.includes('userId'));
  assert.ok(!keys.includes('privacy'));
  assert.ok(!keys.includes('memory'));

  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('user-abc-123'));
  assert.ok(!/rawImageUri|localUri|capturedImageUri|localImageUri/.test(serialized));
});

// ── 13. existing recommended product type preserved ───────────────────────────

test('recommended product objects are preserved (reused) on matches', () => {
  const out = sro.createScanResultObject(strongScan());
  assert.equal(out.matches.length, 3);
  assert.equal(out.matches[0].id, 'p1');
  assert.equal(out.matches[0].matchScore, 0.92);
  assert.equal(out.matches[0].name, 'Leather Biker Jacket');
});

// ── extra: userId null when unavailable ───────────────────────────────────────

test('userId defaults to null when unavailable (no anonymous id generated)', () => {
  const out = sro.createScanResultObject(strongScan());
  assert.equal(out.userId, null);
});

// ── extra: card title/subtitle examples ───────────────────────────────────────

test('card title uses color+material+category when present', () => {
  const out = sro.createScanResultObject(strongScan());
  assert.equal(out.visual.cardTitle, 'Black, Charcoal Leather jacket');
});

test('card title is just the category when only category is present', () => {
  const out = sro.createScanResultObject({
    status: 'completed',
    identification: { item_type: 'jacket', confidence_score: 0.7, brand_guess: 'X' },
    recommendedProducts: [{ id: 'q', imageUrl: 'https://cdn.example.com/q.jpg' }],
  });
  assert.equal(out.visual.cardTitle, 'Jacket');
});

test('weak identity single match shows learning subtitle', () => {
  const out = sro.createScanResultObject({
    status: 'completed',
    identification: { confidence_score: 0.2 },
    recommendedProducts: [{ id: 'q', imageUrl: 'https://cdn.example.com/q.jpg' }],
  });
  assert.equal(out.visual.cardSubtitle, 'Style match found — exact item still learning');
  const card = sro.createResultCardViewModel(out);
  assert.equal(card.resultType, 'style');
  assert.equal(card.matchQualityLabel, 'Close style match');
  assert.equal(card.subtitle, 'Good visual similarity. Exact product identity is still learning.');
});

test('weak scan produces exploratory result card copy', () => {
  const out = sro.createScanResultObject(weakScan());
  const card = sro.createResultCardViewModel(out);
  assert.equal(card.resultType, 'exploratory');
  assert.equal(card.matchQualityLabel, 'Style analysis ready');
  assert.equal(card.emptyMatchMessage, 'Style analysis ready. Product matches will improve as the catalog grows.');
  assert.ok(card.missingSignals.includes('brand'));
});

test('no product matches still produce useful result-card copy', () => {
  const input = strongScan();
  input.recommendedProducts = [];
  input.displayResult = {};
  const out = sro.createScanResultObject(input);
  const card = sro.createResultCardViewModel(out);
  assert.equal(card.matchCount, 0);
  assert.equal(card.resultType, 'exploratory');
  assert.equal(card.matchQualityLabel, 'Style analysis ready');
  assert.equal(card.subtitle, 'Product matches will improve as the catalog grows.');
});

test('result card never claims exact match without strong evidence', () => {
  const input = strongScan();
  input.identification.brand_guess = null;
  input.identification.logo_detected = false;
  const out = sro.createScanResultObject(input);
  const card = sro.createResultCardViewModel(out);
  assert.notEqual(card.resultType, 'exact');
  assert.notEqual(card.matchQualityLabel, 'Exact match candidate');
  assert.ok(card.missingSignals.includes('brand'));
});
