'use strict';

/**
 * Governed runtime capture-preparation stage (Phase 1 finding F-1, owner-authorized).
 *
 * WHAT THIS IS
 * The execution pipeline's mirror of the production client's upload preparation.
 * The frozen corpus is the SOURCE corpus; preparation belongs here, not in the
 * dataset. Frozen v0.3.0 originals are opened read-only, never rewritten, and the
 * dataset is not versioned merely because a derivative was produced.
 *
 * WHAT PRODUCTION DOES (certified v140)
 *   services/imageUtils.js: ImageManipulator.manipulateAsync(uri,
 *     [{ resize: { width: 896 } }],
 *     { compress: 0.65, format: JPEG, base64: true })
 *   scan-identify/index.ts: rejects base64 payloads over 2 MB before calling the
 *     provider.
 *
 * FIDELITY LIMITS, STATED RATHER THAN CLAIMED AWAY
 *   - libvips is not expo-image-manipulator. Both produce a baseline JPEG at the
 *     requested quality, but the entropy-coded bytes will differ. This stage
 *     reproduces production's INPUT CHARACTERISTICS (pixel dimensions, chroma
 *     subsampling, quality band), not its exact bytes. No byte-level parity is
 *     asserted anywhere.
 *   - Byte determinism holds for a fixed codec version. It is NOT guaranteed
 *     across libvips upgrades, so the codec versions are recorded in every
 *     preparation record and a run is only self-consistent, never eternally
 *     reproducible, without them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { CERTIFIED_CONTRACT, base64Length } = require('./capturePreparation');

let sharp = null;
/**
 * Loaded lazily so the rest of the harness — validation, freeze verification,
 * dry planning — keeps working on a machine without the native codec installed,
 * and so the absence produces a clear message instead of a module-load crash.
 */
function requireSharp() {
  if (sharp) return sharp;
  try {
    // eslint-disable-next-line global-require -- deliberate lazy native load
    sharp = require('sharp');
  } catch (error) {
    throw new Error(
      'the capture-preparation stage requires the `sharp` image codec (devDependency). '
        + `Install it before preparing derivatives. Underlying error: ${error.message}`
    );
  }
  return sharp;
}

/**
 * Exact mirror of the certified client: width pinned to 896, height proportional.
 * A narrower source is UPSCALED, because `resize: { width: 896 }` upscales and the
 * point of this stage is to send what production sends.
 */
const POLICY_CERTIFIED_CLIENT_WIDTH = 'certified_client_width_896';
/**
 * Longest edge capped at 896. Differs from production for any non-landscape
 * source: a 3:4 portrait becomes 672x896 here and 896x1195 in production.
 */
const POLICY_MAX_DIMENSION = 'max_dimension_896';

const POLICIES = Object.freeze([POLICY_CERTIFIED_CLIENT_WIDTH, POLICY_MAX_DIMENSION]);
const DEFAULT_POLICY = POLICY_CERTIFIED_CLIENT_WIDTH;

/** JPEG quality 0.65 on the client's 0-1 scale is 65 on the encoder's 0-100 scale. */
const JPEG_QUALITY = Math.round(CERTIFIED_CONTRACT.scannerImageJpegQuality * 100);
const TARGET_EDGE_PX = CERTIFIED_CONTRACT.scannerImageMaxWidth;

function sha256OfBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function resolvePolicy(declared) {
  if (declared == null || declared === '') return DEFAULT_POLICY;
  if (!POLICIES.includes(declared)) {
    throw new Error(`unknown preparation policy "${declared}"; expected one of ${POLICIES.join(', ')}`);
  }
  return declared;
}

/**
 * Refuse a derivative root that lives inside a Git worktree.
 *
 * Prepared derivatives are image bytes. The whole governed-storage design exists
 * so image bytes never enter Git, and a derivative root under a worktree would
 * quietly undo that — including via a parent directory several levels up.
 */
