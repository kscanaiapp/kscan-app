#!/usr/bin/env node
'use strict';

/**
 * Collects scanner JSON reports and runs baseline comparison + static gate verdict.
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/run-static-security-gate.js <reportsDir>
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_REPORTS = [
  'gitleaks-results.json',
  'semgrep-results.json',
  'osv-results.json',
  'trivy-results.json',
  'npm-audit.json',
];

function main() {
  const reportsDir = process.argv[2] || '.';
  const missing = REQUIRED_REPORTS.filter((f) => !fs.existsSync(path.join(reportsDir, f)));
  if (missing.length > 0) {
    console.error(JSON.stringify({ ok: false, error: 'missing reports', missing }));
    process.exit(2);
  }

  for (const file of REQUIRED_REPORTS) {
    try {
      JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf8'));
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: 'malformed report', file, message: err.message }));
      process.exit(2);
    }
  }

  const normalizedPath = path.join(reportsDir, 'normalized-findings.json');
  execSync(`node security/scripts/normalize-security-findings.js "${reportsDir}" "${normalizedPath}"`, { stdio: 'inherit' });

  const baselinePath = path.join('security', 'baselines', 'security-findings-baseline.json');
  try {
    execSync(`node security/scripts/compare-security-baseline.js "${normalizedPath}" "${baselinePath}" "${reportsDir}"`, { stdio: 'inherit' });
  } catch (err) {
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, normalizedPath }));
}

if (require.main === module) {
  main();
}

module.exports = { REQUIRED_REPORTS };
