/**
 * Garment mesh warp and rasterization (Sections 13-14).
 *
 * The deformation itself is the EXISTING affine-MLS implementation in
 * `@kscan-live-vto/asset-pipeline` — Section 13 is explicit that this pass
 * does not restart an algorithm benchmark and does not silently substitute
 * TPS/ARAP. This module only builds the mesh, moves its vertices through that
 * function, rasterizes the result, and measures what happened.
 *
 * Rasterization is forward-mapped: each grid cell becomes two triangles whose
 * vertices carry their source texture coordinates, and each covered
 * destination pixel barycentrically interpolates those coordinates and
 * samples the texture bilinearly. Forward mapping is chosen over an inverse
 * warp because the MLS map has no closed-form inverse, and inverting it
 * numerically per pixel would trade a clear geometric story for speed this
 * evaluation renderer does not need.
 */

import { deformVertex, type ControlPointPair } from '@kscan-live-vto/asset-pipeline';
import type { KsgarmentManifest } from '@kscan-live-vto/garment-contract';
import { blendPixel, sampleBilinear, type Point, type RgbaImage } from './raster';

export interface GridMesh {
  /** Vertex positions in texture pixel space. */
  source: Point[];
  /** Vertex positions in destination (person image) pixel space. */
  destination: Point[];
  /** Triangle vertex indices, 3 per triangle. */
  triangles: number[];
  columns: number;
  rows: number;
}

export function buildGridMesh(manifest: KsgarmentManifest, textureWidth: number, textureHeight: number): {
  source: Point[];
  triangles: number[];
  columns: number;
  rows: number;
} {
  const columns = manifest.meshDefinition.width;
  const rows = manifest.meshDefinition.height;
  const source: Point[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      source.push({
        x: (col / (columns - 1)) * textureWidth,
        y: (row / (rows - 1)) * textureHeight,
      });
    }
  }

  const triangles: number[] = [];
  for (let row = 0; row + 1 < rows; row++) {
    for (let col = 0; col + 1 < columns; col++) {
      const tl = row * columns + col;
      const tr = tl + 1;
      const bl = tl + columns;
      const br = bl + 1;
      triangles.push(tl, tr, bl, tr, br, bl);
    }
  }

  return { source, triangles, columns, rows };
}

export function deformMesh(source: readonly Point[], pairs: readonly ControlPointPair[]): Point[] {
  return source.map((v) => deformVertex(v, pairs));
}

/**
 * Rasterizes the warped mesh into `target`, sampling `texture`.
 *
 * Triangles are expanded by half a pixel around their edges before the
 * coverage test so adjacent cells do not leave a seam of unwritten pixels
 * between them. Alpha comes from the texture, so the garment silhouette is
 * carried by the asset, never re-derived here.
 */
