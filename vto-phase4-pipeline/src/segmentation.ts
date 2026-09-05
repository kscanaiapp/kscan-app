import { createImage, cropImage, getPixel, setPixel, type RgbaImage } from './pixels';
import { computeForegroundMask, estimateBackgroundColor, type BackgroundEstimate } from './background';
import { labelConnectedComponents, largestComponent, type ComponentStats } from './components';
import { SIGNIFICANT_COMPONENT_AREA_FRACTION } from './sourcePreflight';

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
  /** EVERY connected foreground component, including single-pixel compression speckle. Diagnostic only — see `significantComponentCount`. */
  componentCount: number;
  /**
   * Components at or above `SIGNIFICANT_COMPONENT_AREA_FRACTION` of image
   * area. This — not `componentCount` — is the meaningful measure of "how
   * many things are in this picture", and is the same notion the shot
   * classifier already uses. See docs/vto-phase4-2-defect-ledger.md,
   * P42-001, for why the distinction is load-bearing.
   */
  significantComponentCount: number;
  /**
   * Largest NON-winner connected component, as a fraction of the winner's
   * own area. Audit P42-A-001: `significantComponentCount` alone measures
   * significance against the FRAME, so a detached sleeve/strap sitting just
   * below `SIGNIFICANT_COMPONENT_AREA_FRACTION` of image area contributed
   * exactly nothing while being silently dropped from the emitted asset.
   * This measures it against the GARMENT instead, which is the scale that
   * decides whether the asset is materially incomplete.
   */
  largestNonWinnerComponentRatio: number;
  /**
   * Aggregate area of every component that is significant by NEITHER measure
   * (i.e. true compression speckle), relative to the winner. This is the
   * A8 speck-AREA ceiling input: it stays ~0.02 on real JPEG/WebP speckle
   * (measured: 1196 components -> 0.024) and only approaches 1 when the
   * foreground really is confetti.
   */
  insignificantFragmentRatio: number;
}

export interface SegmentationFailure {
  ok: false;
  reason: 'no_foreground_component' | 'component_too_small';
}

const MIN_COMPONENT_PIXELS = 64;

/**
 * Audit P42-A-001 (amendment A8). A component counts as SIGNIFICANT if it is
 * material against the FRAME (the pre-existing 1%-of-image rule, unchanged)
 * OR material against the GARMENT.
 *
 * The garment-relative arm closes a proven cliff: a detached garment part at
 * 0.99% of image area scored `significantComponentCount = 1` and cost the
 * segmentation confidence EXACTLY ZERO, while being dropped from the emitted
 * asset (only `winner` is written into the mask). A shirt missing a sleeve
 * was therefore emitted as LIVE2D_ELIGIBLE.
 *
 * CALIBRATION (§26 — derived, not invented). Measured on the committed
 * 490-product characterization evidence:
 *   - EASY sources carry a median non-winner foreground of 0.0002 of the
 *     total foreground (p90 0.019). Compression speckle is 2-3 orders of
 *     magnitude below this threshold: 1196 single-pixel components on a
 *     48,792px garment is 0.00002 per component.
 *   - A detached part large enough to matter measures >= 0.02 of the winner.
 * The two populations are separated by ~1000x, so 0.02 sits in a wide gap
 * rather than on a knife edge. `phase42AuditRepairs.test.ts` pins the gap.
 */
export const SIGNIFICANT_COMPONENT_GARMENT_FRACTION = 0.02;

/**
 * A8 speck-AREA ceiling. When the aggregate area of components significant
 * by NEITHER measure reaches this multiple of the winner's area, the mask is
 * confetti and `significantComponentCount === 1` must stop meaning "clean".
 * Set far above every measured real value (worst observed real speckle load
 * is 0.024) so it is a genuine backstop and never fires on compression
 * noise — which is exactly what P42-001 exists to tolerate.
 */
export const INSIGNIFICANT_FRAGMENT_CEILING = 0.5;

function isSignificantComponent(c: ComponentStats, img: RgbaImage, winner: ComponentStats): boolean {
  if (c.size / (img.width * img.height) >= SIGNIFICANT_COMPONENT_AREA_FRACTION) return true;
  return c.id !== winner.id && c.size / winner.size >= SIGNIFICANT_COMPONENT_GARMENT_FRACTION;
}

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

  const largestNonWinner = components.reduce((m, c) => (c.id === winner.id ? m : Math.max(m, c.size)), 0);

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
    significantComponentCount: components.filter((c) => isSignificantComponent(c, img, winner)).length,
    largestNonWinnerComponentRatio: largestNonWinner / winner.size,
    insignificantFragmentRatio:
      components.filter((c) => c.id !== winner.id && !isSignificantComponent(c, img, winner)).reduce((a, c) => a + c.size, 0) / winner.size,
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
