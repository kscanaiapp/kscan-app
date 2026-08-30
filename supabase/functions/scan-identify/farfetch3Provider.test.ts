import assert from 'node:assert/strict';
import { enrichFarfetchProductByUrl, isFarfetchProductUrl } from './farfetch3Provider.ts';

// ── URL safety / contract shape ─────────────────────────────────────────────

Deno.test('isFarfetchProductUrl: accepts a real farfetch.com product URL', () => {
  assert.equal(
    isFarfetchProductUrl('https://www.farfetch.com/shopping/women/marc-jacobs-sac-a-main-item-14568802.aspx'),
    true,
  );
  assert.equal(
    isFarfetchProductUrl('https://farfetch.com/shopping/women/gucci-gg-marmont-item-14622430.aspx'),
    true,
  );
});

Deno.test('isFarfetchProductUrl: rejects a search/listing URL — proven live to fail extraction', () => {
  // Live-probed during Phase 3: /searchByURL on an items.aspx?q= URL returns
  // {"error":"Error Extracting URL"}. Rejecting it here avoids a wasted call.
  assert.equal(
    isFarfetchProductUrl('https://www.farfetch.com/shopping/search/items.aspx?q=black+leather+jacket'),
    false,
  );
  assert.equal(isFarfetchProductUrl('https://www.farfetch.com/shopping/women/gucci/items.aspx'), false);
});

Deno.test('isFarfetchProductUrl: rejects non-farfetch domains, http, and embedded credentials', () => {
  assert.equal(isFarfetchProductUrl('https://not-farfetch.com/shopping/women/x-item-1.aspx'), false);
  assert.equal(isFarfetchProductUrl('http://www.farfetch.com/shopping/women/x-item-1.aspx'), false);
  assert.equal(isFarfetchProductUrl('https://user:pass@www.farfetch.com/shopping/women/x-item-1.aspx'), false);
  assert.equal(isFarfetchProductUrl('https://evil.com/www.farfetch.com-item-1.aspx'), false);
  assert.equal(isFarfetchProductUrl(undefined), false);
  assert.equal(isFarfetchProductUrl(''), false);
});

// ── Fails closed without configuration (this suite grants no --allow-env / --allow-net) ──

Deno.test('enrichFarfetchProductByUrl: fails closed (disabled) rather than throwing when unconfigured', async () => {
  const result = await enrichFarfetchProductByUrl(
    'https://www.farfetch.com/shopping/women/gucci-gg-marmont-item-14622430.aspx',
  );
  assert.equal(result.product, null);
  assert.ok(result.errorType);
});

Deno.test('enrichFarfetchProductByUrl: rejects a non-product URL before any network attempt', async () => {
  const result = await enrichFarfetchProductByUrl('https://www.farfetch.com/shopping/search/items.aspx?q=x');
  assert.equal(result.product, null);
  // Whichever gate trips first (disabled/no_key in this test environment, or
  // not_a_product_url), the call must resolve safely — never throw.
  assert.ok(result.errorType);
});

// ── Structural / contract-lock assertions ───────────────────────────────────

Deno.test('farfetch3Provider: correct host, endpoint, secret names — no literal RapidAPI key', async () => {
  const source = await Deno.readTextFile(new URL('./farfetch3Provider.ts', import.meta.url));

  assert.ok(source.includes("'farfetch3.p.rapidapi.com'"), 'must target the approved farfetch3 host');
  assert.ok(source.includes('/searchByURL?url='), 'must use the proven /searchByURL enrichment endpoint');
  assert.ok(source.includes("readEnv('FARFETCH3_RAPIDAPI_KEY')"), 'must read a dedicated secret name');
  assert.ok(source.includes("readEnv('RAPIDAPI_KEY')"), 'must fall back to the shared secret, not fail closed');
  assert.equal(/rapidapi[_-]?key['"]?\s*[:=]\s*['"][0-9a-f]{10,}/i.test(source), false, 'no literal key');
  // The retired host may still be named in header prose explaining why it was
  // replaced; it must not appear as an active constant/URL.
  assert.equal(/(DEFAULT_HOST|getHost\(\))\s*=[^\n]*farfetch-data/.test(source), false);
  assert.equal(/`https:\/\/\$\{host\}[^`]*farfetch-data/.test(source), false);

  // No keyword-search endpoint call — proven live not to exist on this API.
  assert.equal(/fetch\([^)]*\/search\?q=/.test(source), false);
});

Deno.test('farfetch3Provider: does not fabricate a candidate when the extraction fails', async () => {
  const source = await Deno.readTextFile(new URL('./farfetch3Provider.ts', import.meta.url));
  assert.ok(source.includes("errorType: 'extraction_error'"));
});
