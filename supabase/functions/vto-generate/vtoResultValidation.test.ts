import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateVtoResultMedia } from './vtoResultValidation.ts';
import { MOCK_VTO_RESULT_BASE64 } from './providers/mockResultAsset.ts';

function png(bytes: Uint8Array) {
  const encoded = btoa(String.fromCharCode(...bytes));
  return {
    dataUri: 'data:image/png;base64,' + encoded,
    mediaType: 'image/png',
    width: null, height: null, billedUnits: null,
  };
}
function validPng(): Uint8Array {
  return Uint8Array.from(atob(MOCK_VTO_RESULT_BASE64), c => c.charCodeAt(0));
}

Deno.test('VTO-005: actual approved PNG yields intrinsic dimensions', () => {
  const outcome = validateVtoResultMedia(png(validPng()));
  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.media.width, 256);
    assertEquals(outcome.media.height, 320);
  }
});

Deno.test('VTO-005: a truncated PNG result is never accepted as output', () => {
  const bytes = validPng().slice(0, -12);
  const outcome = validateVtoResultMedia(png(bytes));
  assertEquals(outcome.ok, false);
});

Deno.test('VTO-005: reject absurd image dimensions even with plausible MIME and magic', () => {
  const bytes = validPng();
  bytes[16] = 0x7f; bytes[17] = 0xff; bytes[18] = 0xff; bytes[19] = 0xff;
  const outcome = validateVtoResultMedia(png(bytes));
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.detail, 'invalid_image_dimensions');
});

Deno.test('VTO-005: provider dimension assertion must match decoded header', () => {
  const original = png(validPng());
  const outcome = validateVtoResultMedia({ ...original, width: 999 });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.detail, 'image_dimensions_mismatch');
});
