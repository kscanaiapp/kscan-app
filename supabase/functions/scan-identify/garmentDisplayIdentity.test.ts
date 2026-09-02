/**
 * Build 34 Scanner audit — SCAN-003 / SCAN-004.
 *
 * Item A's identity may never appear on Item B's card.
 *
 * Reproduced live on App Staging with assets/qa_fixtures/accessory.jpg: the
 * response's second detected garment came back as
 *
 *   candidateId: "garment-2-eyewear-aviator-sunglasses"
 *   label:       "Blue Crossbody Bag"     <- garment 1's label
 *   subtype:     ""                       <- erased
 *
 * because the per-garment loop read the PRIMARY garment's quality-gate label
 * whenever the current garment's own subtype had been suppressed, and then
 * wrote the suppressed (empty) subtype over the identity the candidateId was
 * minted from.
 *
 * These are behavioural tests over the extracted resolver, plus a wiring test
 * over the loop that consumes it, plus an end-to-end reproduction driving the
 * real quality-tune + quality-gate stack with the exact live payload.
 */
import assert from 'node:assert/strict';
import { resolveGarmentDisplayIdentity, sanitizeDetectedGarments } from './multiItemGarments.ts';
import { applyQualityTaxonomyTune } from './qualityTuneNormalize.ts';
import { applyScannerQualityGate } from './scannerQualityGate.ts';

Deno.test('a suppressed subtype never pulls in another garment label', () => {
  const identity = resolveGarmentDisplayIdentity({
    tunedItemType: 'eyewear',
    tunedSubtype: '',
    priorSubtype: 'aviator sunglasses',
    priorCategory: 'eyewear',
    // The primary garment's label is NOT accepted here at all — the only
    // gate label this function can see is the garment's own.
    ownGateLabel: 'Gold Eyewear',
  });
  assert.equal(identity.category, 'eyewear');
  assert.equal(identity.subtype, 'aviator sunglasses',
    'a subtype suppressed for retrieval must not erase the identity the candidateId was minted from');
  assert.equal(identity.label, 'aviator sunglasses',
    'the label must name THIS garment');
  assert.notEqual(identity.label, 'Blue Crossbody Bag');
});

Deno.test("the garment's own gate label is used only when it has no subtype at all", () => {
  const identity = resolveGarmentDisplayIdentity({
    tunedItemType: 'eyewear',
    tunedSubtype: '',
    priorSubtype: '',
    priorCategory: 'eyewear',
    ownGateLabel: 'Gold Eyewear',
  });
  assert.equal(identity.label, 'Gold Eyewear');
  assert.equal(identity.subtype, 'eyewear', 'subtype falls back to the category, never to empty');
});

Deno.test('with no gate and no prior subtype everything collapses to the category', () => {
  const identity = resolveGarmentDisplayIdentity({
    tunedItemType: 'bag',
    tunedSubtype: '',
    priorSubtype: '',
    priorCategory: 'bag',
  });
  assert.deepEqual(identity, { category: 'bag', subtype: 'bag', label: 'bag' });
});

Deno.test('a tuned subtype still wins — taxonomy correction is not reverted', () => {
  const identity = resolveGarmentDisplayIdentity({
    tunedItemType: 'outerwear',
    tunedSubtype: 'moto jacket',
    priorSubtype: 'biker jacket',
    priorCategory: 'jacket',
    ownGateLabel: 'Black Moto Jacket',
  });
  assert.equal(identity.category, 'outerwear', 'the tuned category is authoritative');
  assert.equal(identity.subtype, 'moto jacket', 'the tuned subtype is authoritative');
  assert.equal(identity.label, 'moto jacket');
});

Deno.test('an empty tuned item_type keeps the garment on its detected category', () => {
  const identity = resolveGarmentDisplayIdentity({
    tunedItemType: '',
    tunedSubtype: 'chelsea boot',
    priorSubtype: 'chelsea boot',
    priorCategory: 'footwear',
  });
  assert.equal(identity.category, 'footwear');
  assert.equal(identity.label, 'chelsea boot');
});

