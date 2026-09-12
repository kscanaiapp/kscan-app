'use strict';

/**
 * HARNESS VISUAL DESCRIPTOR - THIS IS NOT FASHIONCLIP AND NOT A MODEL.
 *
 * Provider tag: `HARNESS_VISUAL_DESCRIPTOR_NOT_FASHIONCLIP`, which
 * rerank/executionIdentity.js lists in NON_MODEL_PROVIDERS and
 * ../embeddingCache.js refuses to store under any real model revision. There
 * is no configuration, no flag and no code path by which output from this
 * module can satisfy `REAL_FASHIONCLIP_EXECUTED` - that is enforced by the
 * guard, and proved by a negative-control test that attempts exactly this
 * substitution and asserts it is rejected.
 *
 * WHAT IT IS. A hand-written, zero-parameter image descriptor: decode the
 * PNG, then summarise the decoded pixels as a coarse colour histogram, a
 * horizontal/vertical edge-energy pair, and a garment-width profile down the
 * vertical axis. It contains no learned weights, no training, and no semantic
 * understanding of fashion. It cannot recognise a garment, a brand or a
 * style.
 *
 * WHY IT EXISTS. Section 4 of this lane's spec is explicit that when the real
 * model cannot load, the remaining work should "materially complete the
 * re-ranking implementation and make the real execution immediately runnable
 * later." A re-ranker that has only ever been driven by a SHA-256 hash stream
 * (../harnessStubEmbedder.js) has never been shown to respond to image
 * content at all - every ranking it produces is a deterministic shuffle. This
 * descriptor closes that specific gap: it is enough visual signal to prove
 * the path from decoded pixels -> embedding -> cosine similarity -> reordered
 * candidate list is wired correctly and moves visually-closer products up.
 *
 * WHAT ITS NUMBERS ARE WORTH. Nothing, as fashion-quality evidence. The
 * images it reads are rendered from the very attributes FMQ scores against
 * (attributeImageSource.js), so any FMQ metric computed over this descriptor
 * is measuring a closed loop - metadata rendered to pixels and read back out.
 * It is reported strictly as MECHANISM_CHECK and never as retrieval quality.
 * Spec section 4: "Do not present stub output as experimental evidence."
 */

const zlib = require('node:zlib');

const PROVIDER = 'HARNESS_VISUAL_DESCRIPTOR_NOT_FASHIONCLIP';
const DESCRIPTOR_REVISION = 'harness-visual-descriptor-v1';
const DESCRIPTOR_PREPROCESSING_VERSION = 'harness-descriptor-decode-rgb-v1';

/** Colour-histogram resolution: 3 bins per channel = 27 colour cells. */
const BINS_PER_CHANNEL = 3;
/** Vertical bands for the width profile (silhouette proxy). */
const PROFILE_BANDS = 8;

/**
 * Decode a truecolour 8-bit RGB PNG produced by
 * real-fashion-corpus/testAssets/generate.js#makePng.
 *
 * That encoder writes filter type 0 (None) on every scanline, so unfiltering
 * is a byte-offset strip rather than a full PNG filter implementation. This
 * decoder deliberately REFUSES anything else (other colour types, bit depths,
 * interlacing, or a non-zero filter byte) rather than guessing - a silently
 * mis-decoded image would produce a descriptor that looks fine and means
 * nothing.
 */
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new Error('decodePng: not a buffer');
  }
  let offset = 8; // skip signature
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colourType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4; // + CRC
  }

  if (bitDepth !== 8 || colourType !== 2 || interlace !== 0) {
    throw new Error(`decodePng: unsupported PNG (bitDepth=${bitDepth} colourType=${colourType} interlace=${interlace})`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = 1 + width * 3;
  if (raw.length < height * stride) {
    throw new Error(`decodePng: truncated pixel data (${raw.length} < ${height * stride})`);
  }

  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const filterByte = raw[y * stride];
    if (filterByte !== 0) {
      throw new Error(`decodePng: unsupported scanline filter ${filterByte} on row ${y}`);
    }
    raw.copy(pixels, y * width * 3, y * stride + 1, y * stride + 1 + width * 3);
  }

  return { width, height, pixels };
}

function l2Normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector.slice();
  return vector.map((v) => v / norm);
}

