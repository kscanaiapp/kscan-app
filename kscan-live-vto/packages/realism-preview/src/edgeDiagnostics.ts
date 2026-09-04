/**
 * Edge integration diagnostics — Phase 3 Section 12.
 *
 * "Add measurable edge diagnostics where practical." Package #2 already
 * proved the garment layer carries partial-alpha edge pixels rather than a
 * binary silhouette (supersampled premultiplied-alpha compositing --
 * `GARMENT_SUPERSAMPLE`/`downsample` in static-renderer). This module makes
 * that measurable rather than a single pass/fail test assertion, and adds
 * the two things Section 12 explicitly forbids a check for: silhouette
 * growth and excessive halo, both detectable as a change in the opaque
 * pixel count / bounding box between a baseline and a post-processed image.
 */

import { getPixel, type RgbaImage } from '@kscan-live-vto/static-renderer';

export interface AlphaCoverageHistogram {
  fullyOpaque: number;
  fullyTransparent: number;
  partial: number;
  total: number;
}

export function alphaCoverageHistogram(image: RgbaImage): AlphaCoverageHistogram {
  let fullyOpaque = 0;
  let fullyTransparent = 0;
  let partial = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const a = getPixel(image, x, y).a;
      if (a === 0) fullyTransparent += 1;
      else if (a === 255) fullyOpaque += 1;
      else partial += 1;
    }
  }
  return { fullyOpaque, fullyTransparent, partial, total: image.width * image.height };
}

/** Fraction of edge-relevant pixels (opaque + partial) that are partial --
 *  a coarse "how soft is the edge" measurement. Zero would mean a hard,
 *  binary silhouette; this module does not assert a target value, only
 *  reports it (Section 18: record distributions first). */
export function edgePartialAlphaRatio(histogram: AlphaCoverageHistogram): number {
  const edgeRelevant = histogram.fullyOpaque + histogram.partial;
  return edgeRelevant === 0 ? 0 : histogram.partial / edgeRelevant;
}

export function opaquePixelCount(image: RgbaImage, alphaThreshold = 250): number {
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (getPixel(image, x, y).a >= alphaThreshold) count += 1;
    }
  }
  return count;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of pixels at or above `alphaThreshold`; null if none. The
 *  basis for detecting silhouette growth: Phase 3 post-processing must not
 *  expand this box beyond a small tolerance versus a pre-Phase-3 baseline
 *  of the same render. */
export function opaqueBoundingBox(image: RgbaImage, alphaThreshold = 250): BoundingBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (getPixel(image, x, y).a >= alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

export function boundingBoxArea(box: BoundingBox | null): number {
  if (!box) return 0;
  return (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1);
}
