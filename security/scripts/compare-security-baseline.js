#!/usr/bin/env node
'use strict';

/**
 * Compares normalized scanner findings against the approved security baseline.
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/compare-security-baseline.js \
 *     <normalizedFindings.json> <baseline.json> [outputDir]
 *
 * Exit codes:
 *   0 = pass (may include report-only findings)
 *   1 = blocked (new blocking findings or policy violation)
 *   2 = operational failure (missing/malformed input)
 */

const fs = require('node:fs');
const path = require('node:path');

const BLOCKING_RUNTIME = new Set(['MOBILE RUNTIME', 'BACKEND RUNTIME']);
const BLOCKING_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

function loadJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Malformed ${label}: ${err.message}`);
  }
}

function indexBaseline(baseline) {
  const byFingerprint = new Map();
  for (const item of baseline.findings || []) {
    byFingerprint.set(item.fingerprint, item);
  }
  return byFingerprint;
}

function severityRank(severity) {
  const order = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0, UNVERIFIED: 0 };
  return order[String(severity || '').toUpperCase()] ?? 0;
}

function isBlockingNewFinding(finding) {
  if (finding.scanner === 'Gitleaks') {
    return true;
  }
  if (!BLOCKING_SEVERITIES.has(String(finding.severity || '').toUpperCase())) {
    return false;
  }
  return BLOCKING_RUNTIME.has(finding.runtimeClassification);
}

function compare(normalized, baseline) {
  const baselineIndex = indexBaseline(baseline);
  const currentFingerprints = new Set();

  const result = {
    comparedAt: new Date().toISOString(),
    baselineVersion: baseline.version || 'unknown',
    baselineGeneratedAt: baseline.generatedAt || null,
    newBlockingFindings: [],
    newReportOnlyFindings: [],
    existingBaselineFindings: [],
    resolvedFindings: [],
    severityIncreases: [],
    runtimeClassificationChanges: [],
    scannerOperationalState: normalized.scanners || [],
    scannerErrors: normalized.errors || [],
    finalPromotionVerdict: 'PASS',
  };

  for (const finding of normalized.findings || []) {
    currentFingerprints.add(finding.fingerprint);
    const baselineFinding = baselineIndex.get(finding.fingerprint);

    if (!baselineFinding) {
      if (isBlockingNewFinding(finding)) {
        result.newBlockingFindings.push({ ...finding, changeType: 'NEW_FINDING' });
      } else {
        result.newReportOnlyFindings.push({ ...finding, changeType: 'NEW_FINDING' });
      }
      continue;
    }

    result.existingBaselineFindings.push({
      ...finding,
      changeType: 'EXISTING_FINDING',
      baselineAccepted: baselineFinding.accepted !== false,
      baselineNotes: baselineFinding.notes || '',
    });

    if (severityRank(finding.severity) > severityRank(baselineFinding.severity)) {
      const change = {
        fingerprint: finding.fingerprint,
        scanner: finding.scanner,
        ruleId: finding.ruleId,
        previousSeverity: baselineFinding.severity,
        newSeverity: finding.severity,
        changeType: 'SEVERITY_INCREASE',
      };
      result.severityIncreases.push(change);
      if (isBlockingNewFinding({ ...finding, severity: finding.severity })) {
        result.newBlockingFindings.push({ ...finding, changeType: 'SEVERITY_INCREASE' });
      }
    }

    if (
      baselineFinding.runtimeClassification
      && finding.runtimeClassification
      && baselineFinding.runtimeClassification !== finding.runtimeClassification
      && BLOCKING_RUNTIME.has(finding.runtimeClassification)
      && !BLOCKING_RUNTIME.has(baselineFinding.runtimeClassification)
    ) {
      result.runtimeClassificationChanges.push({
        fingerprint: finding.fingerprint,
        scanner: finding.scanner,
        ruleId: finding.ruleId,
        previousRuntime: baselineFinding.runtimeClassification,
        newRuntime: finding.runtimeClassification,
        changeType: 'RUNTIME_CLASSIFICATION_CHANGE',
      });
      if (isBlockingNewFinding(finding)) {
        result.newBlockingFindings.push({ ...finding, changeType: 'RUNTIME_CLASSIFICATION_CHANGE' });
      }
    }
  }

  for (const [fingerprint, baselineFinding] of baselineIndex.entries()) {
    if (!currentFingerprints.has(fingerprint)) {
      result.resolvedFindings.push({ ...baselineFinding, changeType: 'RESOLVED_FINDING' });
    }
  }

  if ((normalized.errors || []).length > 0) {
    result.finalPromotionVerdict = 'OPERATIONAL FAILURE';
  } else if (result.newBlockingFindings.length > 0) {
    result.finalPromotionVerdict = 'BLOCKED';
  } else if (result.newReportOnlyFindings.length > 0) {
    result.finalPromotionVerdict = 'PASS WITH REPORT-ONLY FINDINGS';
  } else {
    result.finalPromotionVerdict = 'PASS';
  }

  return result;
}

function writeReports(result, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'baseline-comparison.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const lines = [
    '# Security Baseline Comparison',
    '',
    `**Final promotion verdict:** ${result.finalPromotionVerdict}`,
    '',
    '## Summary',
    '',
    `| Category | Count |`,
    `| --- | ---: |`,
    `| New blocking findings | ${result.newBlockingFindings.length} |`,
    `| New report-only findings | ${result.newReportOnlyFindings.length} |`,
    `| Existing baseline findings | ${result.existingBaselineFindings.length} |`,
    `| Resolved findings | ${result.resolvedFindings.length} |`,
    `| Severity increases | ${result.severityIncreases.length} |`,
    `| Runtime classification changes | ${result.runtimeClassificationChanges.length} |`,
    `| Scanner operational errors | ${result.scannerErrors.length} |`,
    '',
    '## Blocking policy',
    '',
    '- Confirmed new secret: BLOCK',
    '- New Critical/High mobile/backend runtime issue: BLOCK',
    '- Existing accepted baseline issue: REPORT',
    '- New Medium/Low issue: REPORT',
    '- Scanner execution failure: BLOCK',
    '- Missing or malformed scanner output: BLOCK',
    '',
  ];

  if (result.newBlockingFindings.length > 0) {
    lines.push('## New blocking findings', '');
    for (const f of result.newBlockingFindings.slice(0, 50)) {
      lines.push(`- [${f.scanner}] ${f.ruleId} — ${f.normalizedPath || f.fileOrPackage} (${f.severity}, ${f.runtimeClassification})`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(outputDir, 'baseline-comparison.md'), `${lines.join('\n')}\n`, 'utf8');
  return jsonPath;
}

function main() {
  const normalizedPath = process.argv[2];
  const baselinePath = process.argv[3] || path.join('security', 'baselines', 'security-findings-baseline.json');
  const outputDir = process.argv[4] || 'security/reports';

  if (!normalizedPath) {
    console.error('Usage: compare-security-baseline.js <normalizedFindings.json> [baseline.json] [outputDir]');
    process.exit(2);
  }

  let normalized;
  let baseline;
  try {
    normalized = loadJson(normalizedPath, 'normalized findings');
    baseline = loadJson(baselinePath, 'baseline');
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (!Array.isArray(normalized.findings)) {
    console.error('Malformed normalized findings: findings array required');
    process.exit(2);
  }

  const result = compare(normalized, baseline);
  const jsonPath = writeReports(result, outputDir);
  console.log(JSON.stringify({
    verdict: result.finalPromotionVerdict,
    newBlocking: result.newBlockingFindings.length,
    newReportOnly: result.newReportOnlyFindings.length,
    output: jsonPath,
  }));

  if (result.scannerErrors.length > 0 || result.finalPromotionVerdict === 'BLOCKED' || result.finalPromotionVerdict === 'OPERATIONAL FAILURE') {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { compare, isBlockingNewFinding, writeReports };
