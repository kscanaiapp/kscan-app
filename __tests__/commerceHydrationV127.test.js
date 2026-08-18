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

// P1-C replaced the single global abort/single-flight slot with a per-item
// job registry (services/commerceJobScheduler.ts) — switching the selected
// item must not abort or discard another item's job. The scheduling
// DECISIONS are proven behaviorally in __tests__/commerceJobScheduler.test.js
// (real execution against the hostile item-switch matrix); these remaining
// checks confirm the hook actually calls that module rather than re-inlining
// the logic it replaced.

test('SINGLE FLIGHT / STALE RESPONSE: the hook delegates to the per-item scheduler, not an inlined global guard', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  assert.ok(
    src.includes("from '../services/commerceJobScheduler'"),
    'hook no longer imports the per-item scheduler',
  );
  for (const fn of ['shouldDispatchCommerceHydration', 'isCommerceJobCurrent', 'isCommerceJobVisible']) {
    assert.ok(src.includes(fn), `hook does not call ${fn}`);
  }
  // The pre-P1-C single global slots must not have come back.
  for (const removed of ['commerceRequestedForRef', 'commerceActiveForRef', 'commerceAbortRef', 'commerceRequestRef']) {
    assert.equal(src.includes(removed), false, `${removed} reintroduces the single global commerce slot P1-C removed`);
  }
  // Applying a result additionally checks that `analysis` still points at the
  // SAME evidence object before writing it — a second, independent guard
  // beyond the scheduler, so a late item-B answer can never render into
  // item-A's slot even if some future refactor weakens the scheduler.
  assert.ok(src.includes('prev && prev.commerceEvidence === evidence ? updateAnalysis(prev) : prev'));
});

test('WIRING: every helper hooks/useKScan.js imports from commerceJobScheduler is exported by it', () => {
  // The same class of defect as the original P0 (app.js importing a helper
  // services/library never exported): a typo here would be a runtime
  // TypeError the very first time a deferred scan hydrates, invisible to a
  // source-text-only check unless it actually resolves the import.
  const hookSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  const schedulerSrc = fs.readFileSync(path.join(ROOT, 'services', 'commerceJobScheduler.ts'), 'utf8');
  const exported = [...schedulerSrc.matchAll(/^export\s+function\s+(\w+)/gm)].map((m) => m[1]);

  const importRe = /import\s*\{([^}]+)\}\s*from\s*'\.\.\/services\/commerceJobScheduler'/;
  const match = hookSrc.match(importRe);
  assert.ok(match, 'hook does not import from ../services/commerceJobScheduler');
  const named = match[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
  assert.ok(named.length > 0);
  for (const name of named) {
    assert.ok(exported.includes(name), `hook imports ${name}, commerceJobScheduler does not export it`);
  }
});

test('SCAN SUPERSESSION: a new scan bumps the generation and aborts every item\'s job at once', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  const startIdx = src.indexOf('const startInFlight = useCallback');
  assert.ok(startIdx > 0, 'startInFlight not found');
  const body = src.slice(startIdx, startIdx + 900);
  assert.ok(body.includes('commerceScanGenerationRef.current += 1;'), 'new scan does not bump the commerce generation');
  assert.ok(
    body.includes('for (const job of commerceJobsRef.current.values()) job.controller?.abort();'),
    'new scan does not abort every item\'s in-flight commerce job',
  );
});

test('UNMOUNT SAFETY: every in-flight job is aborted, and item switching aborts none', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  assert.ok(src.includes('if (!isMountedRef.current) return false;'));
  // Unmount aborts every remaining job.
  const unmountIdx = src.indexOf('hook unmounts');
  const unmountBody = src.slice(unmountIdx, unmountIdx + 300);
  assert.ok(unmountBody.includes('for (const job of commerceJobsRef.current.values()) job.controller?.abort();'));
  // selectScanItem must never abort a job — it only changes what is displayed.
  const selectStart = src.indexOf('const selectScanItem = useCallback');
  const selectEnd = src.indexOf('}, [status, scanItems, enrichDisplayedAnalysis]);');
  const selectBody = src.slice(selectStart, selectEnd);
  assert.equal(selectBody.includes('.abort()'), false, 'selecting an item aborts a commerce job — the P1-C defect');
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

// ── 8. Module wiring (regression: v127 imported helpers that did not exist) ──
//
// The v127 late-commerce effect was ported from the other platform's app.js
// together with its call sites but not its helpers, so `app.js` imported
// `selectPurchaseOptionsSnapshot` from a library module that never exported it.
// Babel resolves a missing named export to `undefined`, so this was not a build
// error — it was a TypeError thrown inside the effect on every saved scan.
//
// These tests are executable: they read the real module's real export list.

function libraryExports() {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'library.js'), 'utf8');
  return [...src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1]);
}

