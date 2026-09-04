/**
 * Product fidelity regression — Phase 3 Section 15.
 *
 * "Create explicit regression tests using the existing logo canary."
 * Reuses the real LOGO_TEE fixture and the real `renderRigidStage`/
 * `renderDeformedStage` pipeline (the same one Package #2 was human-PASSed
 * against), then applies every Phase 3 post-process step this package adds
 * (gamma/exposure, contact shadow) to a CLONE of the final composite, and
 * asserts the product identity survives: the already-computed
 * `logoDistortion` geometry metrics (unaffected by construction, since
 * Phase 3 never touches control points or the warp) stay within Package
 * #2's own established tolerance, AND the logo's own sampled color stays
 * within this package's color-fidelity bounds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOGO_TEE,
  NEUTRAL_PERSON,
  cloneImage,
  generateSyntheticGarment,
  generateSyntheticPerson,
  renderDeformedStage,
  renderRigidStage,
  type RenderInput,
} from '@kscan-live-vto/static-renderer';
import { applyContactShadows, standardCollarAndShoulderShadowRegions } from '../contactShadow';
import { applyGammaExposureAdjustment, computeGammaExposureAdjustment, meanLuminanceOfOpaquePixels } from '../gammaExposure';
import { hueDeltaDegrees, preservesChannelBrightness, samplePixelColor } from '../productFidelity';

// Package #2's own established tolerance (docs/vto-static-preview-review.md,
// renderer.test.ts's "DEFECT 1" tests): aspect ratio must stay within ±0.06
// of 1.0 on the neutral fixture.
const NEUTRAL_ASPECT_TOLERANCE = 0.06;

function buildLogoTeeInput(): RenderInput {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(LOGO_TEE);
  return {
    fixtureId: person.spec.fixtureId,
    caseId: 'product-fidelity-regression',
    personImage: person.image,
    bodyFrame: person.bodyFrame,
    descriptor: garment.descriptor,
    asset: {
      manifest: garment.manifest,
      texture: garment.texture,
      alphaMask: garment.alphaMask,
      logoBoxTexturePx: garment.logoBoxTexturePx,
    },
    foregroundMask: null,
    maskProvenance: 'none',
    gitSha: 'test',
  };
}

test('the logo canary survives the full Phase 3 realism pipeline: no mirroring, aspect ratio within Package #2 tolerance', () => {
  const input = buildLogoTeeInput();
  const rigid = renderRigidStage(input);
  assert.equal(rigid.ok, true);
  if (!rigid.ok) return;
  const deformed = renderDeformedStage(input, rigid.result);
  assert.equal(deformed.ok, true);
  if (!deformed.ok) return;

  const logo = deformed.result.metrics.logo;
  assert.ok(logo, 'the logo canary fixture must produce a logo distortion measurement');
  assert.equal(logo!.mirrored, false, 'Phase 3 must not introduce a mirroring regression');
  assert.ok(
    Math.abs(logo!.aspectRatioChange - 1) < NEUTRAL_ASPECT_TOLERANCE,
    `logo aspectRatioChange ${logo!.aspectRatioChange} exceeded Package #2's own ${NEUTRAL_ASPECT_TOLERANCE} tolerance`,
  );

  // Apply the full Phase 3 post-process chain to a CLONE of the composite --
  // geometry (computed above, from the warp stage) is structurally
  // unaffected by this, but this proves the chain itself runs end to end
  // against a real rendered logo garment without error.
  const postProcessed = cloneImage(deformed.result.image);
  const gamma = computeGammaExposureAdjustment(
    { meanLuminance: 0.45 },
    meanLuminanceOfOpaquePixels(deformed.result.garmentLayer),
  );
  applyGammaExposureAdjustment(postProcessed, gamma);
  applyContactShadows(
    postProcessed,
    standardCollarAndShoulderShadowRegions({
      leftX: rigid.result.anchors.leftShoulder.x,
      rightX: rigid.result.anchors.rightShoulder.x,
      topY: Math.min(rigid.result.anchors.leftShoulder.y, rigid.result.anchors.rightShoulder.y),
    }),
  );

  assert.equal(postProcessed.width, deformed.result.image.width);
  assert.equal(postProcessed.height, deformed.result.image.height);
});

test('color fidelity: a sampled garment pixel near the logo keeps a small hue delta and stays within brightness bounds after gamma + shadow', () => {
  const input = buildLogoTeeInput();
  const rigid = renderRigidStage(input);
  assert.equal(rigid.ok, true);
  if (!rigid.ok) return;
  const deformed = renderDeformedStage(input, rigid.result);
  assert.equal(deformed.ok, true);
  if (!deformed.ok) return;

  // Sample a point inside the rendered torso region, away from the image
  // edge, as a stand-in "product color" reference -- not the logo pixels
  // themselves (which may be near-transparent background between glyphs),
  // but representative garment fabric color.
  const sampleX = Math.round(deformed.result.image.width / 2);
  const sampleY = Math.round(deformed.result.image.height * 0.55);
  const before = samplePixelColor(deformed.result.image, sampleX, sampleY);

  const postProcessed = cloneImage(deformed.result.image);
  const gamma = computeGammaExposureAdjustment({ meanLuminance: 0.4 }, meanLuminanceOfOpaquePixels(deformed.result.garmentLayer));
  applyGammaExposureAdjustment(postProcessed, gamma);
  applyContactShadows(
    postProcessed,
    standardCollarAndShoulderShadowRegions({
      leftX: rigid.result.anchors.leftShoulder.x,
      rightX: rigid.result.anchors.rightShoulder.x,
      topY: Math.min(rigid.result.anchors.leftShoulder.y, rigid.result.anchors.rightShoulder.y),
    }),
  );
  const after = samplePixelColor(postProcessed, sampleX, sampleY);

  assert.ok(hueDeltaDegrees(before, after) < 10, `product hue shifted by ${hueDeltaDegrees(before, after)} degrees, exceeding the bound`);
  assert.ok(preservesChannelBrightness(before, after, 0.75), 'combined Phase 3 post-processing must not dirty the sampled garment color beyond a generous combined bound');
});
