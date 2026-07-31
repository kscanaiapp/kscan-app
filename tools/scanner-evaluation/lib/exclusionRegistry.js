'use strict';

/**
 * Evaluation exclusion registry enforcement (Phase 0H section 8).
 *
 * WHY THIS EXISTS: until now the exclusion of the eight pending-provenance QA
 * fixtures lived as prose inside an inventory document. Prose does not stop a
 * file being added to a manifest. This does.
 *
 * Enforcement is threefold, because any one axis alone is evadable:
 *
 *   1. normalized repository path  — catches the obvious case, and catches
 *      Windows/POSIX separator and ./ prefix variations;
 *   2. SHA-256 content hash       — catches the same bytes referenced from a
 *      different path, or renamed;
 *   3. derivative-source relation — catches a case that declares one of the
 *      excluded images as its source, i.e. a crop, blur, recompression or
 *      lighting transform. Those are transformation derivatives of excluded
 *      material and inherit the exclusion.
 *
 * The exclusion is recorded as `excluded_pending_provenance`. It is NOT
 * permanent, and it asserts nothing about age, ownership, consent or legality.
 * Reintroduction requires documented provenance, an explicit owner decision, and
 * a new registry version.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REGISTRY_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'evals',
  'scanner-accuracy',
  'exclusion-registry.v1.json'
);

function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

const REGISTRY = loadRegistry();

/** Strip separators and a leading ./ so path spoofing does not evade the check. */
function normalizePath(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim()
    .toLowerCase();
}

/** Accepts bare hex or a `sha256:`-prefixed digest. */
function normalizeHash(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/^sha256:/, '');
}

const EXCLUDED_PATHS = new Set(REGISTRY.entries.map((e) => normalizePath(e.excludedPath)));
const EXCLUDED_SHA256 = new Set(REGISTRY.entries.map((e) => normalizeHash(e.sha256)));
const EXCLUDED_MD5 = new Set(REGISTRY.entries.map((e) => normalizeHash(e.md5)));

/**
 * Is this reference excluded, and on which axis?
 *
 * @param {{ path?: string, sha256?: string, md5?: string, derivedFromPath?: string,
 *           derivedFromSha256?: string }} ref
 * @returns {{ excluded: boolean, axis: string|null, reasonCode: string|null, detail: string|null }}
 */
function checkReference(ref = {}) {
  const clean = (axis, detail) => ({
    excluded: true,
    axis,
    reasonCode: 'excluded_pending_provenance',
    detail,
  });

  const p = normalizePath(ref.path);
  if (p && EXCLUDED_PATHS.has(p)) return clean('normalized_repository_path', p);

  const sha = normalizeHash(ref.sha256);
  if (sha && EXCLUDED_SHA256.has(sha)) {
    return clean('sha256_content_hash', `${sha.slice(0, 16)}… matches an excluded image`);
  }

  const md5 = normalizeHash(ref.md5);
  if (md5 && EXCLUDED_MD5.has(md5)) {
    return clean('md5_content_hash', `${md5.slice(0, 16)}… matches an excluded image`);
  }

  // Derivative relationship: a crop or transform of excluded material inherits
  // the exclusion. Checked on both path and hash of the declared source.
  const dp = normalizePath(ref.derivedFromPath);
  if (dp && EXCLUDED_PATHS.has(dp)) {
    return clean('derivative_source_relationship', `declared source ${dp} is excluded`);
  }
  const dsha = normalizeHash(ref.derivedFromSha256);
  if (dsha && EXCLUDED_SHA256.has(dsha)) {
    return clean('derivative_source_relationship', 'declared source hash is excluded');
  }

  return { excluded: false, axis: null, reasonCode: null, detail: null };
}

/** Hash a file on disk, so a manifest cannot claim a hash it does not have. */
function sha256OfFile(absolutePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

/**
 * Scan a governed case record for any excluded reference.
 *
 * Checks every image reference, its recorded hash, and any declared derivative
 * source. Returns one finding per violation.
 */
function findExclusionViolations(caseRecord) {
  const violations = [];
  const refs = Array.isArray(caseRecord && caseRecord.imageReferences)
    ? caseRecord.imageReferences
    : [];
  const hashes = Array.isArray(caseRecord && caseRecord.imageHashes) ? caseRecord.imageHashes : [];

  refs.forEach((ref, index) => {
    const result = checkReference({
      path: ref && ref.refValue,
      sha256: hashes[index],
      derivedFromPath: ref && ref.derivedFromPath,
      derivedFromSha256: ref && ref.derivedFromSha256,
    });
    if (result.excluded) {
      violations.push({
        path: `imageReferences[${index}]`,
        axis: result.axis,
        reasonCode: result.reasonCode,
        message: `excluded from evaluation use (${result.axis}): ${result.detail}`,
      });
    }
  });

  // A case may also declare a derivative source at the case level.
  const caseLevel = checkReference({
    derivedFromPath: caseRecord && caseRecord.derivedFromPath,
    derivedFromSha256: caseRecord && caseRecord.derivedFromSha256,
  });
  if (caseLevel.excluded) {
    violations.push({
      path: 'derivedFromPath',
      axis: caseLevel.axis,
      reasonCode: caseLevel.reasonCode,
      message: `excluded from evaluation use (${caseLevel.axis}): ${caseLevel.detail}`,
    });
  }

  return violations;
}

/**
 * Scan any list-shaped artifact — dataset manifest, baseline manifest,
 * candidate list, derived-image source record, holdout list — for excluded
 * references.
 *
 * @param {object|Array} artifact
 * @param {string} label what the artifact is, for the finding message
 */
function scanArtifact(artifact, label = 'artifact') {
  const findings = [];

  const walk = (node, trail) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${trail}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      const direct = checkReference({
        path: node.refValue || node.path || node.governedRef || node.storageRef,
        sha256: node.sha256 || node.hash,
        md5: node.md5,
        derivedFromPath: node.derivedFromPath,
        derivedFromSha256: node.derivedFromSha256,
      });
      if (direct.excluded) {
        findings.push({
          artifact: label,
          path: trail,
          axis: direct.axis,
          reasonCode: direct.reasonCode,
          message: `${label} references excluded material (${direct.axis}): ${direct.detail}`,
        });
      }
      for (const [key, value] of Object.entries(node)) walk(value, `${trail}.${key}`);
      return;
    }
    if (typeof node === 'string') {
      const result = checkReference({ path: node, sha256: node });
      if (result.excluded) {
        findings.push({
          artifact: label,
          path: trail,
          axis: result.axis,
          reasonCode: result.reasonCode,
          message: `${label} references excluded material (${result.axis}): ${result.detail}`,
        });
      }
    }
  };

  walk(artifact, label);
  return findings;
}

module.exports = {
  REGISTRY_PATH,
  REGISTRY,
  loadRegistry,
  normalizePath,
  normalizeHash,
  EXCLUDED_PATHS,
  EXCLUDED_SHA256,
  checkReference,
  sha256OfFile,
  findExclusionViolations,
  scanArtifact,
};
