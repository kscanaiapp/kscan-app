import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compositeStaticPreview, createImage, getPixel, rgba, type FeatherSpec } from '@kscan-live-vto/static-renderer';
import { LOGO_TEE, NEUTRAL_PERSON, generateSyntheticGarment, generateSyntheticPerson } from '@kscan-live-vto/static-renderer';
import { renderDeformedStage, renderRigidStage, type RenderInput } from '@kscan-live-vto/static-renderer';
import {
  createMask,
  fillRect,
  type SemanticScene,
} from '@kscan-live-vto/realism';
import { PRECOMPUTED_SEMANTIC_MASK_LABEL } from '@kscan-live-vto/realism';
import { semanticSceneToForegroundImage } from '../semanticForeground';

const NO_FEATHER: FeatherSpec = { radiusShoulderSpanFraction: 0, resolvedRadiusPx: 0 };

function sceneWithForearmRect(width: number, height: number, rect: { x: number; y: number; w: number; h: number }): SemanticScene {
  const mask = createMask(width, height, 0);
  fillRect(mask, rect, 1);
  return {
    forearm_hand: {
      region: 'forearm_hand',
      frame: { timestamp: 0, mask, confidence: 0.9, provenance: 'PRECOMPUTED' },
      label: PRECOMPUTED_SEMANTIC_MASK_LABEL,
    },
  };
}

test('semanticSceneToForegroundImage paints real person pixel color at covered texels, with alpha from coverage', () => {
  const person = createImage(10, 10, rgba(10, 20, 30, 255));
  const scene = sceneWithForearmRect(10, 10, { x: 2, y: 2, w: 3, h: 3 });
  const { image, contributingRegions } = semanticSceneToForegroundImage(scene, person);
  assert.deepEqual(contributingRegions, ['forearm_hand']);
  const inside = getPixel(image, 3, 3);
  assert.deepEqual(inside, { r: 10, g: 20, b: 30, a: 255 });
  const outside = getPixel(image, 0, 0);
  assert.equal(outside.a, 0, 'texels outside every region must stay fully transparent');
});

test('an empty scene produces a fully transparent foreground image', () => {
  const person = createImage(4, 4, rgba(255, 255, 255, 255));
  const { image, contributingRegions } = semanticSceneToForegroundImage({}, person);
  assert.deepEqual(contributingRegions, []);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) assert.equal(getPixel(image, x, y).a, 0);
  }
});

test('feeding the combined semantic foreground through compositeStaticPreview occludes the garment exactly where coverage is present', () => {
  const person = createImage(20, 20, rgba(200, 150, 100, 255)); // skin-tone stand-in
  const garmentLayer = createImage(20, 20, rgba(20, 60, 200, 255)); // a solid "garment" fill covering the whole frame
  const scene = sceneWithForearmRect(20, 20, { x: 5, y: 5, w: 6, h: 6 });
  const { image: foreground } = semanticSceneToForegroundImage(scene, person);

  const result = compositeStaticPreview(person, garmentLayer, foreground, {
    restoreForeground: true,
    feather: NO_FEATHER,
  });

  const occludedTexel = getPixel(result.image, 7, 7); // inside the forearm rect
  assert.deepEqual(occludedTexel, { r: 200, g: 150, b: 100, a: 255 }, 'a covered texel must show the person, not the garment');

  const garmentTexel = getPixel(result.image, 1, 1); // outside the forearm rect
  assert.deepEqual(garmentTexel, { r: 20, g: 60, b: 200, a: 255 }, 'an uncovered texel must still show the garment');
});

function buildRenderInput(overrides: Partial<RenderInput> = {}): RenderInput {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(LOGO_TEE);
  return {
    fixtureId: person.spec.fixtureId,
    caseId: 'realism-preview-unit-test',
    personImage: person.image,
    bodyFrame: person.bodyFrame,
    descriptor: garment.descriptor,
    asset: {
      manifest: garment.manifest,
      texture: garment.texture,
      alphaMask: garment.alphaMask,
      logoBoxTexturePx: garment.logoBoxTexturePx,
    },
    foregroundMask: person.foregroundMask,
    maskProvenance: 'precomputed',
    gitSha: 'test',
    ...overrides,
  };
}

test('a semantic-derived foreground image runs end to end through the real renderRigidStage/renderDeformedStage pipeline', () => {
  const baseInput = buildRenderInput();
  const scene = sceneWithForearmRect(baseInput.personImage.width, baseInput.personImage.height, {
    x: baseInput.personImage.width * 0.3,
    y: baseInput.personImage.height * 0.45,
    w: baseInput.personImage.width * 0.4,
    h: baseInput.personImage.height * 0.08,
  });
  const { image: semanticForeground } = semanticSceneToForegroundImage(scene, baseInput.personImage);
  const input: RenderInput = { ...baseInput, foregroundMask: semanticForeground, maskProvenance: 'precomputed' };

  const rigid = renderRigidStage(input);
  assert.equal(rigid.ok, true);
  if (!rigid.ok) return;
  assert.equal(rigid.result.gate.passed, true, 'the rigid gate must still pass -- Phase 3 foreground substitution must not affect placement');

  const deformed = renderDeformedStage(input, rigid.result);
  assert.equal(deformed.ok, true);
  if (!deformed.ok) return;
  assert.ok(deformed.result.manifest.imageDimensions.width > 0);
  assert.equal(typeof deformed.result.metrics.foregroundOverGarmentPixels, 'number');
});
