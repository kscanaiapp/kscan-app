'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function sha256OfFile(absolutePath) {
  const bytes = fs.readFileSync(absolutePath);
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Hash a governed TEXT artifact over LF-normalised bytes.
 *
 * Repository policy is `eol=lf`, but a Windows working copy can hold CRLF while
 * Git stores LF. Hashing the working-copy bytes produces a digest that verifies
 * on the authoring workstation and fails from a fresh clone or in CI, which
 * silently breaks the reproducibility the freeze record and holdout seal claim.
 * Normalising CRLF to LF makes the digest identical to the committed blob.
 *
 * Binary artifacts (images) must keep `sha256OfFile` — normalising their bytes
 * would corrupt the hash.
 */
function sha256OfTextFile(absolutePath) {
  const normalised = fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n');
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex')}`;
}

/**
 * Reconstruct a governed text artifact's SEALED byte representation.
 *
 * WHY THIS EXISTS (Build 4 Phase 2B repair)
 *
 * A review artifact can seal TWO digests over the same content: a portable one
 * (`sha256OfTextFile`, LF-normalised) and an "as-reviewed" one, which is the
 * literal byte stream the reviewer actually read at lock time — on this
 * project, always a Windows CRLF working copy. The as-reviewed digest is a
 * chain-of-custody record, not a portability digest, so it must never be
 * compared against whatever bytes the CURRENT checkout happens to hold: an LF
 * checkout (a fresh clone, CI, a different worktree) would fail a comparison
 * against a CRLF-sealed digest even though the content is byte-for-byte the
 * same after normalisation.
 *
 * The fix is not to normalise both sides to one encoding and compare — that
 * would just move the problem, since the as-reviewed digest is specifically
 * over CRLF bytes and an LF-normalised comparison could never reproduce it.
 * Instead this function DETERMINISTICALLY RECONSTRUCTS the sealed
 * representation from whatever line endings the current checkout holds:
 * normalise to LF first (so CRLF, LF and mixed input all converge on one
 * canonical form), then re-expand to the sealed encoding. Reconstruction is
 * order-independent of the input encoding, so it produces the identical byte
 * stream — and therefore the identical hash — whether it runs against an LF
 * checkout, a CRLF checkout, or a file with mixed line endings.
 *
 * A genuine content change (a character, a word, a reordered line) survives
 * both the normalisation and the re-expansion, because neither step touches
 * anything but line-ending bytes: the reconstructed hash still changes, and
 * verification still fails, exactly as before.
 *
 * @param {string} absolutePath
 * @param {{ eol?: 'crlf' | 'lf' }} [options] the sealed encoding to reconstruct.
 *   Defaults to 'crlf', because every as-reviewed digest recorded so far was
 *   sealed from a Windows authoring workstation.
 */
function reconstructSealedTextBytes(absolutePath, { eol = 'crlf' } = {}) {
  const lfNormalised = fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n');
  const reconstructed = eol === 'crlf' ? lfNormalised.replace(/\n/g, '\r\n') : lfNormalised;
  return Buffer.from(reconstructed, 'utf8');
}

/** Hash of `reconstructSealedTextBytes` — checkout-portable by construction. */
function sha256OfSealedTextFile(absolutePath, options) {
  return `sha256:${crypto.createHash('sha256').update(reconstructSealedTextBytes(absolutePath, options)).digest('hex')}`;
}

/**
 * STORAGE CONTRACT
 *
 * `KSCAN_EVAL_STORAGE_ROOT` is the storage root that CONTAINS the two governed
 * child directories. It is never one of them:
 *
 *   <storage root>/tier-a              read-only governed source corpus
 *   <storage root>/results/<run-id>    private run output
 *
 * The two children have SEPARATE containment checks. Proving only that both sit
 * under a common parent would permit a run to write results into the source
 * corpus, so each root is asserted independently.
 *
 * This bug was real: `acquire-licensed-images.js` has always written to
 * `<root>/tier-a/...`, while the resolver read from `<root>/...`. The reader had
 * drifted away from the writer, so pointing the variable at the documented root
 * resolved 0 of 56 governed images. Rather than tolerate both spellings, a root
 * that already ends in `tier-a` is now rejected with an actionable message —
 * silently accepting either is how the ambiguity survived.
 */