test('WIRING: every helper app.js imports from services/library is exported by it', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const exported = libraryExports();

  // Every `import { ... } from './services/library'` specifier must resolve.
  const importRe = /import\s*\{([^}]+)\}\s*from\s*'\.\/services\/library'/g;
  const named = [];
  for (const match of app.matchAll(importRe)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) named.push(name);
    }
  }

  assert.ok(named.length > 0, 'no library import found in app.js');
  for (const name of named) {
    assert.ok(
      exported.includes(name),
      `app.js imports ${name} from services/library, which does not export it`,
    );
  }
});

test('WIRING: the commerce snapshot selector exists and is behaviorally correct', () => {
  assert.ok(
    libraryExports().includes('selectPurchaseOptionsSnapshot'),
    'services/library.js does not export selectPurchaseOptionsSnapshot',
  );

  const src = fs.readFileSync(path.join(ROOT, 'services', 'library.js'), 'utf8');
  const start = src.indexOf('export function selectPurchaseOptionsSnapshot');
  const body = src.slice(start, src.indexOf('\n}', start));
  // Precedence must not be widened to `products`: that shelf is catalog
  // similarity, not live commerce.
  assert.ok(body.includes('analysis.purchaseOptions'));
  assert.ok(body.includes('analysis.recommendedProducts'));
  assert.equal(/analysis\.products/.test(body), false, 'similarity matches relabelled as offers');
});

test('WIRING: no identifier from the mis-ported Elise effect survives in app.js', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  // These were referenced by an effect copied from the other platform without
  // its imports or its `useLocalSearchParams` declarations. The dependency
  // array is evaluated on every render, so a single surviving reference is a
  // ReferenceError that prevents the Scan screen from mounting.
  // Collect every top-level binding: import specifiers plus declarations. A
  // reference is only safe if it resolves to one of them.
  const bound = new Set();
  for (const match of app.matchAll(/import\s*(?:\w+\s*,\s*)?\{([^}]+)\}\s*from/g)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name) bound.add(name);
    }
  }
  for (const match of app.matchAll(/(?:const|let|var|function)\s+(\w+)/g)) {
    bound.add(match[1]);
  }

  for (const identifier of [
    'returnToSessionId',
    'visualContextIntentId',
    'consumeVisualContextScanIntent',
    'isVisualContextRevisionCurrent',
    'appendVisualContextEntry',
  ]) {
    assert.ok(
      !app.includes(identifier) || bound.has(identifier),
      `app.js references ${identifier} without declaring or importing it`,
    );
  }
});

test('PERSISTENCE: the attach key is content-derived, so enrichment still persists', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = app.indexOf('attachedCommerceRef');
  assert.ok(start > 0, 'no late-commerce attach effect');
  const body = app.slice(start, start + 1400);

  // Enrichment replaces offers in place, so the shelf length is invariant
  // across the enrichment hop. A length-keyed guard therefore treats enriched
  // data as already-written and silently drops it.
  assert.ok(
    body.includes('purchaseOptionsFingerprint(options)'),
    'attach key is not content-derived — enriched offers will not persist',
  );
  assert.equal(
    /:\s*'\s*\+\s*options\.length/.test(body), false,
    'attach key still uses the offer count',
  );
});

test('PERSISTENCE: the fingerprint distinguishes an enriched shelf of equal length', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'library.js'), 'utf8');
  const start = src.indexOf('export function purchaseOptionsFingerprint');
  assert.ok(start > 0, 'no fingerprint helper');
  const end = src.indexOf('\n}', src.indexOf('.join(', start));
  // Execute the real helper rather than asserting on its text.
  const fingerprint = new Function(
    'return ' + src.slice(start + 'export '.length, end + 2),
  )();

  const discovery = [
    { title: 'Moto Jacket', productUrl: 'https://s.test/a', price: '$450', imageUrl: '' },
    { title: 'Suede Bomber', productUrl: 'https://s.test/b', price: '$300', imageUrl: '' },
  ];
  // What bounded URL enrichment returns: same offers, better data, same count.
  const enriched = [
    { title: 'Moto Jacket', productUrl: 'https://s.test/a', price: '$399', imageUrl: 'https://c.test/a.jpg' },
    { title: 'Suede Bomber', productUrl: 'https://s.test/b', price: '$300', imageUrl: '' },
  ];

  assert.equal(discovery.length, enriched.length, 'fixture does not model in-place enrichment');
  assert.notEqual(
    fingerprint(discovery), fingerprint(enriched),
    'fingerprint cannot distinguish an enriched shelf — enrichment will not persist',
  );
  // Stable for identical content, so no redundant write on every rerender.
  assert.equal(fingerprint(discovery), fingerprint(discovery.map((o) => ({ ...o }))));
  assert.equal(fingerprint([]), '');
});
