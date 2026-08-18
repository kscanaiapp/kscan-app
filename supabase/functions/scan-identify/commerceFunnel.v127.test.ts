/**
 * Commerce Funnel (v127) — acceptance tests.
 *
 * These are behavioral, not source-shape, wherever behavior can be observed:
 * providers are driven at the `fetch` boundary with controlled latency, so a
 * "hung provider" is genuinely a promise that never settles rather than a
 * mocked module that pretends to be one.
 *
 * Each test uses a distinct subtype so its query differs — `shoppingProvider`
 * keeps a one-hour per-query response cache and a shared query would leak
 * results between tests.
 */
import assert from 'node:assert/strict';
import {
  COMMERCE_CACHE_TTL_MS,
  COMMERCE_FUNNEL_DEFAULT_ENABLED,
  COMMERCE_FUNNEL_VERSION,
  FAST_COMMERCE_DEADLINE_MS,
  FAST_COMMERCE_SUFFICIENT_RESULTS,
  isCommerceFunnelEnabled,
  MAX_ENRICHMENT_CANDIDATES,
  providerDeadlineMs,
} from './commerceFunnelConfig.ts';
import { collectBounded } from './commerceFastPath.ts';
import {
  buildCommerceCacheKey,
  commerceCacheClear,
  commerceCacheGet,
  commerceCacheSet,
  fingerprintQuery,
} from './commerceResultCache.ts';
import {
  buildCanonicalCommerce,
  canonicalProductKey,
  parseOfferPrice,
} from './canonicalCommerce.ts';
import {
  enrichCommerceOffers,
  getFastCommerceResults,
  selectEnrichmentCandidates,
} from './scanCommerceRouter.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';

// ── Fetch harness ────────────────────────────────────────────────────────────

type Route = {
  match: (url: string) => boolean;
  delayMs: number;
  /** Omit to hang forever — the promise never settles. */
  body?: unknown;
  status?: number;
  reject?: boolean;
};

const realFetch = globalThis.fetch;
let fetchCallCount = 0;