function assertOutsideGit(derivativeRoot) {
  let current = path.resolve(derivativeRoot);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      throw new Error(
        `derivative root ${derivativeRoot} is inside the Git worktree at ${current}. `
          + 'Prepared image bytes must be stored outside every Git worktree.'
      );
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return true;
}

/** Codec identity, recorded so a later run can tell whether bytes are comparable. */
function codecVersions() {
  const s = requireSharp();
  return { sharp: s.versions.sharp, libvips: s.versions.vips };
}

/**
 * Prepare one source image into one derivative.
 *
 * @param {{ sourcePath: string, expectedSourceSha256?: string, viewId: string,
 *           derivativeRoot: string, policy?: string, force?: boolean }} options
 * @returns {Promise<object>} the preparation record
 */
async function prepareImage(options) {
  const s = requireSharp();
  const policy = resolvePolicy(options.policy);
  const { sourcePath, derivativeRoot, viewId } = options;

  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`source image not found: ${sourcePath}`);
  }
  if (!derivativeRoot) throw new Error('a derivative root is required');
  if (!viewId) throw new Error('a viewId is required to name the derivative deterministically');
  assertOutsideGit(derivativeRoot);

  // Read-only. The frozen original is never written, moved or re-encoded in place.
  const sourceBytes = fs.readFileSync(sourcePath);
  const sourceSha256 = sha256OfBuffer(sourceBytes);
  if (options.expectedSourceSha256) {
    const expected = String(options.expectedSourceSha256).replace(/^sha256:/, '');
    if (expected !== sourceSha256) {
      throw new Error(
        `source hash mismatch for ${sourcePath}: manifest ${expected}, file ${sourceSha256}. `
          + 'Preparation refuses to run against unverified source bytes.'
      );
    }
  }

  const sourceMeta = await s(sourceBytes).metadata();

  // Orientation is applied deterministically and then discarded: `rotate()` with
  // no argument bakes the EXIF orientation into the pixels, and the JPEG written
  // below carries no orientation tag. A viewer-dependent rotation can therefore
  // never change what the model receives.
  let pipeline = s(sourceBytes).rotate();

  if (policy === POLICY_CERTIFIED_CLIENT_WIDTH) {
    // No `withoutEnlargement`: production upscales a narrow source, so this does too.
    pipeline = pipeline.resize({ width: TARGET_EDGE_PX, fit: 'contain' });
  } else {
    pipeline = pipeline.resize({
      width: TARGET_EDGE_PX,
      height: TARGET_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: false,
    });
  }

  const derivativeBytes = await pipeline
    .jpeg({
      quality: JPEG_QUALITY,
      chromaSubsampling: '4:2:0',
      progressive: false,
      mozjpeg: false,
      // EXIF/ICC are not carried forward; the payload is pixels only.
      force: true,
    })
    .toBuffer();

  const derivativeMeta = await s(derivativeBytes).metadata();
  const derivativeSha256 = sha256OfBuffer(derivativeBytes);

  // Content-addressed by SOURCE hash, so two cases sharing an image share a
  // derivative and a re-run cannot collide with an unrelated view.
  const targetDir = path.join(derivativeRoot, sourceSha256.slice(0, 16));
  fs.mkdirSync(targetDir, { recursive: true });
  const derivativePath = path.join(targetDir, `${viewId}.jpg`);
  if (fs.existsSync(derivativePath) && !options.force) {
    const existing = fs.readFileSync(derivativePath);
    if (sha256OfBuffer(existing) !== derivativeSha256) {
      throw new Error(
        `existing derivative at ${derivativePath} differs from the freshly prepared bytes. `
          + 'This means the codec or policy changed; pass force to overwrite deliberately.'
      );
    }
  } else {
    fs.writeFileSync(derivativePath, derivativeBytes);
  }

  const encodedLength = base64Length(derivativeBytes.length);

  return {
    viewId,
    policy,
    sourcePath,
    sourceSha256,
    sourceByteLength: sourceBytes.length,
    sourceWidth: sourceMeta.width,
    sourceHeight: sourceMeta.height,
    sourceOrientation: sourceMeta.orientation == null ? null : sourceMeta.orientation,
    derivativePath,
    derivativeSha256,
    derivativeByteLength: derivativeBytes.length,
    derivativeWidth: derivativeMeta.width,
    derivativeHeight: derivativeMeta.height,
    derivativeBase64Length: encodedLength,
    withinCertifiedCeiling: encodedLength <= CERTIFIED_CONTRACT.maxImageBase64Bytes,
    certifiedCeiling: CERTIFIED_CONTRACT.maxImageBase64Bytes,
    upscaled: sourceMeta.width < TARGET_EDGE_PX,
    transform: {
      orientationApplied: 'exif_baked_then_stripped',
      resize: policy === POLICY_CERTIFIED_CLIENT_WIDTH
        ? { width: TARGET_EDGE_PX, heightProportional: true, enlargementAllowed: true }
        : { longestEdge: TARGET_EDGE_PX, fit: 'inside', enlargementAllowed: true },
      format: 'jpeg',
      quality: JPEG_QUALITY,
      qualityClientScale: CERTIFIED_CONTRACT.scannerImageJpegQuality,
      chromaSubsampling: '4:2:0',
      progressive: false,
      metadataStripped: true,
    },
    codec: codecVersions(),
    certifiedSourceSha: CERTIFIED_CONTRACT.certifiedSourceSha,
  };
}

