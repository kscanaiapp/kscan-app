/**
 * Synthetic garment fixtures (Section 10).
 *
 * GARMENT 1 — plain T-shirt.
 * GARMENT 2 — T-shirt carrying visible directional text, the canary for
 *             accidental mirroring, orientation error, texture inversion,
 *             excessive anisotropic stretching, and pattern displacement.
 *
 * These are MECHANICS EVIDENCE ONLY (Section 20). A synthetic garment says
 * nothing about whether a real retailer catalog image can be turned into a
 * `.ksgarment` — that requires an authorized real-fixture corpus, and until
 * one exists the honest report is "REAL CATALOG ASSET VIABILITY: BLOCKED —
 * FIXTURE CORPUS REQUIRED".
 *
 * Control-point UVs use the same wearer's-anatomical-side convention as the
 * person fixtures: `leftShoulder` is the wearer's left, which sits at LOWER u
 * in the selfie-oriented frame. See fixtures/person.ts's header.
 */

import {
  KSGARMENT_SCHEMA_VERSION,
  type GarmentControlPoint,
  type GarmentDescriptor,
  type KsgarmentManifest,
} from '@kscan-live-vto/garment-contract';
import { createImage, drawText, fillPolygon, measureText, rgba, type Point, type Rgba, type RgbaImage } from '../raster';

export interface SyntheticGarmentFixture {
  manifest: KsgarmentManifest;
  descriptor: GarmentDescriptor;
  /** RGBA texture. Alpha is the garment silhouette. */
  texture: RgbaImage;
  /** Separate alpha mask image (alpha channel meaningful), mirroring the .ksgarment bundle layout. */
  alphaMask: RgbaImage;
  /** True when the texture carries directional content that must not mirror. */
  isDirectionalCanary: boolean;
  /**
   * Bounding box of the directional content in TEXTURE PIXEL space, so the
   * logo-distortion metric can track the exact region a reviewer will be
   * looking at rather than a guessed rectangle. Null for the plain tee.
   */
  logoBoxTexturePx: { topLeft: Point; bottomRight: Point } | null;
}

/**
 * Garment proportion, in shoulder-seam-span multiples (seam line → hem).
 *
 * This is the fixture's single most important number and the first version of
 * it was wrong: at a 2.625 ratio the rigid stop gate correctly refused every
 * case with `garment_largely_outside_torso`, because a garment two and a half
 * shoulder-spans long cannot sit on a torso ~1.3 spans deep without being
 * squashed to 40% of its height. 1.35 is where a real hip-length tee's own
 * geometry sits, and it matches the shoulder→hem target that
 * attachment.ts's HIP_LENGTH_HEM_DROP produces.
 */
export const GARMENT_LENGTH_RATIO = 1.35;

/**
 * T-shirt silhouette in normalized texture UV space, laid out on a 512x340
 * canvas so that (hem v - shoulder v) * height === GARMENT_LENGTH_RATIO *
 * (shoulder Δu * width). garmentProportionRatio() below asserts that
 * relationship holds rather than trusting these hand-placed numbers.
 */
const SILHOUETTE_UV: readonly Point[] = [
  // Neck opening: half-width ~0.175 of the seam span, which is a crew neck.
  // The first version used 0.58 of the seam span and closed it with a single
  // apex vertex, which rendered as a deep V exposing most of the chest —
  // caught by looking at the image, not by any metric.
  { x: 0.43, y: 0.075 }, // neck left
  { x: 0.30, y: 0.100 }, // left shoulder seam
  // Short sleeve: outer edge ~0.31 seam-spans beyond the seam. The first
  // version put it 1.1 seam-spans out (sleeve span 2.17x the shoulder span),
  // which is not a t-shirt, it is a cape.
  { x: 0.175, y: 0.170 }, // left sleeve outer top
  { x: 0.155, y: 0.360 }, // left sleeve outer bottom
  { x: 0.255, y: 0.400 }, // left armpit
  { x: 0.235, y: 0.735 }, // left waist
  { x: 0.25, y: 0.935 }, // left hem
  { x: 0.75, y: 0.935 }, // right hem
  { x: 0.765, y: 0.735 }, // right waist
  { x: 0.745, y: 0.400 }, // right armpit
  { x: 0.845, y: 0.360 }, // right sleeve outer bottom
  { x: 0.825, y: 0.170 }, // right sleeve outer top
  { x: 0.70, y: 0.100 }, // right shoulder seam
  { x: 0.57, y: 0.075 }, // neck right
  // Crew neckline as a shallow arc rather than an apex.
  { x: 0.545, y: 0.128 },
  { x: 0.50, y: 0.150 },
  { x: 0.455, y: 0.128 },
];

const CONTROL_POINTS: readonly GarmentControlPoint[] = [
  { id: 'leftShoulder', u: 0.30, v: 0.118 },
  { id: 'rightShoulder', u: 0.70, v: 0.118 },
  { id: 'leftSleeve', u: 0.19, v: 0.280 },
  { id: 'rightSleeve', u: 0.81, v: 0.280 },
  { id: 'leftTorso', u: 0.24, v: 0.560 },
  { id: 'rightTorso', u: 0.76, v: 0.560 },
  { id: 'waist', u: 0.50, v: 0.735 },
  { id: 'leftHem', u: 0.25, v: 0.930 },
  { id: 'rightHem', u: 0.75, v: 0.930 },
];

/**
 * The fixture's actual seam-to-hem ÷ seam-span ratio at a given canvas size.
 * Exported so a test can pin it against GARMENT_LENGTH_RATIO — the defect
 * this guards against (a garment silhouette whose proportions drift away from
 * what the body targets ask for) is invisible in the texture on its own and
 * only shows up as a squashed render or a refused gate.
 */
