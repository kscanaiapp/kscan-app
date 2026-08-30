import assert from 'node:assert/strict';
import { detectFashionGarments } from './fashionDetectionProvider.ts';

Deno.test('detectFashionGarments: fails closed (disabled) rather than throwing when unconfigured', async () => {
  const result = await detectFashionGarments('https://example.test/sanitized/scan-123.jpg');
  assert.deepEqual(result.garments, []);
  assert.equal(result.errorType, 'disabled');
});

Deno.test('detectFashionGarments: empty image URL is rejected', async () => {
  const result = await detectFashionGarments('');
  assert.deepEqual(result.garments, []);
  assert.ok(result.errorType);
});

Deno.test('fashionDetectionProvider: is commerce enrichment only — never authoritative for Scanner state', async () => {
  const source = await Deno.readTextFile(new URL('./fashionDetectionProvider.ts', import.meta.url));
  // No import from the Scanner/identification modules and no mutation of any
  // identification/attributes object — this file only ever returns its own
  // FashionDetectionResult to whatever optional caller wants it.
  assert.equal(/from ['"]\.\/scannerQualityGate\.ts['"]/.test(source), false);
  assert.equal(/from ['"]\.\/scannerCategoryRoute\.ts['"]/.test(source), false);
  assert.equal(/identification\[/.test(source), false);
});

Deno.test('fashionDetectionProvider: not wired into the live commerce path', async () => {
  const router = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  assert.equal(router.includes('fashionDetectionProvider'), false);
});

Deno.test('fashionDetectionProvider: correct host, endpoint, secret names — no literal RapidAPI key', async () => {
  const source = await Deno.readTextFile(new URL('./fashionDetectionProvider.ts', import.meta.url));
  assert.ok(source.includes("'fashion4.p.rapidapi.com'"));
  assert.ok(source.includes('/v2/results'));
  assert.ok(source.includes("readEnv('FASHION4_RAPIDAPI_KEY')"));
  assert.equal(/rapidapi[_-]?key['"]?\s*[:=]\s*['"][0-9a-f]{10,}/i.test(source), false, 'no literal key');
});

Deno.test('fashionDetectionProvider: bounded garment output', async () => {
  const source = await Deno.readTextFile(new URL('./fashionDetectionProvider.ts', import.meta.url));
  assert.ok(source.includes('MAX_GARMENTS'));
});
