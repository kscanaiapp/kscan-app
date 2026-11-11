import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { sanitizeDetectedGarments } from './multiItemGarments.ts';
import { projectScannerBrandIdentity, shouldUseScannerBrandEvidence } from './brandEvidence.ts';
import { withScannerMultiItemBrandPrompt, withScannerMultiItemBrandSchema } from './multiItemBrandEvidence.ts';

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

Deno.test('multi-item helper stays Scanner-only: no other module imports it', async () => {
  // Blast-radius guard: importing this module from a shared file would widen
  // the deployable closure of every function that shares that file.
  const root = new URL('../', import.meta.url);
  const importers: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const entry of Deno.readDir(dir)) {
      const next = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory) {
        if (entry.name === 'node_modules') continue;
        await walk(new URL(entry.name + '/', dir), next);
      } else if (entry.isFile && next.endsWith('.ts') && !next.endsWith('.test.ts')) {
        const text = await Deno.readTextFile(new URL(entry.name, dir));
        if (text.includes('multiItemBrandEvidence.ts')) importers.push(next);
      }
    }
  }
  await walk(root, '');
  assertEquals(importers, ['scan-identify/index.ts']);
});
