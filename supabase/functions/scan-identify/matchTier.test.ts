import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { classifyCommerceMatch, normalizeCommerceMatchMetadata, commerceMatchLabel, type CommerceMatchContext } from './matchTier.ts';
const product = { id: 'nb-574', brand: 'New Balance', title: 'New Balance 574 Burgundy Sneaker', productUrl: 'https://retailer.test/p/nb-574' };
const context: CommerceMatchContext = { brandEvidence: { brand: 'New Balance', verified: true, source: 'logo' }, categoryCompatible: true, subtypeCompatible: true };
const proof = { source: 'verified_product_identity' as const, scanModel: '574', productModel: '574', scanVariant: 'Burgundy', productVariant: 'Burgundy' };
Deno.test('match tier: supported brand alone is same-brand, never exact', () => {
  assertEquals(classifyCommerceMatch(product, context)?.tier, 'same_brand');
  assertEquals(commerceMatchLabel(classifyCommerceMatch(product, context), product), 'Same Brand Alternatives');
});
Deno.test('match tier: exact requires authoritative model and compatible verified variant', () => {
  assertEquals(classifyCommerceMatch(product, { ...context, exactIdentity: proof })?.tier, 'exact');
  assertEquals(classifyCommerceMatch(product, { ...context, exactIdentity: { ...proof, productVariant: 'Black' } })?.tier, 'same_brand');
  assertEquals(classifyCommerceMatch(product, { ...context, exactIdentity: { ...proof, scanVariant: '' } })?.tier, 'same_brand');
});
Deno.test('match tier: partial model collisions and generic descriptions never become exact', () => {
  for (const model of ['5740', 'New Balance burgundy sneaker']) {
    assertEquals(classifyCommerceMatch(product, { ...context, exactIdentity: { ...proof, productModel: model } })?.tier, 'same_brand');
  }
  assertEquals(classifyCommerceMatch(product, { ...context, exactIdentity: { ...proof, scanModel: 'New Balance burgundy sneaker', productModel: 'New Balance burgundy sneaker' } })?.tier, 'same_brand');
});
Deno.test('match tier: contradictions, unverified brands and category/subtype conflict remain similar', () => {
  assertEquals(classifyCommerceMatch({ ...product, brand: 'Nike' }, context)?.tier, 'similar');
  assertEquals(classifyCommerceMatch(product, { ...context, brandEvidence: { ...context.brandEvidence, verified: false } })?.tier, 'similar');
  assertEquals(classifyCommerceMatch(product, { ...context, categoryCompatible: false })?.tier, 'similar');
  assertEquals(classifyCommerceMatch(product, { ...context, subtypeCompatible: false })?.tier, 'similar');
});
Deno.test('match tier: retailer identity, title comparisons and brand substrings confer no same-brand evidence', () => {
  assertEquals(classifyCommerceMatch({ ...product, brand: undefined, title: 'Fashion sneaker', source: 'On' }, { ...context, brandEvidence: { brand: 'On', verified: true, source: 'wordmark' } })?.tier, 'similar');
  assertEquals(classifyCommerceMatch({ ...product, brand: undefined, title: 'Sneaker alternative to New Balance' }, context)?.tier, 'similar');
});
Deno.test('match tier: unsafe, nonpublic and intermediary destinations cannot carry actionable match claims', () => {
  for (const productUrl of ['javascript:alert(1)', 'https://user:pass@retailer.test/p', 'https://172.16.1.1/p', 'https://[::1]/p', 'https://[fc00::1]/p', 'https://[fe80::1]/p', 'https://a.localhost/p', 'https://shopping.google.com/product/1']) {
    assertEquals(classifyCommerceMatch({ ...product, productUrl }, context), null, productUrl);
  }
});
Deno.test('match tier: metadata is listing-bound and legacy/unknown versions never upgrade', () => {
  const metadata = classifyCommerceMatch(product, { ...context, exactIdentity: proof })!;
  assertEquals(normalizeCommerceMatchMetadata(metadata, { ...product, id: 'other' }), null);
  assertEquals(normalizeCommerceMatchMetadata(metadata, { ...product, productUrl: 'https://retailer.test/p/other' }), null);
  assertEquals(normalizeCommerceMatchMetadata({ ...metadata, version: 2 }, product), null);
  assertEquals(commerceMatchLabel({ tier: 'exact', confidence: 1 }, product), 'Similar Styles');
  assertEquals(normalizeCommerceMatchMetadata({ ...metadata, evidence: { ...metadata.evidence, model: { ...metadata.evidence.model, verification: 'model_confidence' } } }, product)?.tier, 'same_brand');
});
