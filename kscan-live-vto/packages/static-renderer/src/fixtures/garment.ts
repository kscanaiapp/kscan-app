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
 * squashed to 40% of its height.
 *
 * Recalibrated for the v2 garment frame (review package #2). With
 * SHOULDER_SEAM_OUTSET 0.08 and SHOULDER_SEAM_RISE 0.09, the neutral
 * fixture's lateral scale is 1.3866 and its shoulder→hem axis is 390.7px, so
 * a garment at this ratio maps with equal lateral and longitudinal scale —
 * chest content keeps its aspect ratio rather than being squashed. Bodies
 * with a different torso-to-shoulder ratio than the neutral fixture will
 * still deform non-uniformly, and that is correct: a garment adapting to a
 * short or long torso is the whole point. What is NOT acceptable is a
 * constant compression applied to every body, which is what package #1 had.
 */
export const GARMENT_LENGTH_RATIO = 1.3745;

/**
 * T-shirt silhouette in normalized texture UV space, laid out on a 512x360
 * canvas so that (hem v - shoulder v) * height === GARMENT_LENGTH_RATIO *
 * (shoulder Δu * width). garmentProportionRatio() below asserts that
 * relationship holds rather than trusting these hand-placed numbers.
 */
const SILHOUETTE_UV: readonly Point[] = [
  // Neck opening: half-width ~0.175 of the seam span, which is a crew neck.
  // The first version used 0.58 of the seam span and closed it with a single
  // apex vertex, which rendered as a deep V exposing most of the chest —
  // caught by looking at the image, not by any metric.
  { x: 0.43, y: 0.0766 }, // neck left
  { x: 0.30, y: 0.1007 }, // left shoulder seam
  // Short sleeve: outer edge ~0.275 seam-spans beyond the seam. Package #1
  // put it 1.1 seam-spans out (a cape); package #2's first render was still
  // 0.86 seam-spans, which with the new full-width chest hold rendered as a
  // poncho that swallowed the arms. A tee's body is ~1.1x its shoulder-seam
  // width, not 1.33x.
  { x: 0.190, y: 0.1681 }, // left sleeve outer top
  { x: 0.175, y: 0.3511 }, // left sleeve outer bottom
  { x: 0.285, y: 0.3896 }, // left armpit
  { x: 0.275, y: 0.7121 }, // left waist
  { x: 0.29, y: 0.9047 }, // left hem
  { x: 0.71, y: 0.9047 }, // right hem
  { x: 0.725, y: 0.7121 }, // right waist
  { x: 0.715, y: 0.3896 }, // right armpit
  { x: 0.825, y: 0.3511 }, // right sleeve outer bottom
  { x: 0.810, y: 0.1681 }, // right sleeve outer top
  { x: 0.70, y: 0.1007 }, // right shoulder seam
  { x: 0.57, y: 0.0766 }, // neck right
  // Crew neckline as a shallow arc rather than an apex.
  { x: 0.545, y: 0.1196 },
  { x: 0.50, y: 0.1488 },
  { x: 0.455, y: 0.1196 },
];

const CONTROL_POINTS: readonly GarmentControlPoint[] = [
  { id: 'leftShoulder', u: 0.30, v: 0.118 },
  { id: 'rightShoulder', u: 0.70, v: 0.118 },
  { id: 'leftSleeve', u: 0.205, v: 0.274 },
  { id: 'rightSleeve', u: 0.795, v: 0.274 },
  // Sleeve/body junction — anchors the torso side of the armpit so the
  // articulated sleeve cannot drag the chest. Matches the silhouette's own
  // armpit vertices.
  { id: 'leftArmpit', u: 0.285, v: 0.3896 },
  { id: 'rightArmpit', u: 0.715, v: 0.3896 },
  { id: 'leftTorso', u: 0.28, v: 0.5436 },
  { id: 'rightTorso', u: 0.72, v: 0.5436 },
  { id: 'waist', u: 0.50, v: 0.7121 },
  { id: 'leftHem', u: 0.29, v: 0.900 },
  { id: 'rightHem', u: 0.71, v: 0.900 },
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
  height: 360,
  fabric: rgba(206, 74, 62, 255),
};

export const LOGO_TEE: GarmentFixtureSpec = {
  productId: 'fixture-tee-logo-002',
  width: 512,
  height: 360,
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
