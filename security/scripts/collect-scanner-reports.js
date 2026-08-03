#!/usr/bin/env node
'use strict';

/**
 * Collects scanner JSON reports from downloaded GitHub Actions artifacts.
 * Maps workflow artifact uploads to the filenames expected by normalize-security-findings.js.
 *
 * Usage:
 *   node security/scripts/collect-scanner-reports.js <downloadRoot> <outputDir>
 *
 * Env (optional):
 *   GITHUB_RUN_NUMBER — used in expected artifact names for diagnostics
 *   GITHUB_EVENT_PULL_REQUEST_HEAD_SHA / GITHUB_SHA — candidate attribution
 */

const fs = require('node:fs');
const path = require('node:path');

/** Workflow upload name suffix -> required JSON filename inside artifact */
const SCANNER_ARTIFACTS = [
  { artifactSuffix: 'gitleaks-report', reportFile: 'gitleaks-results.json', scanner: 'Gitleaks' },
  { artifactSuffix: 'semgrep-report', reportFile: 'semgrep-results.json', scanner: 'Semgrep' },
  { artifactSuffix: 'osv-report', reportFile: 'osv-results.json', scanner: 'OSV-Scanner' },
  { artifactSuffix: 'trivy-report', reportFile: 'trivy-results.json', scanner: 'Trivy' },
  { artifactSuffix: 'npm-audit-report', reportFile: 'npm-audit.json', scanner: 'npm audit' },
];

function walkFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}

function findReportFile(downloadRoot, reportFile) {
  const matches = walkFiles(downloadRoot).filter((f) => path.basename(f) === reportFile);
  if (matches.length === 0) return null;
  // Prefer shallowest path (merge-multiple should flatten, but be defensive).
  matches.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return matches[0];
}

function validateJson(filePath, label) {
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Malformed ${label}: ${filePath} — ${err.message}`);
  }
}

function main() {
  const downloadRoot = process.argv[2] || 'security/reports';
  const outputDir = process.argv[3] || path.join(downloadRoot, 'collected');
  const runNumber = process.env.GITHUB_RUN_NUMBER || 'unknown';

  if (!fs.existsSync(downloadRoot)) {
    console.error(`Operational failure: artifact download directory missing: ${downloadRoot}`);
    process.exit(2);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const collected = [];
  const missing = [];
  const malformed = [];

  for (const spec of SCANNER_ARTIFACTS) {
    const found = findReportFile(downloadRoot, spec.reportFile);
    if (!found) {
      missing.push({
        scanner: spec.scanner,
        expectedReportFile: spec.reportFile,
        expectedArtifactPattern: `${spec.artifactSuffix}-${runNumber}`,
      });
      continue;
    }

    try {
      validateJson(found, spec.reportFile);
      const dest = path.join(outputDir, spec.reportFile);
      fs.copyFileSync(found, dest);
      collected.push({
        scanner: spec.scanner,
        source: found,
        destination: dest,
        reportFile: spec.reportFile,
      });
    } catch (err) {
      malformed.push({
        scanner: spec.scanner,
        reportFile: spec.reportFile,
        source: found,
        error: err.message,
      });
    }
  }

  const manifest = {
    collectedAt: new Date().toISOString(),
    downloadRoot: path.resolve(downloadRoot),
    outputDir: path.resolve(outputDir),
    runNumber,
    candidateSha: process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA || process.env.GITHUB_SHA || 'unknown',
    mergeSha: process.env.GITHUB_SHA || 'unknown',
    collected,
    missing,
    malformed,
  };

  fs.writeFileSync(path.join(outputDir, 'collection-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (missing.length > 0) {
    console.error('Operational failure: missing scanner reports after artifact download:');
    for (const item of missing) {
      console.error(`  - ${item.scanner}: expected ${item.reportFile} from artifact ${item.expectedArtifactPattern}`);
    }
    console.error(JSON.stringify({ missing, collected: collected.length }, null, 2));
    process.exit(2);
  }

  if (malformed.length > 0) {
    console.error('Operational failure: malformed scanner reports:');
    for (const item of malformed) {
      console.error(`  - ${item.scanner}: ${item.error}`);
    }
    process.exit(2);
  }

  console.log(JSON.stringify({
    ok: true,
    collected: collected.length,
    outputDir: path.resolve(outputDir),
    candidateSha: manifest.candidateSha,
  }));
}

if (require.main === module) {
  main();
}

module.exports = { SCANNER_ARTIFACTS, findReportFile, walkFiles };
