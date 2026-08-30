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

test('SINGLE FLIGHT: one hydration per scan result, retry may supersede', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  assert.ok(src.includes('commerceRequestedRef'), 'no single-flight guard');
  assert.ok(src.includes("if (!isRetry && commerceRequestedRef.current === flightKey) return;"));
  assert.ok(src.includes("if (isRetry && commerceRequestedRef.current === `${flightKey}:active`) return;"));
});

test('STALE RESPONSE: generation guard drops a superseded answer', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
  assert.ok(src.includes('commerceGenerationRef.current += 1;'), 'generation never advances');
  assert.ok(src.includes('if (commerceGenerationRef.current !== generation) return false;'));
  // The bump happens when a new scan starts, so an old answer is inert before
  // the new scan can even finish.
  const bumpIdx = src.indexOf('commerceGenerationRef.current += 1;');
  const startIdx = src.indexOf('const startInFlight = useCallback');
  assert.ok(bumpIdx > startIdx && bumpIdx - startIdx < 900, 'generation bump is not in startInFlight');
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

test('SAVE RACE: attach is keyed off the saved id, with no timer anywhere', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = src.indexOf('const attachedCommerceRef');
  assert.ok(start > 0, 'no late-commerce attach effect');
  const body = src.slice(start, start + 1200);

  // Correct whether commerce arrived before or after the save resolved: the
  // effect simply waits for both facts to be true.
  assert.ok(body.includes("if (status !== 'result' || !savedScanId) return;"));
  assert.ok(body.includes('attachScanPurchaseOptions(savedScanId, options'));
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

// ── 6. Build 32: per-item correlation id (candidateId) ───────────────────────

test('candidateId is omitted from the body when not supplied (every pre-Build-32 caller)', () => {
  const body = hydration.buildCommerceOnlyBody(EVIDENCE);
  assert.equal('candidateId' in body, false);
});

test('candidateId is carried on the body only when supplied, trimmed', () => {
  const body = hydration.buildCommerceOnlyBody({ ...EVIDENCE, candidateId: '  garment-1-outerwear-jacket  ' });
  assert.equal(body.candidateId, 'garment-1-outerwear-jacket');
});

test('a blank candidateId is treated as absent, not sent as an empty string', () => {
  const body = hydration.buildCommerceOnlyBody({ ...EVIDENCE, candidateId: '   ' });
  assert.equal('candidateId' in body, false);
});

test('the response echoes candidateId back only when the backend returned one', async () => {
  reset();
  RESPONDER = () => ({
    data: {
      status: 'completed',
      purchaseOptions: [offer('https://a.test/1')],
      candidateId: 'garment-1-outerwear-jacket',
      commerce: {},
      funnel: {},
    },
    error: null,
  });
  const result = await hydration.fetchDeferredCommerce({ ...EVIDENCE, candidateId: 'garment-1-outerwear-jacket' });
  assert.equal(result.candidateId, 'garment-1-outerwear-jacket');

  reset();
  RESPONDER = () => ({
    data: { status: 'completed', purchaseOptions: [offer('https://a.test/1')], commerce: {}, funnel: {} },
    error: null,
  });
  const noId = await hydration.fetchDeferredCommerce(EVIDENCE);
  assert.equal(noId.candidateId, undefined);
});
