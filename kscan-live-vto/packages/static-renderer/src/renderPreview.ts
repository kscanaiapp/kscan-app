/**
 * Headless static preview renderer (Sections 6-7).
 *
 * Consumes PersonImage + BodyFrame + GarmentDescriptor + KsGarmentAsset +
 * optional ForegroundMask, and emits PreviewImage + PreviewManifest +
 * PreviewMetrics.
 *
 * THIS IS AN ENGINEERING / EVALUATION RENDERER. It establishes semantic
 * golden behavior — control-point mapping, garment geometry, deformation,
 * layering, mirroring, asset interpretation. It is NOT expected to be
 * pixel-identical to the eventual Metal/Android native renderer, and its
 * pixel output must NOT be used as the native rasterization regression
 * baseline. Native goldens get established on physical devices, later.
 *
 * Order of operations follows the critical path exactly: anchors → rigid
 * placement → rigid stop gate → (only if the gate passes) deformation →
 * compositing → lighting.
 */

import type { BodyFrame } from '@kscan-live-vto/contract';
import type { ControlPointPair } from '@kscan-live-vto/asset-pipeline';
import type { GarmentDescriptor, KsgarmentManifest } from '@kscan-live-vto/garment-contract';
import {
  applySimilarity,
  computeControlPointTargets,
  evaluateRigidGate,
  extractBodyAnchors,
  fitRigidPlacement,
  type BodyAnchors,
  type ControlPointTargets,
  type RigidGateResult,
  type SimilarityTransform,
} from './attachment';
import { compositeStaticPreview, resolveFeather, type FeatherSpec, type MaskProvenance } from './composite';
import {
  applyLightingAdjustment,
  computeLightingAdjustment,
  estimateLighting,
  type LightingAdjustment,
  type LightingState,
} from './lighting';
import {
  controlPointResiduals,
  garmentCoverage,
  logoDistortion,
  type ControlPointResidualSummary,
  type CoverageResult,
  type LogoDistortion,
} from './metrics';
import {
  cloneImage,
  createImage,
  drawLine,
  drawMarker,
  drawText,
  fillDisc,
  rgba,
  type Point,
  type RgbaImage,
} from './raster';
import { buildGridMesh, deformMesh, meshJacobianStats, rasterizeMesh, type GridMesh, type JacobianStats } from './warp';

export const RENDERER_VERSION = '0.1.0';
export const DEFORMATION_ALGORITHM = 'affine-mls@asset-pipeline-0.1.0';

export interface KsGarmentAsset {
  manifest: KsgarmentManifest;
  texture: RgbaImage;
  alphaMask: RgbaImage;
  /** Bounding box of directional content in TEXTURE PIXEL space, for the logo canary metric. */
  logoBoxTexturePx?: { topLeft: Point; bottomRight: Point } | null;
}

export interface RenderInput {
  fixtureId: string;
  caseId: string;
  personImage: RgbaImage;
  bodyFrame: BodyFrame;
  descriptor: GarmentDescriptor;
  asset: KsGarmentAsset;
  foregroundMask: RgbaImage | null;
  maskProvenance: MaskProvenance;
  gitSha: string;
  /** Extra honest caveats to carry into the manifest for this specific case. */
  knownLimitations?: string[];
}

export type RenderFailureStage = 'anchors' | 'rigid_placement';

export interface RigidStageResult {
  anchors: BodyAnchors;
  targets: ControlPointTargets;
  transform: SimilarityTransform;
  gate: RigidGateResult;
  /** Garment placed rigidly over the person — no deformation, no lighting, no occlusion. */
  image: RgbaImage;
  /** The same, with body anchors and garment control points annotated. */
  overlay: RgbaImage;
  torsoRegion: Point[];
}

export function torsoRegionOf(anchors: BodyAnchors): Point[] {
  return [anchors.leftShoulder, anchors.rightShoulder, anchors.rightHip, anchors.leftHip];
}