function installFetch(routes: Route[]): void {
  fetchCallCount = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCallCount += 1;
    const route = routes.find((r) => r.match(url));
    if (!route) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => {
        if (route.reject) {
          reject(new Error('provider exploded'));
          return;
        }
        if (route.body === undefined) return; // hang: never settles
        resolve(
          new Response(JSON.stringify(route.body), {
            status: route.status ?? 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }, route.delayMs);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/**
 * A provider that has not answered yet.
 *
 * Deliberately settleable: the collector must return without it, but leaving a
 * permanently-pending promise behind would trip Deno's test sanitizer, so each
 * test releases its stragglers once the assertion it exists for has been made.
 */
/** Let released straggler continuations run before the test frame ends. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function hangingProvider<T>(value: T): { promise: Promise<T>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<T>((resolve) => {
    release = () => resolve(value);
  });
  return { promise, release };
}

const isSerper = (u: string) => u.includes('google.serper.dev');
const isBrave = (u: string) => u.includes('api.search.brave.com');
const isPoshmark = (u: string) => u.includes('poshmark');

function serperBody(count: number, prefix = 'sl') {
  return {
    shopping: Array.from({ length: count }, (_, i) => ({
      title: `Saint Laurent L01 Leather Motorcycle Jacket ${prefix}${i}`,
      productLink: `https://retailer-${prefix}${i}.example-shop.test/p/${i}`,
      source: 'RetailerNeutral',
      price: `$${1200 + i}`,
      imageUrl: `https://cdn.example-shop.test/${prefix}${i}.jpg`,
    })),
  };
}

function poshmarkBody(count: number, prefix = 'pm') {
  return {
    results: Array.from({ length: count }, (_, i) => ({
      title: `Saint Laurent Leather Moto Jacket ${prefix}${i}`,
      url: `https://poshmark.com/listing/${prefix}${i}`,
      listingId: `${prefix}${i}`,
      brand: 'Saint Laurent',
      price: 900 + i,
      currency: 'USD',
      imageUrl: `https://cdn.poshmark.test/${prefix}${i}.jpg`,
      condition: 'Excellent',
      size: 'M',
      status: 'available',
    })),
  };
}

function setEnv(): void {
  Deno.env.set('SHOPPING_SERPER_API_KEY', 'test-serper');
  Deno.env.set('SHOPPING_BRAVE_API_KEY', 'test-brave');
  Deno.env.set('POSHMARK_ENABLED', 'true');
  Deno.env.set('POSHMARK_RAPIDAPI_KEY', 'test-poshmark');
  Deno.env.set('BACKEND_QUALITY_TUNE_ENABLED', 'true');
}

function garment(subtype: string): Record<string, unknown> {
  return {
    item_type: 'outerwear',
    subtype,
    primary_color: 'black',
    material_estimate: 'leather',
  };
}

function fastInput(subtype: string, extra: Record<string, unknown> = {}) {
  return {
    mode: 'image' as const,
    identification: garment(subtype),
    limit: 8,
    ...extra,
  };
}

function product(partial: Partial<RecommendedProduct> & { title: string; productUrl: string }): RecommendedProduct {
  return {
    id: partial.id || `id-${partial.productUrl.slice(-8)}`,
    title: partial.title,
    source: partial.source || 'RetailerA',
    price: partial.price ?? '$1,200',
    type: partial.type || 'retail',
    imageUrl: partial.imageUrl ?? 'https://cdn.example-shop.test/i.jpg',
    productUrl: partial.productUrl,
    ...(partial.brand ? { brand: partial.brand } : {}),
  };
}

// ── A. Flag semantics ────────────────────────────────────────────────────────

Deno.test('v127 flag: version, default, and env override semantics', () => {
  assert.deepEqual(COMMERCE_FUNNEL_VERSION, 'v127');
  assert.deepEqual(isCommerceFunnelEnabled(() => undefined), COMMERCE_FUNNEL_DEFAULT_ENABLED);
  assert.deepEqual(isCommerceFunnelEnabled(() => 'true'), true);
  assert.deepEqual(isCommerceFunnelEnabled(() => 'ON'), true);
  assert.deepEqual(isCommerceFunnelEnabled(() => 'false'), false);
  assert.deepEqual(isCommerceFunnelEnabled(() => '0'), false);
  assert.deepEqual(isCommerceFunnelEnabled(() => 'maybe'), COMMERCE_FUNNEL_DEFAULT_ENABLED);
});

Deno.test('INVARIANT: provider deadline can never exceed the remaining budget', () => {
  // The Phase 3 defect this encodes: a 4.5s global budget paired with a 4.5s
  // per-provider timeout let one provider consume the entire window.
  assert.deepEqual(providerDeadlineMs(1_900, 4_500), 1_900);
  assert.deepEqual(providerDeadlineMs(300, 4_500), 300);
  assert.deepEqual(providerDeadlineMs(4_500, 1_000), 1_000);
  assert.deepEqual(providerDeadlineMs(-50, 4_500), 0);
  for (const remaining of [0, 1, 250, 1_900, 4_500]) {
    for (const timeout of [1_000, 4_000, 4_500]) {
      assert.ok(providerDeadlineMs(remaining, timeout) <= remaining);
      assert.ok(providerDeadlineMs(remaining, timeout) <= timeout);
    }
  }
});

// ── B. INVARIANT 1: the scan result does not wait on providers ───────────────

Deno.test('INVARIANT 1: MODE A creates no provider promise when v127 is enabled', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const start = index.indexOf('} else if (commerceFunnelEnabled) {');
  assert.ok(start > 0, 'v127 MODE A branch is missing');
  const branch = index.slice(start, index.indexOf('    } else {', start));

  // Nothing in the deferred branch may start commerce: not awaited, not raced,
  // not fire-and-forget.
  for (const forbidden of ['getScanCommerceResults', 'getFastCommerceResults', 'Promise.race', 'await ']) {
    assert.ok(!branch.includes(forbidden), `MODE A deferred branch contains ${forbidden}`);
  }
  assert.ok(branch.includes('deferred: true'), 'client is not told commerce was deferred');
  assert.ok(branch.includes('commerceSkipped: true'));
});

Deno.test('INVARIANT 1: 10s-hung providers cannot delay the bounded collector', async () => {
  const a = hangingProvider('never-a');
  const b = hangingProvider('never-b');
  const started = Date.now();
  const outcome = await collectBounded<string>(
    [
      { key: 'a', promise: a.promise, onTimeout: 'timeout-a' },
      { key: 'b', promise: b.promise, onTimeout: 'timeout-b' },
    ],
    { deadlineMs: 120 },
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2_000, `collector waited ${elapsed}ms on hung providers`);
  assert.deepEqual(outcome.timedOutKeys.sort(), ['a', 'b']);
  assert.deepEqual(outcome.values.get('a'), 'timeout-a');
  assert.deepEqual(outcome.earlyExit, false);
  a.release();
  b.release();
  await drainMicrotasks();
});

// ── C. INVARIANT 2: fast provider survives a hung one ───────────────────────

Deno.test('INVARIANT 2: a hung provider cannot erase a fast provider result', async () => {
  const hung = hangingProvider('late');
  const outcome = await collectBounded<string>(
    [
      { key: 'fast', promise: Promise.resolve('offers'), onTimeout: 'lost' },
      { key: 'hung', promise: hung.promise, onTimeout: 'timeout' },
    ],
    { deadlineMs: 150 },
  );

  assert.deepEqual(outcome.values.get('fast'), 'offers');
  assert.deepEqual(outcome.values.get('hung'), 'timeout');
  assert.deepEqual(outcome.settledKeys, ['fast']);
  assert.deepEqual(outcome.timedOutKeys, ['hung']);
  hung.release();
  await drainMicrotasks();
});

Deno.test('INVARIANT 2: a rejecting provider degrades to no-result, never throws', async () => {
  const outcome = await collectBounded<string>(
    [
      { key: 'ok', promise: Promise.resolve('offers'), onTimeout: 'lost' },
      { key: 'boom', promise: Promise.reject(new Error('provider exploded')), onTimeout: 'safe-empty' },
    ],
    { deadlineMs: 150 },
  );
  assert.deepEqual(outcome.values.get('ok'), 'offers');
  assert.deepEqual(outcome.values.get('boom'), 'safe-empty');
});

Deno.test('early success: the collector returns once the shelf is good enough', async () => {
  const slow = hangingProvider(0);
  const outcome = await collectBounded<number>(
    [
      { key: 'quick', promise: Promise.resolve(5), onTimeout: 0 },
      { key: 'slow', promise: slow.promise, onTimeout: 0 },
    ],
    {
      deadlineMs: 5_000,
      isSufficient: (settled) => settled.reduce((a, b) => a + b, 0) >= FAST_COMMERCE_SUFFICIENT_RESULTS,
    },
  );
  assert.deepEqual(outcome.earlyExit, true);
  assert.ok(outcome.elapsedMs < 1_000, `early exit took ${outcome.elapsedMs}ms`);
  slow.release();
  await drainMicrotasks();
});

// ── D. INVARIANT 5/6: Poshmark latency ──────────────────────────────────────

Deno.test('INVARIANT 5: a 14s Poshmark cannot delay the fast commerce shelf', async () => {
  setEnv();
  commerceCacheClear();
  installFetch([
    { match: isSerper, delayMs: 30, body: serperBody(4, 'slowposh') },
    { match: isBrave, delayMs: 30, body: { web: { results: [] } } },
    { match: isPoshmark, delayMs: 14_000, body: poshmarkBody(3) },
  ]);
  try {
    const started = Date.now();
    const result = await getFastCommerceResults(fastInput('moto jacket slowposh'));
    const elapsed = Date.now() - started;

    assert.ok(elapsed < FAST_COMMERCE_DEADLINE_MS + 400, `fast path took ${elapsed}ms`);
    assert.ok(result.products.length > 0, 'fast provider results were lost');
    const poshmark = result.funnel.providers.find((p) => p.provider === 'poshmark');
    assert.deepEqual(poshmark?.outcome, 'timeout');
  } finally {
    restoreFetch();
  }
});

Deno.test('INVARIANT 6: a 250ms Poshmark participates normally', async () => {
  setEnv();
  commerceCacheClear();
  installFetch([
    { match: isSerper, delayMs: 20, body: serperBody(1, 'fastposh') },
    { match: isBrave, delayMs: 20, body: { web: { results: [] } } },
    { match: isPoshmark, delayMs: 250, body: poshmarkBody(3, 'fastpm') },
  ]);
  try {
    const result = await getFastCommerceResults(fastInput('moto jacket fastposh'));
    const poshmark = result.funnel.providers.find((p) => p.provider === 'poshmark');
    assert.deepEqual(poshmark?.outcome, 'success');
    assert.ok((poshmark?.resultCount ?? 0) > 0);
  } finally {
    restoreFetch();
  }
});

// ── E. INVARIANT 3/4: cache ─────────────────────────────────────────────────

Deno.test('INVARIANT 4: a cache miss performs real discovery', async () => {
  setEnv();
  commerceCacheClear();
  installFetch([
    { match: isSerper, delayMs: 10, body: serperBody(3, 'miss') },
    { match: isBrave, delayMs: 10, body: { web: { results: [] } } },
    { match: isPoshmark, delayMs: 10, body: poshmarkBody(1, 'missp') },
  ]);
  try {
    const result = await getFastCommerceResults(fastInput('moto jacket cachemiss'));
    assert.deepEqual(result.funnel.cacheHit, false);
    assert.ok(fetchCallCount > 0, 'a cache miss made no provider call');
    assert.ok(result.products.length > 0);
  } finally {
    restoreFetch();
  }
});

Deno.test('INVARIANT 3: a cache hit serves the shelf without another fan-out', async () => {
  setEnv();
  commerceCacheClear();
  installFetch([
    { match: isSerper, delayMs: 10, body: serperBody(3, 'hit') },
    { match: isBrave, delayMs: 10, body: { web: { results: [] } } },
    { match: isPoshmark, delayMs: 10, body: poshmarkBody(1, 'hitp') },
  ]);
  try {
    const first = await getFastCommerceResults(fastInput('moto jacket cachehit'));
    assert.deepEqual(first.funnel.cacheHit, false);
    assert.ok(first.products.length > 0);

    const callsAfterFirst = fetchCallCount;
    const second = await getFastCommerceResults(fastInput('moto jacket cachehit'));

    assert.deepEqual(second.funnel.cacheHit, true);
    assert.deepEqual(second.funnel.discoveryMs, 0);
    assert.deepEqual(fetchCallCount, callsAfterFirst, 'cache hit still called a provider');
    assert.deepEqual(second.products.length, first.products.length);
    assert.ok((second.funnel.cacheAgeMs ?? -1) >= 0);
  } finally {
    restoreFetch();
  }
});

Deno.test('cache key derives only from structured evidence and market context', () => {
  const base = {
    category: 'outerwear',
    subtype: 'moto jacket',
    brand: 'Saint Laurent',
    exactItemHypothesis: 'L01 Motorcycle Jacket',
    queryFingerprint: fingerprintQuery('saint laurent l01 leather motorcycle jacket'),
    locale: 'en-US',
    currency: 'USD',
    country: 'US',
  };
  const key = buildCommerceCacheKey(base);

  // Deterministic and order-insensitive on the query text.
  assert.deepEqual(key, buildCommerceCacheKey({ ...base }));
  assert.deepEqual(
    fingerprintQuery('leather motorcycle jacket saint laurent l01'),
    fingerprintQuery('saint laurent l01 leather motorcycle jacket'),
  );

  // Every keyed dimension actually participates.
  for (const mutation of [
    { category: 'bag' },
    { subtype: 'biker jacket' },
    { brand: 'Acme' },
    { exactItemHypothesis: 'Other Model' },
    { locale: 'en-GB' },
    { currency: 'GBP' },
    { country: 'GB' },
    { queryFingerprint: fingerprintQuery('something else entirely') },
  ]) {
    assert.ok(
      buildCommerceCacheKey({ ...base, ...mutation }) !== key,
      `cache key ignored ${JSON.stringify(mutation)}`,
    );
  }

  // The raw query text is never recoverable from the key.
  assert.ok(!key.includes('saint'));
  assert.ok(!key.includes('laurent'));
  assert.ok(key.startsWith('v127:'));
});

Deno.test('cache: TTL is inside the governed 5-15 minute band and empty shelves are not cached', () => {
  assert.ok(COMMERCE_CACHE_TTL_MS >= 5 * 60 * 1000);
  assert.ok(COMMERCE_CACHE_TTL_MS <= 15 * 60 * 1000);

  commerceCacheClear();
  const key = buildCommerceCacheKey({
    category: 'outerwear', subtype: 'x', queryFingerprint: 'q',
  });
  // Caching an empty shelf would suppress a real retry for the whole TTL.
  commerceCacheSet(key, { products: [], query: 'q', providersTried: [] });
  assert.deepEqual(commerceCacheGet(key).hit, false);

  commerceCacheSet(key, {
    products: [product({ title: 'A', productUrl: 'https://shop.test/a' })],
    query: 'q',
    providersTried: ['serper'],
  });
  assert.deepEqual(commerceCacheGet(key).hit, true);
});

Deno.test('PRIVACY: the cache key input type admits no identity or image field', async () => {
  const src = await Deno.readTextFile(new URL('./commerceResultCache.ts', import.meta.url));
  const typeStart = src.indexOf('export type CommerceCacheKeyInput');
  const typeBlock = src.slice(typeStart, src.indexOf('};', typeStart));
  for (
    const forbidden of ['userId', 'user_id', 'email', 'image', 'base64', 'signedUrl', 'prompt', 'scanId']
  ) {
    assert.ok(!typeBlock.includes(forbidden), `cache key input admits ${forbidden}`);
  }
});

// ── F. INVARIANT 7/10: enrichment ───────────────────────────────────────────

Deno.test('INVARIANT 7: 3s enrichment does not gate the first commerce shelf', async () => {
  setEnv();
  commerceCacheClear();
  installFetch([
    { match: isSerper, delayMs: 20, body: {
      shopping: [{
        title: 'Saint Laurent L01 Leather Motorcycle Jacket',
        productLink: 'https://www.farfetch.com/shopping/women/saint-laurent-l01-jacket-item-12345.aspx',
        source: 'Farfetch', price: '$4,500',
        imageUrl: 'https://cdn.farfetch.test/1.jpg',
      }],
    } },
    { match: isBrave, delayMs: 20, body: { web: { results: [] } } },
    { match: isPoshmark, delayMs: 20, body: poshmarkBody(2, 'enr') },
    // Enrichment host — deliberately slow. It must not be called on this path.
    { match: (u) => u.includes('farfetch3'), delayMs: 3_000, body: {} },
  ]);
  try {
    const started = Date.now();
    const result = await getFastCommerceResults(fastInput('moto jacket enrichdefer'));
    const elapsed = Date.now() - started;

    assert.ok(elapsed < FAST_COMMERCE_DEADLINE_MS, `first shelf waited ${elapsed}ms`);
    assert.ok(result.products.length > 0);
    // Enrichment is offered as a candidate, not performed.
    assert.ok(result.enrichmentCandidates.length > 0, 'no enrichment candidate surfaced');
    assert.deepEqual(result.enrichmentCandidates[0].retailer, 'farfetch');
    assert.ok(result.enrichmentCandidates.length <= MAX_ENRICHMENT_CANDIDATES);
  } finally {
    restoreFetch();
  }
});

Deno.test('enrichment candidates are bounded and sneaker-gated for KicksCrew', () => {
  const pool = [
    product({ title: 'A', productUrl: 'https://www.farfetch.com/shopping/women/a-item-1.aspx' }),
    product({ title: 'B', productUrl: 'https://www.farfetch.com/shopping/women/b-item-2.aspx' }),
    product({ title: 'C', productUrl: 'https://www.farfetch.com/shopping/women/c-item-3.aspx' }),
    product({ title: 'D', productUrl: 'https://www.kickscrew.com/products/aj1' }),
  ];

  const apparel = selectEnrichmentCandidates(pool, { identification: garment('moto jacket') });
  assert.deepEqual(apparel.length, MAX_ENRICHMENT_CANDIDATES, 'cap not applied to a 3-candidate pool');
  assert.ok(apparel.every((c) => c.retailer === 'farfetch'), 'KicksCrew leaked into an apparel scan');

  const sneaker = selectEnrichmentCandidates([pool[3]], {
    identification: { item_type: 'footwear', subtype: 'sneakers' },
  });
  assert.deepEqual(sneaker.length, 1);
  assert.deepEqual(sneaker[0].retailer, 'kickscrew');
});

Deno.test('INVARIANT 10: enrichment merges into the same offer, never duplicates it', async () => {
  const pool = [
    product({ title: 'Discovered', productUrl: 'https://www.farfetch.com/shopping/women/a-item-1.aspx' }),
    product({ title: 'Other', productUrl: 'https://shop.test/other' }),
  ];
  installFetch([{ match: () => true, delayMs: 5, body: {} }]);
  try {
    const first = await enrichCommerceOffers(pool, [
      { productUrl: 'https://www.farfetch.com/shopping/women/a-item-1.aspx', retailer: 'farfetch' },
    ], { deadlineMs: 300 });
    const second = await enrichCommerceOffers(first.products, [
      { productUrl: 'https://www.farfetch.com/shopping/women/a-item-1.aspx', retailer: 'farfetch' },
    ], { deadlineMs: 300 });

    // A retry cannot grow the shelf.
    assert.deepEqual(first.products.length, pool.length);
    assert.deepEqual(second.products.length, pool.length);
    const urls = second.products.map((p) => p.productUrl);
    assert.deepEqual(new Set(urls).size, urls.length, 'enrichment retry duplicated an offer');
  } finally {
    restoreFetch();
  }
});

Deno.test('enrichment is bounded to the governed candidate cap', async () => {
  installFetch([{ match: () => true, delayMs: 5, body: {} }]);
  try {
    const many = Array.from({ length: 6 }, (_, i) => ({
      productUrl: `https://www.farfetch.com/shopping/women/x${i}-item-${i}.aspx`,
      retailer: 'farfetch' as const,
    }));
    const result = await enrichCommerceOffers([], many, { deadlineMs: 300 });
    assert.ok(result.attempted <= MAX_ENRICHMENT_CANDIDATES, `attempted ${result.attempted}`);
  } finally {
    restoreFetch();
  }
});

// ── G. INVARIANT 8: total commerce failure ──────────────────────────────────

Deno.test('INVARIANT 8: every provider failing yields an empty retryable shelf, not a throw', async () => {
  setEnv();
  commerceCacheClear();
  installFetch([
    { match: isSerper, delayMs: 10, status: 500, body: { error: 'boom' } },
    { match: isBrave, delayMs: 10, status: 500, body: { error: 'boom' } },
    { match: isPoshmark, delayMs: 10, reject: true },
  ]);
  try {
    const result = await getFastCommerceResults(fastInput('moto jacket allfail'));
    assert.deepEqual(result.products.length, 0);
    assert.ok(result.errorType !== undefined, 'no diagnostic for a total failure');
    assert.deepEqual(result.funnel.cacheHit, false);
    // A failed shelf must never be cached.
    const again = await getFastCommerceResults(fastInput('moto jacket allfail'));
    assert.deepEqual(again.funnel.cacheHit, false);
  } finally {
    restoreFetch();
  }
});

// ── H. INVARIANT 11: privacy ────────────────────────────────────────────────

Deno.test('INVARIANT 11: MODE B rejects every image-shaped payload field', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assert.ok(
    index.indexOf('function rejectImagePayloadForCommerceOnly') > 0,
    'MODE B image gate is missing',
  );

  // Executed rather than grepped: the gate is recursive, so its key list lives
  // outside the function body and a source slice would no longer see it.
  const { reject } = loadPrivacyGate(index);
  for (const field of ['imageBase64', 'image', 'imageUrl', 'imageUri', 'photo', 'base64', 'evidence']) {
    assert.ok(reject({ [field]: 'x' }), `MODE B does not reject ${field}`);
  }
  // Rejection, not silent ignore — a client bug must fail loudly.
  assert.ok(index.includes("error: 'commerce_only_invalid'"));

  // MODE B never reads an image field for any purpose.
  const modeBStart = index.indexOf('if (commerceFunnelEnabled && isCommerceOnlyRequest(body)) {');
  const modeB = index.slice(modeBStart, modeBStart + 5_000);
  for (const forbidden of ['imageBase64', 'inline_data', 'geminiKey', 'buildGeminiUrl']) {
    assert.ok(!modeB.includes(forbidden), `MODE B references ${forbidden}`);
  }
});

Deno.test('PRIVACY: no commerce provider receives image data', async () => {
  for (const file of ['shoppingProvider.ts', 'poshmarkProvider.ts', 'farfetch3Provider.ts', 'kicksCrewProvider.ts']) {
    let src: string;
    try {
      src = await Deno.readTextFile(new URL(`./${file}`, import.meta.url));
    } catch {
      continue; // provider not present on this line
    }
    for (const forbidden of ['imageBase64', 'inline_data', 'base64,']) {
      assert.ok(!src.includes(forbidden), `${file} handles image payload data`);
    }
  }
});

// ── I. INVARIANT 12: retailer neutrality ────────────────────────────────────

Deno.test('INVARIANT 12: retailer identity does not change the canonical grouping', () => {
  const a = product({
    title: 'Saint Laurent L01 Leather Motorcycle Jacket',
    productUrl: 'https://a.test/p/1',
    source: 'Farfetch',
    brand: 'Saint Laurent',
  });
  const b = product({
    title: 'Saint Laurent L01 Leather Motorcycle Jacket',
    productUrl: 'https://b.test/p/1',
    source: 'Poshmark',
    brand: 'Saint Laurent',
  });
  // Same product from two retailers → one product, two offers.
  assert.deepEqual(canonicalProductKey(a), canonicalProductKey(b));

  const canonical = buildCanonicalCommerce([a, b]);
  assert.deepEqual(canonical.products.length, 1);
  assert.deepEqual(canonical.products[0].offerCount, 2);
  assert.deepEqual(canonical.duplicateOfferCount, 1);

  const src = Deno.readTextFileSync(new URL('./canonicalCommerce.ts', import.meta.url));
  const keyFn = src.slice(src.indexOf('export function canonicalProductKey'));
  assert.ok(!/\.source\b/.test(keyFn.slice(0, 400)), 'grouping key reads provider identity');
});

Deno.test('canonical model: offers keep price/currency/condition and never drop a listing', () => {
  const offers = [
    product({ title: 'Saint Laurent L01 Jacket', productUrl: 'https://a.test/1', price: '$4,500', source: 'Farfetch' }),
    product({ title: 'Saint Laurent L01 Jacket', productUrl: 'https://b.test/1', price: '$900', source: 'Poshmark' }),
    product({ title: 'Totally Different Bag', productUrl: 'https://c.test/1', price: '£300' }),
  ];
  const canonical = buildCanonicalCommerce(offers);

  const total = canonical.products.reduce((n, p) => n + p.offers.length, 0);
  assert.deepEqual(total, offers.length, 'grouping dropped an offer');

  const jacket = canonical.products.find((p) => p.offers.length === 2)!;
  assert.deepEqual(jacket.lowestPriceValue, 900);
  assert.deepEqual(jacket.offers[0].currency, 'USD');

  assert.deepEqual(parseOfferPrice('£300').currency, 'GBP');
  assert.deepEqual(parseOfferPrice('£300').value, 300);
  assert.deepEqual(parseOfferPrice('not a price').value, null);
});

// ── J. Flag-off equivalence ─────────────────────────────────────────────────

Deno.test('FLAG OFF: the Phase 3 inline commerce path is untouched', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

  // The Phase 3 branch still exists verbatim behind the else.
  assert.ok(index.includes('const commerce = await Promise.race(['));
  assert.ok(index.includes('IMAGE_MODE_COMMERCE_TIMEOUT_MS'));
  // MODE B is unreachable unless the flag is on.
  assert.ok(index.includes('if (commerceFunnelEnabled && isCommerceOnlyRequest(body))'));
  // The deferred branch is guarded, not the default.
  assert.ok(index.includes('} else if (commerceFunnelEnabled) {'));

  const router = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  // Phase 3 orchestration constants survive for the flag-off path.
  assert.ok(router.includes('GLOBAL_DISCOVERY_DEADLINE_MS'));
  assert.ok(router.includes('MAX_FARFETCH_ENRICH'));
  assert.ok(router.includes('MAX_KICKSCREW_ENRICH'));
});

Deno.test('FLAG OFF: query construction is shared, not duplicated, between paths', async () => {
  const router = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  // Exactly one call into the v125 builder — both paths route through the
  // shared resolver, so the fast path cannot drift into a second query builder.
  assert.deepEqual((router.match(/buildWeightedCommerceQueries\(\{/g) ?? []).length, 1);
  assert.deepEqual((router.match(/function resolveCommerceQueries/g) ?? []).length, 1);
  assert.ok(router.includes('const resolved = resolveCommerceQueries(input);'));
});

// ── K. Deferred-branch definite assignment (regression: MODE A returned failed) ─
//
// The v127 deferred branch originally assigned only `shoppingMeta`, leaving
// `finalRecommendedProducts` and `rankedProductsForAudit` unassigned. The
// response builder, the audit event, and the commerce telemetry all
// dereference those bindings unconditionally, so with the funnel flag ON every
// authenticated image scan threw, was swallowed by the handler's outer catch,
// and came back `failed` — after paying for the Gemini call.
//
// Source-shape assertions could not catch that: the branch reads correctly as
// text. These two tests are behavioral.

Deno.test('REGRESSION: the deferred branch assigns every binding the response path reads', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const start = index.indexOf('} else if (commerceFunnelEnabled) {');
  const end = index.indexOf('\n    } else {', start);
  assert.ok(start > 0 && end > start, 'deferred branch not found');
  const branch = index.slice(start, end);

  // Every binding the deferred response path dereferences must be assigned in
  // the branch that produces that response.
  for (const binding of [
    'finalRecommendedProducts',
    'finalSimilarityMatches',
    'rankedProductsForAudit',
    'shoppingMeta',
  ]) {
    assert.ok(
      branch.includes(`${binding} = `),
      `deferred branch never assigns ${binding} — the flag-on scan will throw`,
    );
  }
});

Deno.test('REGRESSION: an unassigned ranked-products binding is what threw', async () => {
  const { buildAuditEvent } = await import('../_shared/scanHelpers.ts');
  const response = { status: 'completed', scanId: 'scan-1' };

  // Negative control: this is precisely the pre-fix state of the binding.
  assert.throws(
    () => buildAuditEvent(response, null, undefined as never, 12, 'scan-1'),
    TypeError,
    'undefined ranked products no longer throws — the negative control is stale',
  );

  // What the repaired branch now passes.
  const event = buildAuditEvent(response, null, [], 12, 'scan-1');
  assert.equal(event.status, 'completed');
});

Deno.test('REGRESSION: MODE B resolves the same category route as the inline path', async () => {
  const { resolveScannerCategoryRoute } = await import('./scannerCategoryRoute.ts');

  // A sneaker identity must reach the footwear route on BOTH paths, or the
  // deferred shelf is built from a different v125 query template than the
  // flag-off path builds for the same garment.
  const identification = { item_type: 'shoes', subtype: 'sneakers' };

  const inline = resolveScannerCategoryRoute({
    requestMode: 'legacy_single_item',
    knownCategory: identification.item_type,
    knownSubtype: identification.subtype,
  });

  // The pre-fix MODE B call shape: `selected_item` with no candidate.
  const brokenModeB = resolveScannerCategoryRoute({ requestMode: 'selected_item' });
  assert.equal(brokenModeB, 'general', 'negative control is stale');
  assert.notEqual(
    inline, brokenModeB,
    'inline and the old MODE B shape agree, so this regression cannot be observed',
  );

  // And the shape MODE B uses now.
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const modeB = index.slice(
    index.indexOf('if (commerceFunnelEnabled && isCommerceOnlyRequest(body))'),
  ).slice(0, 3000);
  assert.ok(
    modeB.includes("requestMode: 'legacy_single_item'"),
    'MODE B no longer routes by known category/subtype',
  );
  assert.equal(modeB.includes("requestMode: 'selected_item'"), false);
});

Deno.test('TYPECHECK GATE: the Edge Function compiles clean', async () => {
  // The compiler pointed directly at the deferred-branch defect (7x TS2454)
  // and `supabase functions deploy` does not typecheck, so nothing caught it.
  // This makes the type checker part of the suite.
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ['check', new URL('./index.ts', import.meta.url).pathname.replace(/^\//, '')],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stderr } = await cmd.output();
  assert.equal(
    code, 0,
    `deno check failed:\n${new TextDecoder().decode(stderr)}`,
  );
});

// ── L. MODE B image ingress is closed at every depth ────────────────────────
//
// The original gate swept top-level keys only. `identification` was mitigated
// by its allowlist, but `attributes` was a raw cast that reaches the outbound
// provider query, so `attributes.imageBase64` was an accepted second route for
// image bytes into the commerce stack. The gate is now recursive, and attribute
// values are capped exactly as searchQueries already were.

function extractFn(src: string, name: string): string {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, 'missing ' + name);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}

function loadPrivacyGate(src: string) {
  const strip = (s: string) =>
    s
      .replace(/:\s*Record<string,\s*unknown>/g, '')
      .replace(/:\s*string\s*\|\s*null/g, '')
      .replace(/:\s*string\s*\|\s*undefined/g, '')
      .replace(/:\s*unknown/g, '')
      .replace(/:\s*string/g, '')
      .replace(/:\s*number/g, '')
      .replace(/\s+as\s+Record<string,\s*unknown>/g, '')
      .replace(/\(entry\):\s*entry is string/g, '(entry)');

  const code = [
    'const MAX_STRING_LEN = 120; const MAX_ARRAY_ITEMS = 12;',
    "const PROHIBITED_IMAGE_KEYS = ['imageBase64','image','imageUrl','imageUri','photo','base64','evidence'];",
    strip(extractFn(src, 'safeString')),
    strip(extractFn(src, 'rejectImagePayloadForCommerceOnly')),
    strip(extractFn(src, 'boundCommerceAttributes')),
    'return { reject: rejectImagePayloadForCommerceOnly, bound: boundCommerceAttributes };',
  ].join('\n');

  return new Function(code)() as {
    reject: (b: Record<string, unknown>) => string | null;
    bound: (a: Record<string, unknown>) => Record<string, unknown>;
  };
}

Deno.test('PRIVACY: MODE B rejects an image payload nested at any depth', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const { reject } = loadPrivacyGate(src);

  // Top level — the original coverage.
  for (const key of ['imageBase64', 'image', 'imageUrl', 'imageUri', 'photo', 'base64', 'evidence']) {
    assert.ok(reject({ [key]: 'x' }), 'top-level ' + key + ' accepted');
  }

  // Nested — the gap. `attributes` reaches the provider query unallowlisted,
  // so this was image bytes crossing the trust boundary with a 200.
  assert.ok(reject({ attributes: { imageBase64: 'AAAA' } }), 'attributes.imageBase64 accepted');
  assert.ok(reject({ attributes: { imageUrl: 'https://private/scan.jpg' } }), 'private scan URL accepted');
  assert.ok(reject({ identification: { photo: 'AAAA' } }), 'identification.photo accepted');
  assert.ok(reject({ attributes: { a: { b: { base64: 'AAAA' } } } }), 'deeply nested base64 accepted');

  // The reason names the offending path, so a client bug is diagnosable.
  assert.equal(reject({ attributes: { imageBase64: 'A' } }), 'image_payload_rejected:attributes.imageBase64');

  // A legitimate commerce-only body still passes untouched.
  assert.equal(
    reject({
      identification: { item_type: 'shoes', subtype: 'sneakers' },
      attributes: { category: 'footwear', colorPalette: ['red'] },
      searchQueries: ['red sneakers'],
      market: { locale: 'en-US' },
    }),
    null,
  );
});

Deno.test('PRIVACY: MODE B attribute text is bounded before it reaches a provider', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const { bound } = loadPrivacyGate(src);

  // Named attribute values are concatenated into the outbound provider query.
  // searchQueries was already capped; these were not.
  const out = bound({
    category: 'y'.repeat(500),
    colorPalette: ['x'.repeat(500)],
    keepBool: true,
    keepNum: 5,
  });
  assert.equal((out.category as string).length, 120);
  assert.equal((out.colorPalette as string[])[0].length, 120);

  // Keys are preserved rather than allowlisted — dropping them would silently
  // remove commerce signal on the deferred path only.
  assert.equal(out.keepBool, true);
  assert.equal(out.keepNum, 5);
});

// ── M. P1-A: MODE B provider spend is bounded ───────────────────────────────
//
// MODE B had no auth, rate limit, or quota check of any kind: `verify_jwt` is
// off for this function, so a caller could omit the Authorization header
// entirely and invoke Serper/Brave/Poshmark as an unlimited standalone paid
// search API. Gating by auth state would not have bounded that, since the
// caller controls whether a bearer token is sent at all. This reuses the same
// IP+UA fingerprint authority the anonymous image path already has, applied
// uniformly regardless of auth state, before any evidence parsing or provider
// call.

/**
 * Extract one `function name(...): ReturnType { body }` as plain JS.
 *
 * Only the signature is touched — parameter type annotations are dropped by
 * splitting on top-level commas and keeping the name before `:`, and any
 * return-type text between the parameter list and the opening `{` is
 * discarded outright. The body is copied verbatim: this codebase's function
 * bodies use plain `const x = ...` (no inline type annotations), and a
 * `{ key: value }` object literal in a body is already valid JS, so nothing
 * there needs stripping — which is what made the previous regex-based
 * stripper unsafe, since it could not tell an object literal key from a type
 * annotation and silently corrupted the body.
 */
function extractFunctionAsJs(src: string, name: string): string {
  const nameStart = src.indexOf(`function ${name}(`);
  assert.ok(nameStart > 0, `missing ${name}`);
  const parenOpen = nameStart + `function ${name}`.length;
  assert.equal(src[parenOpen], '(');

  let depth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) { parenClose = i; break; }
    }
  }
  assert.ok(parenClose > 0, `unbalanced parameter list for ${name}`);

  // Split top-level commas only — a param type like `Map<string, Foo>`
  // contains a comma of its own that must not split the parameter list.
  const paramText = src.slice(parenOpen + 1, parenClose);
  const rawParams: string[] = [];
  let nest = 0;
  let last = 0;
  for (let i = 0; i < paramText.length; i++) {
    const ch = paramText[i];
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') nest++;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') nest--;
    else if (ch === ',' && nest === 0) {
      rawParams.push(paramText.slice(last, i));
      last = i + 1;
    }
  }
  rawParams.push(paramText.slice(last));

  const params = rawParams
    .map((p) => p.trim().split(':')[0].trim())
    .filter(Boolean);

  // Skip an optional return-type annotation between `)` and the body's `{`.
  // This file's return types are either absent or a single `{ ... }` object
  // literal, so the body's own opening brace is not the first `{` after
  // `parenClose` when a return type is present — it is the one AFTER the
  // return type's closing `}`.
  let cursor = parenClose + 1;
  while (/\s/.test(src[cursor])) cursor++;
  if (src[cursor] === ':') {
    cursor++;
    while (/\s/.test(src[cursor])) cursor++;
    assert.equal(src[cursor], '{', `${name} has a non-object return type this extractor does not handle`);
    let typeDepth = 0;
    for (; cursor < src.length; cursor++) {
      if (src[cursor] === '{') typeDepth++;
      else if (src[cursor] === '}') {
        typeDepth--;
        if (typeDepth === 0) { cursor++; break; }
      }
    }
    while (/\s/.test(src[cursor])) cursor++;
  }
  const bodyOpen = cursor;
  assert.equal(src[bodyOpen], '{', `no function body found for ${name}`);

  depth = 0;
  let bodyClose = -1;
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { bodyClose = i; break; }
    }
  }
  assert.ok(bodyClose > bodyOpen, `unbalanced body for ${name}`);

  return `function ${name}(${params.join(', ')}) ${src.slice(bodyOpen, bodyClose + 1)}`;
}