/**
 * Compute the descriptor for one decoded image.
 *
 * Sections, in order:
 *   [0 .. 26]  coarse RGB colour histogram (3x3x3), background-excluded
 *   [27, 28]   mean horizontal / vertical edge energy (pattern proxy)
 *   [29 .. 36] per-band garment width fraction (silhouette proxy)
 */
function describe({ width, height, pixels }) {
  const hist = new Array(BINS_PER_CHANNEL ** 3).fill(0);
  const profile = new Array(PROFILE_BANDS).fill(0);
  const bandRows = new Array(PROFILE_BANDS).fill(0);
  let edgeH = 0;
  let edgeV = 0;
  let edgeCount = 0;

  const at = (x, y) => {
    const i = (y * width + x) * 3;
    return [pixels[i], pixels[i + 1], pixels[i + 2]];
  };

  // Background detection by CORNER SAMPLING rather than by a hardcoded
  // colour. Excluding the backdrop keeps the histogram about the garment
  // rather than about how much backdrop a narrow silhouette leaves visible -
  // but an earlier version of this function assumed the backdrop was light,
  // and so silently erased every WHITE garment in the corpus, scoring it as
  // pure background. Sampling the actual corners removes the assumption: it
  // learns the backdrop from the image instead of presuming it, and declines
  // to suppress anything when the corners disagree (as they would on a real
  // photograph with no uniform backdrop).
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const cornersAgree = corners.every(
    (c) => Math.abs(c[0] - corners[0][0]) <= 4 && Math.abs(c[1] - corners[0][1]) <= 4 && Math.abs(c[2] - corners[0][2]) <= 4,
  );
  const backdrop = corners[0];
  const isBackground = cornersAgree
    ? ([r, g, b]) => Math.abs(r - backdrop[0]) <= 6 && Math.abs(g - backdrop[1]) <= 6 && Math.abs(b - backdrop[2]) <= 6
    : () => false;

  for (let y = 0; y < height; y += 1) {
    const band = Math.min(PROFILE_BANDS - 1, Math.floor((y / height) * PROFILE_BANDS));
    bandRows[band] += 1;
    let rowGarment = 0;

    for (let x = 0; x < width; x += 1) {
      const px = at(x, y);
      if (isBackground(px)) continue;
      rowGarment += 1;

      const [r, g, b] = px;
      const br = Math.min(BINS_PER_CHANNEL - 1, Math.floor((r / 256) * BINS_PER_CHANNEL));
      const bg = Math.min(BINS_PER_CHANNEL - 1, Math.floor((g / 256) * BINS_PER_CHANNEL));
      const bb = Math.min(BINS_PER_CHANNEL - 1, Math.floor((b / 256) * BINS_PER_CHANNEL));
      hist[br * BINS_PER_CHANNEL * BINS_PER_CHANNEL + bg * BINS_PER_CHANNEL + bb] += 1;

      if (x + 1 < width) {
        const nx = at(x + 1, y);
        if (!isBackground(nx)) {
          edgeH += Math.abs(r - nx[0]) + Math.abs(g - nx[1]) + Math.abs(b - nx[2]);
          edgeCount += 1;
        }
      }
      if (y + 1 < height) {
        const ny = at(x, y + 1);
        if (!isBackground(ny)) {
          edgeV += Math.abs(r - ny[0]) + Math.abs(g - ny[1]) + Math.abs(b - ny[2]);
        }
      }
    }
    profile[band] += rowGarment / width;
  }

  const total = hist.reduce((a, b) => a + b, 0) || 1;
  const histNorm = hist.map((v) => v / total);
  const denom = edgeCount || 1;
  const edges = [edgeH / denom / 765, edgeV / denom / 765];
  const profileNorm = profile.map((v, i) => (bandRows[i] ? v / bandRows[i] : 0));

  return l2Normalize([...histNorm, ...edges, ...profileNorm]);
}

/** @param {Buffer} pngBuffer @returns {number[]} unit-norm descriptor */
function describeImage(pngBuffer) {
  return describe(decodePng(pngBuffer));
}

function embedImages(pngBuffers) {
  return {
    ok: true,
    provider: PROVIDER,
    modelRevision: DESCRIPTOR_REVISION,
    embeddings: pngBuffers.map((b) => describeImage(b)),
  };
}

module.exports = {
  PROVIDER,
  DESCRIPTOR_REVISION,
  DESCRIPTOR_PREPROCESSING_VERSION,
  decodePng,
  describeImage,
  embedImages,
};