/**
 * Prepare every image of one case, in manifest order.
 *
 * @param {object} caseRecord
 * @param {{ resolveRef: (refValue: string) => string, derivativeRoot: string,
 *           policy?: string, force?: boolean }} options
 */
async function prepareCase(caseRecord, options) {
  const refs = Array.isArray(caseRecord.imageReferences) ? caseRecord.imageReferences : [];
  const hashes = Array.isArray(caseRecord.imageHashes) ? caseRecord.imageHashes : [];
  const records = [];
  for (const [index, ref] of refs.entries()) {
    // The view id comes from the governed ref's last segment, so it is stable
    // across runs rather than positional.
    const segments = ref.refValue.split('/').filter(Boolean);
    const viewId = segments[segments.length - 1] || `view-${index}`;
    records.push(await prepareImage({
      sourcePath: options.resolveRef(ref.refValue),
      expectedSourceSha256: hashes[index],
      viewId,
      derivativeRoot: options.derivativeRoot,
      policy: options.policy,
      force: options.force,
    }));
  }
  return {
    caseId: caseRecord.caseId,
    policy: resolvePolicy(options.policy),
    imageCount: records.length,
    preparations: records,
    allWithinCertifiedCeiling: records.every((r) => r.withinCertifiedCeiling),
  };
}

/** Roll up preparation records for the run artifacts. */
function summarizePreparations(records) {
  const over = records.filter((r) => !r.withinCertifiedCeiling);
  const lengths = records.map((r) => r.derivativeBase64Length);
  return {
    imageCount: records.length,
    allWithinCertifiedCeiling: over.length === 0,
    imagesOverCertifiedCeiling: over.length,
    oversizedViewIds: over.map((r) => r.viewId),
    largestDerivativeBase64Length: lengths.length ? Math.max(...lengths) : 0,
    smallestDerivativeBase64Length: lengths.length ? Math.min(...lengths) : 0,
    meanDerivativeBase64Length: lengths.length
      ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)
      : 0,
    upscaledCount: records.filter((r) => r.upscaled).length,
    certifiedCeiling: CERTIFIED_CONTRACT.maxImageBase64Bytes,
    policy: records.length ? records[0].policy : null,
    codec: records.length ? records[0].codec : null,
  };
}

module.exports = {
  POLICY_CERTIFIED_CLIENT_WIDTH,
  POLICY_MAX_DIMENSION,
  POLICIES,
  DEFAULT_POLICY,
  JPEG_QUALITY,
  TARGET_EDGE_PX,
  assertOutsideGit,
  codecVersions,
  resolvePolicy,
  prepareImage,
  prepareCase,
  summarizePreparations,
};
