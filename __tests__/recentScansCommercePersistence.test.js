/**
 * iOS V17 — Recent Scans commerce persistence and purchase cards.
 *
 * Covers the durable commerce snapshot end to end:
 *   scan-identify response
 *     -> scanIdentificationMapper (products vs purchaseOptions split)
 *     -> services/library.js saveScan serialization
 *     -> JSON storage round trip (simulates app relaunch)
 *     -> loadLibrary hydration
 *     -> AnalysisCard / ProductShelf purchase-card wiring
 *     -> Linking.openURL purchase action
 *
 * The first point of loss this pins: saveScan persisted only `analysis.products`
 * (the catalog similarity shelf) and dropped `analysis.purchaseOptions` (live
 * commerce), so reopened Recent Scans had no purchase cards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = process.env.KSCAN_COMMERCE_SOURCE_ROOT
  ? path.resolve(process.env.KSCAN_COMMERCE_SOURCE_ROOT)
  : path.resolve(__dirname, '..');

// ── Minimal TS/TSX module loader (recursive, RN-free) ───────────────────────
const tsCache = new Map();
function loadModule(absNoExt) {
  for (const ext of ['.ts', '.tsx', '.js']) {
    const p = absNoExt.endsWith(ext) ? absNoExt : absNoExt + ext;
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
    if (tsCache.has(p)) return tsCache.get(p);
    const { outputText } = ts.transpileModule(fs.readFileSync(p, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
      fileName: p,
    });
    const mod = { exports: {} };
    tsCache.set(p, mod.exports);
    const req = (id) => {
      // Never boot the real Supabase client: it starts RN/Platform async work
      // that outlives the test process. Pure mappers are what we exercise here.
      if (/supabaseClient$/.test(id)) return { supabase: {} };
      if (id.startsWith('.')) return loadModule(path.resolve(path.dirname(p), id)) || {};
      try { return require(id); } catch { return {}; }
    };
    Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
      mod.exports, req, mod, p, path.dirname(p),
    );
    tsCache.set(p, mod.exports);
    return mod.exports;
  }
  return null;
}
const load = (rel) => loadModule(path.join(ROOT, rel).replace(/\.(ts|tsx|js)$/, ''));

globalThis.__DEV__ = false;

const { mapScanIdentifyToAnalysis } = load('services/scanIdentificationMapper.ts');
const { normalizePurchaseOptions } = load('services/dressingRoomCommerce.ts');

const librarySource = fs.readFileSync(path.join(ROOT, 'services/library.js'), 'utf8');
const analysisCardSource = fs.readFileSync(path.join(ROOT, 'components/AnalysisCard.tsx'), 'utf8');
const productShelfSource = fs.readFileSync(path.join(ROOT, 'components/ProductShelf.tsx'), 'utf8');
const librarySreenSource = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const cloudSource = fs.readFileSync(path.join(ROOT, 'services/savedScansCloud.ts'), 'utf8');

// ── Pure re-implementations of the two library.js helpers ───────────────────
// These are contract models retained for focused normalization coverage. The
// separate recentScansCommerceActualRoundTrip suite loads the real library.js
// module against an in-memory expo-file-system implementation.
function selectPurchaseOptionsSnapshot(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const raw = Array.isArray(analysis.purchaseOptions)
    ? analysis.purchaseOptions
    : Array.isArray(analysis.recommendedProducts)
      ? analysis.recommendedProducts
      : [];
  return normalizePurchaseOptions(raw);
}
function hydrateSavedScan(scan) {
  if (!scan || typeof scan !== 'object') return scan;
  const stored = Array.isArray(scan.purchaseOptions)
    ? scan.purchaseOptions
    : Array.isArray(scan.purchase_options)
      ? scan.purchase_options
      : [];
  return { ...scan, purchaseOptions: normalizePurchaseOptions(stored) };
}

/** Exact persisted-record construction from services/library.js saveScan(). */
function serializeScan(analysis, id = 'scan_1') {
  return {
    id,
    createdAt: '2026-07-25T00:00:00.000Z',
    imageUri: '/img.jpg',
    thumbnailUri: '/thumb.jpg',
    attributes: {
      category: analysis.metadata?.category ?? '',
      silhouette: analysis.metadata?.silhouette ?? '',
      color_palette: analysis.metadata?.color ?? '',
      material_estimate: null, style_tags: [], confidence_score: null,
    },
    result: analysis.result ?? '',
    products: Array.isArray(analysis.products) ? analysis.products : [],
    purchaseOptions: selectPurchaseOptionsSnapshot(analysis),
    source: 'scan',
  };
}
/** Simulates app close + relaunch: file write, process death, file read. */
const reopen = (scan) => hydrateSavedScan(JSON.parse(JSON.stringify(scan)));

