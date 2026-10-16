import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyScannerQualityGate } from './scannerQualityGate.ts';

const sneaker = { item_type: 'footwear', subtype: 'sneaker', primary_color: 'burgundy', material_estimate: 'suede', confidence_score: 0.92 };
const legacy = (extra: Record<string, unknown>) => applyScannerQualityGate(
  { ...sneaker, ...extra }, undefined,
  { commerceIdentityEnabled: true, useClassifiedBrandEvidence: false },
);

Deno.test('non-Scanner isolation preserves bare-logo evidence and existing brand guess', () => {
  const out = legacy({ logo_detected: true, brand_guess: 'New Balance' });
  assertEquals(out.identification.brand_guess, 'New Balance');
  assertEquals(out.brandSuppressed, false);
  assertEquals(out.commerceIdentity?.brand, 'New Balance');
  assertEquals(out.commerceIdentity?.brandGrade, 'verified');
  const scanner = applyScannerQualityGate({ ...sneaker, logo_detected: true, brand_guess: 'New Balance' });
  assertEquals(scanner.identification.brand_guess, null);
});

Deno.test('non-Scanner isolation preserves guess precedence over a conflicting wordmark', () => {
  const out = legacy({ visible_brand_text: 'Prada', brand_guess: 'Gucci' });
  assertEquals(out.identification.brand_guess, 'Gucci');
  assertEquals(out.commerceIdentity?.brand, 'Gucci');
  assertEquals(out.commerceIdentity?.visibleBrandText, 'Prada');
  assertEquals(out.commerceIdentity?.brandGrade, 'verified');
});

Deno.test('non-Scanner isolation retains original Miu Miu speculation suppression', () => {
  for (const brand_guess of ['Miu Miu', 'miumiu']) {
    const out = legacy({ visible_brand_text: brand_guess, brand_guess, logo_detected: true });
    assertEquals(out.identification.brand_guess, null);
    assertEquals(out.brandSuppressed, true);
    assertEquals(out.commerceIdentity?.brand, null);
    assertEquals(out.commerceIdentity?.brandGrade, 'invalid');
  }
});

Deno.test('non-Scanner isolation does not canonicalize newly classified logo fields', () => {
  const out = legacy({ logo_detected: true, logo_brand: 'New Balance', logo_confidence: 'high' });
  assertEquals(out.identification.brand_guess, undefined);
  assertEquals(out.commerceIdentity?.brand, null);
  const scanner = applyScannerQualityGate({ ...sneaker, logo_detected: true, logo_brand: 'New Balance', logo_confidence: 'high' });
  assertEquals(scanner.identification.brand_guess, 'New Balance');
});

Deno.test('non-Scanner isolation preserves observed text and original speculative exact grading', () => {
  const out = legacy({ visible_brand_text: 'designer style', brand_guess: 'Prada', exact_item_hypothesis: 'Miu Miu', exact_match_confidence: 'high' });
  assertEquals(out.identification.visible_brand_text, 'designer style');
  assertEquals(out.identification.brand_guess, 'Prada');
  assertEquals(out.commerceIdentity?.exactItemHypothesis, null);
  assertEquals(out.commerceIdentity?.exactMatchGrade, 'invalid');
});