/** Stage 1-3: anchors, rigid placement, and the stop gate. */
export function renderRigidStage(
  input: RenderInput,
): { ok: true; result: RigidStageResult } | { ok: false; stage: RenderFailureStage; reason: string } {
  const { personImage, asset } = input;
  const anchorsOutcome = extractBodyAnchors(input.bodyFrame, personImage.width, personImage.height);
  if (!anchorsOutcome.ok) return { ok: false, stage: 'anchors', reason: anchorsOutcome.reason };
  const anchors = anchorsOutcome.anchors;

  const targets = computeControlPointTargets(asset.manifest, anchors);
  const placement = fitRigidPlacement(asset.manifest, asset.texture.width, asset.texture.height, targets);
  if (!placement.ok) return { ok: false, stage: 'rigid_placement', reason: placement.reason };

  const gate = evaluateRigidGate(asset.manifest, placement.transform, asset.texture.width, asset.texture.height, anchors);

  // Rigid render: the same rasterizer, with the mesh moved by a similarity
  // instead of by MLS. Using one rasterizer for both means a difference
  // between the two images is a difference in the MAPPING, never in the
  // rasterization.
  const grid = buildGridMesh(asset.manifest, asset.texture.width, asset.texture.height);
  const rigidMesh: GridMesh = {
    ...grid,
    destination: grid.source.map((p) => applySimilarity(placement.transform, p)),
  };
  const rigidLayer = createImage(personImage.width, personImage.height, rgba(0, 0, 0, 0));
  rasterizeMesh(rigidLayer, asset.texture, rigidMesh);

  const rigidComposite = compositeStaticPreview(personImage, rigidLayer, null, {
    restoreForeground: false,
    feather: resolveFeather(anchors.shoulderSpanPx),
  });

  return {
    ok: true,
    result: {
      anchors,
      targets,
      transform: placement.transform,
      gate,
      image: rigidComposite.image,
      overlay: buildAttachmentOverlay(rigidComposite.image, anchors, targets, asset.manifest, placement.transform, asset.texture, gate),
      torsoRegion: torsoRegionOf(anchors),
    },
  };
}

const BODY_MARKER = rgba(64, 224, 208, 255);
const GARMENT_MARKER = rgba(255, 196, 0, 255);

function buildAttachmentOverlay(
  base: RgbaImage,
  anchors: BodyAnchors,
  targets: ControlPointTargets,
  manifest: KsgarmentManifest,
  transform: SimilarityTransform,
  texture: RgbaImage,
  gate: RigidGateResult,
): RgbaImage {
  const overlay = cloneImage(base);
  const scale = Math.max(1, Math.round(base.width / 360));

  // Body skeleton, in one color.
  const bodyPoints: Array<[string, Point]> = [
    ['NECK', anchors.neckBase],
    ['L-SHLDR', anchors.leftShoulder],
    ['R-SHLDR', anchors.rightShoulder],
    ['L-HIP', anchors.leftHip],
    ['R-HIP', anchors.rightHip],
    ['WAIST', anchors.waist],
  ];
  drawLine(overlay, anchors.leftShoulder, anchors.rightShoulder, 2, BODY_MARKER);
  drawLine(overlay, anchors.leftShoulder, anchors.leftHip, 2, BODY_MARKER);
  drawLine(overlay, anchors.rightShoulder, anchors.rightHip, 2, BODY_MARKER);
  drawLine(overlay, anchors.leftHip, anchors.rightHip, 2, BODY_MARKER);
  for (const [, p] of bodyPoints) fillDisc(overlay, p.x, p.y, 4 * scale * 0.6, BODY_MARKER);

  // Garment control points as placed by the rigid transform, in another
  // color, with a line to the semantic target they were aiming at. A long
  // line is a visible attachment error; a dot with no line is a control point
  // with no target.
  for (const cp of manifest.controlPoints) {
    const placed = applySimilarity(transform, { x: cp.u * texture.width, y: cp.v * texture.height });
    drawMarker(overlay, placed.x, placed.y, 6 * scale * 0.7, GARMENT_MARKER);
    const target = targets[cp.id];
    if (target) drawLine(overlay, placed, target, 1, rgba(255, 255, 255, 170));
  }

  const lines = [
    `RIGID ATTACHMENT ${gate.passed ? 'GATE PASS' : 'GATE FAIL'}`,
    `SCALE RATIO ${gate.measurements.scaleRatio.toFixed(3)}`,
    `NECKLINE DIST ${gate.measurements.necklineToNeckBasePx.toFixed(1)} / TOL ${gate.measurements.necklineToleranceP.toFixed(1)}`,
    'TEAL BODY ANCHOR   AMBER GARMENT CONTROL POINT',
  ];
  if (!gate.passed) lines.push(...gate.findings.map((f) => `FINDING ${f.toUpperCase().replace(/_/g, ' ')}`));
  lines.forEach((line, i) => {
    drawText(overlay, line, 8 * scale, 8 * scale + i * 10 * scale, {
      scale,
      color: gate.passed ? rgba(230, 255, 230, 255) : rgba(255, 210, 210, 255),
      background: rgba(0, 0, 0, 170),
    });
  });

  return overlay;
}