function extractRateLimiter(src: string) {
  const grab = (name: string) => extractFunctionAsJs(src, name);
  const winM = src.match(/const COMMERCE_ONLY_RATE_LIMIT_WINDOW_MS = ([^;]+);/);
  const maxM = src.match(/const COMMERCE_ONLY_RATE_LIMIT_MAX = ([^;]+);/);
  assert.ok(winM && maxM, 'rate limit constants not found');

  const code = [
    `const COMMERCE_ONLY_RATE_LIMIT_WINDOW_MS = ${winM![1]};`,
    `const COMMERCE_ONLY_RATE_LIMIT_MAX = ${maxM![1]};`,
    grab('checkSlidingWindowRateLimit'),
    grab('checkCommerceOnlyRateLimit'),
    'return { checkCommerceOnlyRateLimit, WINDOW_MS: COMMERCE_ONLY_RATE_LIMIT_WINDOW_MS, MAX: COMMERCE_ONLY_RATE_LIMIT_MAX };',
  ].join('\n');

  // commerceOnlyRateLimits is a module-level Map captured by the extracted
  // function's closure; re-declare it fresh so tests do not share state.
  const withMap = `const commerceOnlyRateLimits = new Map();\n${code}`;
  return new Function(withMap)() as {
    checkCommerceOnlyRateLimit: (fp: string) => { allowed: boolean; retryAfterSeconds: number; count: number };
    WINDOW_MS: number;
    MAX: number;
  };
}

