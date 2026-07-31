'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { ROOT, resolveImageRef, sha256OfFile, sha256OfTextFile } = require('./governedStorage');

const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|webp|heic|gif|bmp|tiff?)$/i;

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function repoRelative(absolutePath) {
  return path.relative(ROOT, absolutePath).replace(/\\/g, '/');
}

function resolveRepoFile(relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error(`freeze file path must be repository-relative: ${relativePath}`);
  }
  const absolute = path.resolve(ROOT, relativePath);
  const relative = repoRelative(absolute);
  if (relative === '..' || relative.startsWith('../')) {
    throw new Error(`freeze file path escapes the repository: ${relativePath}`);
  }
  return absolute;
}

function verifyFrozenDataset(manifestPath, freezeRecordPath, options = {}) {
  const absoluteManifest = path.resolve(manifestPath);
  const absoluteFreeze = path.resolve(freezeRecordPath);
  const errors = [];
  let manifest;
  let freeze;

  try {
    manifest = JSON.parse(fs.readFileSync(absoluteManifest, 'utf8'));
    freeze = JSON.parse(fs.readFileSync(absoluteFreeze, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [{ check: 'record_read', message: error.message }] };
  }

  if (manifest.datasetVersion !== freeze.datasetVersion) {
    errors.push({
      check: 'dataset_version',
      message: `manifest ${manifest.datasetVersion} does not match freeze record ${freeze.datasetVersion}`,
    });
  }

  const expectedFiles = freeze.files && typeof freeze.files === 'object' ? freeze.files : {};
  const manifestRelative = repoRelative(absoluteManifest);
  if (!Object.prototype.hasOwnProperty.call(expectedFiles, manifestRelative)) {
    errors.push({
      check: 'canonical_manifest',
      message: `manifest ${manifestRelative} is not the manifest governed by this freeze record`,
    });
  }

  const actualFileHashes = {};
  for (const [relative, expected] of Object.entries(expectedFiles)) {
    let absolute;
    try {
      absolute = resolveRepoFile(relative);
    } catch (error) {
      errors.push({ check: 'freeze_path', file: relative, message: error.message });
      continue;
    }
    if (!fs.existsSync(absolute)) {
      errors.push({ check: 'frozen_file_present', file: relative, message: 'frozen input is missing' });
      continue;
    }
    // Governed freeze inputs are text (.json/.md). Hash them LF-normalised so the
    // digest reproduces from a fresh clone; a CRLF working copy would otherwise
    // verify here and fail everywhere else.
    const actual = sha256OfTextFile(absolute).slice('sha256:'.length);
    actualFileHashes[relative] = actual;
    if (actual !== expected) {
      errors.push({
        check: 'frozen_file_hash',
        file: relative,
        message: `expected ${expected}, found ${actual}`,
      });
    }
  }

  const aggregateInput = Object.keys(actualFileHashes)
    .sort()
    .map((relative) => `${relative}:${actualFileHashes[relative]}\n`)
    .join('');
  const aggregateSha256 = sha256Hex(Buffer.from(aggregateInput, 'utf8'));
  if (aggregateSha256 !== freeze.aggregateSha256) {
    errors.push({
      check: 'aggregate_hash',
      message: `expected ${freeze.aggregateSha256}, found ${aggregateSha256}`,
    });
  }

  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  const imageCount = cases.reduce(
    (count, caseRecord) => count + (Array.isArray(caseRecord.imageReferences) ? caseRecord.imageReferences.length : 0),
    0
  );
  const development = manifest.split && Array.isArray(manifest.split.development)
    ? manifest.split.development.length
    : 0;
  const holdout = manifest.split && Array.isArray(manifest.split.holdout)
    ? manifest.split.holdout.length
    : 0;
  for (const [field, actual] of Object.entries({
    caseCount: cases.length,
    imageCount,
    development,
    holdout,
  })) {
    if (freeze[field] !== actual) {
      errors.push({ check: field, message: `freeze record ${freeze[field]} does not match manifest ${actual}` });
    }
  }

  let imageHashVerified = 0;
  let storageConfigurationFailed = false;
  for (const caseRecord of cases) {
    const refs = Array.isArray(caseRecord.imageReferences) ? caseRecord.imageReferences : [];
    const hashes = Array.isArray(caseRecord.imageHashes) ? caseRecord.imageHashes : [];
    if (refs.length !== hashes.length) {
      errors.push({
        check: 'image_hash_count',
        caseId: caseRecord.caseId,
        message: `${refs.length} references do not match ${hashes.length} hashes`,
      });
      continue;
    }
    for (let index = 0; index < refs.length; index += 1) {
      let absolute;
      try {
        absolute = resolveImageRef(refs[index].refValue, options);
      } catch (error) {
        if (!storageConfigurationFailed) {
          errors.push({ check: 'storage_root', message: error.message });
          storageConfigurationFailed = true;
        }
        continue;
      }
      if (!fs.existsSync(absolute)) {
        errors.push({
          check: 'image_present',
          caseId: caseRecord.caseId,
          imageRef: refs[index].refValue,
          message: 'governed image is missing',
        });
        continue;
      }
      const actual = sha256OfFile(absolute);
      if (actual !== hashes[index]) {
        errors.push({
          check: 'image_hash',
          caseId: caseRecord.caseId,
          imageRef: refs[index].refValue,
          message: `expected ${hashes[index]}, found ${actual}`,
        });
        continue;
      }
      imageHashVerified += 1;
    }
  }

  let imagesInGit = null;
  try {
    imagesInGit = execFileSync('git', ['ls-files', 'evals/scanner-accuracy'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .filter((file) => IMAGE_EXTENSION_RE.test(file)).length;
    if (imagesInGit !== freeze.imagesInGit) {
      errors.push({
        check: 'images_in_git',
        message: `freeze record ${freeze.imagesInGit} does not match tracked image count ${imagesInGit}`,
      });
    }
  } catch (error) {
    errors.push({ check: 'images_in_git', message: error.message });
  }

  return {
    ok: errors.length === 0,
    datasetVersion: manifest.datasetVersion,
    frozenAs: freeze.frozenAs,
    notARealWorldSmartGlassesBenchmark: freeze.notARealWorldSmartGlassesBenchmark === true,
    notAComprehensiveBrandAccuracyCorpus: freeze.notAComprehensiveBrandAccuracyCorpus === true,
    positiveBrandSupport: freeze.positiveBrandSupport,
    manifest: manifestRelative,
    freezeRecord: repoRelative(absoluteFreeze),
    aggregateSha256,
    expectedAggregateSha256: freeze.aggregateSha256,
    caseCount: cases.length,
    imageCount,
    development,
    holdout,
    imageHashVerified,
    imagesInGit,
    errors,
  };
}

module.exports = { verifyFrozenDataset };
