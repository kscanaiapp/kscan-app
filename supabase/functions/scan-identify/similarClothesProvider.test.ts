import assert from 'node:assert/strict';
import { searchSimilarClothes } from './similarClothesProvider.ts';

Deno.test('searchSimilarClothes: fails closed (disabled) rather than throwing when unconfigured', async () => {
  const result = await searchSimilarClothes('https://example.test/sanitized/scan-123.jpg');
  assert.deepEqual(result.products, []);
  assert.equal(result.errorType, 'disabled');
});

Deno.test('searchSimilarClothes: empty image URL is rejected', async () => {
  const result = await searchSimilarClothes('');
  assert.deepEqual(result.products, []);
  assert.ok(result.errorType);
});

Deno.test('similarClothesProvider: BLOCKED_BY_PRIVACY_TRANSPORT — no caller in the router supplies an image URL', async () => {
  const router = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  assert.equal(router.includes('similarClothesProvider'), false, 'must not be wired into the live commerce path yet');
});

Deno.test('similarClothesProvider: correct host, endpoint, secret names — no literal RapidAPI key', async () => {
  const source = await Deno.readTextFile(new URL('./similarClothesProvider.ts', import.meta.url));
  assert.ok(source.includes("'similar-clothes-ai.p.rapidapi.com'"));
  assert.ok(source.includes("readEnv('SIMILAR_CLOTHES_RAPIDAPI_KEY')"));
  assert.ok(source.includes('application/x-www-form-urlencoded'));
  assert.equal(/rapidapi[_-]?key['"]?\s*[:=]\s*['"][0-9a-f]{10,}/i.test(source), false, 'no literal key');
});

Deno.test('similarClothesProvider: raw pre-sanitization image path cannot reach this provider', async () => {
  // The adapter takes only a caller-supplied string and never touches the
  // filesystem, Scanner state, or any local:// / file:// / content:// path —
  // it has no code path capable of reading a raw device image at all.
  const source = await Deno.readTextFile(new URL('./similarClothesProvider.ts', import.meta.url));
  assert.equal(/file:\/\/|content:\/\/|FileSystem|expo-file-system/i.test(source), false);
});
