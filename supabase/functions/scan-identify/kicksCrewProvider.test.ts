import assert from 'node:assert/strict';
import { enrichKicksCrewProductByUrl, isKicksCrewProductUrl } from './kicksCrewProvider.ts';

// ── URL safety / contract shape ─────────────────────────────────────────────

Deno.test('isKicksCrewProductUrl: accepts any path under the kickscrew.com origin', () => {
  // Locale segments (e.g. /en-PT/) are not assumed constant — see header.
  assert.equal(
    isKicksCrewProductUrl('https://www.kickscrew.com/en-PT/products/nike-ja-3-mink-brown-hf2793-200'),
    true,
  );
  assert.equal(isKicksCrewProductUrl('https://www.kickscrew.com/products/anything'), true);
});

Deno.test('isKicksCrewProductUrl: rejects non-kickscrew domains, http, and near-miss hosts', () => {
  assert.equal(isKicksCrewProductUrl('https://kickscrew.com/products/x'), false, 'must match the exact www origin');
  assert.equal(isKicksCrewProductUrl('http://www.kickscrew.com/products/x'), false);
  assert.equal(isKicksCrewProductUrl('https://www.kickscrew.com.evil.com/products/x'), false);
  assert.equal(isKicksCrewProductUrl(undefined), false);
  assert.equal(isKicksCrewProductUrl(''), false);
});

// ── Fails closed without configuration ──────────────────────────────────────

Deno.test('enrichKicksCrewProductByUrl: fails closed (disabled) rather than throwing when unconfigured', async () => {
  const result = await enrichKicksCrewProductByUrl(
    'https://www.kickscrew.com/en-PT/products/nike-ja-3-mink-brown-hf2793-200',
  );
  assert.equal(result.product, null);
  assert.ok(result.errorType);
});

Deno.test('enrichKicksCrewProductByUrl: rejects a non-KicksCrew URL', async () => {
  const result = await enrichKicksCrewProductByUrl('https://www.farfetch.com/shopping/x-item-1.aspx');
  assert.equal(result.product, null);
  assert.ok(result.errorType);
});

// ── Structural / contract-lock assertions ───────────────────────────────────

Deno.test('kicksCrewProvider: correct host, endpoint, secret names — no literal RapidAPI key', async () => {
  const source = await Deno.readTextFile(new URL('./kicksCrewProvider.ts', import.meta.url));

  assert.ok(source.includes("'kickscrew-sneakers-data.p.rapidapi.com'"));
  assert.ok(source.includes('/description/byurl?productUrl='));
  assert.ok(source.includes("readEnv('KICKSCREW_RAPIDAPI_KEY')"));
  assert.ok(source.includes("readEnv('RAPIDAPI_KEY')"));
  assert.equal(/rapidapi[_-]?key['"]?\s*[:=]\s*['"][0-9a-f]{10,}/i.test(source), false, 'no literal key');

  // Owner-restricted for this phase: URL-driven enrichment only. A live probe
  // during Phase 3 proved /search?query= technically responds on this host,
  // but this integration must not call it — the header may say so in prose;
  // it must not appear as an actual outgoing request.
  assert.equal(/fetch\([^)]*\/search\?query=/.test(source), false, 'must not call the search endpoint');
  assert.equal(/const url = [^\n]*\/search\?query=/.test(source), false);
});

Deno.test('kicksCrewProvider: sneaker-only gating stays a router concern, not baked into the adapter', async () => {
  // The adapter itself is a plain URL->product function; it is the router's
  // job (scanCommerceRouter.ts) to only call it under isSneakerIdentification.
  // This test locks that division so a future edit cannot silently make the
  // adapter itself category-aware in a way that could diverge from the router.
  const source = await Deno.readTextFile(new URL('./kicksCrewProvider.ts', import.meta.url));
  assert.equal(/isSneaker/i.test(source), false);
});
