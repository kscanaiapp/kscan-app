import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyScannerQualityGate } from './scannerQualityGate.ts';
import { sanitizeDetectedGarments } from './multiItemGarments.ts';
import { projectScannerBrandIdentity, scopeScannerBrandSchema, shouldUseScannerBrandEvidence, summarizeScannerBrandEvidence, withScannerMultiItemBrandPrompt, withScannerMultiItemBrandSchema } from './brandEvidence.ts';
import { normalizeToV2 } from '../_shared/fashionIdentificationV2.ts';

const sneaker = { item_type: 'footwear', subtype: 'sneaker', primary_color: 'burgundy', material_estimate: 'suede', silhouette: 'low profile', confidence_score: 0.92 };
const gate = (id: Record<string, unknown>) => applyScannerQualityGate({ ...sneaker, ...id }, undefined, { commerceIdentityEnabled: true });

Deno.test('New Balance classified logo survives without inventing a model or requiring a wordmark', () => {
  const out = gate({ logo_detected: true, logo_brand: 'New Balance', logo_confidence: 'high', logo_description: 'slanted block N with contrast outline on side panel' });
  assertEquals(out.identification.brand_guess, 'New Balance');
  assertEquals(out.commerceIdentity?.brand, 'New Balance');
  assertEquals(out.commerceIdentity?.brandGrade, 'verified');
  assertEquals(out.commerceIdentity?.exactItemHypothesis, null);
});

Deno.test('wordmark overrides contradictory hypothesis in both identification and commerce identity', () => {
  const out = gate({ visible_brand_text: 'New Balance', brand_guess: 'Nike', logo_detected: true });
  assertEquals(out.identification.brand_guess, 'New Balance');
  assertEquals(out.commerceIdentity?.brand, 'New Balance');
});

Deno.test('negative controls: a decorative N, unnamed logo, and uncertain classification cannot verify New Balance', () => {
  for (const extra of [
    { logo_detected: true },
    { visible_brand_text: 'N', logo_detected: true },
    { logo_detected: true, logo_brand: 'New Balance', logo_confidence: 'low' },
    { logo_detected: false, logo_brand: 'New Balance', logo_confidence: 'high' },
    { logo_detected: true, logo_brand: 'N', logo_confidence: 'high' },
  ]) {
    const out = gate({ brand_guess: 'New Balance', ...extra });
    assertEquals(out.identification.brand_guess, null);
    assertEquals(out.commerceIdentity?.brandGrade, 'weak');
  }
});

Deno.test('unrelated classified logo governs over a New Balance guess', () => {
  const out = gate({ logo_detected: true, logo_brand: 'Nike', logo_confidence: 'high', brand_guess: 'New Balance' });
  assertEquals(out.identification.brand_guess, 'Nike');
  assertEquals(out.commerceIdentity?.brand, 'Nike');
});

Deno.test('a real Miu Miu wordmark is not speculative branding', () => {
  const out = gate({ visible_brand_text: 'Miu Miu', brand_guess: 'Miu Miu' });
  assertEquals(out.identification.brand_guess, 'Miu Miu');
  assertEquals(out.commerceIdentity?.brandGrade, 'verified');
});

Deno.test('selected-item model schema accepts brand evidence with the optional identity flag OFF', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const object = source.match(/const SELECTED_ITEM_RESPONSE_SCHEMA = (\{[\s\S]*?\n\}) as const;/)?.[1];
  assert(object);
  const schema = new Function(`return (${object})`)();
  const fields = schema.properties.identification.properties;
  for (const key of ['visible_brand_text', 'brand_guess', 'logo_detected', 'logo_brand', 'logo_description', 'logo_confidence']) {
    assert(fields[key], `${key} was excluded from the actual model response schema`);
  }
  assertEquals(schema.properties.identification.required.includes('logo_brand'), false);
  const eliseFields = scopeScannerBrandSchema(schema, false, false).properties.identification.properties;
  for (const key of ['visible_brand_text', 'brand_guess', 'logo_detected', 'logo_brand', 'logo_description', 'logo_confidence']) assertEquals(eliseFields[key], undefined);
  const legacyIdentity = scopeScannerBrandSchema(schema, false, true).properties.identification.properties;
  assert(legacyIdentity.visible_brand_text);
  assertEquals(legacyIdentity.logo_brand, undefined);
  assertEquals(scopeScannerBrandSchema(schema, true, false), schema);
});

Deno.test('multi-item sanitizer retains each selected garment logo without mixing candidates', () => {
  const out = sanitizeDetectedGarments([
    { ...sneaker, label: 'Burgundy sneaker', category: 'footwear', logo_detected: true, logo_brand: 'New Balance', logo_confidence: 'high' },
    { item_type: 'bag', subtype: 'tote', label: 'Black tote', category: 'bag', logo_detected: false },
  ]);
  assertEquals(out.length, 2);
  assertEquals(out[0].identification.logo_brand, 'New Balance');
  assertEquals(out[1].identification.logo_brand, undefined);
});

Deno.test('privacy-safe evidence diagnostics contain bounded states only', () => {
  const summary = summarizeScannerBrandEvidence({ visible_brand_text: 'private wording', brand_guess: 'private guess', exact_item_hypothesis: 'private model', imageBase64: 'private pixels' });
  assertEquals(summary, { brandEvidenceSource: 'wordmark', brandVerified: true, logoDetected: false, hasBrandHypothesis: true, hasExactHypothesis: true });
});

