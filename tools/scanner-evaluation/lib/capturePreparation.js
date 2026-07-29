'use strict';

/**
 * The certified capture-preparation contract (Phase 1 repair F-1).
 *
 * WHY THIS EXISTS
 * The deployed v140 identification path does not receive camera-original bytes.
 * The production client resizes and re-encodes every frame BEFORE upload, and the
 * Edge Function rejects anything above a fixed base64 ceiling before it ever
 * reaches the provider. An evaluation harness that posts governed originals is
 * therefore not measuring the production Scanner at all — it is measuring a
 * request the production Scanner never receives, and for large originals it is
 * measuring the size guard rather than the model.
 *
 * Both failure directions are real and neither is visible in the result payload:
 *
 *   - OVER the ceiling: the certified path returns `failed` from the size guard
 *     and makes ZERO provider calls. Scored naively, that is indistinguishable
 *     from a model failure, so the baseline under-reports accuracy and attributes
 *     a transport rejection to the Scanner.
 *   - UNDER the ceiling but un-prepared: the model receives more pixels and less
 *     compression artefact than production ever supplies, so the baseline
 *     OVER-reports accuracy relative to the shipped experience.
 *
 * WHAT THIS MODULE DOES
 * It refuses to let either happen silently. A case may only be planned when the
 * harness declares a capture-preparation mode that is production-equivalent, and
 * when the bytes actually destined for the request fit the certified ceiling.
 *
 * WHAT IT DOES NOT DO
 * It does not resize or re-encode anything, and it does not touch the frozen
 * dataset. Producing production-equivalent derivatives requires either a new
 * image-codec dependency in this repository or a governed dataset patch version;
 * both are owner decisions and neither is taken here. Until one is taken, the
 * only correct behaviour is to fail closed, which is what `MODE_ABSENT` does.
 */

const fs = require('fs');
const path = require('path');

/**
 * Constants transcribed from the certified v140 source. Every value carries the
 * file and symbol it came from so drift is detectable rather than assumed, and
 * `verifyAgainstCertifiedSource` re-derives them from a certified worktree.
 */
const CERTIFIED_CONTRACT = Object.freeze({
  /** supabase/functions/scan-identify/index.ts :: MAX_IMAGE_BASE64_BYTES */
  maxImageBase64Bytes: 2 * 1024 * 1024,
  /** services/imageUtils.js :: SCANNER_IMAGE_MAX_WIDTH */
  scannerImageMaxWidth: 896,
  /** services/imageUtils.js :: SCANNER_IMAGE_JPEG_QUALITY */
  scannerImageJpegQuality: 0.65,
  /** supabase/functions/scan-identify/index.ts :: DEFAULT_MIME */
  defaultMime: 'image/jpeg',
  certifiedSourceSha: 'f5f4ed2eda4984db0658c3209fece223acd33188',
  provenance: Object.freeze({
    maxImageBase64Bytes: 'supabase/functions/scan-identify/index.ts::MAX_IMAGE_BASE64_BYTES',
    scannerImageMaxWidth: 'services/imageUtils.js::SCANNER_IMAGE_MAX_WIDTH',
    scannerImageJpegQuality: 'services/imageUtils.js::SCANNER_IMAGE_JPEG_QUALITY',
    defaultMime: 'supabase/functions/scan-identify/index.ts::DEFAULT_MIME',
  }),
});

/** No preparation stage exists. Nothing may execute. */
const MODE_ABSENT = 'absent';
/** Governed bytes are posted verbatim. Explicitly NOT production-equivalent. */
const MODE_GOVERNED_ORIGINAL = 'governed_original';
/** Derivatives produced at the certified client's width and quality. */
const MODE_CERTIFIED_CLIENT_EQUIVALENT = 'certified_client_equivalent';

const MODES = Object.freeze([MODE_ABSENT, MODE_GOVERNED_ORIGINAL, MODE_CERTIFIED_CLIENT_EQUIVALENT]);

