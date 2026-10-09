/**
 * Build 35 Scanner live certification — defect B35-SCAN-021.
 *
 * The quality gate used to strip a CORRECT subtype whenever the model's category
 * label had no curated allow-list. `normalizeCategory()` is the identity for any
 * label it does not know, so two unmapped labels ("skirt", "mini skirt") could
 * never compare equal and read as a category/subtype CONFLICT. The subtype was
 * cleared, the quality band fell to "low" and the shopping query degraded to
 * colour + category. Observed live on Staging (2026-10-09): aviator sunglasses
 * (`eyewear` / `aviator sunglasses`) became "Gold Eyewear" and every returned
 * offer was an optical eyeglasses frame.
 *
 * A conflict needs POSITIVE evidence. These tests pin both halves of that rule:
 * consistent pairs keep their subtype, and genuinely contradictory pairs are still
 * suppressed (negative controls).
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyScannerQualityGate } from './scannerQualityGate.ts';

type Pair = [category: string, subtype: string];

function gate(category: string, subtype: string, color = 'black') {
  return applyScannerQualityGate(
    { item_type: category, subtype, primary_color: color, confidence_score: 0.9 },
    { category },
  );
}

const hasConflict = (r: ReturnType<typeof gate>) =>
  r.consistencyConflicts.some((c) => c.code === 'category_subtype_conflict');

/** Consistent pairs the live gate used to strip (18 of 64 swept; the first two are the live failures). */
const CONSISTENT_BUT_FORMERLY_STRIPPED: Pair[] = [
  ['eyewear', 'aviator sunglasses'],
  ['eyewear', 'sunglasses'],
  ['eyewear', 'eyeglasses'],
  ['glasses', 'round glasses'],
  ['accessories', 'sunglasses'],
  ['skirt', 'mini skirt'],
  ['skirt', 'pleated midi skirt'],
  ['skirts', 'denim skirt'],
  ['jumpsuit', 'wide-leg jumpsuit'],
  ['romper', 'floral romper'],
  ['knitwear', 'cable knit sweater'],
  ['vest', 'puffer vest'],
  ['socks', 'crew socks'],
  ['swimwear', 'bikini'],
  ['activewear', 'sports bra'],
  ['suit', 'two-piece suit'],
  ['underwear', 'boxer briefs'],
  ['sleepwear', 'pajama set'],
];

/** Consistent pairs that already worked and must keep working. */
const CONSISTENT_ALREADY_KEPT: Pair[] = [
  ['bags', 'backpack'],
  ['footwear', 'sneakers'],
  ['tops', 't-shirt'],
  ['pants', 'jeans'],
  ['dress', 'wedding dress'],
  ['outerwear', 'leather jacket'],
  ['hat', 'baseball cap'],
  ['jewelry', 'gold necklace'],
  ['watch', 'analog watch'],
  ['hoodie', 'pullover hoodie'],
  ['blazer', 'tailored blazer'],
  ['accessory', 'belt'],
];

for (const [category, subtype] of [...CONSISTENT_BUT_FORMERLY_STRIPPED, ...CONSISTENT_ALREADY_KEPT]) {
  Deno.test(`subtype retained: ${category} / ${subtype}`, () => {
    const r = gate(category, subtype);
    assertEquals(r.identification.subtype, subtype, 'a consistent subtype must not be stripped');
    assert(!hasConflict(r), 'a consistent pair must not be reported as a conflict');
    assert(!r.suppressedAttributes.includes('subtype'));
  });
}

Deno.test('aviator sunglasses keep their identity in the label and the quality band', () => {
  const r = gate('eyewear', 'aviator sunglasses', 'gold');
  assertEquals(r.label, 'Gold Aviator Sunglasses');
  assert(r.qualityBand !== 'low', `band was ${r.qualityBand}`);
  const stripped = gate('dress', 'Straight-Leg Trousers'); // a real conflict, for contrast
  assert(r.qualityScore > stripped.qualityScore);
});

Deno.test('a retained subtype restores a moderate-or-better commerce query level for skirts', () => {
  const r = gate('skirt', 'pleated midi skirt', 'blue');
  assert(r.qualityBand !== 'low', `band was ${r.qualityBand}`);
  assertEquals(r.label, 'Blue Pleated Midi Skirt');
});

/** NEGATIVE CONTROLS: genuinely contradictory pairs are still suppressed. */
const CONTRADICTORY: Pair[] = [
  ['dress', 'Straight-Leg Trousers'],
  ['dress', 'jeans'],
  ['outerwear', 'sneakers'],
  ['top', 'sneakers'],
  ['bag', 'trousers'],
  ['pants', 'sandals'],
  ['footwear', 'tailored blazer'],
  ['skirt', 'trousers'],
  ['skirt', 'jeans'],
  ['eyewear', 'sneakers'],
  ['accessories', 'jeans'],
  ['knitwear', 'jeans'],
  ['vest', 'sneakers'],
  ['jumpsuit', 'sandals'],
];

for (const [category, subtype] of CONTRADICTORY) {
  Deno.test(`NEGATIVE CONTROL: contradictory pair is still suppressed: ${category} / ${subtype}`, () => {
    const r = gate(category, subtype);
    assert(hasConflict(r), 'a contradictory pair must still be reported');
    assertEquals(r.identification.subtype, '');
    assert(r.suppressedAttributes.includes('subtype'));
  });
}
