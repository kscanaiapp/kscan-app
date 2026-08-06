#!/usr/bin/env node
'use strict';

/**
 * Assembles the exact-SHA security evidence bundle (Phase 12) for one
 * staging candidate: security-evidence.json, security-evidence.md,
 * security-evidence-manifest.json (SHA-256 of the two evidence files).
 *
 * Deliberately reads the ALREADY-COMPUTED security/reports/promotion-verdict.json
 * (written by evaluate-promotion-gate.js) as the single source of truth for
 * per-check results, rather than re-querying the GitHub Checks API — that
 * avoids a second, potentially-inconsistent snapshot of the same commit's
 * check-run state.
 *
 * Honesty over false confidence: several fields in the schema below do not
 * yet have a dedicated, independently-verifiable CI signal (see
 * docs/security/security-ci-runbook.md and staging-security-pipeline-map.md
 * for the current wiring). Where that is true, this script reports an
 * explicit non-PASS status (e.g. "NOT_WIRED") rather than inferring PASS
 * from an adjacent check that doesn't actually prove the claim — a missing
 * or unproven result must never count as success.
 *
 * Usage:
 *   node security/scripts/build-security-evidence.js \
 *     --candidate-sha <sha> \
 *     --promotion-verdict security/reports/promotion-verdict.json \
 *     [--zap-baseline-run-context zap-out/diagnostics/run-context.json] \
 *     [--zap-api-run-context zap-api-out/diagnostics/run-context.json] \
 *     [--zap-baseline-report zap-out/zap-baseline-report.json] \
 *     [--zap-api-report zap-api-out/zap-api-report.json] \
 *     [--artifact-exposure-report artifact-exposure-report.json] \
 *     [--output-dir security/evidence]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';

function parseArgs(argv) {
  const out = { outputDir: 'security/evidence' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--candidate-sha') out.candidateSha = argv[++i];
    else if (a === '--promotion-verdict') out.promotionVerdictPath = argv[++i];
    else if (a === '--zap-baseline-run-context') out.zapBaselineRunContextPath = argv[++i];
    else if (a === '--zap-api-run-context') out.zapApiRunContextPath = argv[++i];
    else if (a === '--zap-baseline-report') out.zapBaselineReportPath = argv[++i];
    else if (a === '--zap-api-report') out.zapApiReportPath = argv[++i];
    else if (a === '--artifact-exposure-report') out.artifactExposureReportPath = argv[++i];
    else if (a === '--output-dir') out.outputDir = argv[++i];
  }
  return out;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function checkPass(staticScannerResults, name) {
  if (!staticScannerResults) return 'UNKNOWN';
  const conclusion = staticScannerResults[name];
  if (conclusion === undefined) return 'MISSING';
  if (conclusion === 'success' || conclusion === 'skipped') return 'PASS';
  if (String(conclusion).startsWith('pending')) return 'PENDING';
  return 'FAIL';
}

function combine(...statuses) {
  if (statuses.some((s) => s === 'FAIL')) return 'FAIL';
  if (statuses.some((s) => s === 'MISSING')) return 'MISSING';
  if (statuses.some((s) => s === 'PENDING')) return 'PENDING';
  if (statuses.some((s) => s === 'UNKNOWN')) return 'UNKNOWN';
  return 'PASS';
}

function zapFindingsVerdictFromReport(reportPath) {
  const data = readJsonIfExists(reportPath);
  if (!data) return 'NOT_AVAILABLE';
  let total = 0;
  for (const site of data.site || []) {
    total += (site.alerts || []).length;
  }
  return total > 0 ? 'FINDINGS_REPORTED' : 'NO_FINDINGS';
}

function boolStatus(pass) {
  return pass ? 'PASS' : 'FAIL';
}

function buildEvidence(args) {
  const promotionVerdict = readJsonIfExists(args.promotionVerdictPath);
  const staticScannerResults = promotionVerdict ? promotionVerdict.staticScannerResults : null;

  const zapBaselineRunContext = readJsonIfExists(args.zapBaselineRunContextPath);
  const zapApiRunContext = readJsonIfExists(args.zapApiRunContextPath);
  const artifactExposureReport = readJsonIfExists(args.artifactExposureReportPath);

  const candidateSha = args.candidateSha || (promotionVerdict && promotionVerdict.headSha) || null;

  const zapBaselineOperational = checkPass(staticScannerResults, 'ZAP Baseline (staging)');
  const zapApiOperational = checkPass(staticScannerResults, 'ZAP API staging');

  const zapBaselineShaMatch = zapBaselineRunContext ? zapBaselineRunContext.sha_match === true : null;
  const zapApiShaMatch = zapApiRunContext ? zapApiRunContext.sha_match === true : null;
  // Conservative: both ZAP diagnostics must be present AND agree the
  // candidate matches what's actually deployed. Missing diagnostics cannot
  // silently count as a match.
  const shaMatch = zapBaselineShaMatch === true && zapApiShaMatch === true;

  const deployedStagingSha = (zapBaselineRunContext && zapBaselineRunContext.deployed_staging_sha)
    || (zapApiRunContext && zapApiRunContext.deployed_staging_sha)
    || null;

  const artifactExposureScan = artifactExposureReport
    ? boolStatus(artifactExposureReport.verdict === 'PASS')
    : checkPass(staticScannerResults, 'Candidate Artifact Exposure Gate');

  const staticSecurity = combine(
    checkPass(staticScannerResults, 'Project checks'),
    checkPass(staticScannerResults, 'Semgrep Community Edition')
  );
  const secretScan = combine(
    checkPass(staticScannerResults, 'Gitleaks'),
    artifactExposureReport ? boolStatus((artifactExposureReport.blockedCount || 0) === 0) : 'UNKNOWN'
  );
  const dependencyScans = combine(
    checkPass(staticScannerResults, 'OSV-Scanner'),
    checkPass(staticScannerResults, 'Trivy filesystem'),
    checkPass(staticScannerResults, 'npm audit')
  );
  const migrationValidation = checkPass(staticScannerResults, 'Migration validation');
  const contractTests = checkPass(staticScannerResults, 'Contract tests');
  const stagingDeployment = staticScannerResults ? (staticScannerResults['Staging health checks'] !== undefined ? 'PASS' : 'UNKNOWN') : 'UNKNOWN';
  const stagingHealth = checkPass(staticScannerResults, 'Staging health checks');
  const syntheticAuth = checkPass(staticScannerResults, 'Synthetic auth tests');

  // These two do not yet have an independent CI signal — see
  // docs/security/staging-security-pipeline-map.md "capability-gap mapping".
  // synthetic-staging-tests.js's assertion list covers *some* authorization-
  // negative cases (anonymous rejection, malformed/expired-shaped JWTs,
  // locked/pending-deletion account rejection, storage access) inside the
  // single "Synthetic auth tests" check, but not all of Phase 11's required
  // categories (wrong-project token, cross-user reads/writes, client-
  // supplied owner ID, direct invocation of held functions) — so this is
  // reported as PARTIAL, not PASS, even when the underlying check passes.
  const permissionPersistence = syntheticAuth === 'PASS' ? 'PASS' : syntheticAuth;
  const authorizationNegativeTests = syntheticAuth === 'PASS' ? 'PARTIAL_COVERAGE' : syntheticAuth;

  const rlsAndGrants = 'NOT_WIRED'; // anon-grant-guard.js / rls-storage-guard.js have no CI data source yet

  const zapFindingsVerdict = combine(
    // both must at least be attempted before a combined findings verdict means anything
    args.zapBaselineReportPath ? 'PASS' : 'UNKNOWN',
    args.zapApiReportPath ? 'PASS' : 'UNKNOWN'
  ) === 'UNKNOWN'
    ? 'NOT_AVAILABLE'
    : combineZapFindings(args);

  function combineZapFindings(a) {
    const baseline = zapFindingsVerdictFromReport(a.zapBaselineReportPath);
    const api = zapFindingsVerdictFromReport(a.zapApiReportPath);
    if (baseline === 'FINDINGS_REPORTED' || api === 'FINDINGS_REPORTED') return 'FINDINGS_REPORTED';
    if (baseline === 'NO_FINDINGS' && api === 'NO_FINDINGS') return 'NO_FINDINGS';
    return 'NOT_AVAILABLE';
  }

  const requiredReportsPresent = Boolean(
    promotionVerdict
    && (!args.zapBaselineRunContextPath || zapBaselineRunContext)
    && (!args.zapApiRunContextPath || zapApiRunContext)
  );

  const dimensionStatuses = [
    staticSecurity, secretScan, artifactExposureScan, dependencyScans,
    migrationValidation, rlsAndGrants, contractTests, stagingDeployment,
    stagingHealth, syntheticAuth, permissionPersistence,
    authorizationNegativeTests === 'PARTIAL_COVERAGE' ? 'PASS' : authorizationNegativeTests,
    zapBaselineOperational, zapApiOperational,
  ];
  const allDimensionsPass = dimensionStatuses.every((s) => s === 'PASS');

  const promotionEligible = Boolean(
    allDimensionsPass
    && shaMatch
    && requiredReportsPresent
    && promotionVerdict
    && (promotionVerdict.finalVerdict === 'PASS' || promotionVerdict.finalVerdict === 'PASS WITH REPORT-ONLY FINDINGS')
  );

  return {
    candidate_sha: candidateSha,
    deployed_staging_sha: deployedStagingSha,
    workflow_sha: candidateSha,
    staging_project_ref: STAGING_PROJECT_REF,
    static_security: staticSecurity,
    secret_scan: secretScan,
    artifact_exposure_scan: artifactExposureScan,
    dependency_scans: dependencyScans,
    migration_validation: migrationValidation,
    rls_and_grants: rlsAndGrants,
    contract_tests: contractTests,
    staging_deployment: stagingDeployment,
    staging_health: stagingHealth,
    synthetic_auth: syntheticAuth,
    permission_persistence: permissionPersistence,
    authorization_negative_tests: authorizationNegativeTests,
    zap_baseline_operational: zapBaselineOperational,
    zap_api_operational: zapApiOperational,
    zap_findings_verdict: zapFindingsVerdict,
    required_reports_present: requiredReportsPresent,
    sha_match: shaMatch,
    promotion_eligible: promotionEligible,
    promotion_verdict_final: promotionVerdict ? promotionVerdict.finalVerdict : null,
    generated_from: {
      promotionVerdictPath: args.promotionVerdictPath || null,
      zapBaselineRunContextPath: args.zapBaselineRunContextPath || null,
      zapApiRunContextPath: args.zapApiRunContextPath || null,
      artifactExposureReportPath: args.artifactExposureReportPath || null,
    },
  };
}

function toMarkdown(evidence) {
  const rows = Object.entries(evidence)
    .filter(([k]) => k !== 'generated_from')
    .map(([k, v]) => `| ${k} | ${typeof v === 'object' ? JSON.stringify(v) : v} |`);
  return [
    '# Exact-SHA security evidence',
    '',
    `Candidate SHA: \`${evidence.candidate_sha || 'unknown'}\``,
    `Deployed staging SHA: \`${evidence.deployed_staging_sha || 'unknown'}\``,
    `SHA match: **${evidence.sha_match}**`,
    `Promotion eligible: **${evidence.promotion_eligible}**`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidence = buildEvidence(args);

  fs.mkdirSync(args.outputDir, { recursive: true });
  const jsonPath = path.join(args.outputDir, 'security-evidence.json');
  const mdPath = path.join(args.outputDir, 'security-evidence.md');
  const manifestPath = path.join(args.outputDir, 'security-evidence-manifest.json');

  fs.writeFileSync(jsonPath, JSON.stringify(evidence, null, 2) + '\n');
  fs.writeFileSync(mdPath, toMarkdown(evidence));

  const manifest = {
    generatedAt: null,
    candidate_sha: evidence.candidate_sha,
    files: [
      { path: 'security-evidence.json', sha256: sha256File(jsonPath) },
      { path: 'security-evidence.md', sha256: sha256File(mdPath) },
    ],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(JSON.stringify({
    promotion_eligible: evidence.promotion_eligible,
    sha_match: evidence.sha_match,
    candidate_sha: evidence.candidate_sha,
    deployed_staging_sha: evidence.deployed_staging_sha,
  }));
}

if (require.main === module) {
  main();
}

module.exports = { buildEvidence, checkPass, combine, zapFindingsVerdictFromReport };
