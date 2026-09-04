/**
 * Deformation metrics (Section 14).
 *
 * "Do not create fake precision. Metrics support visual review; they do not
 * replace it." Every number here is a direct geometric measurement of what
 * the warp did — no scores, no weighted composites, no invented thresholds
 * masquerading as quality gates.
 */

import type { ControlPointPair } from '@kscan-live-vto/asset-pipeline';
import type { GarmentControlPointId, KsgarmentManifest } from '@kscan-live-vto/garment-contract';
import type { ControlPointTargets } from './attachment';
import { pointInPolygon } from './lighting';
import { getPixel, type Point, type RgbaImage } from './raster';
import { mapTexturePoint } from './warp';

export interface ControlPointResidual {
  id: GarmentControlPointId;
  /** Distance between the intended target and where the warp actually put the control point. */
  pixels: number;
  /** The same distance normalized by the body's shoulder span. */
  normalized: number;
}

export interface ControlPointResidualSummary {
  perPoint: ControlPointResidual[];
  maxPixels: number;
  meanPixels: number;
  maxNormalized: number;
}

/**
 * Affine MLS interpolates its control points exactly, so a healthy residual
 * here is ~0 and a non-zero one means the warp is not honoring its anchors
 * (degenerate configuration, wrong pairing, or a coordinate-space mix-up).
 * That makes this the cheapest available detector for an anchoring bug.
 */
export function controlPointResiduals(
  manifest: KsgarmentManifest,
  pairs: readonly ControlPointPair[],
  targets: ControlPointTargets,
  textureWidth: number,
  textureHeight: number,
  shoulderSpanPx: number,
): ControlPointResidualSummary {
  const perPoint: ControlPointResidual[] = [];
  for (const cp of manifest.controlPoints) {
    const target = targets[cp.id];
    if (!target) continue;
    const mapped = mapTexturePoint({ x: cp.u * textureWidth, y: cp.v * textureHeight }, pairs);
    const pixels = Math.hypot(mapped.x - target.x, mapped.y - target.y);
    perPoint.push({ id: cp.id, pixels, normalized: shoulderSpanPx > 0 ? pixels / shoulderSpanPx : 0 });
  }

  if (perPoint.length === 0) {
    return { perPoint, maxPixels: 0, meanPixels: 0, maxNormalized: 0 };
  }
  return {
    perPoint,
    maxPixels: Math.max(...perPoint.map((r) => r.pixels)),
    meanPixels: perPoint.reduce((s, r) => s + r.pixels, 0) / perPoint.length,
    maxNormalized: Math.max(...perPoint.map((r) => r.normalized)),
  };
}

export interface CoverageResult {
  /** Fraction of the expected torso region the garment actually covers. */
  torsoCoverage: number;
  torsoPixels: number;
  coveredTorsoPixels: number;
  /** Garment pixels that landed OUTSIDE the torso region, as a fraction of all garment pixels. Sleeves legitimately contribute here. */
  spillFraction: number;
  garmentPixels: number;
}

export function garmentCoverage(garmentLayer: RgbaImage, torsoRegion: readonly Point[]): CoverageResult {
  let torsoPixels = 0;
  let coveredTorsoPixels = 0;
  let garmentPixels = 0;
  let garmentOutside = 0;

  for (let y = 0; y < garmentLayer.height; y++) {
    for (let x = 0; x < garmentLayer.width; x++) {
      const inTorso = pointInPolygon({ x: x + 0.5, y: y + 0.5 }, torsoRegion);
      const covered = getPixel(garmentLayer, x, y).a > 128;
      if (inTorso) torsoPixels += 1;
      if (covered) garmentPixels += 1;
      if (inTorso && covered) coveredTorsoPixels += 1;
      if (covered && !inTorso) garmentOutside += 1;
    }
  }

  return {
    torsoCoverage: torsoPixels > 0 ? coveredTorsoPixels / torsoPixels : 0,
    torsoPixels,
    coveredTorsoPixels,
    spillFraction: garmentPixels > 0 ? garmentOutside / garmentPixels : 0,
    garmentPixels,
  };
}

export interface LogoDistortion {
  /** Mean length of the box's horizontal edges after the warp, ÷ before. */
  horizontalScale: number;
  verticalScale: number;
  /** horizontalScale ÷ verticalScale. 1.0 means the logo kept its aspect ratio. */
  aspectRatioChange: number;
  /** Departure from parallelogram, normalized by box size — catches shear the scales alone miss. */
  shearIndicator: number;
  /** True when the warped box's winding reversed, i.e. the logo is mirrored. */
  mirrored: boolean;
}

/**
 * Tracks a texture-space box (the logo's bounding box) through the same warp
 * the garment received. Section 14 asks specifically for horizontal/vertical
 * scale change and the resulting aspect-ratio change on the logo fixture.
 */
export function logoDistortion(
  boxTopLeft: Point,
  boxBottomRight: Point,
  pairs: readonly ControlPointPair[],
): LogoDistortion {
  const corners = {
    tl: { x: boxTopLeft.x, y: boxTopLeft.y },
    tr: { x: boxBottomRight.x, y: boxTopLeft.y },
    br: { x: boxBottomRight.x, y: boxBottomRight.y },
    bl: { x: boxTopLeft.x, y: boxBottomRight.y },
  };
  const warped = {
    tl: mapTexturePoint(corners.tl, pairs),
    tr: mapTexturePoint(corners.tr, pairs),
    br: mapTexturePoint(corners.br, pairs),
    bl: mapTexturePoint(corners.bl, pairs),
  };

  const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const srcH = (dist(corners.tl, corners.tr) + dist(corners.bl, corners.br)) / 2;
  const srcV = (dist(corners.tl, corners.bl) + dist(corners.tr, corners.br)) / 2;
  const dstH = (dist(warped.tl, warped.tr) + dist(warped.bl, warped.br)) / 2;
  const dstV = (dist(warped.tl, warped.bl) + dist(warped.tr, warped.br)) / 2;

  const horizontalScale = srcH > 0 ? dstH / srcH : 0;
  const verticalScale = srcV > 0 ? dstV / srcV : 0;

  // Signed area of the warped quad: negative means the winding reversed,
  // which for a logo means it reads backwards.
  const signedArea =
    0.5 *
    ((warped.tl.x * warped.tr.y - warped.tr.x * warped.tl.y) +
      (warped.tr.x * warped.br.y - warped.br.x * warped.tr.y) +
      (warped.br.x * warped.bl.y - warped.bl.x * warped.br.y) +
      (warped.bl.x * warped.tl.y - warped.tl.x * warped.bl.y));

  // A pure similarity keeps the two diagonals equal; their imbalance is a
  // compact shear/skew indicator.
  const diag1 = dist(warped.tl, warped.br);
  const diag2 = dist(warped.tr, warped.bl);
  const meanDiag = (diag1 + diag2) / 2;

  return {
    horizontalScale,
    verticalScale,
    aspectRatioChange: verticalScale > 0 ? horizontalScale / verticalScale : 0,
    shearIndicator: meanDiag > 0 ? Math.abs(diag1 - diag2) / meanDiag : 0,
    mirrored: signedArea < 0,
  };
}
