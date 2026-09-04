import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMask, fillRect } from '../foregroundMask';
import {
  OCCLUSION_LAYERS,
  OCCLUSION_PAINT_ORDER,
  PRECOMPUTED_SEMANTIC_MASK_LABEL,
  REGION_LAYER,
  SEMANTIC_REGIONS,
  assertValidSemanticMaskFrame,
  assertValidSemanticScene,
  combineSemanticScene,
  occludes,
  paintOrderIndex,
  type SemanticMaskFrame,
} from '../semanticOcclusion';

test('BODY occludes GARMENT, GARMENT occludes EXISTING_CLOTHING and BACKGROUND, EXISTING_CLOTHING occludes BACKGROUND', () => {
  assert.ok(occludes('BODY', 'GARMENT'));
  assert.ok(occludes('GARMENT', 'EXISTING_CLOTHING'));
  assert.ok(occludes('GARMENT', 'BACKGROUND'));
  assert.ok(occludes('EXISTING_CLOTHING', 'BACKGROUND'));
});

test('occlusion order is not reversible for any pair', () => {
  for (const a of OCCLUSION_LAYERS) {
    for (const b of OCCLUSION_LAYERS) {
      if (a === b) continue;
      assert.notEqual(occludes(a, b), occludes(b, a), `${a} vs ${b} should not both (or neither) occlude`);
    }
  }
});

test('paintOrderIndex is strictly increasing along OCCLUSION_PAINT_ORDER and throws on an unknown layer', () => {
  const indices = OCCLUSION_PAINT_ORDER.map(paintOrderIndex);
  for (let i = 1; i < indices.length; i += 1) assert.ok(indices[i]! > indices[i - 1]!);
  assert.throws(() => paintOrderIndex('NOT_A_LAYER' as never), RangeError);
});

test('every SEMANTIC_REGIONS entry maps to a known OCCLUSION_LAYERS value', () => {
  for (const region of SEMANTIC_REGIONS) {
    assert.ok((OCCLUSION_LAYERS as readonly string[]).includes(REGION_LAYER[region]));
  }
  assert.equal(REGION_LAYER.background, 'BACKGROUND');
  assert.equal(REGION_LAYER.hair, 'BODY');
  assert.equal(REGION_LAYER.forearm_hand, 'BODY');
});

function labeledFrame(region: SemanticMaskFrame['region'], label = PRECOMPUTED_SEMANTIC_MASK_LABEL): SemanticMaskFrame {
  // Starts empty (0), matching every other fixture in this package: a
  // semantic mask represents "nothing here unless explicitly filled," not a
  // uniform default coverage that would contaminate texels a test didn't
  // mean to set.
  return {
    region,
    frame: { timestamp: 0, mask: createMask(2, 2, 0), confidence: 0.8, provenance: 'PRECOMPUTED' },
    label,
  };
}

test('assertValidSemanticMaskFrame accepts the exact required label for a PRECOMPUTED frame', () => {
  assert.doesNotThrow(() => assertValidSemanticMaskFrame(labeledFrame('hair')));
});

test('assertValidSemanticMaskFrame rejects a PRECOMPUTED frame with a missing or wrong label', () => {
  assert.throws(() => assertValidSemanticMaskFrame(labeledFrame('hair', 'made up label')), RangeError);
  assert.throws(() => assertValidSemanticMaskFrame(labeledFrame('hair', '')), RangeError);
});

test('assertValidSemanticScene rejects an entry keyed under the wrong region', () => {
  const scene = { hair: labeledFrame('forearm_hand') };
  assert.throws(() => assertValidSemanticScene(scene as never), RangeError);
});

test('combineSemanticScene takes a per-texel maximum across every populated region', () => {
  const armMask = labeledFrame('forearm_hand');
  fillRect(armMask.frame.mask, { x: 0, y: 0, w: 1, h: 1 }, 0.4);
  const hairMask = labeledFrame('hair');
  fillRect(hairMask.frame.mask, { x: 0, y: 0, w: 1, h: 1 }, 0.9);
  fillRect(hairMask.frame.mask, { x: 1, y: 1, w: 1, h: 1 }, 0.3);

  const { coverage, contributingRegions } = combineSemanticScene(
    { forearm_hand: armMask, hair: hairMask },
    2,
    2,
  );
  assert.equal(coverage[0], 0.9); // max(0.4, 0.9)
  assert.equal(coverage[3], 0.3); // only hair touched this texel
  assert.deepEqual(contributingRegions.sort(), ['forearm_hand', 'hair']);
});

test('combineSemanticScene throws on a region mask whose dimensions disagree with the requested output size', () => {
  const armMask = labeledFrame('forearm_hand');
  assert.throws(() => combineSemanticScene({ forearm_hand: armMask }, 5, 5), RangeError);
});
