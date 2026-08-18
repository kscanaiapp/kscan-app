/**
 * v127 client commerce hydration — deterministic lifecycle tests.
 *
 * These exercise the real service module against a mocked Supabase transport,
 * so "MODE B was dispatched" means an actual invoke with an actual body, not a
 * spy on our own wrapper. The hook-level guards that cannot be imported under
 * `node --test` (React) are asserted against source instead, and those are
 * called out individually.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

// ── Transport harness ────────────────────────────────────────────────────────

let INVOKES = [];
let RESPONDER = () => ({ data: null, error: { message: 'not configured' } });

function loadCommerceHydration() {
  const source = fs.readFileSync(
    path.join(ROOT, 'services', 'commerceHydration.ts'),
    'utf8',
  );
  const ts = require('typescript');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const mod = { exports: {} };
  const requireShim = (id) => {
    if (id === './supabaseClient') {
      return {
        supabase: {
          functions: {
            invoke: async (fn, opts) => {
              INVOKES.push({ fn, body: opts?.body, signal: opts?.signal });
              return RESPONDER(fn, opts);
            },
          },
        },
      };
    }
    if (id.startsWith('node:')) return require(id);
    return {};
  };
  const fnBody = new Function('exports', 'module', 'require', js);
  fnBody(mod.exports, mod, requireShim);
  return mod.exports;
}

const hydration = loadCommerceHydration();

function reset() {
  INVOKES = [];
  RESPONDER = () => ({ data: null, error: { message: 'not configured' } });
}

const EVIDENCE = {
  identification: { item_type: 'outerwear', subtype: 'moto jacket', primary_color: 'black' },
  attributes: { category: 'outerwear' },
};

function offer(url, extra = {}) {
  return {
    id: 'id-' + url.slice(-6),
    title: 'Saint Laurent L01 Leather Motorcycle Jacket',
    productUrl: url,
    source: 'RetailerNeutral',
    price: '$4,500',
    imageUrl: 'https://cdn.example-shop.test/i.jpg',
    ...extra,
  };
}

// ── 1. MODE B request shape and privacy ──────────────────────────────────────

test('MODE B body carries structured evidence and no image field', () => {
  const body = hydration.buildCommerceOnlyBody(EVIDENCE);
  assert.equal(body.requestMode, 'commerce_only');
  assert.deepEqual(body.identification, EVIDENCE.identification);
  assert.deepEqual(body.attributes, EVIDENCE.attributes);
  for (const forbidden of ['imageBase64', 'image', 'imageUrl', 'imageUri', 'photo', 'base64', 'evidence']) {
    assert.equal(forbidden in body, false, `MODE B body carries ${forbidden}`);
  }
});

test('PRIVACY: an image field smuggled into identification is stripped before send', () => {
  const body = hydration.buildCommerceOnlyBody({
    identification: {
      item_type: 'outerwear',
      imageBase64: 'data:image/jpeg;base64,AAAA',
      photo: 'file:///private/scan.jpg',
    },
  });
  assert.equal('imageBase64' in body.identification, false);
  assert.equal('photo' in body.identification, false);
  assert.equal(body.identification.item_type, 'outerwear');
});

test('the client never rebuilds commerce query intelligence', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'commerceHydration.ts'), 'utf8');
  // Query construction, ranking and caching are backend concerns (v125/v124/v127).
  for (const forbidden of ['buildWeightedCommerceQueries', 'scoreProductAgreement', 'commerceCache', 'brand_confidence']) {
    assert.equal(src.includes(forbidden), false, `client duplicates backend concern: ${forbidden}`);
  }
});

// ── 2. Response normalization ────────────────────────────────────────────────

test('MODE B success normalizes to a hydrated shelf', async () => {
  reset();
  RESPONDER = () => ({
    data: {
      status: 'completed',
      purchaseOptions: [offer('https://a.test/1'), offer('https://b.test/2')],
      commerce: { provider: 'serper', enrichmentCandidates: [] },
      funnel: { cacheHit: false },
    },
    error: null,
  });
  const result = await hydration.fetchDeferredCommerce(EVIDENCE);
  assert.equal(result.status, 'success');
  assert.equal(result.purchaseOptions.length, 2);
  assert.equal(result.cacheHit, false);
  assert.equal(INVOKES.length, 1);
  assert.equal(INVOKES[0].fn, 'scan-identify');
  assert.equal(INVOKES[0].body.requestMode, 'commerce_only');
});

test('MODE B empty is a soft outcome, not an error', async () => {
  reset();
  RESPONDER = () => ({
    data: { status: 'completed', purchaseOptions: [], commerce: { available: false, retryable: true } },
    error: null,
  });
  const result = await hydration.fetchDeferredCommerce(EVIDENCE);
  assert.equal(result.status, 'empty');
  assert.equal(result.purchaseOptions.length, 0);
  assert.equal(result.retryable, true);
});

test('MODE B transport error is soft and retryable', async () => {
  reset();
  RESPONDER = () => ({ data: null, error: { message: 'boom 500' } });
  const result = await hydration.fetchDeferredCommerce(EVIDENCE);
  assert.equal(result.status, 'error');
  assert.equal(result.retryable, true);
  assert.equal(result.purchaseOptions.length, 0);
});

test('MODE B abort yields a non-retryable error and no crash', async () => {
  reset();
  const controller = new AbortController();
  controller.abort();
  const result = await hydration.fetchDeferredCommerce(EVIDENCE, { signal: controller.signal });
  assert.equal(result.status, 'error');
  assert.equal(result.errorType, 'aborted');
  // An abort is a deliberate cancellation; retrying it is not a fix.
  assert.equal(result.retryable, false);
  assert.equal(INVOKES.length, 0, 'aborted hydration still hit the network');
});

test('a malformed offer without a destination is not shown as a purchase option', async () => {
  reset();
  RESPONDER = () => ({
    data: {
      status: 'completed',
      purchaseOptions: [offer('https://ok.test/1'), { title: 'no url' }, { productUrl: 'https://x.test/2' }],
      commerce: {},
    },
    error: null,
  });
  const result = await hydration.fetchDeferredCommerce(EVIDENCE);
  assert.equal(result.purchaseOptions.length, 1);
});

test('backend cache hit hydrates normally and is reported', async () => {
  reset();
  RESPONDER = () => ({
    data: {
      status: 'completed',
      purchaseOptions: [offer('https://a.test/1')],
      commerce: { provider: 'serper' },
      funnel: { cacheHit: true, discoveryMs: 0 },
    },
    error: null,
  });
  const result = await hydration.fetchDeferredCommerce(EVIDENCE);
  assert.equal(result.status, 'success');
  assert.equal(result.cacheHit, true);
});

test('CLIENT CACHE: the hydration service stores nothing between calls', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'commerceHydration.ts'), 'utf8');
  // No module-level mutable store — the backend owns caching.
  assert.equal(/^const\s+\w*[Cc]ache\w*\s*=\s*new (Map|Set)/m.test(src), false);
  assert.equal(src.includes('AsyncStorage'), false);
});

// ── 3. Enrichment merge ──────────────────────────────────────────────────────

test('enrichment updates an existing offer instead of appending a duplicate', () => {
  const current = [offer('https://a.test/1'), offer('https://b.test/2')];
  const enriched = [offer('https://a.test/1', { price: '$4,200', brand: 'Saint Laurent' })];
  const merged = hydration.mergeEnrichedOffers(current, enriched);

  assert.equal(merged.length, 2, 'enrichment changed the shelf size');
  assert.equal(merged[0].price, '$4,200');
  assert.equal(merged[0].brand, 'Saint Laurent');
  assert.equal(merged[1].price, '$4,500');
  const urls = merged.map((o) => o.productUrl);
  assert.equal(new Set(urls).size, urls.length);
});

test('enrichment never trades a populated field for an empty one', () => {
  const current = [offer('https://a.test/1', { price: '$4,500', imageUrl: 'https://cdn.test/good.jpg' })];
  const enriched = [offer('https://a.test/1', { price: '', imageUrl: null, brand: 'Saint Laurent' })];
  const merged = hydration.mergeEnrichedOffers(current, enriched);

  assert.equal(merged[0].price, '$4,500');
  assert.equal(merged[0].imageUrl, 'https://cdn.test/good.jpg');
  assert.equal(merged[0].brand, 'Saint Laurent');
  assert.ok(merged[0].productUrl, 'a valid product URL was lost');
});

test('RETAILER NEUTRALITY: merge preserves backend ordering exactly', () => {
  const current = [
    offer('https://a.test/1', { source: 'Poshmark' }),
    offer('https://b.test/2', { source: 'Farfetch' }),
    offer('https://c.test/3', { source: 'RetailerNeutral' }),
  ];
  const merged = hydration.mergeEnrichedOffers(current, [offer('https://c.test/3', { price: '$1' })]);
  assert.deepEqual(merged.map((o) => o.productUrl), current.map((o) => o.productUrl));

  const src = fs.readFileSync(path.join(ROOT, 'services', 'commerceHydration.ts'), 'utf8');
  for (const forbidden of ['.sort(', 'Farfetch', 'Poshmark', 'KicksCrew']) {
    assert.equal(src.includes(forbidden), false, `client re-orders or names ${forbidden}`);
  }
});

// ── 4. Contract carriage (deferral marker) ───────────────────────────────────

test('MODE A deferral marker is carried through normalization', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'scanIdentification.ts'), 'utf8');
  assert.ok(src.includes("(commerceMeta as Record<string, unknown>).deferred === true"));
  assert.ok(src.includes('out.commerceDeferred = true;'));

  const mapper = fs.readFileSync(path.join(ROOT, 'services', 'scanIdentificationMapper.ts'), 'utf8');
  assert.ok(mapper.includes('resp.commerceDeferred === true'));
  assert.ok(mapper.includes('analysis.commerceEvidence'));
});

test('FLAG OFF: a response without commerce.deferred keeps Phase 3 behavior', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'scanIdentification.ts'), 'utf8');
  // The marker is only set on an explicit true, so an absent or malformed
  // commerce block leaves recommendedProducts read exactly as before.
  const idx = src.indexOf('out.commerceDeferred = true;');
  const guard = src.slice(Math.max(0, idx - 400), idx);
  assert.ok(guard.includes('=== true'), 'deferral is inferred rather than explicit');

  const mapper = fs.readFileSync(path.join(ROOT, 'services', 'scanIdentificationMapper.ts'), 'utf8');
  assert.ok(mapper.includes('if (resp.commerceDeferred === true) {'));
});

// ── 5. Hook lifecycle guards (source-level) ──────────────────────────────────

// Android's Scanner is a multi-item queue (scanItems / selectScanItem): the
// displayed item can change without a new scan attempt, so single-flight and
// stale-response protection are keyed per DISPLAYED ITEM (evidence object
// identity) rather than per scan generation. This mirrors the existing
// secondhandRequestRef pattern enrichDisplayedAnalysis already uses for the
// identical class of problem (a late sneaker/secondhand response decorating
// the wrong candidate) — see the comment above hydrateDeferredCommerce.

test('SINGLE FLIGHT: one hydration per displayed item, retry may supersede', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  assert.ok(src.includes('commerceRequestedForRef'), 'no single-flight guard');
  assert.ok(src.includes('commerceActiveForRef'), 'no active-request guard');
  assert.ok(src.includes('if (!isRetry && commerceRequestedForRef.current === evidence) return;'));
  assert.ok(src.includes('if (isRetry && commerceActiveForRef.current === evidence) return;'));
  // Keyed by evidence object identity, not a derived string — switching to a
  // different item's evidence naturally clears the guard without an explicit
  // reset, since that object was never seen before.
  assert.ok(src.includes('commerceRequestedForRef.current = evidence;'));
});

test('STALE RESPONSE: request-id guard drops an answer for a no-longer-displayed item', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  assert.ok(src.includes('commerceRequestRef.current += 1;'), 'request id never advances');
  assert.ok(src.includes('if (commerceRequestRef.current !== requestId) return false;'));
  // Bumped at every dispatch (so a request for the currently displayed item
  // always wins a race against a stale one) AND at scan start (so cross-scan
  // answers cannot survive either).
  const dispatchBumpIdx = src.indexOf(
    'commerceRequestRef.current += 1;',
    src.indexOf('const hydrateDeferredCommerce'),
  );
  assert.ok(dispatchBumpIdx > 0, 'no per-dispatch request-id bump');
  const startBumpIdx = src.indexOf('commerceRequestRef.current += 1;');
  const startIdx = src.indexOf('const startInFlight = useCallback');
  assert.ok(startBumpIdx > startIdx && startBumpIdx - startIdx < 900, 'request id is not bumped in startInFlight');
  // Applying a result additionally checks that `analysis` still points at the
  // SAME evidence object before writing it — a second, independent guard
  // beyond the request-id counter, so a late item-B answer can never render
  // into item-A's slot even if some future refactor weakens the counter.
  assert.ok(src.includes('prev && prev.commerceEvidence === evidence ? updateAnalysis(prev) : prev'));
});

test('UNMOUNT SAFETY: no state write after unmount, and hydration is aborted', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  assert.ok(src.includes('if (!isMountedRef.current) return false;'));
  assert.ok(src.includes('commerceAbortRef.current?.abort();'));
});

test('SCAN STATUS IS NOT REGRESSED: hydration only touches commerce state', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  const start = src.indexOf('const hydrateDeferredCommerce');
  const end = src.indexOf('const retryCommerce');
  assert.ok(start > 0 && end > start);
  const body = src.slice(start, end);
  // Never re-enters a scan loading state, never fails the scan.
  assert.equal(/setStatus\(/.test(body), false, 'hydration mutates scan status');
  assert.equal(/setError\(/.test(body), false, 'hydration sets a scan error');
  assert.equal(/setIsAnalyzing\(/.test(body), false, 'hydration re-enters analyzing');
});

test('RETRY: reuses structured evidence and issues MODE B only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  const start = src.indexOf('const retryCommerce');
  const body = src.slice(start, start + 400);
  assert.ok(body.includes('hydrateDeferredCommerce(analysis, { isRetry: true })'));
  // No scanner/Gemini re-entry on a commerce retry.
  for (const forbidden of ['runScannerIdentification', 'identifyScanImage', 'prepareScannerEvidence']) {
    assert.equal(body.includes(forbidden), false, `commerce retry calls ${forbidden}`);
  }
});

// ── 6. Late-commerce persistence ─────────────────────────────────────────────

test('PERSISTENCE: late commerce updates the same record and never appends', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'library.js'), 'utf8');
  const start = src.indexOf('export async function attachScanPurchaseOptions');
  assert.ok(start > 0, 'no late-commerce persistence path');
  const body = src.slice(start, src.indexOf('\n}', src.indexOf('} catch {', start)));

  // Updates in place by record id — no second scan row.
  assert.ok(body.includes("existing.findIndex((item) => item && item.id === id)"));
  assert.ok(body.includes('updated[index] = { ...target, purchaseOptions: normalized };'));
  assert.equal(/\[scan, \.\.\.existing\]/.test(body), false, 'attach creates a new record');
  // Ownership is enforced inside the serialized section, as elsewhere.
  assert.ok(body.includes('enqueueLibraryMutation'));
  assert.ok(body.includes('isActorRequestCurrent(actorRequest)'));
  // An empty shelf must not clear a populated one.
  assert.ok(body.includes('if (normalized.length === 0) return false;'));
});

test('SAVE RACE: attach is keyed off each item\'s saved id, with no timer anywhere', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = src.indexOf('const attachedCommerceRef');
  assert.ok(start > 0, 'no late-commerce attach effect');
  const body = src.slice(start, start + 1400);

  // Android saves per item (persistScanItem / savedScanIdsByItem), not as a
  // single scan record, so this iterates scanItems rather than reading one
  // savedScanId — correct whether commerce arrives before or after THAT
  // item's save resolves, and for every item, not only the displayed one.
  assert.ok(body.includes('for (const item of scanItems) {'));
  assert.ok(body.includes('const savedId = savedScanIdsByItem[item.id];'));
  assert.ok(body.includes('if (!savedId) continue;'));
  assert.ok(body.includes('attachScanPurchaseOptions(savedId, options'));
  assert.equal(/setTimeout|setInterval/.test(body), false, 'save race synchronized with a timer');
});

test('REOPEN: no commerce request is issued from the library surface', () => {
  const library = fs.readFileSync(path.join(ROOT, 'app', 'library.tsx'), 'utf8');
  for (const forbidden of ['fetchDeferredCommerce', 'commerce_only', 'scan-identify']) {
    assert.equal(library.includes(forbidden), false, `library reopen triggers ${forbidden}`);
  }
});

test('DISPATCH: hydration is gated on the deferral marker only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  const start = src.indexOf("if (status !== 'result') return;");
  assert.ok(start > 0);
  const body = src.slice(start, start + 300);
  assert.ok(body.includes('if (!analysis?.commerceDeferred) return;'));
  assert.ok(body.includes('hydrateDeferredCommerce(analysis)'));
});

// ── 7. Multi-item association (Android only) ─────────────────────────────────
//
// Android's Scanner can complete several items in one queue. Item A's commerce
// must never land on item B, whether B is now displayed or A is still
// resolving in the background.

test('MULTI-ITEM: each item carries its own stable id into commerce evidence', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  assert.ok(
    src.includes('item.analysis.commerceEvidence.itemId = item.id;'),
    'items are not individually identifiable for commerce hydration',
  );
  // Stashed client-side only — buildCommerceOnlyBody() copies a fixed key
  // allowlist (identification/attributes/searchQueries/market), so itemId can
  // never reach the network even though it rides on the evidence object.
  const bodySrc = fs.readFileSync(path.join(ROOT, 'services', 'commerceHydration.ts'), 'utf8');
  const buildStart = bodySrc.indexOf('export function buildCommerceOnlyBody');
  const buildBody = bodySrc.slice(buildStart, buildStart + 1200);
  assert.equal(buildBody.includes('itemId'), false, 'itemId leaks into the MODE B body');
});

test('MULTI-ITEM: a hydrated result updates the matching scanItems entry by id', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  const start = src.indexOf('const applyToItem');
  assert.ok(start > 0, 'no per-item apply path');
  const body = src.slice(start, start + 500);
  assert.ok(body.includes('it.id === itemId'), 'update does not match by item id');
  assert.ok(body.includes('setScanItems((current) => current.map('), 'update does not target scanItems');
  // The displayed singleton is updated independently, guarded by the SAME
  // evidence-object check the stale-response test verifies — so a background
  // item's hydration can update scanItems without ever touching whatever the
  // user currently has on screen.
  assert.ok(body.includes('prev && prev.commerceEvidence === evidence'));
});
