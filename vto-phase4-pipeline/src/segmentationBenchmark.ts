import { fillBackground, fillPolygon } from './drawing';
import { createImage, getPixel, type RgbaImage } from './pixels';
import { segmentGarment } from './segmentation';

/**
 * Phase 4.2 §28-§34 — SEGMENTATION BENCHMARK.
 *
 * §28 forbids spending the phase incrementally patching the deterministic
 * segmenter without first establishing whether a local model would be
 * materially better. This module is the measuring instrument for that
 * decision: a single interface both paths implement, evaluated against
 * masks that are GROUND TRUTH rather than another estimate.
 *
 * §31 is strict about where ground truth may come from. Here it comes from
 * the synthetic generator's own `garmentPolygon` — the exact region that
 * was drawn — rasterized with the exact same `fillPolygon` used to draw it.
 * That makes IoU/precision/recall genuinely meaningful for these fixtures.
 * It is deliberately NOT computed for real product photos: no ground-truth
 * mask exists for those, and §31 forbids inventing one.
 */

export interface SegmentationMask {
  width: number;
  height: number;
  /** 1 = garment, 0 = not garment. */
  data: Uint8Array;
}

export interface SegmentationPath {
  /** Stable identifier recorded in evidence. */
  id: string;
  /** Version/provenance string — for a model this carries the exact weights identity (§29). */
  version: string;
  kind: 'deterministic' | 'local-model';
  segment(image: RgbaImage): SegmentationMask | null;
}

/** Rasterizes a polygon into a boolean mask using the SAME fill routine that drew it. */
export function polygonToMask(width: number, height: number, polygon: [number, number][]): SegmentationMask {
  const scratch = createImage(width, height);
  fillBackground(scratch, [0, 0, 0]);
  fillPolygon(scratch, polygon, [255, 255, 255]);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = getPixel(scratch, x, y)[0] > 127 ? 1 : 0;
    }
  }
  return { width, height, data };
}

/**
 * PATH A — the current deterministic background-subtraction segmenter.
 *
 * `segmentGarment` returns a mask cropped to the garment's bounding box, so
 * it is re-expanded to full-frame coordinates here; otherwise every metric
 * would silently compare different coordinate spaces.
 */
export const DETERMINISTIC_PATH: SegmentationPath = {
  id: 'deterministic-background-subtraction',
  version: 'phase4-segmentation@0.1.0',
  kind: 'deterministic',
  segment(image: RgbaImage): SegmentationMask | null {
    const result = segmentGarment(image);
    if (!result.ok) return null;

    const data = new Uint8Array(image.width * image.height);
    // `bbox` is the winning component's own extent in source coordinates;
    // `alphaMask` is cropped to that extent plus the segmenter's margin.
    const marginX = Math.round((result.alphaMask.width - (result.bbox.maxX - result.bbox.minX + 1)) / 2);
    const marginY = Math.round((result.alphaMask.height - (result.bbox.maxY - result.bbox.minY + 1)) / 2);
    const originX = result.bbox.minX - marginX;
    const originY = result.bbox.minY - marginY;

    for (let y = 0; y < result.alphaMask.height; y++) {
      for (let x = 0; x < result.alphaMask.width; x++) {
        if (getPixel(result.alphaMask, x, y)[3] <= 127) continue;
        const sx = originX + x;
        const sy = originY + y;
        if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
        data[sy * image.width + sx] = 1;
      }
    }
    return { width: image.width, height: image.height, data };
  },
};

export interface SegmentationMetrics {
  /** Intersection over union against ground truth. */
  iou: number;
  precision: number;
  recall: number;
  /** Fraction of ground-truth boundary pixels the predicted mask also has on its boundary (within 1px). */
  boundaryAgreement: number;
  /** Predicted garment pixels / ground-truth garment pixels. >1 means over-segmentation. */
  maskCompleteness: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

function isBoundary(mask: SegmentationMask, x: number, y: number): boolean {
  if (mask.data[y * mask.width + x] !== 1) return false;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= mask.width || ny >= mask.height) return true;
    if (mask.data[ny * mask.width + nx] !== 1) return true;
  }
  return false;
}

