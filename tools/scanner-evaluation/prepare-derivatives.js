#!/usr/bin/env node
'use strict';

/**
 * Produce governed capture-preparation derivatives (Phase 1 finding F-1).
 *
 * WHY THIS IS ITS OWN STEP
 * Preparation writes image bytes and costs real CPU. Making it an explicit,
 * auditable command rather than a side effect of run planning means:
 *   - the bytes that will be sent to the provider exist and are hashed BEFORE any
 *     spend decision is taken;
 *   - the baseline runner stays synchronous and can fail closed on a missing
 *     preparation manifest instead of silently preparing on the fly;
 *   - the transform parameters are recorded once, in one artifact, and every run
 *     that consumes them references the same hash.
 *
 * The frozen dataset is read-only here. Originals are never rewritten and no
 * dataset version is created: preparation belongs to the execution pipeline.
 *
 * Usage
 *   node tools/scanner-evaluation/prepare-derivatives.js \
 *     --manifest evals/scanner-accuracy/tier-a-manifest.v0.3.0.json \
 *     --derivative-root <dir outside every Git worktree> \
 *     [--policy certified_client_width_896] [--split development|holdout] [--force]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const imagePreparation = require('./lib/imagePreparation');
const { resolveImageRef } = require('./lib/governedStorage');
const { verifyFrozenDataset } = require('./lib/frozenDataset');
const runIdentity = require('./lib/runIdentity');

const ROOT = path.resolve(__dirname, '..', '..');
const PREPARATION_MANIFEST = 'preparation-manifest.json';

function parseArgs(argv) {
  const args = {
    manifest: null,
    derivativeRoot: null,
    policy: null,
    split: null,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--manifest': args.manifest = next(); break;
      case '--derivative-root': args.derivativeRoot = next(); break;
      case '--policy': args.policy = imagePreparation.resolvePolicy(next()); break;
      case '--split': {
        const value = next();
        if (!runIdentity.SPLITS.includes(value)) {
          throw new Error(`--split must be one of ${runIdentity.SPLITS.join(', ')}, received ${value}`);
        }
        args.split = value;
        break;
      }
      case '--force': args.force = true; break;
      case '--help': args.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.help) {
    if (!args.manifest) throw new Error('--manifest is required');
    if (!args.derivativeRoot) throw new Error('--derivative-root is required');
  }
  return args;
}

/**
 * Canonical hash of a preparation manifest's substance.
 *
 * Only the fields that determine what bytes reach the provider are hashed, so a
 * regenerated manifest with a new timestamp still matches, while a changed policy,
 * codec, source or derivative does not.
 */
function preparationManifestHash(record) {
  const canonical = {
    datasetVersion: record.datasetVersion,
    datasetAggregateSha256: record.datasetAggregateSha256,
    policy: record.policy,
    codec: record.codec,
    certifiedContract: record.certifiedContract,
    images: record.images
      .slice()
      .sort((a, b) => (a.sourceSha256 < b.sourceSha256 ? -1 : a.sourceSha256 > b.sourceSha256 ? 1 : 0))
      .map((image) => ({
        caseId: image.caseId,
        refValue: image.refValue,
        sourceSha256: image.sourceSha256,
        derivativeSha256: image.derivativeSha256,
        derivativeWidth: image.derivativeWidth,
        derivativeHeight: image.derivativeHeight,
        derivativeBase64Length: image.derivativeBase64Length,
      })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('see file header for usage');
    return { ok: true, help: true };
  }

  const manifestPath = path.resolve(ROOT, args.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // The frozen corpus is verified before a single derivative is written, so a
  // derivative can never be produced from drifted source bytes.
  const datasetVersion = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/dataset-version.json'), 'utf8')
  );
  let frozen = null;
  if (datasetVersion.activeFreeze) {
    frozen = verifyFrozenDataset(manifestPath, path.join(ROOT, datasetVersion.activeFreeze.freezeRecord));
    if (!frozen.ok) {
      console.error(JSON.stringify({ ok: false, stage: 'frozen_dataset', errors: frozen.errors }, null, 2));
      process.exitCode = 1;
      return { ok: false, stage: 'frozen_dataset', errors: frozen.errors };
    }
  }

  const derivativeRoot = path.resolve(args.derivativeRoot);
  imagePreparation.assertOutsideGit(derivativeRoot);
  fs.mkdirSync(derivativeRoot, { recursive: true });

  const partition = runIdentity.partitionBySplit(manifest.cases, manifest.split);
  const cases = args.split === runIdentity.SPLIT_HOLDOUT
    ? partition.holdout
    : args.split === runIdentity.SPLIT_DEVELOPMENT
      ? partition.development
      : manifest.cases;

  const images = [];
  for (const caseRecord of cases) {
    const prepared = await imagePreparation.prepareCase(caseRecord, {
      resolveRef: (refValue) => resolveImageRef(refValue),
      derivativeRoot,
      policy: args.policy,
      force: args.force,
    });
    for (const [index, record] of prepared.preparations.entries()) {
      images.push({
        caseId: caseRecord.caseId,
        refValue: caseRecord.imageReferences[index].refValue,
        ...record,
      });
    }
  }

  const summary = imagePreparation.summarizePreparations(images);
  const record = {
    preparationManifestVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    datasetVersion: manifest.datasetVersion,
    datasetAggregateSha256: frozen ? frozen.aggregateSha256 : null,
    split: args.split,
    policy: imagePreparation.resolvePolicy(args.policy),
    codec: imagePreparation.codecVersions(),
    certifiedContract: {
      scannerImageMaxWidth: imagePreparation.TARGET_EDGE_PX,
      jpegQuality: imagePreparation.JPEG_QUALITY,
      maxImageBase64Bytes: summary.certifiedCeiling,
    },
    derivativeRoot,
    derivativesInGit: 0,
    summary,
    images,
    fidelityLimitations: [
      'libvips is not expo-image-manipulator. Pixel dimensions, chroma subsampling and quality band match the certified client; entropy-coded bytes do not. No byte-level parity is asserted.',
      'Byte determinism holds for a fixed codec version and is not guaranteed across libvips upgrades. The codec versions are recorded above.',
      'The certified client pins WIDTH to 896 and lets height scale, so a portrait frame exceeds 896 on its long edge in production. Policy certified_client_width_896 reproduces that; max_dimension_896 does not and is not the default.',
    ],
  };
  record.preparationManifestSha256 = preparationManifestHash(record);

  const manifestTarget = path.join(derivativeRoot, PREPARATION_MANIFEST);
  fs.writeFileSync(manifestTarget, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const result = {
    ok: summary.allWithinCertifiedCeiling,
    preparationManifest: manifestTarget,
    preparationManifestSha256: record.preparationManifestSha256,
    policy: record.policy,
    codec: record.codec,
    imageCount: summary.imageCount,
    imagesOverCertifiedCeiling: summary.imagesOverCertifiedCeiling,
    largestDerivativeBase64Length: summary.largestDerivativeBase64Length,
    meanDerivativeBase64Length: summary.meanDerivativeBase64Length,
    upscaledCount: summary.upscaledCount,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, preparationManifestHash, PREPARATION_MANIFEST };