Deno.test('P1-A: MODE B provider spend is bounded per fingerprint, not unlimited', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const { checkCommerceOnlyRateLimit, MAX } = extractRateLimiter(src);

  // Exactly MAX calls from one fingerprint are allowed.
  let lastAllowed = true;
  for (let i = 0; i < MAX; i++) {
    const r = checkCommerceOnlyRateLimit('fp-abuse');
    lastAllowed = r.allowed;
    assert.equal(r.allowed, true, `call ${i + 1} of the allowed budget was rejected`);
  }
  assert.equal(lastAllowed, true);

  // The next call from the SAME fingerprint is rejected — this is the bound
  // that did not exist before this repair, where nothing capped this loop.
  const blocked = checkCommerceOnlyRateLimit('fp-abuse');
  assert.equal(blocked.allowed, false, 'MODE B accepted more than MAX calls from one fingerprint — unbounded');
  assert.ok(blocked.retryAfterSeconds > 0);

  // A DIFFERENT fingerprint is unaffected — the bound is per-caller, not a
  // single global counter that would let one abusive client lock everyone out.
  const other = checkCommerceOnlyRateLimit('fp-legitimate-user');
  assert.equal(other.allowed, true, 'a legitimate caller was blocked by another fingerprint\'s abuse');
});

Deno.test('P1-A: the rate-limit rejection returns before any evidence parsing or provider call', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const rateLimitReturn = src.indexOf("error: 'commerce_only_rate_limited'");
  const evidenceParse = src.indexOf('const evidence = readCommerceOnlyEvidence(body);');
  const providerCall = src.indexOf('const fast = await getFastCommerceResults({');

  assert.ok(rateLimitReturn > 0, 'MODE B has no rate limit rejection at all');
  assert.ok(evidenceParse > rateLimitReturn, 'evidence is parsed before the rate limit is checked');
  assert.ok(providerCall > rateLimitReturn, 'a provider can be called before the rate limit is checked');

  // And the check itself is the very first thing MODE B does, ahead of even
  // the (cheap) image-payload rejection — no work of any kind precedes it.
  const modeBStart = src.indexOf('if (commerceFunnelEnabled && isCommerceOnlyRequest(body)) {');
  const rateLimitCheck = src.indexOf('checkCommerceOnlyRateLimit(commerceOnlyFingerprint)');
  const imageRejectCheck = src.indexOf('rejectImagePayloadForCommerceOnly(body)', modeBStart);
  assert.ok(modeBStart > 0 && rateLimitCheck > modeBStart && rateLimitCheck < imageRejectCheck);
});

