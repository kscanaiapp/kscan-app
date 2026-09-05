import { createImage, getPixel, rotateImage, setPixel, type RgbaImage } from './pixels';
import { maskWidthProfile } from './segmentation';

export interface CanonicalizationResult {
  ok: true;
  texture: RgbaImage;
  alphaMask: RgbaImage;
  appliedRotationDegrees: number;
  tiltEvidence: { measuredTiltDegrees: number; sampledRows: number };
}

export interface CanonicalizationFailure {
  ok: false;
  reason: 'TILT_TOO_SEVERE';
  measuredTiltDegrees: number;
}

const MAX_CORRECTABLE_TILT_DEGREES = 20;
const MIN_TILT_TO_CORRECT_DEGREES = 1;

/**
 * Easy: identity pass-through (crop/pad already done by segmentation;
 * "preserve aspect/product geometry" per task section 21 means doing
 * nothing further here).
 *
 * Medium: bounded rotation rectification. The correction angle is measured,
 * not assumed — linear regression of the mask's left/right-center x-offset
 * against row index estimates a single global tilt angle from the garment's
 * own boundary. This is a deliberately simpler case of the "affine,
 * control-point-driven" rectification family described in task section 21
 * (full moving-least-squares control-point warping exists only in the
 * read-only PR #291/#295 reference and is not reachable from this branch —
 * see docs/vto-phase4-source-authority.md); adopting the richer version is
 * recorded as a P9 follow-up once real Medium-class evidence justifies it
 * (docs/vto-phase4-defect-ledger.md).
 */
export function canonicalizeMedium(texture: RgbaImage, alphaMask: RgbaImage): CanonicalizationResult | CanonicalizationFailure {
  const profile = maskWidthProfile(alphaMask).filter((p) => p.width > 0);
  if (profile.length < 8) {
    return { ok: true, texture, alphaMask, appliedRotationDegrees: 0, tiltEvidence: { measuredTiltDegrees: 0, sampledRows: profile.length } };
  }

  const rows = profile.map((p) => p.row);
  const centers = profile.map((p) => (p.leftX + p.rightX) / 2);
  const meanRow = rows.reduce((a, b) => a + b, 0) / rows.length;
  const meanCenter = centers.reduce((a, b) => a + b, 0) / centers.length;

  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < rows.length; i++) {
    covariance += (rows[i] - meanRow) * (centers[i] - meanCenter);
    variance += (rows[i] - meanRow) * (rows[i] - meanRow);
  }
  const slope = variance === 0 ? 0 : covariance / variance; // dx per dy
  const measuredTiltDegrees = (Math.atan(slope) * 180) / Math.PI;

  if (Math.abs(measuredTiltDegrees) > MAX_CORRECTABLE_TILT_DEGREES) {
    return { ok: false, reason: 'TILT_TOO_SEVERE', measuredTiltDegrees };
  }

  if (Math.abs(measuredTiltDegrees) < MIN_TILT_TO_CORRECT_DEGREES) {
    return { ok: true, texture, alphaMask, appliedRotationDegrees: 0, tiltEvidence: { measuredTiltDegrees, sampledRows: profile.length } };
  }

  const radians = (measuredTiltDegrees * Math.PI) / 180;
  const rotatedTexture = rotateImage(texture, -radians);
  const rotatedAlpha = rotateImage(alphaMask, -radians);
  const retrimmed = retrimToAlphaBounds(rotatedTexture, rotatedAlpha);

  return {
    ok: true,
    texture: retrimmed.texture,
    alphaMask: retrimmed.alphaMask,
    appliedRotationDegrees: -measuredTiltDegrees,
    tiltEvidence: { measuredTiltDegrees, sampledRows: profile.length },
  };
}

/** After rotation, trim the empty (rotation-introduced) border back to the alpha mask's real extent. */
function retrimToAlphaBounds(texture: RgbaImage, alphaMask: RgbaImage): { texture: RgbaImage; alphaMask: RgbaImage } {
  let minX = alphaMask.width;
  let minY = alphaMask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < alphaMask.height; y++) {
    for (let x = 0; x < alphaMask.width; x++) {
      const [, , , a] = getPixel(alphaMask, x, y);
      if (a > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return { texture, alphaMask };

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const outTexture = createImage(w, h);
  const outAlpha = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [tr, tg, tb, ta] = getPixel(texture, minX + x, minY + y);
      setPixel(outTexture, x, y, tr, tg, tb, ta);
      const [ar, ag, ab, aa] = getPixel(alphaMask, minX + x, minY + y);
      setPixel(outAlpha, x, y, ar, ag, ab, aa);
    }
  }
  return { texture: outTexture, alphaMask: outAlpha };
}