Deno.test('end to end: the live accessory.jpg payload no longer leaks garment 1 onto garment 2', () => {
  // The exact detectedGarments the model returned for assets/qa_fixtures/accessory.jpg.
  const garments = sanitizeDetectedGarments([
    {
      label: 'crossbody bag',
      category: 'bag',
      subtype: 'crossbody bag',
      bounds: { x: 0, y: 0.12, width: 0.58, height: 0.6 },
      confidenceScore: 0.95,
      visual_observation: 'Blue and white striped canvas crossbody bag with black leather straps.',
      item_type: 'bag',
      primary_color: 'blue',
    },
    {
      label: 'aviator sunglasses',
      category: 'eyewear',
      subtype: 'aviator sunglasses',
      bounds: { x: 0.6, y: 0.33, width: 0.22, height: 0.18 },
      confidenceScore: 0.92,
      visual_observation: 'Metal-framed aviator sunglasses with gradient brown lenses.',
      item_type: 'eyewear',
      primary_color: 'gold',
    },
  ]);
  assert.equal(garments.length, 2);

  // Replay the per-garment normalization loop exactly as index.ts runs it.
  let primaryGate: { label: string } | null = null;
  const resolved = garments.map((g, i) => {
    let tuned = applyQualityTaxonomyTune(
      g.identification as Record<string, unknown>,
      g.attributes as Record<string, unknown>,
    );
    const gated = applyScannerQualityGate(tuned.identification, tuned.attributes, {
      commerceIdentityEnabled: false,
    });
    tuned = { ...tuned, identification: gated.identification, attributes: gated.attributes };
    if (i === 0) primaryGate = gated;
    return resolveGarmentDisplayIdentity({
      tunedItemType: tuned.identification.item_type,
      tunedSubtype: tuned.identification.subtype,
      priorSubtype: g.subtype,
      priorCategory: g.category,
      ownGateLabel: gated.label,
    });
  });

  assert.ok(primaryGate, 'the primary gate was captured (it still shapes single-item commerce)');
  assert.equal(resolved[1].label, 'aviator sunglasses',
    'garment 2 must name the sunglasses, not garment 1');
  assert.notEqual(resolved[1].label, resolved[0].label,
    'two distinct garments must never share a label');
  assert.notEqual(resolved[1].label, (primaryGate as { label: string }).label,
    "garment 2 must never inherit the primary garment's gate label");
  assert.equal(resolved[1].subtype, 'aviator sunglasses',
    'the candidateId says aviator-sunglasses; the displayed subtype must agree');
  assert.ok(garments[1].candidateId.includes('aviator-sunglasses'),
    'guard on the premise: the candidateId really does encode this subtype');
});

Deno.test('index.ts resolves garment identity through the shared resolver, not inline', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const loopStart = src.indexOf('for (let i = 0; i < detectedGarments.length; i++) {');
  assert.ok(loopStart > 0, 'the per-garment normalization loop is missing');
  const loopEnd = src.indexOf('const primaryTuned = primaryGarmentResponseFields(', loopStart);
  assert.ok(loopEnd > loopStart, 'could not bound the per-garment normalization loop');
  const loop = src.slice(loopStart, loopEnd);

  assert.ok(loop.includes('resolveGarmentDisplayIdentity({'),
    'identity must be resolved by the tested helper');
  assert.ok(!loop.includes('intelligenceGate?.label'),
    "the primary garment's gate label must never be read inside the per-garment loop");
  assert.ok(loop.includes('ownGateLabel = gated.label'),
    "each garment must carry its OWN gate label");
  assert.ok(loop.includes('const priorSubtype = g.subtype;'),
    'the pre-gate subtype must be captured before g.identification is replaced');
  assert.ok(loop.includes('if (i === 0) intelligenceGate = gated;'),
    'the primary gate must still be retained for the commerce-shaping fields below the loop');
});