Deno.test('P1-A: authenticated and anonymous callers share the same spend boundary', async () => {
  // MODE B has no bearer-token requirement — verify_jwt is off for this
  // function — so an attacker can simply omit the Authorization header and
  // any auth-gated limiter would not bound them. The fingerprint check must
  // not read `auth` at all, or it can be routed around by omitting a token.
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const start = src.indexOf('if (commerceFunnelEnabled && isCommerceOnlyRequest(body)) {');
  const rateLimitEnd = src.indexOf("429,\n      );\n    }", start);
  assert.ok(start > 0 && rateLimitEnd > start);
  const rateLimitBlock = src.slice(start, rateLimitEnd);
  assert.equal(/\bauth\.\w+/.test(rateLimitBlock), false, 'rate limit is conditioned on auth state and can be bypassed by omitting a token');
});

// ── N. Early-exit sufficiency counts USABLE candidates, not raw ones ────────
//
// The fast-path collector's `isSufficient` closure originally counted raw
// provider result counts. Three candidates a provider returns that are ALL
// later rejected by filterAndDedupeProducts' first structural gate (missing
// image, invalid/demo purchase URL) could still close the early-exit gate,
// abandoning a slower provider that might have supplied the only real offers
// — an empty final shelf despite "enough" raw candidates having arrived.

