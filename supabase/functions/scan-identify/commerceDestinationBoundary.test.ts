import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { filterAndDedupeProducts, hasValidPurchaseUrl } from './qualityTuneCommerce.ts';
import { normalizeUrl } from './shoppingProvider.ts';
import { scoreProductAgreement } from './commerceRelevanceAgreement.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';

const garment = { item_type: 'footwear', subtype: 'sneakers', primary_color: 'red' };
const product = (productUrl: string): RecommendedProduct => ({
  id: productUrl, title: 'Red low-top sneakers', source: 'Retailer', type: 'retail',
  productUrl, imageUrl: 'https://cdn.retailer.com/shoe.jpg', price: '$100',
});

Deno.test('final commerce boundary rejects private, credentialed, insecure and search-only destinations', () => {
  for (const url of [
    'http://retailer.com/p/shoe', 'https://user:password@retailer.com/p/shoe',
    'https://172.16.1.2/shoe', 'https://[::1]/shoe', 'https://[::ffff:127.0.0.1]/shoe',
    'https://[fc00::1]/shoe', 'https://[fe80::1]/shoe', 'https://0.0.0.0/shoe',
    'https://www.google.com/search?q=red+sneakers', 'https://shopping.google.com/product/123',
  ]) {
    assertEquals(hasValidPurchaseUrl(product(url)), false, url);
    assertEquals(filterAndDedupeProducts([product(url)], garment, { enabled: true, categoryRoute: 'footwear' }).products.length, 0, url);
  }
});

Deno.test('public direct retailer remains eligible without a preferred retailer list', () => {
  const offer = product('https://independent-retailer.com/products/red-sneakers');
  assert(hasValidPurchaseUrl(offer));
  assertEquals(filterAndDedupeProducts([offer], garment, { enabled: true, categoryRoute: 'footwear' }).products.length, 1);
  assert(scoreProductAgreement(offer, garment, 'footwear').score > scoreProductAgreement(product('https://www.google.com/search?q=sneakers'), garment, 'footwear').score);
});

Deno.test('existing provider URL normalizer uses the governed public-host guard', () => {
  for (const url of ['https://[::1]/', 'https://[::ffff:7f00:1]/', 'https://[fd12::1]/', 'https://0.0.0.0/', 'https://100.64.0.1/']) {
    assertEquals(normalizeUrl(url), undefined, url);
  }
});
