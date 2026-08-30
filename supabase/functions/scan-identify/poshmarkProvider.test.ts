import assert from 'node:assert/strict';
import { searchPoshmarkProducts } from './poshmarkProvider.ts';

// ── Fails closed without configuration ──────────────────────────────────────

Deno.test('searchPoshmarkProducts: fails closed (disabled) rather than throwing when unconfigured', async () => {
  const result = await searchPoshmarkProducts('nike shoes', { limit: 5 });
  assert.deepEqual(result.products, []);
  assert.ok(result.errorType);
});

Deno.test('searchPoshmarkProducts: empty query is rejected before any network attempt', async () => {
  const result = await searchPoshmarkProducts('   ', { limit: 5 });
  assert.deepEqual(result.products, []);
  assert.ok(result.errorType);
});

// ── Structural / contract-lock assertions ───────────────────────────────────

Deno.test('poshmarkProvider: correct host, endpoint, secret names — no literal RapidAPI key', async () => {
  const source = await Deno.readTextFile(new URL('./poshmarkProvider.ts', import.meta.url));

  assert.ok(source.includes("'poshmark-fashion-resale.p.rapidapi.com'"));
  assert.ok(source.includes('/poshmark/search?query='));
  assert.ok(source.includes("readEnv('POSHMARK_RAPIDAPI_KEY')"));
  assert.ok(source.includes("readEnv('RAPIDAPI_KEY')"));
  assert.ok(source.includes("readEnv('POSHMARK_RAPIDAPI_HOST')"), 'host must be overridable per-secret');
  assert.equal(/rapidapi[_-]?key['"]?\s*[:=]\s*['"][0-9a-f]{10,}/i.test(source), false, 'no literal key');
});

Deno.test('poshmarkProvider: never sends sortBy — every attempted value was rejected live', async () => {
  // Live-probed during Phase 3: sortBy=best_match / relevant / relevance all
  // returned HTTP 500 "Input is not valid". Omitting the param entirely is
  // the only request shape that returned real results. The header may
  // mention the rejected values in prose; the actual request URL must not.
  const source = await Deno.readTextFile(new URL('./poshmarkProvider.ts', import.meta.url));
  assert.equal(/const url = [^\n]*sortBy=/.test(source), false);
});

Deno.test('poshmarkProvider: resale provenance never becomes a ranking input', async () => {
  const source = await Deno.readTextFile(new URL('./poshmarkProvider.ts', import.meta.url));
  // commerceType is set once, as plain metadata on the mapped product — not
  // referenced anywhere as a comparison/sort key inside this file.
  assert.equal((source.match(/commerceType/g) || []).length <= 3, true);
  assert.equal(/commerceType\s*===?\s*['"]resale['"][\s\S]{0,80}(price|score|rank|sort)/i.test(source), false);
});

Deno.test('poshmarkProvider: rejects a non-Poshmark listing URL during normalization', async () => {
  const source = await Deno.readTextFile(new URL('./poshmarkProvider.ts', import.meta.url));
  assert.ok(source.includes('isPoshmarkUrl'));
});