// ── Fixtures ────────────────────────────────────────────────────────────────
const offer = (n, retailer, price, extra = {}) => ({
  id: `buy${n}`,
  title: `Offer ${n}`,
  retailer,
  price,
  currency: 'USD',
  imageUrl: `https://cdn.example.com/buy${n}.jpg`,
  purchaseUrl: `https://${retailer.toLowerCase().replace(/\s/g, '')}.com/p/${n}`,
  ...extra,
});

const backendResponse = (overrides = {}) => ({
  status: 'completed',
  scanId: 'scan-abc',
  identification: { visual_observation: 'Black leather biker jacket', confidence_score: 0.9 },
  attributes: { category: 'outerwear', color: 'black' },
  similarityMatches: [
    { id: 'sim1', title: 'Similar Jacket', retailer: 'Nordstrom', price: 249, currency: 'USD',
      imageUrl: 'https://cdn.example.com/sim1.jpg', purchaseUrl: 'https://nordstrom.com/p/sim1' },
    { id: 'sim2', title: 'Moto Jacket', retailer: 'Zara', price: 129, currency: 'USD',
      imageUrl: 'https://cdn.example.com/sim2.jpg', purchaseUrl: 'https://zara.com/p/sim2' },
  ],
  recommendedProducts: [
    offer(1, 'AllSaints', 519, { availability: 'in_stock' }),
    offer(2, 'Schott NYC', 890),
    offer(3, 'Mr Porter', 1100),
  ],
  userMessage: 'ok',
  ...overrides,
});

// ── 1. Persistence round trip ───────────────────────────────────────────────

test('backend commerce survives normalize -> save -> relaunch -> hydrate', () => {
  const analysis = mapScanIdentifyToAnalysis(backendResponse());

  // Mapper keeps the two commerce channels distinct.
  assert.equal(analysis.products.length, 2, 'catalog similarity shelf');
  assert.equal(analysis.purchaseOptions.length, 3, 'live commerce purchase options');

  const reopened = reopen(serializeScan(analysis));

  assert.equal(reopened.purchaseOptions.length, 3);
  assert.deepEqual(
    reopened.purchaseOptions.map((o) => o.retailer),
    ['AllSaints', 'Schott NYC', 'Mr Porter'],
    'deterministic first-seen order preserved across relaunch',
  );
  // Similarity shelf is untouched by the repair.
  assert.equal(reopened.products.length, 2);
});

test('every field the purchase card renders survives the round trip', () => {
  const analysis = mapScanIdentifyToAnalysis(backendResponse());
  const [first] = reopen(serializeScan(analysis)).purchaseOptions;

  assert.equal(first.retailer, 'AllSaints');
  assert.equal(first.title, 'Offer 1');
  assert.equal(first.price, '519');
  assert.equal(first.currency, 'USD');
  assert.equal(first.availability, 'in_stock');
  assert.equal(first.imageUrl, 'https://cdn.example.com/buy1.jpg');
  assert.equal(first.productUrl, 'https://allsaints.com/p/1');
});

test('at least three distinct options persist and reload', () => {
  const analysis = mapScanIdentifyToAnalysis(backendResponse());
  const reopened = reopen(serializeScan(analysis));
  assert.equal(new Set(reopened.purchaseOptions.map((o) => o.productUrl)).size, 3);
});

// ── 2. First point of loss (regression pin) ─────────────────────────────────