/** Only one mode yields a payload comparable to what production sends. */
const PRODUCTION_EQUIVALENT_MODES = Object.freeze(new Set([MODE_CERTIFIED_CLIENT_EQUIVALENT]));

/**
 * Base64 length of `byteLength` raw bytes.
 *
 * The certified guard measures the length of the base64 STRING, not the decoded
 * size, so the comparison has to be done in base64 space or it under-counts by
 * a third and lets oversized payloads through.
 */
function base64Length(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    throw new Error(`base64Length requires a non-negative byte count, received ${byteLength}`);
  }
  return Math.ceil(byteLength / 3) * 4;
}

function isProductionEquivalent(mode) {
  return PRODUCTION_EQUIVALENT_MODES.has(mode);
}

/**
 * Resolve the declared capture-preparation mode, failing closed.
 *
 * An unset mode is `absent`, never a permissive default: a harness that forgot
 * to declare preparation must not inherit the behaviour of one that has it.
 */
function resolveMode(declared) {
  if (declared == null || declared === '') return MODE_ABSENT;
  if (!MODES.includes(declared)) {
    throw new Error(
      `unknown capture preparation mode "${declared}"; expected one of ${MODES.join(', ')}`
    );
  }
  return declared;
}

/**
 * Evaluate one image against the certified payload contract.
 *
 * @param {{ byteLength: number, refValue?: string }} image
 * @param {{ mode: string, maxImageBase64Bytes?: number }} options
 * @returns {{ ok: boolean, findings: Array<object>, base64Length: number }}
 */
function evaluateImage(image, options = {}) {
  const mode = resolveMode(options.mode);
  const cap = options.maxImageBase64Bytes == null
    ? CERTIFIED_CONTRACT.maxImageBase64Bytes
    : options.maxImageBase64Bytes;
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error(`certified base64 ceiling must be a positive integer, received ${cap}`);
  }

  const encoded = base64Length(image.byteLength);
  const findings = [];

  if (mode === MODE_ABSENT) {
    findings.push({
      severity: 'blocking',
      check: 'capture_preparation_absent',
      message:
        'no capture-preparation stage is declared. The certified client resizes to '
        + `${CERTIFIED_CONTRACT.scannerImageMaxWidth}px wide and re-encodes JPEG at `
        + `quality ${CERTIFIED_CONTRACT.scannerImageJpegQuality} before upload; posting governed `
        + 'originals measures a request production never sends.',
    });
  } else if (!isProductionEquivalent(mode)) {
    findings.push({
      severity: 'blocking',
      check: 'capture_preparation_not_production_equivalent',
      message:
        `capture preparation mode "${mode}" is not production-equivalent, so any score derived `
        + 'from it cannot be reported as a production Scanner baseline.',
    });
  }

  if (encoded > cap) {
    findings.push({
      severity: 'blocking',
      check: 'certified_payload_ceiling',
      message:
        `base64 payload ${encoded} bytes exceeds the certified ceiling ${cap} `
        + `(${CERTIFIED_CONTRACT.provenance.maxImageBase64Bytes}). The certified path returns `
        + 'status "failed" from its size guard and makes zero provider calls, so this case would '
        + 'score as a Scanner failure while never reaching the model.',
      imageRef: image.refValue || null,
      base64Length: encoded,
      ceiling: cap,
    });
  }

  return { ok: findings.length === 0, findings, base64Length: encoded, mode, ceiling: cap };
}

/**
 * Summarise the contract across a set of images without deciding anything.
 * Used by reporting so the limitation can be stated with real denominators.
 */
