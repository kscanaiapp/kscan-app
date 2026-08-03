'use strict';

const { loadPolicy, getFormatById, getFormatByMime } = require('./policy');
const { detectFormatId, readHeaderMetadata } = require('./signatures');
const { sha256Hex } = require('./hashing');
const reencode = require('./reencode');
const clamd = require('./clamdClient');
const { VERDICTS, userFacingMessage, sign } = require('./verdict');

function reject(verdictCode, internalReason, extra = {}) {
  return {
    ok: false,
    verdict: verdictCode,
    internalReason,
    userMessage: userFacingMessage(verdictCode),
    ...extra,
  };
}

// Runs steps 2-11 of the Secure Image Ingestion Gate (docs/security/secure-image-ingestion-architecture.md)
// against an already-buffered image. Steps 1 (auth/account-state), 12
// (server-controlled filename/object key), and 13 (persisting the verdict
// record) are the caller's responsibility, since they're context-specific
// (an in-memory /api/analyze call has no object key or DB row at all; a
// Storage-quarantine worker has both).
//
// options:
//   policy / policyPath  - override the loaded policy (mainly for tests)
//   declaredMimeType     - caller-asserted MIME (never trusted alone)
//   declaredExtension    - caller-asserted extension, lowercase incl leading dot
//   scanEnabled          - whether to invoke the malware scanner (default false;
//                          see docs/security/malware-scanner-operations.md for
//                          the rollout sequence -- when true, ANY scanner
//                          failure/timeout/unavailability fails CLOSED)
//   scannerOptions       - passed through to clamd.scanBuffer
//   verdictSecret        - HMAC secret for signing the returned verdict token
//   verdictTtlMs         - verdict token lifetime (default 15 minutes)
//   requestId            - opaque id threaded into the verdict record for correlation
async function runIngestionGate(buffer, options = {}) {
  const policy = options.policy || loadPolicy(options.policyPath);
  const requestId = options.requestId || null;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return reject(VERDICTS.REJECTED_MALFORMED, 'empty or non-buffer input');
  }

  // Step: request-size enforcement (buffer-level backstop; streaming callers
  // must additionally cap bytes-in-flight before full buffering -- see
  // security/uploads/image-ingestion-policy.json's requestLimits).
  const maxBytes = Math.max(...policy.allowedFormats.map((f) => f.maxCompressedBytes));
  if (buffer.length > maxBytes) {
    return reject(VERDICTS.REJECTED_SIZE, `buffer ${buffer.length} bytes exceeds policy maximum ${maxBytes}`);
  }

  // Step: allowed content-type precheck (declared value only -- cheap early
  // exit, never the source of truth).
  if (options.declaredMimeType) {
    const declaredFormat = getFormatByMime(policy, options.declaredMimeType);
    if (!declaredFormat) {
      return reject(VERDICTS.REJECTED_TYPE, `declared MIME "${options.declaredMimeType}" is not on the allowlist`);
    }
  }

  // Step: magic-byte / file-signature detection -- the actual source of
  // truth for "what type is this."
  const detectedFormatId = detectFormatId(buffer, policy);
  if (!detectedFormatId) {
    return reject(VERDICTS.REJECTED_TYPE, 'no allowed format signature matched');
  }
  const formatPolicy = getFormatById(policy, detectedFormatId);

  // Step: extension / detected-type consistency check.
  if (policy.extensionConsistencyRequired && options.declaredExtension) {
    const ext = String(options.declaredExtension).toLowerCase();
    if (!formatPolicy.expectedExtensions.includes(ext)) {
      return reject(VERDICTS.REJECTED_TYPE, `declared extension "${ext}" does not match detected format "${detectedFormatId}"`);
    }
  }
  if (options.declaredMimeType && !formatPolicy.allowedMimeTypes.includes(options.declaredMimeType)) {
    return reject(
      VERDICTS.REJECTED_TYPE,
      `declared MIME "${options.declaredMimeType}" does not match detected format "${detectedFormatId}"`
    );
  }

  if (buffer.length > formatPolicy.maxCompressedBytes) {
    return reject(
      VERDICTS.REJECTED_SIZE,
      `${buffer.length} bytes exceeds ${detectedFormatId} maximum ${formatPolicy.maxCompressedBytes}`
    );
  }

  // Step: cheap header-only dimension/frame precheck, before the (more
  // expensive, but authoritative) decode probe. Catches obvious bombs early
  // without invoking libvips at all.
  const headerMeta = readHeaderMetadata(buffer, detectedFormatId);
  if (headerMeta) {
    if (headerMeta.width > formatPolicy.maxWidthPx || headerMeta.height > formatPolicy.maxHeightPx) {
      return reject(VERDICTS.REJECTED_DIMENSIONS, 'header-declared dimensions exceed policy');
    }
    if (headerMeta.width * headerMeta.height > formatPolicy.maxTotalPixels) {
      return reject(VERDICTS.REJECTED_DIMENSIONS, 'header-declared total pixels exceed policy');
    }
    if (headerMeta.frames > formatPolicy.maxAnimationFrames) {
      return reject(VERDICTS.REJECTED_DIMENSIONS, 'animated content exceeds policy (frames > 1 not allowed)');
    }
  }

  const sha256Original = sha256Hex(buffer);

  // Step: malware scan (pluggable, fail-closed whenever enabled).
  if (options.scanEnabled) {
    const scanResult = await clamd.scanBuffer(buffer, options.scannerOptions);
    if (scanResult.verdict !== VERDICTS.CLEAN) {
      // scanResult.reason/signatureName are never forwarded into userMessage.
      return reject(scanResult.verdict, `scanner verdict ${scanResult.verdict}: ${scanResult.reason}`);
    }
  }

  // Step: safe decoder probe + decode/re-encode into the canonical safe format.
  const reencodeResult = await reencode.decodeAndReencode(buffer, formatPolicy);
  if (!reencodeResult.ok) {
    return reject(reencodeResult.verdict || VERDICTS.REENCODE_FAILED, reencodeResult.reason);
  }

  // Step: revalidate the generated output. Re-running signature detection
  // against our OWN re-encoded bytes is a sanity check that the re-encode
  // actually produced a clean, policy-conforming file of the expected type
  // -- defense against a re-encoder bug or misconfiguration silently
  // passing unsafe content through.
  const outputFormatId = detectFormatId(reencodeResult.canonicalBuffer, policy);
  if (outputFormatId !== formatPolicy.outputReencodeFormat) {
    return reject(VERDICTS.REENCODE_FAILED, 'canonical output failed signature self-check');
  }
  if (reencodeResult.canonicalHasExif || reencodeResult.canonicalHasIcc) {
    return reject(VERDICTS.REENCODE_FAILED, 'canonical output unexpectedly retained metadata');
  }

  const sha256Canonical = sha256Hex(reencodeResult.canonicalBuffer);

  const verdictRecord = {
    verdict: VERDICTS.CLEAN,
    detectedFormat: detectedFormatId,
    width: reencodeResult.width,
    height: reencodeResult.height,
    sha256Original,
    sha256Canonical,
    compressedBytes: reencodeResult.canonicalBuffer.length,
    scannerEngine: options.scanEnabled ? 'clamav' : 'not_run',
    scannedAt: options.scanEnabled ? Date.now() : null,
    requestId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (options.verdictTtlMs || 15 * 60 * 1000),
  };

  const signedVerdict = options.verdictSecret ? sign(verdictRecord, options.verdictSecret) : null;

  return {
    ok: true,
    verdict: VERDICTS.CLEAN,
    canonicalBuffer: reencodeResult.canonicalBuffer,
    canonicalMimeType: getFormatById(policy, formatPolicy.outputReencodeFormat).allowedMimeTypes[0],
    detectedFormat: detectedFormatId,
    width: reencodeResult.width,
    height: reencodeResult.height,
    sha256Original,
    sha256Canonical,
    verdictRecord,
    signedVerdict,
  };
}

module.exports = { runIngestionGate, VERDICTS };
