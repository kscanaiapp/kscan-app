'use strict';

// Sharp/libvips-backed decode probe + re-encode. This is the module that
// destroys hidden metadata, malformed containers, appended trailing bytes,
// and unsupported embedded payloads -- the generated buffer, not the
// original upload, becomes the downstream asset (Phase 6).
//
// `sharp` is required lazily and defensively: this lets every other part of
// the ingestion gate (policy loading, magic-byte detection, header parsing)
// be imported and unit-tested in any environment, including one where the
// native sharp binary hasn't been installed yet (see
// docs/security/image-ingestion-rollback.md for the render.yaml step needed
// to actually activate re-encoding on the deployed Render service).
let sharp = null;
try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
} catch (err) {
  sharp = null;
}

function isAvailable() {
  return sharp !== null;
}

// formatPolicy: one entry from image-ingestion-policy.json's allowedFormats.
async function decodeAndReencode(buffer, formatPolicy) {
  if (!sharp) {
    return {
      ok: false,
      verdict: 'SCANNER_UNAVAILABLE',
      reason: 'image re-encoder (sharp) is not installed in this environment',
    };
  }

  try {
    // limitInputPixels + failOn:'error' are libvips' own decompression-bomb
    // guard -- belt-and-suspenders alongside the header-level precheck in
    // signatures.js, which runs before this and is cheaper but less
    // authoritative (a crafted file could have consistent-looking headers
    // that still decode to something libvips considers hostile).
    const probe = sharp(buffer, { limitInputPixels: formatPolicy.maxTotalPixels, failOn: 'error' });
    const metadata = await probe.metadata();

    const frameCount = metadata.pages || 1;
    if (frameCount > formatPolicy.maxAnimationFrames) {
      return { ok: false, verdict: 'REJECTED_DIMENSIONS', reason: 'animated frame count exceeds policy' };
    }
    if (!metadata.width || !metadata.height) {
      return { ok: false, verdict: 'REJECTED_MALFORMED', reason: 'decoder could not determine dimensions' };
    }
    if (metadata.width > formatPolicy.maxWidthPx || metadata.height > formatPolicy.maxHeightPx) {
      return { ok: false, verdict: 'REJECTED_DIMENSIONS', reason: 'width/height exceeds policy' };
    }
    if (metadata.width * metadata.height > formatPolicy.maxTotalPixels) {
      return { ok: false, verdict: 'REJECTED_DIMENSIONS', reason: 'total pixels exceeds policy' };
    }

    let pipeline = sharp(buffer, { limitInputPixels: formatPolicy.maxTotalPixels, failOn: 'error' })
      .rotate() // bake in EXIF orientation before EXIF itself is dropped below
      .toColorspace('srgb');

    const outputFormat = formatPolicy.outputReencodeFormat;
    if (outputFormat === 'jpeg') {
      pipeline = pipeline.jpeg({ quality: formatPolicy.outputQuality.default, mozjpeg: true });
    } else if (outputFormat === 'png') {
      pipeline = pipeline.png({ compressionLevel: formatPolicy.outputQuality.compressionLevel.default });
    } else if (outputFormat === 'webp') {
      pipeline = pipeline.webp({ quality: formatPolicy.outputQuality.default });
    } else {
      return { ok: false, verdict: 'REENCODE_FAILED', reason: `unsupported outputReencodeFormat "${outputFormat}"` };
    }

    // Sharp strips ALL metadata (EXIF incl. GPS, ICC profile, IPTC, XMP,
    // embedded thumbnails) by default unless .withMetadata() is called --
    // deliberately never called anywhere in this module.
    const canonicalBuffer = await pipeline.toBuffer();
    const canonicalMetadata = await sharp(canonicalBuffer).metadata();

    return {
      ok: true,
      canonicalBuffer,
      width: metadata.width,
      height: metadata.height,
      canonicalHasExif: Boolean(canonicalMetadata.exif),
      canonicalHasIcc: Boolean(canonicalMetadata.icc),
    };
  } catch (err) {
    // libvips throws on malformed structure, decompression-bomb thresholds
    // (limitInputPixels), truncated files, and polyglot/trailing-garbage
    // containers it can't parse -- all correctly mapped to REJECTED_MALFORMED.
    return { ok: false, verdict: 'REJECTED_MALFORMED', reason: err.message };
  }
}

module.exports = { isAvailable, decodeAndReencode };