test('saveScan persists purchaseOptions, not only products', () => {
  // Pins the exact defect: the persisted record must carry its own commerce
  // snapshot. Serializing without it is what stranded offers in Scanner state.
  assert.match(librarySource, /purchaseOptions:\s*selectPurchaseOptionsSnapshot\(analysis\)/);
  assert.match(librarySource, /export function selectPurchaseOptionsSnapshot/);
  assert.match(librarySource, /export function hydrateSavedScan/);
  // Every persisted record is still hydrated through hydrateSavedScan on read.
  // Phase 2B.2 replaced the array-wide `.map()` with per-record hydration so a
  // single corrupt entry can no longer empty the whole history, so the
  // assertion follows the call into that helper.
  assert.match(librarySource, /hydrateScanHistory\(parsed,[\s\S]{0,200}hydrateSavedScan\(scan\)/);
});

test('snapshot source never falls back to the catalog similarity shelf', () => {
  // Relabelling similarityMatches as purchase options would invent offers.
  const analysis = mapScanIdentifyToAnalysis(backendResponse({ recommendedProducts: [] }));
  assert.ok(analysis.products.length >= 2, 'similarity matches still present');
  assert.equal(selectPurchaseOptionsSnapshot(analysis).length, 0);
});

test('legacy backend without similarityMatches invents nothing', () => {
  // Older backend shape: no similarityMatches field, so the mapper routes
  // recommendedProducts into `products` (the shelf) and leaves purchaseOptions
  // undefined. The snapshot must stay empty rather than relabel that shelf as
  // purchase options. Production always emits similarityMatches, so this branch
  // is defensive only.
  const legacy = backendResponse();
  delete legacy.similarityMatches;
  const analysis = mapScanIdentifyToAnalysis(legacy);
  assert.equal(analysis.purchaseOptions, undefined);
  assert.equal(analysis.products.length, 3, 'recommendedProducts became the shelf');
  assert.equal(reopen(serializeScan(analysis)).purchaseOptions.length, 0);
});

test('a raw recommendedProducts bag still yields a snapshot', () => {
  // selectPurchaseOptionsSnapshot also accepts a raw response-shaped object.
  const snapshot = selectPurchaseOptionsSnapshot({
    recommendedProducts: [offer(1, 'AllSaints', 519), offer(2, 'Schott NYC', 890)],
  });
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].productUrl, 'https://allsaints.com/p/1');
});

// ── 3. Purchase-card rendering wiring ───────────────────────────────────────

test('reopened Recent Scan passes the hydrated snapshot to the card', () => {
  assert.match(librarySreenSource, /purchaseOptions=\{selectedScan\.purchaseOptions \?\? \[\]\}/);
  assert.match(librarySreenSource, /products=\{selectedScan\.products\}/);
  assert.match(librarySreenSource, /purchaseOptions\?: Product\[\]/);
});

test('AnalysisCard renders purchase cards beneath the scan, above similar items', () => {
  assert.match(analysisCardSource, /purchaseOptions = \[\]/);
  // v127 (P1-B): the length>=1 gate now lives inside resolvePurchaseShelfMode
  // (see commerceShelfWiring.test.js for its executable behavior); this
  // confirms the render call site is still driven by that exact function.
  assert.match(
    analysisCardSource,
    /purchaseShelfMode === 'options' \?[\s\S]*?<ProductShelf[\s\S]*?products=\{purchaseOptions\}/,
  );
  const purchaseAt = analysisCardSource.indexOf('products={purchaseOptions}');
  const similarAt = analysisCardSource.indexOf('products={products}');
  assert.ok(purchaseAt > 0 && similarAt > 0);
  assert.ok(purchaseAt < similarAt, 'purchase options render above the similarity shelf');
});

test('purchase cards reuse the established ProductShelf, not a second design', () => {
  // One card system. ProductShelf gained a label (v126) and a pending/error
  // state (v127 P1-B), not a fork — no second product-card component exists.
  // Build 32 adds 3 more usages for the restored per-item commerce section
  // (best match / no-match / alternatives, one candidate at a time) — still
  // the same component, not a second design.
  assert.match(productShelfSource, /label = 'SIMILAR ITEMS'/);
  assert.match(analysisCardSource, /label="WHERE TO BUY"/);
  assert.equal((analysisCardSource.match(/<ProductShelf/g) || []).length, 6);
  assert.equal(
    (analysisCardSource.match(/import\s*\{[^}]*ProductShelf[^}]*\}\s*from/g) || []).length,
    1,
    'a second ProductShelf-like import suggests a forked component',
  );
});

test('live Scanner and reopened scan use the identical snapshot shape', () => {
  assert.match(appSource, /purchaseOptions=\{selectPurchaseOptionsSnapshot\(analysis\)\}/);
  assert.match(appSource, /selectPurchaseOptionsSnapshot/);
});