export function compareMasks(predicted: SegmentationMask, truth: SegmentationMask): SegmentationMetrics {
  if (predicted.width !== truth.width || predicted.height !== truth.height) {
    throw new Error('mask dimensions must match to compare');
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < truth.data.length; i++) {
    const p = predicted.data[i] === 1;
    const t = truth.data[i] === 1;
    if (p && t) tp++;
    else if (p && !t) fp++;
    else if (!p && t) fn++;
  }

  // Boundary agreement, tolerant to 1px: a ground-truth boundary pixel counts
  // as matched when any predicted boundary pixel lies within its 8-neighbourhood.
  let truthBoundary = 0;
  let matchedBoundary = 0;
  for (let y = 0; y < truth.height; y++) {
    for (let x = 0; x < truth.width; x++) {
      if (!isBoundary(truth, x, y)) continue;
      truthBoundary++;
      let matched = false;
      for (let dy = -1; dy <= 1 && !matched; dy++) {
        for (let dx = -1; dx <= 1 && !matched; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= predicted.width || ny >= predicted.height) continue;
          if (isBoundary(predicted, nx, ny)) matched = true;
        }
      }
      if (matched) matchedBoundary++;
    }
  }

  const truthTotal = tp + fn;
  const predictedTotal = tp + fp;
  return {
    iou: tp + fp + fn === 0 ? 1 : tp / (tp + fp + fn),
    precision: predictedTotal === 0 ? 0 : tp / predictedTotal,
    recall: truthTotal === 0 ? 0 : tp / truthTotal,
    boundaryAgreement: truthBoundary === 0 ? 0 : matchedBoundary / truthBoundary,
    maskCompleteness: truthTotal === 0 ? 0 : predictedTotal / truthTotal,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
  };
}

export interface BenchmarkCase {
  id: string;
  /**
   * The class this fixture was DESIGNED to represent. This is an intent
   * label, not a measurement — the classifier is the authority on what a
   * fixture actually is, and the two disagree for several fixtures. Group
   * results by `classifiedShotClass` when the question is "how well does
   * segmentation serve the images that actually reach it".
   */
  shotClass: 'EASY' | 'MEDIUM' | 'HARD';
  /** What `classifyShot` actually returns for this fixture. */
  classifiedShotClass?: string;
  image: RgbaImage;
  truth: SegmentationMask;
}

export interface BenchmarkCaseResult {
  caseId: string;
  /** Intent label. */
  shotClass: string;
  /** Measured class — what the pipeline would actually do with this image. */
  classifiedShotClass: string;
  pathId: string;
  segmented: boolean;
  metrics: SegmentationMetrics | null;
  durationMs: number;
}

export function runSegmentationBenchmark(paths: SegmentationPath[], cases: BenchmarkCase[]): BenchmarkCaseResult[] {
  const results: BenchmarkCaseResult[] = [];
  for (const path of paths) {
    for (const c of cases) {
      const started = Date.now();
      const predicted = path.segment(c.image);
      const durationMs = Date.now() - started;
      results.push({
        caseId: c.id,
        shotClass: c.shotClass,
        classifiedShotClass: c.classifiedShotClass ?? 'UNKNOWN',
        pathId: path.id,
        segmented: predicted !== null,
        metrics: predicted ? compareMasks(predicted, c.truth) : null,
        durationMs,
      });
    }
  }
  return results;
}

export function summarizeBenchmark(results: BenchmarkCaseResult[]) {
  const byPath = new Map<string, BenchmarkCaseResult[]>();
  for (const r of results) {
    const list = byPath.get(r.pathId) ?? [];
    list.push(r);
    byPath.set(r.pathId, list);
  }
  const out: Record<string, unknown> = {};
  for (const [pathId, rows] of byPath) {
    const scored = rows.filter((r) => r.metrics !== null);
    const mean = (pick: (m: SegmentationMetrics) => number) =>
      scored.length === 0 ? 0 : Math.round((scored.reduce((a, r) => a + pick(r.metrics as SegmentationMetrics), 0) / scored.length) * 10000) / 10000;
    const iouValues = scored.map((r) => (r.metrics as SegmentationMetrics).iou).sort((a, b) => a - b);
    const at = (p: number) =>
      iouValues.length === 0 ? 0 : Math.round(iouValues[Math.min(iouValues.length - 1, Math.max(0, Math.ceil((p / 100) * iouValues.length) - 1))] * 10000) / 10000;
    out[pathId] = {
      cases: rows.length,
      segmented: scored.length,
      segmentationFailures: rows.length - scored.length,
      // The IoU population is strongly BIMODAL (near-1.0 or near-0), so a
      // mean alone is actively misleading — it reports a quality level that
      // describes none of the cases. Distribution first.
      iouMin: at(0),
      iouP25: at(25),
      iouMedian: at(50),
      iouP75: at(75),
      iouMax: at(100),
      iouAtLeast099: scored.filter((r) => (r.metrics as SegmentationMetrics).iou >= 0.99).length,
      iouBelow05: scored.filter((r) => (r.metrics as SegmentationMetrics).iou < 0.5).length,
      meanIou: mean((m) => m.iou),
      meanPrecision: mean((m) => m.precision),
      meanRecall: mean((m) => m.recall),
      meanBoundaryAgreement: mean((m) => m.boundaryAgreement),
      meanMaskCompleteness: mean((m) => m.maskCompleteness),
      meanDurationMs: Math.round((rows.reduce((a, r) => a + r.durationMs, 0) / Math.max(1, rows.length)) * 100) / 100,
    };
  }
  return out;
}