// ─── Stage 4+: deformation, compositing, lighting ────────────────────────────

export interface PreviewMetrics {
  controlPoint: ControlPointResidualSummary;
  coverage: CoverageResult;
  jacobian: JacobianStats;
  logo: LogoDistortion | null;
  foregroundOverGarmentPixels: number;
}

export interface PreviewManifest {
  fixtureId: string;
  caseId: string;
  rendererVersion: string;
  gitSha: string;
  bodyFrame: BodyFrame;
  garmentAssetVersion: string;
  garmentDescriptorVersion: string;
  deformationAlgorithm: string;
  controlPointMetrics: ControlPointResidualSummary;
  deformationMetrics: { jacobian: JacobianStats; coverage: CoverageResult; logo: LogoDistortion | null };
  maskProvenance: MaskProvenance;
  lightingParameters: {
    applied: boolean;
    state: LightingState;
    adjustment: LightingAdjustment;
    guardrailNote: string;
  };
  imageDimensions: { width: number; height: number };
  colorSpace: 'sRGB';
  feather: FeatherSpec;
  rigidGate: RigidGateResult;
  knownLimitations: string[];
}

export interface DeformedStageResult {
  /** Final preview: deformed garment, foreground restored, lighting applied. */
  image: RgbaImage;
  /** Identical pipeline with the lighting adjustment skipped (Section 18 requires both). */
  unadjustedImage: RgbaImage;
  /** Control image for Section 17: garment over the arm, i.e. the WRONG layer order. */
  occlusionControlImage: RgbaImage | null;
  manifest: PreviewManifest;
  metrics: PreviewMetrics;
}

/**
 * Stage 4+. Refuses to run when the rigid stop gate failed: deformation
 * cannot repair incorrect semantic anchoring, so producing a deformed image
 * from a failed gate would only produce a prettier wrong answer.
 */
