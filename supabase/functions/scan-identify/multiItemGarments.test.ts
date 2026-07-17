import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { rawDetectedGarmentCount, sanitizeDetectedGarments } from './multiItemGarments.ts';

Deno.test('sanitizeDetectedGarments preserves up to five valid garments', () => {
  const out = sanitizeDetectedGarments(
    Array.from({ length: 6 }, (_, index) => ({
      label: `Item ${index + 1}`,
      category: 'top',
      subtype: `subtype ${index + 1}`,
      bounds: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
      confidenceScore: index === 0 ? 2 : 0.8,
      dangerous: 'drop-me',
      identification: {
        item_type: 'top',
        subtype: `subtype ${index + 1}`,
        primary_color: 'black',
        confidence_score: index === 0 ? 2 : 0.8,
        exec: 'drop-me',
      },
    })),
  );

  assertEquals(out.length, 5);
  assertEquals(out[0].confidenceScore, 1);
  assertEquals(out[0].category, 'top');
  assertEquals(out[0].identification.exec, undefined);
  assertEquals((out[0] as Record<string, unknown>).dangerous, undefined);
});

Deno.test('sanitizeDetectedGarments drops malformed candidates individually', () => {
  const out = sanitizeDetectedGarments([
    null,
    'bad',
    { category: 'unknown', subtype: 'unknown', identification: {} },
    {
      category: 'jacket',
      subtype: 'bomber jacket',
      bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      identification: {
        item_type: 'jacket',
        subtype: 'bomber jacket',
        primary_color: 'navy',
      },
    },
  ]);

  assertEquals(out.length, 1);
  assertEquals(out[0].candidateId, 'garment-1-jacket-bomber-jacket');
});

Deno.test('sanitizeDetectedGarments accepts compact real-world candidates and clamps bounds', () => {
  const out = sanitizeDetectedGarments([
    {
      label: 'navy blazer',
      category: 'blazer',
      subtype: 'tailored blazer',
      primary_color: 'navy',
      confidenceScore: 0.78,
      bounds: { x: -0.1, y: 0.08, width: 1.4, height: 0.52 },
    },
  ]);

  assertEquals(out.length, 1);
  assertEquals(out[0].bounds, { x: 0, y: 0.08, width: 1, height: 0.52 });
  assertEquals(out[0].identification.item_type, 'blazer');
  assertEquals(out[0].identification.primary_color, 'navy');
});

Deno.test('rawDetectedGarmentCount reports provider array count only', () => {
  assertEquals(rawDetectedGarmentCount([{ a: 1 }, { a: 2 }]), 2);
  assertEquals(rawDetectedGarmentCount({ detectedGarments: [] }), 0);
});
