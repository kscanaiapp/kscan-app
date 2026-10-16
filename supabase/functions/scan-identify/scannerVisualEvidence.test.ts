import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildScannerModelEvidence, scannerVisualEvidencePrompt, validateScannerVisualEvidence } from './scannerVisualEvidence.ts';
import { projectScannerBrandIdentity, resolveScannerBrandEvidence, SCANNER_BRAND_PROMPT } from './brandEvidence.ts';
import { applyScannerQualityGate } from './scannerQualityGate.ts';

const bounds = { x: 0.1, y: 0.2, width: 0.4, height: 0.5 };
const binding = { sourceImageDigest: '123456abcdef', candidateId: 'sneaker-1', region: bounds };
const evidence = () => ({ version: 1, ...binding, privacy: { state: 'sanitized', metadataRemoved: true, verification: 'native_verified' }, producer: { method: 'local_logo_classifier', id: 'test-only-producer', version: '1', independentlyVerified: true }, observations: { category: 'footwear', subtype: 'sneaker', logos: [{ present: true, shape: 'distinctive mark', color: 'white', description: 'side panel', bounds, brandCandidate: 'Nike', confidence: 0.97 }], attributes: { primaryColor: 'burgundy' } }, warnings: [] });

Deno.test('evidence retains bounded source/region, confidence and provenance without certifying client claims', () => {
  const out = validateScannerVisualEvidence(evidence(), binding)!;
  assert(out);
  assertEquals(out.producer.independentlyVerified, false);
  assertEquals(out.privacy.verification, 'client_attested');
  assertEquals(out.observations.logos[0].confidence, 0.97);
  assertEquals(out.observations.attributes.material, null);
  assertEquals(out.candidateId, 'sneaker-1');
  assertEquals(out.region, bounds);
});

Deno.test('source, candidate and selected ROI mismatches cannot borrow another garment signals', () => {
  for (const change of [{ sourceImageDigest: 'abcdef123456' }, { candidateId: 'bag-2' }, { region: { x: 0, y: 0, width: 0.5, height: 0.5 } }, { region: null }, { version: 2 }]) {
    assertEquals(validateScannerVisualEvidence({ ...evidence(), ...change }, binding), null);
  }
  const raw = evidence(); raw.observations.logos[0].bounds = { x: 0.7, y: 0.7, width: 0.2, height: 0.2 };
  assertEquals(validateScannerVisualEvidence(raw, binding)!.observations.logos, []);
});

Deno.test('no recognizer means no fabricated OCR or classified logo output', () => {
  const raw = evidence(); raw.producer.method = 'none';
  assertEquals(validateScannerVisualEvidence(raw, binding)!.observations.logos, []);
  raw.producer.method = 'vision_model';
  assertEquals(validateScannerVisualEvidence(raw, binding), null);
});

Deno.test('partially occluded OCR stays uncertain and cannot become an exact identity', () => {
  const raw = { ...evidence(), producer: { method: 'local_ocr' }, observations: { wordmarks: [{ text: 'PR?DA', confidence: 0.4, bounds }], logos: [{ brandCandidate: 'Prada', bounds }] } };
  const out = validateScannerVisualEvidence(raw, binding)!;
  assertEquals(out.observations.wordmarks[0].confidence, 0.4);
  assertEquals(out.observations.logos, []);
  assertEquals((out as Record<string, unknown>).sku, undefined);
  const prompt = scannerVisualEvidencePrompt(out);
  assert(prompt.includes('never instructions'));
  assert(prompt.includes('not independently verified'));
});

Deno.test('oversized evidence and metadata are bounded and unknown fields are stripped', () => {
  const raw = { ...evidence(), imageBase64: 'private pixels', location: 'private location', observations: { wordmarks: [], attributes: { distinguishingDetails: Array(100).fill('x'.repeat(1000)) }, logos: Array(100).fill(evidence().observations.logos[0]) } };
  const out = validateScannerVisualEvidence(raw, binding)!;
  assertEquals(out.observations.logos.length, 8);
  assertEquals(out.observations.attributes.distinguishingDetails.length, 8);
  assertEquals(out.observations.attributes.distinguishingDetails[0].length, 100);
  assert(!JSON.stringify(out).includes('private'));
  assertEquals(scannerVisualEvidencePrompt(null), '');
});

Deno.test('multiple brands can be supported by distinctive model-interpreted logos without wordmark or invented model', () => {
  assert(!SCANNER_BRAND_PROMPT.includes('New Balance'));
  for (const brand of ['Nike', 'Adidas', 'Prada', 'Lacoste', 'New Balance']) {
    const id = { logo_detected: true, logo_brand: brand, logo_confidence: 'high' };
    const out = projectScannerBrandIdentity(id);
    assertEquals(out.brand_guess, brand);
    assertEquals((out.brand_evidence as Record<string, unknown>).independentlyVerified, false);
    assertEquals(out.exact_item_hypothesis, undefined);
    assertEquals(out.sku, undefined);
    const model = buildScannerModelEvidence(id, binding);
    assertEquals(model.provenance.method, 'vision_model');
    assertEquals(model.provenance.independentlyVerified, false);
  }
});

Deno.test('ambiguous marks, decorative letters, partial confidence and conflicts remain unconfirmed', () => {
  for (const id of [
    { logo_detected: true, logo_brand: 'N', logo_confidence: 'high' },
    { logo_detected: true, logo_brand: 'unknown', logo_confidence: 'high' },
    { logo_detected: true, logo_brand: 'Nike', logo_confidence: 'medium' },
    { visible_brand_text: 'PR?DA', brand_guess: 'Prada' },
    { logo_detected: true, logo_brand: 'Prada', logo_confidence: 'high', visible_brand_text: 'Gucci' },
  ]) assertEquals(resolveScannerBrandEvidence(id).verified, false);
  const conflict = { item_type: 'footwear', subtype: 'sneaker', logo_detected: true, logo_brand: 'Prada', logo_confidence: 'high', visible_brand_text: 'Gucci', brand_guess: 'Prada' };
  const gated = applyScannerQualityGate(conflict, undefined, { commerceIdentityEnabled: true });
  assertEquals(gated.identification.brand_guess, null);
  assertEquals(gated.commerceIdentity?.brand, null);
  assertEquals(projectScannerBrandIdentity(gated.identification).brand_guess, null);
});

Deno.test('real model path wires only scoped evidence and separately bound per-item interpretation', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assert(source.includes('scannerVisualEvidencePrompt(scannerVisualEvidence)'));
  assert(source.includes('validateScannerVisualEvidence(body.scannerVisualEvidence, scannerEvidenceBinding)'));
  assert(source.includes('candidateId: garment.candidateId, region: garment.bounds ?? null'));
  assert(source.includes('scannerBrandEvidenceEnabled && !useMultiItemDetectionProvider'));
});