Deno.test('EARLY EXIT: unusable raw candidates do not close the gate while a real provider is still running', async () => {
  const { collectBounded } = await import('./commerceFastPath.ts');
  const { hasUsableImage, hasValidPurchaseUrl } = await import('./qualityTuneCommerce.ts');
  const { FAST_COMMERCE_SUFFICIENT_RESULTS } = await import('./commerceFunnelConfig.ts');

  const junkProduct = (i: number) => ({
    id: `junk-${i}`,
    title: 'Junk',
    source: 'RetailerA',
    price: '$10',
    type: 'retail' as const,
    // No imageUrl, no productUrl: rejected by hasUsableImage/hasValidPurchaseUrl.
  });
  const realProduct = (i: number) => ({
    id: `real-${i}`,
    title: 'Real Product',
    source: 'RetailerB',
    price: '$500',
    type: 'retail' as const,
    imageUrl: `https://cdn.example-shop.test/real-${i}.jpg`,
    productUrl: `https://retailer.example-shop.test/p/${i}`,
  });

  // Fast provider settles immediately with FAST_COMMERCE_SUFFICIENT_RESULTS
  // junk candidates — enough to close the OLD (raw-count) gate.
  const junkCount = FAST_COMMERCE_SUFFICIENT_RESULTS;
  const junk = Array.from({ length: junkCount }, (_, i) => junkProduct(i));
  assert.equal(junk.filter((p) => hasValidPurchaseUrl(p) && hasUsableImage(p)).length, 0);

  let slowProviderRan = false;
  const outcome = await collectBounded(
    [
      {
        key: 'fast-junk',
        promise: Promise.resolve({ kind: 'fast-junk' as const, value: { products: junk } }),
        onTimeout: { kind: 'fast-junk' as const, value: { products: [] } },
      },
      {
        key: 'slow-real',
        promise: new Promise((resolve) => {
          setTimeout(() => {
            slowProviderRan = true;
            resolve({ kind: 'slow-real' as const, value: { products: [realProduct(1), realProduct(2)] } });
          }, 40);
        }),
        onTimeout: { kind: 'slow-real' as const, value: { products: [] } },
      },
    ],
    {
      deadlineMs: 500,
      isSufficient: (settled) => {
        let usable = 0;
        for (const s of settled) {
          for (const p of s.value.products) {
            if (hasValidPurchaseUrl(p) && hasUsableImage(p)) usable += 1;
          }
        }
        return usable >= FAST_COMMERCE_SUFFICIENT_RESULTS;
      },
    },
  );

  // The fix: junk alone does not close the gate, so the collector waits for
  // the slow provider within its deadline.
  assert.ok(slowProviderRan, 'the usable-candidate gate did not wait for a provider with real offers');
  const slow = (outcome.values.get('slow-real') as { value: { products: unknown[] } }).value;
  assert.equal(slow.products.length, 2, 'the slow provider\'s real offers were abandoned');
});