// ── 4. Actionability (no transient callback) ────────────────────────────────

test('purchase action opens the persisted URL via the canonical handler', () => {
  const analysis = mapScanIdentifyToAnalysis(backendResponse());
  const reopened = reopen(serializeScan(analysis));

  // ProductShelf resolves the URL from data only.
  assert.match(productShelfSource, /openPersistedCommerceUrl\(url/);
  assert.match(productShelfSource, /Linking\.openURL\(safeUrl\)/);
  assert.match(productShelfSource, /onPress=\{\(\) => handleLinkPress\(purchaseUrl\)\}/);
  // No callback/navigation prop is threaded into the shelf.
  assert.doesNotMatch(productShelfSource, /onPurchasePress|onProductPress|route\.params/);

  // The rehydrated record alone supplies a usable https destination.
  const opened = [];
  const Linking = { openURL: (u) => { opened.push(u); return Promise.resolve(); } };
  for (const option of reopened.purchaseOptions) {
    const url = option.productUrl || option.affiliateUrl;
    if (url) Linking.openURL(url);
  }
  assert.deepEqual(opened, [
    'https://allsaints.com/p/1',
    'https://schottnyc.com/p/2',
    'https://mrporter.com/p/3',
  ]);
});

test('ProductShelf reads the purchase URL from persisted aliases', () => {
  // Every persisted alias is still consulted...
  for (const alias of [
    'product\\.productUrl',
    'product\\.purchaseUrl',
    'product\\.affiliateUrl',
    'product\\.product_url',
    'product\\.purchase_url',
    'product\\.url',
    'product\\.link',
  ]) {
    assert.match(productShelfSource, new RegExp(alias));
  }
  // ...each is still scrubbed before it can be considered...
  assert.match(productShelfSource, /normalizePersistedCommerceUrl\(candidate\)/);
  // ...and the winner is chosen by the destination contract rather than by
  // alias order, so a search-engine page can never outrank a retailer link.
  assert.match(productShelfSource, /selectCommerceDestination\(/);
});

// ── 5. URL and image longevity ──────────────────────────────────────────────

test('persisted merchant URLs are stable https, never signed or tokenized', () => {
  const analysis = mapScanIdentifyToAnalysis(backendResponse());
  for (const option of reopen(serializeScan(analysis)).purchaseOptions) {
    assert.match(option.productUrl, /^https:\/\//);
    assert.doesNotMatch(option.productUrl, /token=|Signature=|X-Amz-|\/storage\/v1\/object\/sign/);
  }
});

test('non-https and malformed URLs are dropped, not persisted', () => {
  const snapshot = normalizePurchaseOptions([
    { title: 'Insecure', retailer: 'R1', purchaseUrl: 'http://insecure.example.com/p' },
    { title: 'Filed', retailer: 'R2', purchaseUrl: 'file:///tmp/x' },
    { title: 'Good', retailer: 'R3', purchaseUrl: 'https://good.example.com/p' },
  ]);
  // http/file are rejected as links; entries survive only via title+retailer.
  const good = snapshot.find((o) => o.retailer === 'R3');
  assert.equal(good.productUrl, 'https://good.example.com/p');
  for (const option of snapshot) {
    assert.ok(option.productUrl === null || option.productUrl.startsWith('https://'));
  }
});

test('card stays visible when the thumbnail cannot be resolved', () => {
  const snapshot = normalizePurchaseOptions([
    { title: 'No Image', retailer: 'AllSaints', price: 519,
      purchaseUrl: 'https://allsaints.com/p/1' },
  ]);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].imageUrl, null);
  assert.equal(snapshot[0].retailer, 'AllSaints');
  assert.equal(snapshot[0].productUrl, 'https://allsaints.com/p/1');
  // Shelf falls back to a placeholder instead of hiding the card.
  assert.match(productShelfSource, /ProductImagePlaceholder category=\{imageCategory\}/);
  assert.match(productShelfSource, /const showImage = !!productImageUrl && !failedImages\[productKey\]/);
});

// ── 6. Backward compatibility ───────────────────────────────────────────────

for (const [name, stored] of [
  ['missing field (legacy record)', undefined],
  ['null commerce', null],
  ['empty array', []],
  ['malformed object', { nope: true }],
  ['array of junk', [null, 3, 'x', []]],
  ['snake_case alias', undefined],
]) {
  test(`legacy record hydrates safely: ${name}`, () => {
    const record = { id: 's', result: 'r', products: [], attributes: {}, source: 'scan' };
    if (stored !== undefined) record.purchaseOptions = stored;
    const hydrated = hydrateSavedScan(record);
    assert.ok(Array.isArray(hydrated.purchaseOptions));
    assert.equal(hydrated.purchaseOptions.length, 0, 'no offers invented');
    assert.equal(hydrated.result, 'r', 'rest of the record is untouched');
  });
}

test('snake_case purchase_options alias normalizes into the card model', () => {
  const hydrated = hydrateSavedScan({
    id: 's',
    purchase_options: [{ title: 'Aliased', retailer: 'Ssense', purchaseUrl: 'https://ssense.com/p/1' }],
  });
  assert.equal(hydrated.purchaseOptions.length, 1);
  assert.equal(hydrated.purchaseOptions[0].productUrl, 'https://ssense.com/p/1');
});

test('a single option renders (one or many both supported)', () => {
  const analysis = mapScanIdentifyToAnalysis(
    backendResponse({ recommendedProducts: [offer(1, 'AllSaints', 519)] }),
  );
  assert.equal(reopen(serializeScan(analysis)).purchaseOptions.length, 1);
  // Gate admits a single option — proven behaviorally in
  // commerceShelfWiring.test.js; this just confirms it is still wired here.
  assert.match(analysisCardSource, /resolvePurchaseShelfMode\(\s*purchaseOptions\.length/);
});

test('non-commerce scan persists and reopens with no fake offers', () => {
  const analysis = mapScanIdentifyToAnalysis(
    backendResponse({ recommendedProducts: [], similarityMatches: [] }),
  );
  const reopened = reopen(serializeScan(analysis));
  assert.equal(reopened.purchaseOptions.length, 0);
  assert.equal(reopened.products.length, 0);
  assert.equal(reopened.result, 'Black leather biker jacket', 'analysis still visible');
});

// ── 7. Update / merge behavior ──────────────────────────────────────────────

test('metadata-only cloud update never resets stored commerce', () => {
  assert.match(
    cloudSource,
    /if \(incomingPurchaseOptions\.length > 0\) \{/,
  );
  assert.match(cloudSource, /select\('id, deleted_at, analysis_result, products, purchase_options'\)/);
});

test('local/cloud merge cannot drop a non-empty snapshot', () => {
  const { mergeLocalAndCloudScans } = load('services/savedScansCloud.ts');
  const local = {
    id: 'scan_1', savedAt: '2026-07-25T00:00:00.000Z',
    purchaseOptions: [{ retailer: 'AllSaints', productUrl: 'https://allsaints.com/p/1' }],
    products: [],
  };
  // Cloud copy is newer but has no commerce (older client wrote it).
  const cloud = { id: 'scan_1', savedAt: '2026-07-26T00:00:00.000Z', purchaseOptions: [], products: [] };
  const [merged] = mergeLocalAndCloudScans([local], [cloud]);
  assert.equal(merged.savedAt, '2026-07-26T00:00:00.000Z', 'winner selection unchanged');
  assert.equal(merged.purchaseOptions.length, 1, 'snapshot carried forward');
});

test('repeated save produces no duplicate cards', () => {
  const analysis = mapScanIdentifyToAnalysis(backendResponse());
  const once = reopen(serializeScan(analysis));
  const twice = reopen(serializeScan(analysis));
  assert.deepEqual(
    once.purchaseOptions.map((o) => o.productUrl),
    twice.purchaseOptions.map((o) => o.productUrl),
  );
  // Duplicate offers in one payload collapse via the canonical fingerprint.
  const dup = offer(1, 'AllSaints', 519);
  assert.equal(normalizePurchaseOptions([dup, { ...dup }]).length, 1);
});

// ── 8. Payload hygiene and size ─────────────────────────────────────────────

test('persisted snapshot strips raw provider and debug fields', () => {
  const snapshot = normalizePurchaseOptions([{
    title: 'Offer', retailer: 'AllSaints', purchaseUrl: 'https://allsaints.com/p/1',
    rawProviderResponse: { huge: 'x'.repeat(5000) },
    promptContext: 'system prompt', authorization: 'Bearer token', apiKey: 'sk-live-123',
    httpDebug: { headers: {} }, imageBytes: 'base64...', analytics: { events: new Array(50).fill('e') },
  }]);
  const serialized = JSON.stringify(snapshot);
  for (const banned of ['rawProviderResponse', 'promptContext', 'authorization',
    'apiKey', 'sk-live-123', 'httpDebug', 'imageBytes', 'analytics', 'Bearer']) {
    assert.ok(!serialized.includes(banned), `persisted payload must not contain ${banned}`);
  }
});

test('commerce array is bounded and a 25-scan library stays small', () => {
  const many = Array.from({ length: 200 }, (_, i) => offer(i, `Retailer${i}`, 100 + i));
  const bounded = normalizePurchaseOptions(many);
  assert.equal(bounded.length, 24, 'canonical MAX_OPTIONS cap applies');

  const analysis = mapScanIdentifyToAnalysis(backendResponse({ recommendedProducts: many }));
  const oneScan = JSON.stringify(serializeScan(analysis)).length;
  const fullLibrary = oneScan * 25; // services/library.js MAX_SCANS
  assert.ok(oneScan < 40_000, `one worst-case scan ${oneScan}B should stay under 40KB`);
  assert.ok(fullLibrary < 1_000_000, `full 25-scan library ${fullLibrary}B should stay under 1MB`);
});

// ── 9. Item association and isolation ───────────────────────────────────────

test('multi-item scans are not persisted until one garment is chosen', () => {
  // Guarantees a saved scan is single-item, so offers cannot pool under the
  // wrong garment. app.js skips saving while confirmationCandidates exist.
  assert.match(appSource, /analysis\.confirmationCandidates\?\.length \|\|/);
  const analysis = mapScanIdentifyToAnalysis(backendResponse({
    detectedGarments: [
      { candidateId: 'g1', category: 'outerwear', subtype: 'biker jacket', confidenceScore: 0.9 },
      { candidateId: 'g2', category: 'footwear', subtype: 'chelsea boot', confidenceScore: 0.8 },
    ],
  }));
  assert.ok(
    Array.isArray(analysis.confirmationCandidates) && analysis.confirmationCandidates.length >= 2,
    'multi-item scan surfaces candidates instead of saving',
  );
});

test('two saved single-item scans keep their own distinct offers', () => {
  const jacket = mapScanIdentifyToAnalysis(backendResponse({
    recommendedProducts: [offer(1, 'AllSaints', 519)],
  }));
  const boots = mapScanIdentifyToAnalysis(backendResponse({
    recommendedProducts: [offer(9, 'Dr Martens', 180)],
  }));
  const savedJacket = reopen(serializeScan(jacket, 'scan_jacket'));
  const savedBoots = reopen(serializeScan(boots, 'scan_boots'));

  assert.equal(savedJacket.purchaseOptions[0].retailer, 'AllSaints');
  assert.equal(savedBoots.purchaseOptions[0].retailer, 'Dr Martens');
  assert.notDeepEqual(savedJacket.purchaseOptions, savedBoots.purchaseOptions);
  // Offers stay keyed to their own scan id.
  assert.equal(savedJacket.id, 'scan_jacket');
  assert.equal(savedBoots.id, 'scan_boots');
});

test('cloud reads are scoped to the authenticated user and skip soft-deletes', () => {
  assert.match(cloudSource, /\.eq\('user_id', user\.id\)/);
  assert.match(cloudSource, /deleted_at/);
  assert.match(cloudSource, /if \(scan\.deletedAt\) continue;/);
});

// ── 10. Offline / no-refetch behavior ───────────────────────────────────────

test('reopened detail renders from stored commerce with no commerce fetch', () => {
  const analysis = mapScanIdentifyToAnalysis(backendResponse());
  const reopened = reopen(serializeScan(analysis));
  assert.equal(reopened.purchaseOptions.length, 3);
  // The detail modal is driven purely by the selected record.
  assert.match(librarySreenSource, /Reopen saved scan — no backend call, no useKScan involvement/);
  assert.doesNotMatch(
    librarySreenSource,
    /searchVintedSecondhand|searchSneakers|mapScanIdentifyToAnalysis/,
  );
});
