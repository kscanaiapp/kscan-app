#!/usr/bin/env node
'use strict';

/**
 * Certified v140 proof CLI (Phase 0C Lane C).
 *
 *   node tools/scanner-evaluation/verify-certified-v140.js
 *   node tools/scanner-evaluation/verify-certified-v140.js --ref HEAD
 *
 * With no --ref it verifies the certified pin itself. With --ref it reports
 * whether that ref is the certified closure, which is how the research branch
 * is proven NOT to be.
 *
 * Makes zero network calls and zero model calls.
 */

const certified = require('./lib/certifiedSource');

function main(argv = process.argv.slice(2)) {
  const refIndex = argv.indexOf('--ref');
  const ref = refIndex >= 0 ? argv[refIndex + 1] : null;
  const record = certified.loadRecord();

  const closure = certified.verifyClosure(ref);
  const boundaries = certified.verifyCertifiedBoundaries(null);
  const comparison = ref ? certified.compareToCertified(ref) : null;

  const report = {
    ok: closure.ok && boundaries.ok,
    certifiedPin: {
      deployedVersion: record.deployedVersion,
      iosBranch: record.certifiedBranches.ios.branch,
      iosSha: record.certifiedBranches.ios.sha,
      androidBranch: record.certifiedBranches.android.branch,
      androidSha: record.certifiedBranches.android.sha,
      scanIdentifyTreeHash: record.scanIdentifyTreeHash,
      bundleHash: record.bundleHash,
      bundleFileCount: record.bundleFileCount,
      treeFileCount: record.treeFileCount,
    },
    closureVerification: {
      ref: closure.ref,
      ok: closure.ok,
      bundleHash: closure.bundleHash,
      expectedBundleHash: closure.expectedBundleHash,
      bundleHashMatches: closure.bundleHash === closure.expectedBundleHash,
      fileCount: closure.fileCount,
      mismatchCount: closure.mismatches.length,
      missingCount: closure.missing.length,
      mismatches: closure.mismatches.slice(0, 10),
    },
    boundaryVerification: boundaries,
    ...(comparison ? { comparison } : {}),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) main();

module.exports = { main };