function summarize(images, options = {}) {
  const cap = options.maxImageBase64Bytes == null
    ? CERTIFIED_CONTRACT.maxImageBase64Bytes
    : options.maxImageBase64Bytes;
  let overCeiling = 0;
  let largest = 0;
  for (const image of images) {
    const encoded = base64Length(image.byteLength);
    if (encoded > cap) overCeiling += 1;
    if (encoded > largest) largest = encoded;
  }
  return {
    mode: resolveMode(options.mode),
    productionEquivalent: isProductionEquivalent(resolveMode(options.mode)),
    imageCount: images.length,
    imagesOverCertifiedCeiling: overCeiling,
    imagesWithinCertifiedCeiling: images.length - overCeiling,
    largestBase64Length: largest,
    certifiedCeiling: cap,
  };
}

/**
 * Re-derive the constants from a certified worktree so a transcription error or
 * upstream drift is caught rather than trusted.
 *
 * @param {string} certRoot certified v140 worktree root
 */
function verifyAgainstCertifiedSource(certRoot) {
  const mismatches = [];
  const read = (relative) => {
    const target = path.join(certRoot, relative);
    if (!fs.existsSync(target)) {
      mismatches.push({ file: relative, message: 'certified file not found' });
      return null;
    }
    return fs.readFileSync(target, 'utf8');
  };

  const edge = read('supabase/functions/scan-identify/index.ts');
  if (edge) {
    const capMatch = edge.match(/const\s+MAX_IMAGE_BASE64_BYTES\s*=\s*([^;]+);/);
    if (!capMatch) {
      mismatches.push({ file: 'index.ts', message: 'MAX_IMAGE_BASE64_BYTES not found' });
    } else {
      // eslint-disable-next-line no-new-func -- a numeric literal expression from certified source
      const value = Function(`"use strict"; return (${capMatch[1]});`)();
      if (value !== CERTIFIED_CONTRACT.maxImageBase64Bytes) {
        mismatches.push({
          file: 'index.ts',
          symbol: 'MAX_IMAGE_BASE64_BYTES',
          expected: CERTIFIED_CONTRACT.maxImageBase64Bytes,
          observed: value,
        });
      }
    }
    const mimeMatch = edge.match(/const\s+DEFAULT_MIME\s*=\s*'([^']+)'/);
    if (!mimeMatch || mimeMatch[1] !== CERTIFIED_CONTRACT.defaultMime) {
      mismatches.push({
        file: 'index.ts',
        symbol: 'DEFAULT_MIME',
        expected: CERTIFIED_CONTRACT.defaultMime,
        observed: mimeMatch ? mimeMatch[1] : null,
      });
    }
  }

  const client = read('services/imageUtils.js');
  if (client) {
    const widthMatch = client.match(/SCANNER_IMAGE_MAX_WIDTH\s*=\s*(\d+)/);
    if (!widthMatch || Number(widthMatch[1]) !== CERTIFIED_CONTRACT.scannerImageMaxWidth) {
      mismatches.push({
        file: 'imageUtils.js',
        symbol: 'SCANNER_IMAGE_MAX_WIDTH',
        expected: CERTIFIED_CONTRACT.scannerImageMaxWidth,
        observed: widthMatch ? Number(widthMatch[1]) : null,
      });
    }
    const qualityMatch = client.match(/SCANNER_IMAGE_JPEG_QUALITY\s*=\s*([\d.]+)/);
    if (!qualityMatch || Number(qualityMatch[1]) !== CERTIFIED_CONTRACT.scannerImageJpegQuality) {
      mismatches.push({
        file: 'imageUtils.js',
        symbol: 'SCANNER_IMAGE_JPEG_QUALITY',
        expected: CERTIFIED_CONTRACT.scannerImageJpegQuality,
        observed: qualityMatch ? Number(qualityMatch[1]) : null,
      });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

module.exports = {
  CERTIFIED_CONTRACT,
  MODE_ABSENT,
  MODE_GOVERNED_ORIGINAL,
  MODE_CERTIFIED_CLIENT_EQUIVALENT,
  MODES,
  base64Length,
  isProductionEquivalent,
  resolveMode,
  evaluateImage,
  summarize,
  verifyAgainstCertifiedSource,
};