export function garmentProportionRatio(width: number, height: number): number {
  const shoulder = CONTROL_POINTS.find((cp) => cp.id === 'leftShoulder')!;
  const hem = CONTROL_POINTS.find((cp) => cp.id === 'leftHem')!;
  const right = CONTROL_POINTS.find((cp) => cp.id === 'rightShoulder')!;
  return ((hem.v - shoulder.v) * height) / ((right.u - shoulder.u) * width);
}

export interface GarmentFixtureSpec {
  productId: string;
  width: number;
  height: number;
  fabric: Rgba;
  /** Directional chest text. Omit for the plain tee. */
  logoText?: string;
  logoColor?: Rgba;
}

export const PLAIN_TEE: GarmentFixtureSpec = {
  productId: 'fixture-tee-plain-001',
  width: 512,
  height: 340,
  fabric: rgba(206, 74, 62, 255),
};

export const LOGO_TEE: GarmentFixtureSpec = {
  productId: 'fixture-tee-logo-002',
  width: 512,
  height: 340,
  fabric: rgba(38, 46, 66, 255),
  // "K SCAN >" — letters catch a mirror flip, the arrow catches it at a glance.
  logoText: 'KSCAN >',
  logoColor: rgba(240, 226, 198, 255),
};

function silhouettePixels(spec: GarmentFixtureSpec): Point[] {
  return SILHOUETTE_UV.map((p) => ({ x: p.x * spec.width, y: p.y * spec.height }));
}

export function generateSyntheticGarment(spec: GarmentFixtureSpec): SyntheticGarmentFixture {
  const texture = createImage(spec.width, spec.height, rgba(0, 0, 0, 0));
  const polygon = silhouettePixels(spec);

  fillPolygon(texture, polygon, spec.fabric);

  // Gentle vertical shading so a reviewer can see vertical compression, and
  // so a flipped texture is not perfectly self-similar.
  for (let y = 0; y < spec.height; y++) {
    const t = y / spec.height;
    const factor = 1.06 - 0.2 * t;
    for (let x = 0; x < spec.width; x++) {
      const i = (y * spec.width + x) * 4;
      if (texture.data[i + 3]! === 0) continue;
      texture.data[i] = texture.data[i]! * factor;
      texture.data[i + 1] = texture.data[i + 1]! * factor;
      texture.data[i + 2] = texture.data[i + 2]! * factor;
    }
  }

  let logoBoxTexturePx: { topLeft: Point; bottomRight: Point } | null = null;

  if (spec.logoText) {
    const scale = Math.max(2, Math.round(spec.width / 110));
    const size = measureText(spec.logoText, scale);
    const textX = (spec.width - size.width) / 2;
    const textY = spec.height * 0.36;
    drawText(texture, spec.logoText, textX, textY, {
      scale,
      color: spec.logoColor ?? rgba(255, 255, 255, 255),
    });
    logoBoxTexturePx = {
      topLeft: { x: textX, y: textY },
      bottomRight: { x: textX + size.width, y: textY + size.height },
    };
    // A short baseline rule under the text: an extra, purely horizontal
    // reference for judging vertical vs horizontal stretch independently.
    const ruleWidth = size.width;
    const ruleY = spec.height * 0.36 + size.height + scale * 2;
    for (let y = ruleY; y < ruleY + scale; y++) {
      for (let x = (spec.width - ruleWidth) / 2; x < (spec.width + ruleWidth) / 2; x++) {
        const px = Math.round(x);
        const py = Math.round(y);
        const i = (py * spec.width + px) * 4;
        if (texture.data[i + 3]! > 0) {
          const c = spec.logoColor ?? rgba(255, 255, 255, 255);
          texture.data[i] = c.r;
          texture.data[i + 1] = c.g;
          texture.data[i + 2] = c.b;
        }
      }
    }
  }

  // The alpha mask as its own image, matching the .ksgarment bundle layout
  // (manifest.json / texture.png / alpha.png).
  const alphaMask = createImage(spec.width, spec.height, rgba(0, 0, 0, 0));
  for (let i = 0; i < spec.width * spec.height; i++) {
    const a = texture.data[i * 4 + 3]!;
    alphaMask.data[i * 4] = 255;
    alphaMask.data[i * 4 + 1] = 255;
    alphaMask.data[i * 4 + 2] = 255;
    alphaMask.data[i * 4 + 3] = a;
  }

  const manifest: KsgarmentManifest = {
    version: KSGARMENT_SCHEMA_VERSION,
    productId: spec.productId,
    category: 'Tops',
    subcategory: 'crew-neck',
    silhouette: 'regular',
    sleeveLength: 'short',
    garmentLength: 'hip',
    neckline: 'crew',
    controlPoints: CONTROL_POINTS.map((cp) => ({ ...cp })),
    meshDefinition: { type: 'grid', width: 24, height: 32 },
    texture: 'texture.png',
    alphaMask: 'alpha.png',
    assetVersion: '1',
  };

  const descriptor: GarmentDescriptor = {
    productId: spec.productId,
    category: 'Tops',
    subcategory: 'crew-neck',
    silhouette: 'Fitted',
    sleeveLength: 'short',
    garmentLength: 'hip',
    neckline: 'crew',
    closure: 'pullover',
    color: spec.logoText ? 'navy' : 'red',
    pattern: spec.logoText ? 'logo' : 'solid',
    textureClass: 'smooth',
    materialClass: 'cotton',
    templateFamily: 't-shirt',
    assetVersion: '1',
  };

  return {
    manifest,
    descriptor,
    texture,
    alphaMask,
    isDirectionalCanary: Boolean(spec.logoText),
    logoBoxTexturePx,
  };
}