const GOVERNED_IMAGE_DIR = 'tier-a';
const PRIVATE_RESULTS_DIR = 'results';

function requireStorageRoot(storageRoot = process.env.KSCAN_EVAL_STORAGE_ROOT) {
  if (!storageRoot || !String(storageRoot).trim()) {
    throw new Error(
      'KSCAN_EVAL_STORAGE_ROOT is not set: refusing to guess the governed storage root'
    );
  }
  const resolved = path.resolve(String(storageRoot).trim());
  if (path.basename(resolved).toLowerCase() === GOVERNED_IMAGE_DIR) {
    throw new Error(
      `KSCAN_EVAL_STORAGE_ROOT must be the storage root that CONTAINS ${GOVERNED_IMAGE_DIR}/ and ` +
        `${PRIVATE_RESULTS_DIR}/, not the ${GOVERNED_IMAGE_DIR} directory itself. ` +
        `Use ${path.dirname(resolved)}`
    );
  }
  return resolved;
}

/** Read-only governed source corpus. Results must never be written here. */
function governedImageRoot(storageRoot) {
  return path.join(requireStorageRoot(storageRoot), GOVERNED_IMAGE_DIR);
}

/** Private run output. Source images must never be copied here. */
function privateResultsRoot(runId, storageRoot) {
  const base = path.join(requireStorageRoot(storageRoot), PRIVATE_RESULTS_DIR);
  if (runId == null || String(runId).trim() === '') return base;
  const id = String(runId).trim();
  if (/[\\/]|\.\./.test(id)) throw new Error(`run id may not contain a path separator or traversal: ${id}`);
  return path.join(base, id);
}

/** Containment that resolves symlinks/junctions where the path already exists. */
function assertContained(candidate, root, label) {
  const realish = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const resolvedRoot = realish(root);
  const resolvedCandidate = realish(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`${label} escapes its governed root`);
  }
  return resolvedCandidate;
}

function resolveImageRef(refValue, { storageRoot = process.env.KSCAN_EVAL_STORAGE_ROOT } = {}) {
  if (!/^[a-z0-9+.-]+:\/\//i.test(refValue)) {
    return path.join(ROOT, refValue);
  }
  const imageRoot = governedImageRoot(storageRoot);

  const withoutScheme = refValue.replace(/^[a-z0-9+.-]+:\/\//i, '');
  const parts = withoutScheme.split('/').filter(Boolean);
  const tierIdx = parts.findIndex((part) => part === GOVERNED_IMAGE_DIR);
  const tail = tierIdx >= 0 ? parts.slice(tierIdx + 1) : parts.slice(1);
  if (tail.some((segment) => segment === '..')) {
    throw new Error(`governed storage ref contains traversal: ${refValue}`);
  }

  const candidate = path.join(imageRoot, ...tail);
  // Containment is asserted against the IMAGE root specifically, so a ref can
  // never reach the results tree or anything outside the corpus.
  assertContained(candidate, imageRoot, 'governed image ref');

  if (fs.existsSync(candidate)) return candidate;
  for (const ext of ['.jpg', '.jpeg', '.png']) {
    if (fs.existsSync(candidate + ext)) return candidate + ext;
  }
  return candidate;
}

module.exports = {
  ROOT,
  GOVERNED_IMAGE_DIR,
  PRIVATE_RESULTS_DIR,
  requireStorageRoot,
  governedImageRoot,
  privateResultsRoot,
  assertContained,
  resolveImageRef,
  sha256OfFile,
  sha256OfTextFile,
  reconstructSealedTextBytes,
  sha256OfSealedTextFile,
};