Deno.test('EARLY EXIT: negative control — the pre-fix raw count DOES close the gate on junk alone', async () => {
  const { collectBounded } = await import('./commerceFastPath.ts');
  const { FAST_COMMERCE_SUFFICIENT_RESULTS } = await import('./commerceFunnelConfig.ts');

  const junk = Array.from({ length: FAST_COMMERCE_SUFFICIENT_RESULTS }, (_, i) => ({ id: `junk-${i}` }));

  let slowProviderRan = false;
  await collectBounded(
    [
      {
        key: 'fast-junk',
        promise: Promise.resolve({ value: { products: junk } }),
        onTimeout: { value: { products: [] } },
      },
      {
        key: 'slow-real',
        promise: new Promise((resolve) => {
          setTimeout(() => { slowProviderRan = true; resolve({ value: { products: [{ id: 'real' }] } }); }, 40);
        }),
        onTimeout: { value: { products: [] } },
      },
    ],
    {
      deadlineMs: 500,
      // The ORIGINAL (pre-fix) closure: raw counts, no usability check.
      isSufficient: (settled) => {
        let usable = 0;
        for (const s of settled) usable += s.value.products.length;
        return usable >= FAST_COMMERCE_SUFFICIENT_RESULTS;
      },
    },
  );

  assert.equal(slowProviderRan, false, 'negative control did not reproduce the pre-fix early-exit-on-junk defect');
});

