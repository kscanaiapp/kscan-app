/**
 * GarmentDescriptor — fashion-semantic contract (Section P1-D1).
 *
 * "The descriptor should map to existing K Scan fashion understanding
 * where available. Unknown is valid. Do not fabricate missing metadata."
 *
 * `category` and `silhouette` reuse the exact enums the existing
 * closet-intake AI already produces (`app/api/analyze+api.js`, recorded in
 * docs/source-authority.md) so a descriptor can eventually be derived from
 * K Scan's existing product/analysis data without inventing a parallel
 * taxonomy. Every other field is new — this program's own construction —
 * and every field carries an explicit `'unknown'` member rather than being
 * optional, so "we don't know" is a real, representable value distinct
 * from "this code path forgot to set it."
 */

/** Matches the category enum already produced by app/api/analyze+api.js. */
export type GarmentCategory =
  | 'Tops'
  | 'Bottoms'
  | 'Outerwear'
  | 'Footwear'
  | 'Accessories'
  | 'Dresses'
  | 'unknown';

/** Matches the silhouette enum already produced by app/api/analyze+api.js. */
export type GarmentSilhouette =
  | 'Oversized'
  | 'Fitted'
  | 'Relaxed'
  | 'Boxy'
  | 'Cropped'
  | 'Wide-leg'
  | 'Slim'
  | 'Flowy'
  | 'Straight'
  | 'Layered'
  | 'unknown';

export type SleeveLength =
  | 'sleeveless'
  | 'short'
  | 'three-quarter'
  | 'long'
  | 'unknown';

export type GarmentLength = 'crop' | 'waist' | 'hip' | 'thigh' | 'knee' | 'unknown';

export type Neckline =
  | 'crew'
  | 'v-neck'
  | 'scoop'
  | 'collar'
  | 'turtleneck'
  | 'off-shoulder'
  | 'unknown';

export type Closure = 'none' | 'button' | 'zip' | 'pullover' | 'tie' | 'unknown';

export type PatternClass =
  | 'solid'
  | 'stripe'
  | 'graphic'
  | 'logo'
  | 'floral'
  | 'plaid'
  | 'unknown';

export type TextureClass = 'smooth' | 'ribbed' | 'knit' | 'woven' | 'fleece' | 'unknown';

export type MaterialClass =
  | 'cotton'
  | 'synthetic'
  | 'denim'
  | 'wool'
  | 'blend'
  | 'unknown';

/**
 * The subset of GarmentCategory/subcategory this program's Live engine is
 * ever allowed to render, per Section 5 ("What we are not building" — no
 * pants, no complex dresses, no layered outfits) and Section 26/P2-C2
 * ("Start only with: 1. T-shirt; 2. simple top; 3. sweater. Do not expand
 * categories until the core pipeline passes."). This is a hard allow-list,
 * not a suggestion — the static and live preview engines both consult it
 * before attempting attachment.
 */
export const LIVE_SUPPORTED_TEMPLATE_FAMILIES = ['t-shirt', 'simple-top', 'sweater'] as const;
export type LiveSupportedTemplateFamily = (typeof LIVE_SUPPORTED_TEMPLATE_FAMILIES)[number];

export interface GarmentDescriptor {
  productId: string;
  category: GarmentCategory;
  subcategory: string | 'unknown';
  silhouette: GarmentSilhouette;
  sleeveLength: SleeveLength;
  garmentLength: GarmentLength;
  neckline: Neckline;
  closure: Closure;
  /** Free-text color label (e.g. from existing K Scan `metadata.color`); not a validated enum. */
  color: string | 'unknown';
  pattern: PatternClass;
  textureClass: TextureClass;
  materialClass: MaterialClass;
  /**
   * Which rig/control-point family this garment uses for deformation
   * (Section P1-D1: "Phase 2 inheritance: Determines rig/control-point
   * behavior"). Distinct from `category`/`subcategory` — a garment can be
   * category `Tops` / subcategory `sweater` and still use the `t-shirt`
   * templateFamily if its silhouette and construction are close enough
   * that the same control-point rig applies. `null` means no rig is
   * assigned yet (asset pipeline has not reached that stage); it is NOT
   * the same as `'unsupported'`, which is a considered decision.
   */
  templateFamily: LiveSupportedTemplateFamily | 'unsupported' | null;
  /** .ksgarment manifest schema version this descriptor was produced against. Section 12: pin, never silently drift. */
  assetVersion: string;
}

export function isLiveSupportedTemplateFamily(
  value: GarmentDescriptor['templateFamily'],
): value is LiveSupportedTemplateFamily {
  return value !== null && (LIVE_SUPPORTED_TEMPLATE_FAMILIES as readonly string[]).includes(value);
}

export function unknownGarmentDescriptor(productId: string, assetVersion: string): GarmentDescriptor {
  return {
    productId,
    category: 'unknown',
    subcategory: 'unknown',
    silhouette: 'unknown',
    sleeveLength: 'unknown',
    garmentLength: 'unknown',
    neckline: 'unknown',
    closure: 'unknown',
    color: 'unknown',
    pattern: 'unknown',
    textureClass: 'unknown',
    materialClass: 'unknown',
    templateFamily: null,
    assetVersion,
  };
}
