/**
 * Semantic occlusion -> renderer foreground image — Phase 3 Sections 6, 10-11.
 *
 * The existing compositor (`@kscan-live-vto/static-renderer`'s
 * `compositeStaticPreview`) already layers person -> garment -> foreground
 * mask -> UI; it consumes any `RgbaImage` handed to it as `foregroundMask`
 * and has no segmentation engine of its own (`maskProvenance: 'generated'`
 * exists in its type but nothing in this workspace has ever produced one --
 * see docs/vto-phase3-source-authority.md). This module is the seam: it
 * turns a Phase 3 `SemanticScene` (named body regions, each independently
 * labeled and confidence-scored) into the single combined `RgbaImage` that
 * seam already accepts, so hair/limb foregrounding reaches the existing,
 * human-PASSed compositor without any change to its own source.
 */

import { createImage, getPixel, setPixel, type RgbaImage } from '@kscan-live-vto/static-renderer';
import { combineSemanticScene, type SemanticRegion, type SemanticScene } from '@kscan-live-vto/realism';

export interface SemanticForegroundResult {
  image: RgbaImage;
  contributingRegions: readonly SemanticRegion[];
}

/**
 * Combines every populated region in `scene` (per-texel maximum, matching
 * Section 10's occlusion order -- see `combineSemanticScene`) and paints the
 * result as a real RGBA cutout: pixel color comes from `personImage` at each
 * covered texel, alpha from the combined coverage. This is the same shape
 * `compositeStaticPreview` already expects from a precomputed foreground
 * mask -- real pixel content with coverage-as-alpha, not a flat silhouette.
 */
export function semanticSceneToForegroundImage(
  scene: SemanticScene,
  personImage: RgbaImage,
): SemanticForegroundResult {
  const { coverage, contributingRegions } = combineSemanticScene(scene, personImage.width, personImage.height);
  const image = createImage(personImage.width, personImage.height);
  for (let y = 0; y < personImage.height; y += 1) {
    for (let x = 0; x < personImage.width; x += 1) {
      const c = coverage[y * personImage.width + x] ?? 0;
      if (c <= 0) continue;
      const src = getPixel(personImage, x, y);
      setPixel(image, x, y, { r: src.r, g: src.g, b: src.b, a: Math.round(c * 255) });
    }
  }
  return { image, contributingRegions };
}
