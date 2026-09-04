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
  const targets = computeControlPointTargets(garment.manifest, anchors.anchors, garment.texture.width, garment.texture.height);

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
  const targets = computeControlPointTargets(garment.manifest, anchors.anchors, garment.texture.width, garment.texture.height);
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
  const targets = computeControlPointTargets(garment.manifest, anchors.anchors, garment.texture.width, garment.texture.height);
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

// ─── Review package #2: regressions for the four FAIL — DEFORMATION defects ──
//
// Each test below fails if one of the defects the human reviewer named at
// ee298587 comes back.

import {
  MAX_LONGITUDINAL_ASPECT_DEVIATION,
  SHOULDER_SEAM_RISE,
  TORSO_WIDTH_HOLD_T,
} from '../attachment';
import { GARMENT_SUPERSAMPLE } from '../renderPreview';

function renderNeutral(personOverrides: Record<string, unknown> = {}) {
  const person = generateSyntheticPerson({ ...NEUTRAL_PERSON, ...personOverrides } as typeof NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(LOGO_TEE);
  const input: RenderInput = {
    fixtureId: person.spec.fixtureId,
    caseId: 'regression',
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
  };
  const rigid = renderRigidStage(input);
  assert.ok(rigid.ok);
  const deformed = renderDeformedStage(input, rigid.result);
  assert.ok(deformed.ok);
  return { person, garment, rigid: rigid.result, deformed: deformed.result };
}

test('DEFECT 1 — no control point is pinned to a same-named body landmark', () => {
  // The package-#1 root cause: `waist` targeted the anatomical waistCenter,
  // which sits well above the hem and dragged the garment's middle up. The
  // waist target must now lie on the shoulder→hem axis at the garment's own
  // longitudinal fraction, i.e. clearly BELOW the anatomical waist landmark.
  const { rigid } = renderNeutral();
  const waistTarget = rigid.targets.waist!;
  const anatomicalWaist = rigid.anchors.waist;
  assert.ok(waistTarget, 'waist target must exist');
  assert.ok(
    waistTarget.y > anatomicalWaist.y + 5,
    `waist target y=${waistTarget.y.toFixed(1)} should sit below the anatomical waist landmark y=${anatomicalWaist.y.toFixed(1)}`,
  );
});

test('DEFECT 1 — chest content keeps its aspect ratio on the neutral fixture', () => {
  const { deformed } = renderNeutral();
  const aspect = deformed.metrics.logo!.aspectRatioChange;
  assert.ok(Math.abs(aspect - 1) < 0.06, `logo aspect ${aspect.toFixed(3)} should be ~1.0 on the neutral fixture`);
});

test('DEFECT 1 — longitudinal distortion stays inside the documented bound on extreme bodies', () => {
  // Narrow (long torso) and broad (short torso) are the stress cases. The
  // bound is on the attachment frame; the rendered logo picks up a little
  // extra from local MLS blending near the sleeve, so allow a small margin
  // over the raw constant rather than pretending the bound is exact.
  const tolerance = MAX_LONGITUDINAL_ASPECT_DEVIATION + 0.06;
  for (const [label, overrides] of [
    ['narrow', { shoulderWidthNorm: 0.26, torsoHeightNorm: 0.33, seed: 23 }],
    ['broad', { shoulderWidthNorm: 0.43, torsoHeightNorm: 0.27, seed: 41 }],
  ] as const) {
    const { deformed } = renderNeutral(overrides);
    const aspect = deformed.metrics.logo!.aspectRatioChange;
    assert.ok(
      Math.abs(aspect - 1) <= tolerance,
      `${label}: logo aspect ${aspect.toFixed(3)} exceeds the bound (1 +/- ${tolerance.toFixed(2)})`,
    );
  }
});

test('DEFECT 2 — the hem is level, with no centre notch', () => {
  // Measures the rendered silhouette directly: the lowest garment pixel at the
  // horizontal centre must not sit meaningfully higher than at the quarter
  // points. The package-#1 notch was ~40px on this fixture.
  const { deformed, rigid } = renderNeutral();
  const layer = deformed.garmentLayer;
  const lowestAt = (x: number): number => {
    for (let y = layer.height - 1; y >= 0; y--) {
      if (getPixel(layer, x, y).a > 128) return y;
    }
    return -1;
  };
  const centreX = Math.round((rigid.anchors.leftShoulder.x + rigid.anchors.rightShoulder.x) / 2);
  const span = rigid.anchors.shoulderSpanPx;
  const centre = lowestAt(centreX);
  const left = lowestAt(Math.round(centreX - span * 0.25));
  const right = lowestAt(Math.round(centreX + span * 0.25));
  assert.ok(centre > 0 && left > 0 && right > 0, 'expected garment pixels at all three sample columns');
  const notch = Math.max(left, right) - centre;
  assert.ok(notch < span * 0.06, `hem notch of ${notch}px at the centre (shoulder span ${span.toFixed(0)}px)`);
});

test('DEFECT 3 — the garment covers the shoulder cap above the joint landmark', () => {
  const { deformed, rigid } = renderNeutral();
  const layer = deformed.garmentLayer;
  const span = rigid.anchors.shoulderSpanPx;
  // A point just above each shoulder joint, inside the cap the seam rise is
  // meant to cover.
  for (const [label, joint] of [
    ['left', rigid.anchors.leftShoulder],
    ['right', rigid.anchors.rightShoulder],
  ] as const) {
    const probeY = Math.round(joint.y - span * SHOULDER_SEAM_RISE * 0.5);
    const probeX = Math.round(joint.x);
    assert.ok(
      getPixel(layer, probeX, probeY).a > 128,
      `${label} shoulder cap is uncovered at (${probeX}, ${probeY})`,
    );
  }
});

test('DEFECT 4 — garment edges are anti-aliased, not binary', () => {
  const { deformed } = renderNeutral();
  const layer = deformed.garmentLayer;
  let partial = 0;
  for (let i = 0; i < layer.width * layer.height; i++) {
    const a = layer.data[i * 4 + 3]!;
    if (a > 8 && a < 247) partial += 1;
  }
  assert.ok(partial > 500, `only ${partial} partially-covered edge pixels — supersampling may not be applied`);
  assert.ok(GARMENT_SUPERSAMPLE >= 2);
  assert.equal(deformed.manifest.supersample, GARMENT_SUPERSAMPLE);
});

test('no fixture variant produces mesh foldover', () => {
  // Adding the armpit control point briefly reintroduced foldover because the
  // articulated sleeve landed inboard of it. This pins that closed across
  // every body/pose the review package renders.
  for (const overrides of [
    {},
    { shoulderWidthNorm: 0.26, torsoHeightNorm: 0.33, seed: 23 },
    { shoulderWidthNorm: 0.43, torsoHeightNorm: 0.27, seed: 41 },
    { armPose: 'away' as const, seed: 57 },
    { armPose: 'crossed' as const, seed: 73 },
  ]) {
    const { deformed } = renderNeutral(overrides);
    assert.equal(
      deformed.metrics.jacobian.foldoverCells,
      0,
      `foldover with overrides ${JSON.stringify(overrides)}`,
    );
    assert.ok(deformed.metrics.jacobian.minDeterminant > 0);
  }
});

test('the armpit control point anchors the torso side of the sleeve junction', () => {
  const { garment, rigid } = renderNeutral();
  const armpit = garment.manifest.controlPoints.find((c) => c.id === 'leftArmpit');
  assert.ok(armpit, 'fixture should declare a leftArmpit control point');
  assert.ok(rigid.targets.leftArmpit, 'leftArmpit should receive a target');
  // It is placed by the torso frame, so it must sit inboard of the sleeve.
  assert.ok(
    rigid.targets.leftArmpit!.x > rigid.targets.leftSleeve!.x,
    'armpit must sit inboard of the sleeve target, or the mesh ordering inverts',
  );
});

test('the garment frame preserves lateral ordering across the chest band', () => {
  assert.ok(TORSO_WIDTH_HOLD_T > 0.4 && TORSO_WIDTH_HOLD_T < 0.8);
  const { garment, rigid } = renderNeutral();
  // Both points sit above TORSO_WIDTH_HOLD_T, so the frame maps them with the
  // same width and must preserve whichever is further outboard in the texture.
  // (On this fixture the shirt body is very slightly wider than the shoulder
  // seam, so the armpit is the outboard one — the invariant is the ordering,
  // not which one wins.)
  const cpOf = (id: string) => garment.manifest.controlPoints.find((c) => c.id === id)!;
  const textureOrder = Math.sign(cpOf('leftArmpit').u - cpOf('leftShoulder').u);
  const bodyOrder = Math.sign(rigid.targets.leftArmpit!.x - rigid.targets.leftShoulder!.x);
  assert.equal(bodyOrder, textureOrder, 'lateral ordering inverted between texture and body');
});
