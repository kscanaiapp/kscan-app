'use strict';

/**
 * ATTRIBUTE-RENDERED PLACEHOLDER IMAGES.
 *
 * THESE ARE NOT PHOTOGRAPHS. They are not pictures of any garment, they are
 * not sourced from any retailer, and they must never enter a real corpus or
 * count toward one. They are procedurally drawn from a fixture's own recorded
 * fashion attributes, in the same spirit (and reusing the same genuine PNG
 * encoder) as tools/real-fashion-corpus/testAssets/generate.js.
 *
 * WHY THIS EXISTS ALONGSIDE `../syntheticImageSource.js`. That module seeds a
 * placeholder from a hash of the candidate's ID, which is exactly right for
 * its purpose - giving every candidate distinct, decodable bytes so the cache
 * and hashing paths are exercised for real. But its output is uncorrelated
 * with what the candidate IS: two navy a-line dresses and a brown boot are
 * equally dissimilar under any image-based comparison, because the pixels
 * derive from an ID string, not from the garment.
 *
 * That makes one thing impossible to demonstrate: whether the re-ranking path
 * actually RESPONDS to visual content end-to-end, or merely shuffles
 * deterministically. Rendering the recorded attributes into the pixels makes
 * that demonstrable - a navy a-line dress renders navy and A-line-shaped, and
 * a brown boot does not.
 *
 * WHAT THIS DOES NOT DO. It does not make any number in this lab evidence
 * about FashionCLIP. The renderer encodes precisely the attributes FMQ
 * already scores, so a descriptor computed over these pixels can only
 * rediscover what the fixture metadata already said - it is a MECHANISM
 * CHECK, never a quality measurement, and the report labels it as such. When
 * real FashionCLIP weights are reachable, real product photography (or at
 * minimum these same placeholder bytes) flows through the identical path with
 * no change to the re-ranker.
 */

const { makePng } = require('../../../real-fashion-corpus/testAssets/generate');

const ATTRIBUTE_RENDER_VERSION = 'attribute-rendered-placeholder-v1';

/** The corpus's full colour vocabulary, mapped to representative RGB. */
const COLOR_RGB = Object.freeze({
  navy: [26, 35, 82],
  black: [24, 24, 26],
  white: [242, 242, 238],
  gray: [140, 142, 146],
  'brown/tan': [142, 100, 62],
  multicolor: [190, 90, 120],
});
const DEFAULT_RGB = [128, 128, 128];

/** Chroma-key backdrop. Deliberately outside the garment colour vocabulary so
 * figure/ground is unambiguous - see renderGarmentImage's note. Exported so a
 * descriptor can be tested against the exact value the renderer paints. */
const BACKDROP_RGB = Object.freeze([0, 200, 0]);

/**
 * Silhouette -> a half-width profile over the vertical axis, in [0,1] of the
 * image half-width. `t` is 0 at the top of the garment, 1 at the bottom.
 */
const SILHOUETTE_PROFILE = Object.freeze({
  'a-line': (t) => 0.22 + 0.62 * t,
  fitted: (t) => 0.30 - 0.04 * Math.sin(Math.PI * t),
  straight: () => 0.34,
  structured: (t) => 0.38 - 0.06 * t,
  'tailored/structured': (t) => 0.40 - 0.10 * t,
  'oversized/relaxed': (t) => 0.46 + 0.06 * Math.sin(Math.PI * t),
});
const DEFAULT_PROFILE = () => 0.34;

/** Material -> a deterministic surface modulation amplitude (how "textured"). */
const MATERIAL_TEXTURE = Object.freeze({
  leather: 6,
  denim: 18,
  'wool/wool blend': 14,
  cotton: 9,
  silk: 3,
});

/** Pattern -> a spatial modulation function returning a signed delta. */
const PATTERN_FN = Object.freeze({
  solid: () => 0,
  striped: (x, y) => (Math.floor(y / 3) % 2 === 0 ? 26 : -26),
  floral: (x, y) => (Math.sin(x / 2.2) * Math.cos(y / 2.4) > 0.35 ? 34 : -12),
  printed: (x, y) => ((x * 7 + y * 5) % 11 < 4 ? 30 : -16),
  'color-block': (x, y, w, h) => (y < h / 2 ? 24 : -24),
});

function clamp8(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Render one garment's attributes into a genuine, decodable RGB PNG.
 *
 * @param {object} attributes - { color, silhouette, material, pattern, category }
 * @param {object} [options]  - { width, height }
 * @returns {Buffer} PNG bytes
 */
function renderGarmentImage(attributes = {}, { width = 32, height = 32 } = {}) {
  const base = COLOR_RGB[attributes.color] || DEFAULT_RGB;
  const profile = SILHOUETTE_PROFILE[attributes.silhouette] || DEFAULT_PROFILE;
  const textureAmp = MATERIAL_TEXTURE[attributes.material] ?? 8;
  const patternFn = PATTERN_FN[attributes.pattern] || PATTERN_FN.solid;

  // Backdrop is a CHROMA KEY, not a studio grey. A neutral light backdrop
  // collides with the 'white' garment colour in this corpus's vocabulary
  // (white renders at 242,242,238), and any background-suppression heuristic
  // downstream would then erase white garments entirely - which it did, until
  // this was fixed. A colour no garment in the vocabulary uses makes
  // figure/ground unambiguous for every colour the corpus contains.
  const BACKGROUND = BACKDROP_RGB;

  const pattern = (x, y) => {
    const t = height <= 1 ? 0 : y / (height - 1);
    const halfWidth = profile(t) * width;
    const dx = Math.abs(x - (width - 1) / 2);
    if (dx > halfWidth) return BACKGROUND;

    const patternDelta = patternFn(x, y, width, height);
    // Deterministic, seed-free surface modulation: a fixed lattice, so the
    // same attributes always render byte-identically.
    const texture = textureAmp * (((x * 3 + y * 5) % 7) / 6 - 0.5);
    return [
      clamp8(base[0] + patternDelta + texture),
      clamp8(base[1] + patternDelta + texture),
      clamp8(base[2] + patternDelta + texture),
    ];
  };

  return makePng({ width, height, pattern });
}

/** Extract render attributes from an FMQ candidate product. */
function attributesFromCandidate(candidate) {
  return {
    color: candidate.color_normalized ?? candidate.color ?? null,
    silhouette: candidate.silhouette ?? null,
    material: candidate.material ?? null,
    pattern: candidate.pattern ?? 'solid',
    category: candidate.canonical_category ?? candidate.category ?? null,
  };
}

/**
 * Extract render attributes for the QUERY image from a fixture's ground
 * truth - i.e. what the shopper actually photographed. Uses groundTruth, not
 * any candidate, so the query is never trivially identical to a candidate's
 * bytes by construction.
 */
function attributesFromGroundTruth(groundTruth) {
  return {
    color: groundTruth.color_family ?? null,
    silhouette: groundTruth.silhouette ?? null,
    material: groundTruth.material ?? null,
    pattern: groundTruth.pattern ?? 'solid',
    category: groundTruth.category ?? null,
  };
}

module.exports = {
  ATTRIBUTE_RENDER_VERSION,
  BACKDROP_RGB,
  COLOR_RGB,
  SILHOUETTE_PROFILE,
  MATERIAL_TEXTURE,
  PATTERN_FN,
  renderGarmentImage,
  attributesFromCandidate,
  attributesFromGroundTruth,
};
