import { createImage, cropImage, getPixel, setPixel, type RgbaImage } from './pixels';
import { computeForegroundMask, estimateBackgroundColor, type BackgroundEstimate } from './background';
import { labelConnectedComponents, largestComponent, type ComponentStats } from './components';

export interface SegmentationResult {
  ok: true;
  texture: RgbaImage;
  alphaMask: RgbaImage;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  maskPixelCount: number;
  bboxPixelCount: number;
  fillRatio: number;
  touchesEdge: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  background: BackgroundEstimate;
  componentCount: number;
}

export interface SegmentationFailure {
  ok: false;
  reason: 'no_foreground_component' | 'component_too_small';
}

const MIN_COMPONENT_PIXELS = 64;

/**
 * Deterministic background-based extraction (task section 17's permitted
 * primary path): the largest connected foreground component becomes the
 * garment mask, cropped to its bounding box with a small margin. No model,
 * no learned segmentation — bounded and defensible, per section 16, not a
 * claim of general-purpose garment segmentation.
 */
export function segmentGarment(
  img: RgbaImage,
  edgeMarginFraction = 0.02,
  colorThresholdOverride?: number,
): SegmentationResult | SegmentationFailure {
  const background = estimateBackgroundColor(img);
  const mask = computeForegroundMask(img, background, colorThresholdOverride);
  const { labels, components } = labelConnectedComponents(mask, img.width, img.height);
  const winner = largestComponent(components);

  if (!winner) return { ok: false, reason: 'no_foreground_component' };
  if (winner.size < MIN_COMPONENT_PIXELS) return { ok: false, reason: 'component_too_small' };

  const margin = Math.round(Math.max(img.width, img.height) * edgeMarginFraction);
  const bbox = {
    minX: Math.max(0, winner.minX - margin),
    minY: Math.max(0, winner.minY - margin),
    maxX: Math.min(img.width, winner.maxX + margin + 1),
    maxY: Math.min(img.height, winner.maxY + margin + 1),
  };

  const bboxW = bbox.maxX - bbox.minX;
  const bboxH = bbox.maxY - bbox.minY;
  const texture = createImage(bboxW, bboxH);
  const alphaMask = createImage(bboxW, bboxH);

  for (let y = 0; y < bboxH; y++) {
    for (let x = 0; x < bboxW; x++) {
      const srcX = bbox.minX + x;
      const srcY = bbox.minY + y;
      const idx = srcY * img.width + srcX;
      const isGarment = labels[idx] === winner.id;
      const [r, g, b] = getPixel(img, srcX, srcY);
      const alpha = isGarment ? 255 : 0;
      setPixel(texture, x, y, r, g, b, alpha);
      // alpha.png must carry the real mask in its OWN alpha channel (every
      // reader — maskWidthProfile, perimeterPixelCount, retrimToAlphaBounds —
      // checks getPixel(...)[3]) while also staying visually inspectable as a
      // grayscale image (R=G=B=alpha). Writing alpha=255 unconditionally here
      // was a real bug: it made every alpha.png opaque everywhere, so every
      // downstream consumer saw a solid rectangle instead of the true
      // silhouette (see docs/vto-phase4-defect-ledger.md, PHASE4-002).
      setPixel(alphaMask, x, y, alpha, alpha, alpha, alpha);
    }
  }

  return {
    ok: true,
    texture,
    alphaMask,
    bbox: { minX: winner.minX, minY: winner.minY, maxX: winner.maxX, maxY: winner.maxY },
    maskPixelCount: winner.size,
    bboxPixelCount: bboxW * bboxH,
    fillRatio: winner.size / (bboxW * bboxH),
    touchesEdge: {
      top: winner.minY <= 1,
      bottom: winner.maxY >= img.height - 2,
      left: winner.minX <= 1,
      right: winner.maxX >= img.width - 2,
    },
    background,
    componentCount: components.length,
  };
}

/** Per-row mask width profile within the bbox — the basis for anchor generation. Row index is relative to the cropped texture. */
export function maskWidthProfile(alphaMask: RgbaImage): { row: number; leftX: number; rightX: number; width: number }[] {
  const profile: { row: number; leftX: number; rightX: number; width: number }[] = [];
  for (let y = 0; y < alphaMask.height; y++) {
    let leftX = -1;
    let rightX = -1;
    for (let x = 0; x < alphaMask.width; x++) {
      const [, , , a] = getPixel(alphaMask, x, y);
      if (a > 127) {
        if (leftX === -1) leftX = x;
        rightX = x;
      }
    }
    profile.push({ row: y, leftX, rightX, width: leftX === -1 ? 0 : rightX - leftX + 1 });
  }
  return profile;
}

export { cropImage };
export type { ComponentStats };