export function renderDeformedStage(
  input: RenderInput,
  rigid: RigidStageResult,
): { ok: true; result: DeformedStageResult } | { ok: false; reason: 'rigid_gate_failed'; gate: RigidGateResult } {
  if (!rigid.gate.passed) return { ok: false, reason: 'rigid_gate_failed', gate: rigid.gate };

  const { personImage, asset } = input;
  const texW = asset.texture.width;
  const texH = asset.texture.height;

  const pairs: ControlPointPair[] = [];
  for (const cp of asset.manifest.controlPoints) {
    const target = rigid.targets[cp.id];
    if (!target) continue;
    pairs.push({ source: { x: cp.u * texW, y: cp.v * texH }, target: { x: target.x, y: target.y } });
  }

  const grid = buildGridMesh(asset.manifest, texW, texH);
  const mesh: GridMesh = { ...grid, destination: deformMesh(grid.source, pairs) };

  const garmentLayer = createImage(personImage.width, personImage.height, rgba(0, 0, 0, 0));
  rasterizeMesh(garmentLayer, asset.texture, mesh);

  // Lighting is measured on the person's torso and applied to a COPY of the
  // garment layer, so the unadjusted layer survives for the comparison image.
  const lightingState = estimateLighting(personImage, rigid.torsoRegion);
  const adjustment = computeLightingAdjustment(lightingState);
  const adjustedLayer = cloneImage(garmentLayer);
  applyLightingAdjustment(adjustedLayer, adjustment);

  const feather = resolveFeather(rigid.anchors.shoulderSpanPx);
  const adjustedComposite = compositeStaticPreview(personImage, adjustedLayer, input.foregroundMask, {
    restoreForeground: input.foregroundMask !== null,
    feather,
  });
  const unadjustedComposite = compositeStaticPreview(personImage, garmentLayer, input.foregroundMask, {
    restoreForeground: input.foregroundMask !== null,
    feather,
  });

  // Section 17's CONTROL: the same composite with the foreground layer
  // deliberately omitted, i.e. the garment incorrectly painted over the arm.
  const occlusionControl = input.foregroundMask
    ? compositeStaticPreview(personImage, adjustedLayer, input.foregroundMask, { restoreForeground: false, feather }).image
    : null;

  const metrics: PreviewMetrics = {
    controlPoint: controlPointResiduals(asset.manifest, pairs, rigid.targets, texW, texH, rigid.anchors.shoulderSpanPx),
    coverage: garmentCoverage(garmentLayer, rigid.torsoRegion),
    jacobian: meshJacobianStats(mesh),
    logo: asset.logoBoxTexturePx
      ? logoDistortion(asset.logoBoxTexturePx.topLeft, asset.logoBoxTexturePx.bottomRight, pairs)
      : null,
    foregroundOverGarmentPixels: adjustedComposite.foregroundOverGarmentPixels,
  };

  const manifest: PreviewManifest = {
    fixtureId: input.fixtureId,
    caseId: input.caseId,
    rendererVersion: RENDERER_VERSION,
    gitSha: input.gitSha,
    bodyFrame: input.bodyFrame,
    garmentAssetVersion: asset.manifest.assetVersion,
    garmentDescriptorVersion: input.descriptor.assetVersion,
    deformationAlgorithm: DEFORMATION_ALGORITHM,
    controlPointMetrics: metrics.controlPoint,
    deformationMetrics: { jacobian: metrics.jacobian, coverage: metrics.coverage, logo: metrics.logo },
    maskProvenance: input.maskProvenance,
    lightingParameters: {
      applied: true,
      state: lightingState,
      adjustment,
      guardrailNote:
        'Experimental guardrails, not product science: hue shift clamped to +/-15deg, saturation to +/-20%, luminance gain to 0.85-1.15.',
    },
    imageDimensions: { width: personImage.width, height: personImage.height },
    colorSpace: 'sRGB',
    feather,
    rigidGate: rigid.gate,
    knownLimitations: [
      'SYNTHETIC FIXTURE — NOT HUMAN. Validates rendering mechanics given known BodyFrames. Does not validate human pose perception, body diversity, or production segmentation quality.',
      'BodyFrame is an input from the fixture generator, not the output of any pose model. No pose model ran.',
      input.maskProvenance === 'precomputed'
        ? 'SEGMENTATION ENGINE: NOT YET IMPLEMENTED — PRECOMPUTED TEST MASK. Compositor behavior only; says nothing about automatic segmentation.'
        : 'No foreground mask supplied; occlusion not exercised in this case.',
      'Headless evaluation renderer. NOT a native rasterization baseline — native goldens must be established on physical devices.',
      ...(input.knownLimitations ?? []),
    ],
  };

  return {
    ok: true,
    result: {
      image: adjustedComposite.image,
      unadjustedImage: unadjustedComposite.image,
      occlusionControlImage: occlusionControl,
      manifest,
      metrics,
    },
  };
}