export function rasterizeMesh(
  target: RgbaImage,
  texture: RgbaImage,
  mesh: GridMesh,
  opacity = 1,
): void {
  const { source, destination, triangles } = mesh;

  for (let t = 0; t < triangles.length; t += 3) {
    const i0 = triangles[t]!;
    const i1 = triangles[t + 1]!;
    const i2 = triangles[t + 2]!;
    const d0 = destination[i0]!;
    const d1 = destination[i1]!;
    const d2 = destination[i2]!;
    const s0 = source[i0]!;
    const s1 = source[i1]!;
    const s2 = source[i2]!;

    const minX = Math.max(0, Math.floor(Math.min(d0.x, d1.x, d2.x) - 1));
    const maxX = Math.min(target.width - 1, Math.ceil(Math.max(d0.x, d1.x, d2.x) + 1));
    const minY = Math.max(0, Math.floor(Math.min(d0.y, d1.y, d2.y) - 1));
    const maxY = Math.min(target.height - 1, Math.ceil(Math.max(d0.y, d1.y, d2.y) + 1));
    if (minX > maxX || minY > maxY) continue;

    const area = (d1.x - d0.x) * (d2.y - d0.y) - (d2.x - d0.x) * (d1.y - d0.y);
    if (Math.abs(area) < 1e-9) continue;
    const invArea = 1 / area;
    // A degenerate-thin or inverted triangle still rasterizes; foldover is
    // reported as a metric (see meshJacobianStats) rather than hidden by
    // dropping the triangle, because silently dropping it would make a
    // broken warp look merely sparse.
    const bias = 0.5 / Math.max(1, Math.sqrt(Math.abs(area)));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let w0 = ((d1.x - px) * (d2.y - py) - (d2.x - px) * (d1.y - py)) * invArea;
        let w1 = ((d2.x - px) * (d0.y - py) - (d0.x - px) * (d2.y - py)) * invArea;
        let w2 = 1 - w0 - w1;
        if (w0 < -bias || w1 < -bias || w2 < -bias) continue;
        w0 = Math.max(0, w0);
        w1 = Math.max(0, w1);
        w2 = Math.max(0, w2);
        const sum = w0 + w1 + w2;
        if (sum <= 0) continue;
        w0 /= sum;
        w1 /= sum;
        w2 /= sum;

        const sx = s0.x * w0 + s1.x * w1 + s2.x * w2;
        const sy = s0.y * w0 + s1.y * w1 + s2.y * w2;
        const sample = sampleBilinear(texture, sx - 0.5, sy - 0.5);
        if (sample.a <= 1) continue;
        blendPixel(target, x, y, { ...sample, a: sample.a * opacity });
      }
    }
  }
}

export interface JacobianStats {
  /** Ratio of deformed cell area to source cell area, per grid cell. */
  minDeterminant: number;
  maxDeterminant: number;
  medianDeterminant: number;
  /** Cells whose orientation flipped — the garment folded through itself. */
  foldoverCells: number;
  cellCount: number;
}

/**
 * Per-cell area ratio with sign, i.e. a discrete Jacobian determinant.
 *
 * A negative value means the cell's winding reversed under the warp: the
 * garment has folded through itself there. Section 14 asks for this to be
 * flagged explicitly, because foldover is invisible in a still where the
 * fabric is a flat color and catastrophic where it is not.
 */
export function meshJacobianStats(mesh: GridMesh): JacobianStats {
  const { source, destination, columns, rows } = mesh;
  const determinants: number[] = [];
  let foldoverCells = 0;

  const signedArea = (a: Point, b: Point, c: Point, d: Point): number =>
    0.5 * ((a.x * b.y - b.x * a.y) + (b.x * c.y - c.x * b.y) + (c.x * d.y - d.x * c.y) + (d.x * a.y - a.x * d.y));

  for (let row = 0; row + 1 < rows; row++) {
    for (let col = 0; col + 1 < columns; col++) {
      const tl = row * columns + col;
      const tr = tl + 1;
      const br = tl + columns + 1;
      const bl = tl + columns;
      const srcArea = signedArea(source[tl]!, source[tr]!, source[br]!, source[bl]!);
      if (Math.abs(srcArea) < 1e-9) continue;
      const dstArea = signedArea(destination[tl]!, destination[tr]!, destination[br]!, destination[bl]!);
      const determinant = dstArea / srcArea;
      determinants.push(determinant);
      if (determinant < 0) foldoverCells += 1;
    }
  }

  if (determinants.length === 0) {
    return { minDeterminant: 0, maxDeterminant: 0, medianDeterminant: 0, foldoverCells: 0, cellCount: 0 };
  }
  const sorted = [...determinants].sort((a, b) => a - b);
  return {
    minDeterminant: sorted[0]!,
    maxDeterminant: sorted[sorted.length - 1]!,
    medianDeterminant: sorted[Math.floor(sorted.length / 2)]!,
    foldoverCells,
    cellCount: determinants.length,
  };
}

/**
 * Where a texture-space point ends up after the warp. Used to measure logo
 * distortion by tracking the corners of the logo's bounding box through the
 * same deformation the garment received.
 */
export function mapTexturePoint(point: Point, pairs: readonly ControlPointPair[]): Point {
  return deformVertex(point, pairs);
}
