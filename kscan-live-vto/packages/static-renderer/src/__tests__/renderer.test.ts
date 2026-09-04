import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng } from '../png';
import { createImage, getPixel, rgba } from '../raster';
import {
  GARMENT_LENGTH_RATIO,
  LOGO_TEE,
  PLAIN_TEE,
  garmentProportionRatio,
  generateSyntheticGarment,
} from '../fixtures/garment';
import { NEUTRAL_PERSON, generateSyntheticPerson } from '../fixtures/person';
import {
  applySimilarity,
  computeControlPointTargets,
  evaluateRigidGate,
  extractBodyAnchors,
  fitRigidPlacement,
} from '../attachment';
import { computeLightingAdjustment, LIGHTING_GUARDRAILS } from '../lighting';
import { logoDistortion } from '../metrics';
import { renderDeformedStage, renderRigidStage, type RenderInput } from '../renderPreview';

function buildInput(overrides: Partial<RenderInput> = {}): RenderInput {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(LOGO_TEE);
  return {
    fixtureId: person.spec.fixtureId,
    caseId: 'unit-test',
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

// ─── PNG codec ────────────────────────────────────────────────────────────────

test('PNG encode/decode round-trips pixels exactly', () => {
  const source = createImage(7, 5, rgba(0, 0, 0, 0));
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 7; x++) {
      const i = (y * 7 + x) * 4;
      source.data[i] = x * 30;
      source.data[i + 1] = y * 50;
      source.data[i + 2] = (x + y) * 20;
      source.data[i + 3] = 255 - x * 10;
    }
  }
  const decoded = decodePng(encodePng(source));
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  for (let i = 0; i < source.data.length; i++) {
    assert.equal(decoded.data[i], source.data[i], `byte ${i} differs`);
  }
});

test('PNG decode rejects a non-PNG buffer', () => {
  assert.throws(() => decodePng(Buffer.from('definitely not a png')));
});

// ─── The mirroring convention ────────────────────────────────────────────────

test("person fixture puts the wearer's left shoulder at lower u (selfie orientation)", () => {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const left = person.bodyFrame.leftShoulder;
  const right = person.bodyFrame.rightShoulder;
  assert.ok(left.present && right.present);
  assert.ok(left.point.u < right.point.u, 'leftShoulder must sit at lower u than rightShoulder');
});

test('garment control points follow the same wearer-anatomical convention', () => {
  const garment = generateSyntheticGarment(PLAIN_TEE);
  const left = garment.manifest.controlPoints.find((cp) => cp.id === 'leftShoulder')!;
  const right = garment.manifest.controlPoints.find((cp) => cp.id === 'rightShoulder')!;
  assert.ok(left.u < right.u, 'garment leftShoulder must sit at lower u than rightShoulder');
});

// ─── Fixture proportion ──────────────────────────────────────────────────────

test('garment fixture proportion matches GARMENT_LENGTH_RATIO', () => {
  // Guards the defect the rigid gate caught on this pass's first run: a
  // silhouette 2.6 seam-spans long that no torso could wear.
  const ratio = garmentProportionRatio(PLAIN_TEE.width, PLAIN_TEE.height);
  assert.ok(Math.abs(ratio - GARMENT_LENGTH_RATIO) < 0.02, `ratio ${ratio} drifted from ${GARMENT_LENGTH_RATIO}`);
});

// ─── Rigid attachment + stop gate ────────────────────────────────────────────

test('rigid attachment passes the stop gate on the neutral fixture', () => {
  const rigid = renderRigidStage(buildInput());
  assert.ok(rigid.ok);
  assert.deepEqual(rigid.result.gate.findings, []);
  assert.equal(rigid.result.gate.passed, true);
});

test('stop gate catches a swapped left/right TARGET assignment (the real inversion bug)', () => {
  // Note on what this does and does not test. fitRigidPlacement builds a
  // similarity FROM the two shoulder correspondences, and a similarity cannot
  // reflect — so mislabeling the garment's own control points yields a 180°
  // rotation (caught as `upside_down`), never a mirror. The inversion that
  // can actually happen is upstream: attachment mapping the garment's left
  // shoulder onto the BODY's right shoulder. That is what this exercises.
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(PLAIN_TEE);
  const anchors = extractBodyAnchors(person.bodyFrame, person.image.width, person.image.height);
  assert.ok(anchors.ok);
  const targets = computeControlPointTargets(garment.manifest, anchors.anchors);

  const swapped = { ...targets, leftShoulder: targets.rightShoulder, rightShoulder: targets.leftShoulder };
  const placement = fitRigidPlacement(garment.manifest, garment.texture.width, garment.texture.height, swapped);
  assert.ok(placement.ok);
  const gate = evaluateRigidGate(
    garment.manifest,
    placement.transform,
    garment.texture.width,
    garment.texture.height,
    anchors.anchors,
  );
  assert.ok(gate.findings.includes('left_right_inversion'), `expected inversion, got ${gate.findings.join(',')}`);
  assert.equal(gate.passed, false);
});