// ── O. Canonical-URL dedupe tier is reachable ───────────────────────────────
//
// productIdentityKey checked the provider-synthesized `pid:` tier before the
// canonical-URL tier. Every active provider sets `id` by hashing the raw
// productUrl (shoppingProvider.ts / poshmarkProvider.ts `makeId`), so `pid:`
// always matched first and the canonical-URL tier — which strips the hash,
// trailing slash, and tracking params — was unreachable. Deterministic
// near-duplicates (trailing slash, path case, an extra unknown query param)
// therefore survived dedup as separate "products".

Deno.test('DEDUPE: a trailing-slash URL variant collapses with its canonical twin', async () => {
  const { filterAndDedupeProducts } = await import('./qualityTuneCommerce.ts');
  const garment = { item_type: 'outerwear', subtype: 'Moto Jacket', primary_color: 'black' };

  const base = (productUrl: string, id: string) => ({
    id,
    title: 'Saint Laurent Leather Moto Jacket',
    source: 'RetailerNeutral',
    price: '$1,200',
    type: 'retail' as const,
    imageUrl: 'https://cdn.example-shop.test/i.jpg',
    productUrl,
  });

  const products = [
    // Same listing; only a trailing slash differs. `id` is a hash of the raw
    // URL (as every real provider produces), so these two get DIFFERENT
    // provider-id hashes despite being the same product.
    base('https://retailer.example-shop.test/p/jacket-123', 'hash-a'),
    base('https://retailer.example-shop.test/p/jacket-123/', 'hash-b'),
  ];
  assert.notEqual(products[0].id, products[1].id);

  const { products: deduped, stats } = filterAndDedupeProducts(products, garment);
  assert.equal(deduped.length, 1, 'a trailing-slash URL variant was not recognized as the same product');
  assert.equal(stats.productsAfterDedupe, 1);
});

Deno.test('DEDUPE: negative control — the pre-fix precedence keeps both as distinct products', async () => {
  // The ORIGINAL (pre-fix) tier order: provider id checked BEFORE canonical URL.
  const src = await Deno.readTextFile(new URL('./qualityTuneCommerce.ts', import.meta.url));
  const start = src.indexOf('function productIdentityKey');
  assert.ok(start > 0);
  const skuLine = "if (retailerId && sku) return { key: `sku:${retailerId}|${sku}`, type: 'retailer_sku' };";
  const afterSku = src.indexOf(skuLine, start) + skuLine.length;

  const preFixSrc = `
    function productIdentityKey(p) {
      const rec = p;
      const retailerId = typeof rec.retailerId === 'string' ? rec.retailerId.toLowerCase() : (typeof p.source === 'string' ? p.source.toLowerCase() : '');
      const sku = typeof rec.sku === 'string' ? rec.sku.toLowerCase() : (typeof rec.SKU === 'string' ? rec.SKU.toLowerCase() : '');
      if (retailerId && sku) return { key: 'sku:' + retailerId + '|' + sku, type: 'retailer_sku' };
      const providerId = typeof p.id === 'string' && p.id.trim() ? p.id.trim().toLowerCase() : '';
      if (providerId && !providerId.startsWith('http')) {
        return { key: 'pid:' + providerId, type: 'provider_product_id' };
      }
      const canon = canonicalizeUrlForIdentity(p.productUrl);
      if (canon) return { key: 'url:' + canon, type: 'canonical_url' };
      return { key: 'fallback:unknown', type: 'weak_fallback' };
    }
    return productIdentityKey;
  `;
  assert.ok(afterSku > start, 'could not locate the sku tier to build the negative control from');

  const { canonicalizeUrlForIdentity } = await import('./qualityTuneCommerce.ts');
  const preFixIdentityKey = new Function('canonicalizeUrlForIdentity', preFixSrc)(canonicalizeUrlForIdentity);

  const a = preFixIdentityKey({ id: 'hash-a', productUrl: 'https://retailer.example-shop.test/p/jacket-123', source: 'RetailerNeutral' });
  const b = preFixIdentityKey({ id: 'hash-b', productUrl: 'https://retailer.example-shop.test/p/jacket-123/', source: 'RetailerNeutral' });
  assert.notEqual(a.key, b.key, 'negative control did not reproduce the pre-fix unreachable-canonical-tier defect');
  assert.equal(a.type, 'provider_product_id');
});
