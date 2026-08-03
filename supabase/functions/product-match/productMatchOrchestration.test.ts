/**
 * Product Match V1 — orchestration, deadlines and endpoint gating (Deno).
 *
 * These tests assert the four latency guarantees behaviourally rather than by
 * inspecting the implementation: providers are fake, timing is real but small,
 * and every assertion is about observable output.
 *
 * No network. No provider credentials are read, so no upstream call is possible
 * even if one were attempted.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { orchestrateProductMatch, type ProviderExecutor } from './orchestrator.ts';
import { normalizeRecommendedProduct, normalizeRetailerProduct, type NormalizedRow } from './normalize.ts';
import type { ProductMatchQuery, ProductSource } from './contracts.ts';
import {
  isProductMatchEnabled,
  PRODUCT_MATCH_DEFAULT_ENABLED,
  readDeadlines,
} from './config.ts';
import { buildProviderExecutors, buildProviderQuery } from './providers.ts';
import { handleProductMatchRequest, parseProductMatchRequest, secretMatches } from './index.ts';
import { assertProductMatchTelemetry, buildProductMatchEvent, emitProductMatchEvent } from './telemetry.ts';
import { dedupeRows } from './dedupe.ts';

const QUERY: ProductMatchQuery = {
  brand: 'Nike',
  visibleBrandText: 'Nike',
  model: 'Air Force 1',
  canonicalCategory: 'footwear',
  color: 'white',
};

const FAST_DEADLINES = { perProviderMs: 200, totalMs: 400, firstUsefulTargetMs: 150 };

function row(source: ProductSource, id: string, url: string): NormalizedRow {
  const hints = { brand: 'Nike', canonicalCategory: 'footwear', color: 'white' };
  const normalized = source === 'farfetch' || source === 'kickscrew'
    ? normalizeRetailerProduct(
      { id, title: 'Nike Air Force 1 07 white', retailer: source, productUrl: url },
      source,
      hints,
    )
    : normalizeRecommendedProduct(
      { id, title: 'Nike Air Force 1 07 white', productUrl: url },
      source === 'brave' ? 'brave' : 'serper',
      hints,
    );
  if (!normalized) throw new Error('fixture failed to normalize');
  return normalized;
}

function provider(
  source: ProductSource,
  behaviour: { delayMs: number; rows?: NormalizedRow[]; throws?: boolean; enabled?: boolean },
): ProviderExecutor {
  return {
    source,
    enabled: behaviour.enabled ?? true,
    run: ({ signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (behaviour.throws) reject(new TypeError('provider blew up'));
          else resolve(behaviour.rows ?? []);
        }, behaviour.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }),
  };
}

// ── guarantee 1 + 2: concurrency, and no single provider blocks the result ──

Deno.test('providers run concurrently: wall clock is the slowest, not the sum', async () => {
  const started = Date.now();
  const { response } = await orchestrateProductMatch({
    query: QUERY,
    providers: [
      provider('farfetch', { delayMs: 120, rows: [row('farfetch', 'f1', 'https://farfetch.com/1')] }),
      provider('kickscrew', { delayMs: 120, rows: [row('kickscrew', 'k1', 'https://kickscrew.com/1')] }),
      provider('serper', { delayMs: 120, rows: [row('serper', 's1', 'https://nike.com/1')] }),
    ],
    options: { deadlines: FAST_DEADLINES },
  });
  const elapsed = Date.now() - started;
  assert(elapsed < 300, `three 120ms providers must not take ${elapsed}ms sequentially`);
  assertEquals(response.providers.filter((p) => p.status === 'completed').length, 3);
});

Deno.test('a provider that exceeds its own deadline does not extend the request', async () => {
  const { response } = await orchestrateProductMatch({
    query: QUERY,
    providers: [
      provider('serper', { delayMs: 10, rows: [row('serper', 's1', 'https://nike.com/1')] }),
      provider('farfetch', { delayMs: 5000 }),
    ],
    options: { deadlines: FAST_DEADLINES },
  });
  const farfetch = response.providers.find((p) => p.source === 'farfetch');
  assertEquals(farfetch?.status, 'timeout');
  assert(response.listings.length > 0, 'the fast provider still produced a result');
});

// ── guarantee 3: partial results are preserved ──────────────────────────────

Deno.test('a partial result is returned and labelled, never discarded', async () => {
  const { response } = await orchestrateProductMatch({
    query: QUERY,
    providers: [
      provider('serper', { delayMs: 10, rows: [row('serper', 's1', 'https://nike.com/1')] }),
      provider('farfetch', { delayMs: 5, throws: true }),
    ],
    options: { deadlines: FAST_DEADLINES },
  });
  assertEquals(response.timings.partial, true);
  assert(response.listings.length > 0);
  const farfetch = response.providers.find((p) => p.source === 'farfetch');
  assertEquals(farfetch?.status, 'error');
  assertEquals(farfetch?.reason, 'TypeError', 'a class name, never the message');
});

Deno.test('an error reason never leaks the provider message', async () => {
  const { response } = await orchestrateProductMatch({
    query: QUERY,
    providers: [provider('serper', { delayMs: 5, throws: true })],
    options: { deadlines: FAST_DEADLINES },
  });
  const serialized = JSON.stringify(response);
  assert(!serialized.includes('blew up'), 'provider messages must not reach the response');
});

Deno.test('when every provider fails the result is empty but explained', async () => {
  const { response } = await orchestrateProductMatch({
    query: QUERY,
    providers: [provider('serper', { delayMs: 5, throws: true })],
    options: { deadlines: FAST_DEADLINES },
  });
  assertEquals(response.listings.length, 0);
  assertEquals(response.emptyReason, 'no_results');
  assertEquals(response.tier, 'NO_CONFIDENT_MATCH');
  assertEquals(response.timings.partial, false, 'nothing succeeded, so nothing is partial');
});

Deno.test('the total deadline bounds the request even when every provider hangs', async () => {
  const started = Date.now();
  const { response } = await orchestrateProductMatch({
    query: QUERY,
    providers: [
      provider('farfetch', { delayMs: 10_000 }),
      provider('kickscrew', { delayMs: 10_000 }),
    ],
    options: { deadlines: { perProviderMs: 5000, totalMs: 250, firstUsefulTargetMs: 200 } },
  });
  const elapsed = Date.now() - started;
  assert(elapsed < 1500, `total deadline must bound the request; took ${elapsed}ms`);
  assertEquals(response.timings.deadlineExceeded, true);
  assert(response.providers.every((p) => p.status === 'timeout'));
});

// ── guarantee 4: first-useful is measured separately ────────────────────────

Deno.test('first-useful is recorded early and complete is recorded late', async () => {
  const { response } = await orchestrateProductMatch({
    query: QUERY,
    providers: [
      provider('serper', { delayMs: 10, rows: [row('serper', 's1', 'https://nike.com/1')] }),
      provider('farfetch', { delayMs: 180, rows: [row('farfetch', 'f1', 'https://farfetch.com/1')] }),
    ],
    options: { deadlines: FAST_DEADLINES },
  });
  const { firstUsefulMatchMs, completeMs } = response.timings;
  assert(firstUsefulMatchMs !== null, 'a useful match was produced');
  assert(firstUsefulMatchMs < completeMs, 'first-useful must precede complete');
  assert(firstUsefulMatchMs < 150, `first-useful should track the fast provider, got ${firstUsefulMatchMs}ms`);
});

Deno.test('first-useful stays null when nothing reached a useful tier', async () => {
  const unrelated = normalizeRecommendedProduct(
    { id: 'x', title: 'Ceramic coffee mug', productUrl: 'https://shop.example/mug' },
    'serper',
    { canonicalCategory: 'homeware' },
  );
  assert(unrelated !== null);
  const { response } = await orchestrateProductMatch({
    query: { canonicalCategory: 'footwear', brand: 'Nike' },
    providers: [provider('serper', { delayMs: 5, rows: [unrelated] })],
    options: { deadlines: FAST_DEADLINES },
  });
  assertEquals(response.timings.firstUsefulMatchMs, null);
  assertEquals(response.tier, 'NO_CONFIDENT_MATCH');
  assertEquals(response.emptyReason, 'below_confidence');
});

Deno.test('latency never changes a tier: the same rows tier identically fast or slow', async () => {
  const rows = [row('farfetch', 'f1', 'https://farfetch.com/1')];
  const fast = await orchestrateProductMatch({
    query: QUERY,
    providers: [provider('farfetch', { delayMs: 1, rows })],
    options: { deadlines: FAST_DEADLINES },
  });
  const slow = await orchestrateProductMatch({
    query: QUERY,
    providers: [provider('farfetch', { delayMs: 150, rows })],
    options: { deadlines: FAST_DEADLINES },
  });
  assertEquals(fast.response.tier, slow.response.tier);
  assertEquals(
    fast.response.families[0]?.variants[0]?.confidence,
    slow.response.families[0]?.variants[0]?.confidence,
  );
});

// ── empty / disabled paths ──────────────────────────────────────────────────

Deno.test('an empty query short-circuits before any provider runs', async () => {
  let invoked = false;
  const { response } = await orchestrateProductMatch({
    query: {},
    providers: [{
      source: 'serper',
      enabled: true,
      run: async () => {
        invoked = true;
        return [];
      },
    }],
    options: { deadlines: FAST_DEADLINES },
  });
  assertEquals(invoked, false);
  assertEquals(response.emptyReason, 'no_query');
});

Deno.test('disabled providers are reported, not invoked', async () => {
  const { response } = await orchestrateProductMatch({
    query: QUERY,
    providers: [provider('farfetch', { delayMs: 1, enabled: false })],
    options: { deadlines: FAST_DEADLINES },
  });
  assertEquals(response.emptyReason, 'no_eligible_providers');
  assertEquals(response.providers[0].status, 'disabled');
});

// ── configuration ───────────────────────────────────────────────────────────

Deno.test('the feature flag is off by default and fails closed on junk values', () => {
  assertEquals(PRODUCT_MATCH_DEFAULT_ENABLED, false);
  assertEquals(isProductMatchEnabled(() => undefined), false);
  assertEquals(isProductMatchEnabled(() => ''), false);
  assertEquals(isProductMatchEnabled(() => 'maybe'), false);
  assertEquals(isProductMatchEnabled(() => 'true'), true);
});

Deno.test('a per-provider deadline above the total deadline is clamped, not obeyed', () => {
  const deadlines = readDeadlines((key) =>
    key === 'PRODUCT_MATCH_PROVIDER_DEADLINE_MS' ? '9000'
      : key === 'PRODUCT_MATCH_TOTAL_DEADLINE_MS' ? '4000'
      : undefined
  );
  assertEquals(deadlines.totalMs, 4000);
  assertEquals(deadlines.perProviderMs, 4000);
});

Deno.test('default deadlines match the documented operating targets', () => {
  const deadlines = readDeadlines(() => undefined);
  assertEquals(deadlines.firstUsefulTargetMs, 5000);
  assertEquals(deadlines.totalMs, 8000);
  assert(deadlines.perProviderMs < deadlines.totalMs);
});

// ── provider wiring: no paid calls without credentials ──────────────────────

Deno.test('with no credentials configured every real provider is disabled', () => {
  const executors = buildProviderExecutors({ envGet: () => undefined, catalogClient: null });
  assertEquals(executors.length, 4);
  assert(
    executors.every((executor) => executor.enabled === false),
    'an unconfigured environment must make paid calls structurally impossible',
  );
});

Deno.test('a provider is enabled only when its own credential is present', () => {
  const executors = buildProviderExecutors({
    envGet: (key) => (key === 'SHOPPING_SERPER_API_KEY' ? 'k' : undefined),
    catalogClient: null,
  });
  const byName = Object.fromEntries(executors.map((e) => [e.source, e.enabled]));
  assertEquals(byName.serper, true);
  assertEquals(byName.farfetch, false);
  assertEquals(byName.kickscrew, false);
  assertEquals(byName.catalog, false);
});

Deno.test('an explicit disable flag beats a present credential', () => {
  const executors = buildProviderExecutors({
    envGet: (key) =>
      key === 'SHOPPING_SERPER_API_KEY' ? 'k' : key === 'SHOPPING_ENABLED' ? 'false' : undefined,
    catalogClient: null,
  });
  assertEquals(executors.find((e) => e.source === 'serper')?.enabled, false);
});

Deno.test('a caller-supplied search query wins over the constructed one', () => {
  assertEquals(buildProviderQuery({ ...QUERY, searchQueries: ['nike af1 white'] }), 'nike af1 white');
  assertEquals(buildProviderQuery(QUERY), 'Nike white Air Force 1 footwear');
});

// ── endpoint gating ─────────────────────────────────────────────────────────

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/product-match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test('the endpoint is 404 while the flag is off', async () => {
  const response = await handleProductMatchRequest(request({ query: QUERY }), {
    envGet: () => undefined,
  });
  assertEquals(response.status, 404);
  assertEquals((await response.json()).code, 'FEATURE_DISABLED');
});

Deno.test('an unset internal secret rejects every request', async () => {
  const response = await handleProductMatchRequest(
    request({ query: QUERY }, { 'x-product-match-secret': 'anything' }),
    { envGet: (key) => (key === 'PRODUCT_MATCH_ENABLED' ? 'true' : undefined) },
  );
  assertEquals(response.status, 401, 'unset must mean "not configured", never "open"');
});

Deno.test('a wrong internal secret is rejected', async () => {
  const envGet = (key: string) =>
    key === 'PRODUCT_MATCH_ENABLED' ? 'true'
      : key === 'PRODUCT_MATCH_INTERNAL_SECRET' ? 'correct-horse'
      : undefined;
  const response = await handleProductMatchRequest(
    request({ query: QUERY }, { 'x-product-match-secret': 'wrong-horses' }),
    { envGet },
  );
  assertEquals(response.status, 401);
});

Deno.test('a correct secret with the flag on reaches orchestration', async () => {
  const envGet = (key: string) =>
    key === 'PRODUCT_MATCH_ENABLED' ? 'true'
      : key === 'PRODUCT_MATCH_INTERNAL_SECRET' ? 'correct-horse'
      : undefined;
  const response = await handleProductMatchRequest(
    request({ query: QUERY }, { 'x-product-match-secret': 'correct-horse' }),
    { envGet },
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  // No credentials are configured, so every provider is disabled.
  assertEquals(body.emptyReason, 'no_eligible_providers');
  assertEquals(body.contractVersion, 1);
});

Deno.test('secretMatches rejects length mismatches and empty inputs', () => {
  assert(secretMatches('abc', 'abc'));
  assert(!secretMatches('abc', 'abcd'));
  assert(!secretMatches(null, 'abc'));
  assert(!secretMatches('abc', null));
  assert(!secretMatches('', ''));
});

// ── request parsing: the privacy boundary is the schema ─────────────────────

Deno.test('an image field is rejected rather than ignored', () => {
  const parsed = parseProductMatchRequest({ query: { imageUrl: 'https://x/y.jpg' } });
  assertEquals(parsed.ok, false);
  assert(parsed.ok === false && parsed.error.includes('imageUrl'));
});

Deno.test('an unknown top-level field is rejected', () => {
  const parsed = parseProductMatchRequest({ query: {}, userId: 'abc' });
  assertEquals(parsed.ok, false);
});

Deno.test('an unknown provider in sources is rejected', () => {
  const parsed = parseProductMatchRequest({ query: QUERY, sources: ['serper', 'amazon'] });
  assertEquals(parsed.ok, false);
});

Deno.test('control characters are stripped before length limiting', () => {
  const parsed = parseProductMatchRequest({ query: { brand: 'Ni\u0000\u001fke' } });
  assert(parsed.ok);
  assertEquals(parsed.ok && parsed.request.query.brand, 'Ni ke');
});

// ── telemetry ───────────────────────────────────────────────────────────────

Deno.test('the built telemetry event carries no URL and no title', async () => {
  const rows = [row('farfetch', 'f1', 'https://farfetch.com/secret-path')];
  const { response, dedupeStats } = await orchestrateProductMatch({
    query: QUERY,
    providers: [provider('farfetch', { delayMs: 1, rows })],
    options: { deadlines: FAST_DEADLINES },
  });
  const event = buildProductMatchEvent({ response, dedupeStats });
  assertProductMatchTelemetry(event);
  const serialized = JSON.stringify(event);
  assert(!serialized.includes('farfetch.com'));
  assert(!serialized.includes('Air Force'));
});

Deno.test('a non-hex correlation hash is dropped rather than stored', () => {
  const event = buildProductMatchEvent({
    response: {
      contractVersion: 1, version: 'v', tier: 'SIMILAR', families: [], listings: [],
      providers: [], timings: { firstUsefulMatchMs: 1, completeMs: 2, deadlineExceeded: false, partial: false },
    },
    dedupeStats: dedupeRows([]).stats,
    correlationHash: 'scan-9f3a-user-42',
  });
  assertEquals(event.correlation_hash, null);
  assertProductMatchTelemetry(event);
});

Deno.test('a hex correlation hash is preserved', () => {
  const event = buildProductMatchEvent({
    response: {
      contractVersion: 1, version: 'v', tier: 'SIMILAR', families: [], listings: [],
      providers: [], timings: { firstUsefulMatchMs: 1, completeMs: 2, deadlineExceeded: false, partial: false },
    },
    dedupeStats: dedupeRows([]).stats,
    correlationHash: 'A1B2C3D4E5F6',
  });
  assertEquals(event.correlation_hash, 'a1b2c3d4e5f6');
});

Deno.test('the privacy assertion rejects a smuggled URL', () => {
  const event = buildProductMatchEvent({
    response: {
      contractVersion: 1, version: 'v', tier: 'SIMILAR', families: [], listings: [],
      providers: [], timings: { firstUsefulMatchMs: null, completeMs: 1, deadlineExceeded: false, partial: false },
    },
    dedupeStats: dedupeRows([]).stats,
  });
  (event as unknown as Record<string, unknown>).empty_reason = 'https://leak.example/x';
  let threw = false;
  try {
    assertProductMatchTelemetry(event);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('emit validates and drops when no writer is injected', async () => {
  const event = buildProductMatchEvent({
    response: {
      contractVersion: 1, version: 'v', tier: 'SIMILAR', families: [], listings: [],
      providers: [], timings: { firstUsefulMatchMs: null, completeMs: 1, deadlineExceeded: false, partial: false },
    },
    dedupeStats: dedupeRows([]).stats,
  });
  assertEquals(await emitProductMatchEvent(event, null), 'validated_only');
});