test('stop gate catches an upside-down garment', () => {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(PLAIN_TEE);
  const anchors = extractBodyAnchors(person.bodyFrame, person.image.width, person.image.height);
  assert.ok(anchors.ok);
  const targets = computeControlPointTargets(garment.manifest, anchors.anchors);
  const placement = fitRigidPlacement(garment.manifest, garment.texture.width, garment.texture.height, targets);
  assert.ok(placement.ok);

  // Rotate the placement by 180 degrees about the shoulder midpoint.
  const flipped = { ...placement.transform, rotationRadians: placement.transform.rotationRadians + Math.PI };
  const shoulderMid = {
    x: (anchors.anchors.leftShoulder.x + anchors.anchors.rightShoulder.x) / 2,
    y: (anchors.anchors.leftShoulder.y + anchors.anchors.rightShoulder.y) / 2,
  };
  const movedMid = applySimilarity(flipped, {
    x: 0.5 * garment.texture.width,
    y: 0.118 * garment.texture.height,
  });
  flipped.translateX += shoulderMid.x - movedMid.x;
  flipped.translateY += shoulderMid.y - movedMid.y;

  const gate = evaluateRigidGate(garment.manifest, flipped, garment.texture.width, garment.texture.height, anchors.anchors);
  assert.ok(gate.findings.includes('upside_down'), `expected upside_down, got ${gate.findings.join(',')}`);
});

test('stop gate catches a grossly mis-scaled garment', () => {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(PLAIN_TEE);
  const anchors = extractBodyAnchors(person.bodyFrame, person.image.width, person.image.height);
  assert.ok(anchors.ok);
  const targets = computeControlPointTargets(garment.manifest, anchors.anchors);
  const placement = fitRigidPlacement(garment.manifest, garment.texture.width, garment.texture.height, targets);
  assert.ok(placement.ok);

  const tripled = { ...placement.transform, scale: placement.transform.scale * 3 };
  const gate = evaluateRigidGate(garment.manifest, tripled, garment.texture.width, garment.texture.height, anchors.anchors);
  assert.ok(gate.findings.includes('gross_scale_error'), `expected gross_scale_error, got ${gate.findings.join(',')}`);
});

test('deformation refuses to run when the rigid gate failed', () => {
  const input = buildInput();
  const rigid = renderRigidStage(input);
  assert.ok(rigid.ok);
  const sabotaged = {
    ...rigid.result,
    gate: { ...rigid.result.gate, passed: false, findings: ['left_right_inversion' as const] },
  };
  const deformed = renderDeformedStage(input, sabotaged);
  assert.equal(deformed.ok, false);
  if (!deformed.ok) assert.equal(deformed.reason, 'rigid_gate_failed');
});

// ─── Deformation metrics ─────────────────────────────────────────────────────

test('affine MLS interpolates its control points, so residuals are ~0', () => {
  const input = buildInput();
  const rigid = renderRigidStage(input);
  assert.ok(rigid.ok);
  const deformed = renderDeformedStage(input, rigid.result);
  assert.ok(deformed.ok);
  // A non-zero residual here means the warp is not honoring its anchors.
  assert.ok(
    deformed.result.metrics.controlPoint.maxPixels < 0.5,
    `max residual ${deformed.result.metrics.controlPoint.maxPixels}px`,
  );
});

test('deformation covers the torso and produces no foldover on the neutral fixture', () => {
  const input = buildInput();
  const rigid = renderRigidStage(input);
  assert.ok(rigid.ok);
  const deformed = renderDeformedStage(input, rigid.result);
  assert.ok(deformed.ok);
  assert.ok(deformed.result.metrics.coverage.torsoCoverage > 0.9);
  assert.equal(deformed.result.metrics.jacobian.foldoverCells, 0);
  assert.ok(deformed.result.metrics.jacobian.minDeterminant > 0);
});

test('logo distortion reports mirroring when the correspondence is flipped', () => {
  const pairs = [
    { source: { x: 0, y: 0 }, target: { x: 100, y: 0 } },
    { source: { x: 100, y: 0 }, target: { x: 0, y: 0 } },
    { source: { x: 100, y: 100 }, target: { x: 0, y: 100 } },
    { source: { x: 0, y: 100 }, target: { x: 100, y: 100 } },
  ];
  const result = logoDistortion({ x: 20, y: 20 }, { x: 80, y: 60 }, pairs);
  assert.equal(result.mirrored, true);
});

test('logo distortion reports no mirroring for the real neutral render', () => {
  const input = buildInput();
  const rigid = renderRigidStage(input);
  assert.ok(rigid.ok);
  const deformed = renderDeformedStage(input, rigid.result);
  assert.ok(deformed.ok);
  assert.ok(deformed.result.metrics.logo);
  assert.equal(deformed.result.metrics.logo!.mirrored, false);
});

// ─── Compositing / occlusion ─────────────────────────────────────────────────