Deno.test('Scanner brand projection survives actual shared V2 normalization with optional layers OFF', () => {
  for (const id of [
    { ...sneaker, logo_detected: true, logo_brand: 'New Balance', logo_confidence: 'high' },
    { ...sneaker, visible_brand_text: 'New Balance', brand_guess: 'Nike' },
  ]) {
    const projected = projectScannerBrandIdentity(id);
    const v2 = normalizeToV2({ requestId: 'scanner-brand-test', outcome: 'classified', identification: projected, evidenceIds: [] });
    assertEquals(v2.item.brand.value, 'New Balance');
  }
  const rejected = projectScannerBrandIdentity({ ...sneaker, logo_detected: true, brand_guess: 'New Balance' });
  const v2 = normalizeToV2({ requestId: 'scanner-brand-negative', outcome: 'classified', identification: rejected, evidenceIds: [] });
  assertEquals(v2.item.brand.value, null);
});

Deno.test('Scanner-only brand prompt and projection exclude every Elise image entry', () => {
  for (const path of ['elise_camera', 'elise_gallery', 'elise_outfit_gallery', 'elise']) {
    assertEquals(shouldUseScannerBrandEvidence('image', path, 'camera'), false);
    assertEquals(shouldUseScannerBrandEvidence('image', undefined, path), false);
  }
  assertEquals(shouldUseScannerBrandEvidence('image', 'scan_camera', 'camera'), true);
  assertEquals(shouldUseScannerBrandEvidence('image', undefined, 'gallery'), true);
  assertEquals(shouldUseScannerBrandEvidence('text', 'scan_camera'), false);
});

Deno.test('multi-item Scanner schema asks optional per-garment brand fields without changing OFF', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const match = source.match(/const MULTI_ITEM_RESPONSE_SCHEMA = (\{[\s\S]*?\n\}) as const;/);
  assert(match, 'real Gemini multi-item schema missing');
  const schema = new Function('return (' + match[1] + ')')();
  const before = JSON.stringify(schema);
  assert(withScannerMultiItemBrandSchema(schema, false) === schema, 'OFF object not preserved');
  const on = withScannerMultiItemBrandSchema(schema, true);
  assertEquals(JSON.stringify(schema), before, 'ON mutates legacy schema');
  assertEquals(on.required, schema.required, 'top-level required keys changed');
  assertEquals(on.properties.detectedGarments.items.required, schema.properties.detectedGarments.items.required);
  assertEquals(on.properties.recommendedProducts.maxItems, 0, 'detection must not run commerce');
  for (const key of ['visible_brand_text', 'logo_detected', 'logo_brand', 'logo_description', 'logo_confidence']) {
    assertEquals(schema.properties.detectedGarments.items.properties[key], undefined, 'OFF unexpectedly includes ' + key);
    assert(on.properties.detectedGarments.items.properties[key], 'ON missing ' + key);
    assertEquals(on.properties.detectedGarments.items.required.includes(key), false, 'new field required ' + key);
  }
  assert(source.includes('withScannerMultiItemBrandSchema(MULTI_ITEM_RESPONSE_SCHEMA, scannerBrandEvidenceEnabled)'), 'actual model request not wired');
});

Deno.test('multi-item brand prompt is opt-in; Elise, OFF and text paths remain unchanged', async () => {
  const original = 'STRICT EXISTING PROMPT';
  assert(withScannerMultiItemBrandPrompt(original, false) === original, 'OFF bytes changed');
  const on = withScannerMultiItemBrandPrompt(original, true);
  assert(on.startsWith(original));
  for (const key of ['visible_brand_text', 'logo_detected', 'logo_brand', 'logo_confidence']) assert(on.includes(key));
  assert(on.includes('generic letter') && on.includes('exact model'));
  for (const path of ['elise', 'elise_camera', 'elise_gallery']) assertEquals(shouldUseScannerBrandEvidence('image', path, 'camera'), false);
  assertEquals(shouldUseScannerBrandEvidence('text', 'scan_camera', 'camera'), false);
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assert(source.includes('withScannerMultiItemBrandPrompt(withQualityAndRoute(MULTI_ITEM_IDENTIFY_PROMPT), scannerBrandEvidenceEnabled)'));
});

Deno.test('multi-item logo evidence survives sanitization but low-confidence/generic N do not', () => {
  const rows = sanitizeDetectedGarments([
    { label: 'Burgundy sneaker', category: 'footwear', subtype: 'sneaker', logo_detected: true, logo_brand: 'New Balance', logo_confidence: 'high', logo_description: 'slanted outlined N on side panel' },
    { label: 'Plain tote', category: 'bag', subtype: 'tote', logo_detected: true, logo_brand: 'N', logo_confidence: 'high' },
    { label: 'Decorative patch', category: 'footwear', subtype: 'sneaker', logo_detected: true, logo_brand: 'New Balance', logo_confidence: 'low' },
  ]);
  assertEquals(rows.length, 3);
  assertEquals(projectScannerBrandIdentity(rows[0].identification).brand_guess, 'New Balance');
  assertEquals(projectScannerBrandIdentity(rows[1].identification).brand_guess, null);
  assertEquals(projectScannerBrandIdentity(rows[2].identification).brand_guess, null);
  assertEquals(rows[0].identification.exact_item_hypothesis, undefined);
});