test('foreground restoration puts person pixels back over the garment', () => {
  const input = buildInput({ caseId: 'occlusion' });
  const crossed = generateSyntheticPerson({ ...NEUTRAL_PERSON, armPose: 'crossed', seed: 73 });
  const occlusionInput: RenderInput = {
    ...input,
    personImage: crossed.image,
    bodyFrame: crossed.bodyFrame,
    foregroundMask: crossed.foregroundMask,
  };
  const rigid = renderRigidStage(occlusionInput);
  assert.ok(rigid.ok);
  const deformed = renderDeformedStage(occlusionInput, rigid.result);
  assert.ok(deformed.ok);
  // The crossed forearms must actually override garment pixels...
  assert.ok(
    deformed.result.metrics.foregroundOverGarmentPixels > 500,
    `only ${deformed.result.metrics.foregroundOverGarmentPixels} foreground-over-garment pixels`,
  );
  // ...and the control image (wrong layer order) must differ from the intended one.
  assert.ok(deformed.result.occlusionControlImage);
  let differing = 0;
  const a = deformed.result.image.data;
  const b = deformed.result.occlusionControlImage!.data;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i]) differing += 1;
  assert.ok(differing > 500, 'control and intended occlusion images should differ substantially');
});

// ─── Lighting ────────────────────────────────────────────────────────────────

test('lighting adjustment stays inside the experimental guardrails', () => {
  // An extreme scene estimate must still clamp to the documented bounds.
  const adjustment = computeLightingAdjustment({
    meanLuminance: 1,
    contrast: 1,
    colorCast: { r: 2.2, g: 0.4, b: 0.4 },
    sampledPixels: 1000,
  });
  assert.ok(Math.abs(adjustment.hueShiftDegrees) <= LIGHTING_GUARDRAILS.maxHueShiftDegrees);
  assert.ok(Math.abs(1 - adjustment.saturationScale) <= LIGHTING_GUARDRAILS.maxSaturationDelta + 1e-9);
  assert.ok(adjustment.luminanceGain <= LIGHTING_GUARDRAILS.maxLuminanceGain);
  assert.ok(adjustment.luminanceGain >= LIGHTING_GUARDRAILS.minLuminanceGain);
  assert.ok(adjustment.clampedFields.length > 0, 'an extreme scene should record which fields clamped');
});

test('render emits both a lighting-adjusted and an unadjusted preview, and they differ', () => {
  const input = buildInput();
  const rigid = renderRigidStage(input);
  assert.ok(rigid.ok);
  const deformed = renderDeformedStage(input, rigid.result);
  assert.ok(deformed.ok);
  assert.equal(deformed.result.manifest.lightingParameters.applied, true);
  let differing = 0;
  const a = deformed.result.image.data;
  const b = deformed.result.unadjustedImage.data;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i]) differing += 1;
  assert.ok(differing > 0, 'adjusted and unadjusted previews should not be identical');
});

// ─── Manifest honesty ────────────────────────────────────────────────────────

test('manifest reports precomputed mask provenance and the synthetic-fixture caveat', () => {
  const input = buildInput();
  const rigid = renderRigidStage(input);
  assert.ok(rigid.ok);
  const deformed = renderDeformedStage(input, rigid.result);
  assert.ok(deformed.ok);
  const manifest = deformed.result.manifest;
  assert.equal(manifest.maskProvenance, 'precomputed');
  assert.equal(manifest.colorSpace, 'sRGB');
  assert.ok(manifest.knownLimitations.some((l) => l.includes('SYNTHETIC')));
  assert.ok(manifest.knownLimitations.some((l) => l.includes('PRECOMPUTED TEST MASK')));
  assert.ok(manifest.knownLimitations.some((l) => l.includes('NOT a native rasterization baseline')));
});

test('rendering is deterministic for the same inputs', () => {
  const first = (() => {
    const input = buildInput();
    const rigid = renderRigidStage(input);
    assert.ok(rigid.ok);
    const deformed = renderDeformedStage(input, rigid.result);
    assert.ok(deformed.ok);
    return encodePng(deformed.result.image);
  })();
  const second = (() => {
    const input = buildInput();
    const rigid = renderRigidStage(input);
    assert.ok(rigid.ok);
    const deformed = renderDeformedStage(input, rigid.result);
    assert.ok(deformed.ok);
    return encodePng(deformed.result.image);
  })();
  assert.ok(first.equals(second), 'two renders of the same input must be byte-identical');
});

test('a rendered preview is not simply the untouched person image', () => {
  const input = buildInput();
  const rigid = renderRigidStage(input);
  assert.ok(rigid.ok);
  const deformed = renderDeformedStage(input, rigid.result);
  assert.ok(deformed.ok);
  let changed = 0;
  for (let y = 0; y < input.personImage.height; y += 4) {
    for (let x = 0; x < input.personImage.width; x += 4) {
      const before = getPixel(input.personImage, x, y);
      const after = getPixel(deformed.result.image, x, y);
      if (before.r !== after.r || before.g !== after.g || before.b !== after.b) changed += 1;
    }
  }
  assert.ok(changed > 200, `only ${changed} sampled pixels changed — the garment may not be rendering`);
});
