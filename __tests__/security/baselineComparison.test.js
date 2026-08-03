#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { compare, isBlockingNewFinding, stableKey } = require('../../security/scripts/compare-security-baseline');
const { fingerprint, normalizePath } = require('../../security/scripts/normalize-security-findings');
const { evaluateLocal } = require('../../security/scripts/evaluate-promotion-gate');
const {
  isAcceptableHealthStatus,
  deriveHealthCheckUrl,
  validateTarget,
} = require('../../security/scripts/validate-zap-target');
const { SCANNER_ARTIFACTS, findReportFile } = require('../../security/scripts/collect-scanner-reports');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-sec-'));
}

test('isBlockingNewFinding: gitleaks always blocks', () => {
  assert.equal(isBlockingNewFinding({ scanner: 'Gitleaks', severity: 'LOW', runtimeClassification: 'UNVERIFIED' }), true);
});

test('isBlockingNewFinding: new high backend runtime blocks', () => {
  assert.equal(isBlockingNewFinding({ scanner: 'Semgrep', severity: 'HIGH', runtimeClassification: 'BACKEND RUNTIME' }), true);
});

test('isBlockingNewFinding: new medium reports only', () => {
  assert.equal(isBlockingNewFinding({ scanner: 'Semgrep', severity: 'MEDIUM', runtimeClassification: 'BACKEND RUNTIME' }), false);
});

test('compare: existing baseline finding reports without blocking', () => {
  const fp = fingerprint(['Semgrep', 'kscan.test-rule', 'server.js', '10']);
  const baseline = {
    version: 'test',
    findings: [{
      scanner: 'Semgrep',
      ruleId: 'kscan.test-rule',
      fingerprint: fp,
      severity: 'MEDIUM',
      runtimeClassification: 'BACKEND RUNTIME',
      accepted: true,
    }],
  };
  const normalized = {
    findings: [{
      scanner: 'Semgrep',
      ruleId: 'kscan.test-rule',
      normalizedPath: 'server.js',
      fileOrPackage: 'server.js',
      severity: 'MEDIUM',
      runtimeClassification: 'BACKEND RUNTIME',
      fingerprint: fp,
    }],
    scanners: [{ scanner: 'Semgrep', status: 'ok' }],
    errors: [],
  };
  const result = compare(normalized, baseline);
  assert.equal(result.finalPromotionVerdict, 'PASS');
  assert.equal(result.existingBaselineFindings.length, 1);
});

test('compare: stableKey matches across fingerprint drift', () => {
  const baseline = {
    version: 'test',
    findings: [{
      scanner: 'Semgrep',
      ruleId: 'kscan.wildcard-cors-javascript',
      normalizedPath: 'server.js',
      fingerprint: 'aaaaaaaaaaaaaaaa',
      severity: 'MEDIUM',
      runtimeClassification: 'BACKEND RUNTIME',
      accepted: true,
    }],
  };
  const normalized = {
    findings: [{
      scanner: 'Semgrep',
      ruleId: 'kscan.wildcard-cors-javascript',
      normalizedPath: 'server.js',
      severity: 'MEDIUM',
      runtimeClassification: 'BACKEND RUNTIME',
      fingerprint: 'bbbbbbbbbbbbbbbb',
    }],
    scanners: [],
    errors: [],
  };
  const result = compare(normalized, baseline);
  assert.equal(result.existingBaselineFindings.length, 1);
  assert.equal(result.existingBaselineFindings[0].matchedVia, 'stableKey');
  assert.equal(result.finalPromotionVerdict, 'PASS');
});

test('compare: new critical fixture blocks', () => {
  const result = compare({
    findings: [{
      scanner: 'Semgrep',
      ruleId: 'kscan.new-critical',
      normalizedPath: 'supabase/functions/x/index.ts',
      severity: 'CRITICAL',
      runtimeClassification: 'BACKEND RUNTIME',
      fingerprint: fingerprint(['Semgrep', 'kscan.new-critical', 'x', '1']),
    }],
    scanners: [],
    errors: [],
  }, { version: 'test', findings: [] });
  assert.equal(result.finalPromotionVerdict, 'BLOCKED');
});

test('compare: new high runtime fixture blocks', () => {
  const result = compare({
    findings: [{
      scanner: 'Trivy',
      ruleId: 'CVE-NEW-HIGH',
      normalizedPath: 'services/api.ts',
      severity: 'HIGH',
      runtimeClassification: 'MOBILE RUNTIME',
      fingerprint: fingerprint(['Trivy', 'CVE-NEW-HIGH', 'services/api.ts']),
    }],
    scanners: [],
    errors: [],
  }, { version: 'test', findings: [] });
  assert.equal(result.finalPromotionVerdict, 'BLOCKED');
});

test('compare: new medium is report-only', () => {
  const result = compare({
    findings: [{
      scanner: 'Semgrep',
      ruleId: 'kscan.new-medium',
      normalizedPath: 'server.js',
      severity: 'MEDIUM',
      runtimeClassification: 'BACKEND RUNTIME',
      fingerprint: fingerprint(['Semgrep', 'kscan.new-medium', 'server.js']),
    }],
    scanners: [],
    errors: [],
  }, { version: 'test', findings: [] });
  assert.equal(result.finalPromotionVerdict, 'PASS WITH REPORT-ONLY FINDINGS');
});

test('compare: resolved finding is reported', () => {
  const fp = fingerprint(['Semgrep', 'gone', 'server.js']);
  const result = compare({
    findings: [],
    scanners: [],
    errors: [],
  }, {
    version: 'test',
    findings: [{
      scanner: 'Semgrep',
      ruleId: 'gone',
      normalizedPath: 'server.js',
      fingerprint: fp,
      severity: 'LOW',
      runtimeClassification: 'BACKEND RUNTIME',
    }],
  });
  assert.equal(result.resolvedFindings.length, 1);
  assert.equal(result.finalPromotionVerdict, 'PASS');
});

test('compare: malformed scanner error is operational failure', () => {
  const result = compare({ findings: [], scanners: [], errors: [{ scanner: 'Semgrep', status: 'malformed' }] }, { version: 'test', findings: [] });
  assert.equal(result.finalPromotionVerdict, 'OPERATIONAL FAILURE');
});

test('path separators: Windows and Linux normalize to same fingerprint parts', () => {
  const { normalizePath: norm } = require('../../security/scripts/normalize-security-findings');
  assert.equal(norm('app\\components\\X.tsx'), 'app/components/X.tsx');
  assert.equal(stableKey({ scanner: 'Semgrep', ruleId: 'r', normalizedPath: 'app\\x.ts' }), 'Semgrep|r|app/x.ts');
});

test('candidate SHA attribution in compare context', () => {
  const result = compare({ findings: [], scanners: [], errors: [] }, { version: 'test', findings: [] }, {
    candidateSha: 'abc123head',
    mergeSha: 'def456merge',
    pullRequestNumber: '42',
  });
  assert.equal(result.candidateSha, 'abc123head');
  assert.equal(result.mergeSha, 'def456merge');
});

test('run-static-security-gate: missing report blocks', () => {
  const dir = tmpDir();
  assert.throws(() => {
    execSync(`node security/scripts/run-static-security-gate.js "${dir}"`, { stdio: 'pipe' });
  });
});

test('normalize-security-findings: malformed semgrep fails', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'semgrep-results.json'), '{not-valid-json', 'utf8');
  assert.throws(() => {
    execSync(`node security/scripts/normalize-security-findings.js "${dir}"`, { stdio: 'pipe' });
  });
});

test('collect-scanner-reports: missing report blocks with clear message', () => {
  const dir = tmpDir();
  assert.throws(() => {
    execSync(`node security/scripts/collect-scanner-reports.js "${dir}" "${path.join(dir, 'out')}"`, {
      stdio: 'pipe',
      env: { ...process.env, GITHUB_RUN_NUMBER: '99' },
    });
  }, /missing scanner reports|Operational failure/i);
});

test('ZAP health: 401/403 accepted; 404/405 rejected', () => {
  assert.equal(isAcceptableHealthStatus(200), true);
  assert.equal(isAcceptableHealthStatus(401), true);
  assert.equal(isAcceptableHealthStatus(403), true);
  assert.equal(isAcceptableHealthStatus(404), false);
  assert.equal(isAcceptableHealthStatus(405), false);
});

test('ZAP health: Supabase root derives /auth/v1/health', () => {
  assert.equal(
    deriveHealthCheckUrl('https://yzqjvdfgefveprobvvyw.supabase.co'),
    'https://yzqjvdfgefveprobvvyw.supabase.co/auth/v1/health',
  );
});

test('ZAP target: production host rejected', () => {
  assert.throws(() => validateTarget('https://wyyuqfdxucjksghsmhry.supabase.co', 'wyyuqfdxucjksghsmhry.supabase.co'));
});

test('promotion gate: all pass', () => {
  assert.equal(evaluateLocal({}).finalVerdict, 'PASS');
});

test('promotion gate: report-only findings', () => {
  assert.equal(evaluateLocal({ reportOnlyFindings: true }).finalVerdict, 'PASS WITH REPORT-ONLY FINDINGS');
});

test('promotion gate: new Critical blocks', () => {
  assert.equal(evaluateLocal({ newCriticalRuntimeFinding: true }).finalVerdict, 'BLOCKED');
});

test('promotion gate: new High blocks', () => {
  assert.equal(evaluateLocal({ newHighRuntimeFinding: true }).finalVerdict, 'BLOCKED');
});

test('promotion gate: scanner crash operational', () => {
  assert.equal(evaluateLocal({ scannerCrash: true }).finalVerdict, 'OPERATIONAL FAILURE');
});

test('promotion gate: missing report operational', () => {
  assert.equal(evaluateLocal({ missingReport: true }).finalVerdict, 'OPERATIONAL FAILURE');
});

test('promotion gate: ZAP config missing on protected PR blocks', () => {
  assert.equal(evaluateLocal({ zapConfigurationMissingOnProtectedPr: true }).finalVerdict, 'BLOCKED');
});

test('promotion gate: ZAP exit 3 operational', () => {
  assert.equal(evaluateLocal({ zapExit3: true }).finalVerdict, 'OPERATIONAL FAILURE');
});

test('promotion gate: candidate SHA mismatch blocks', () => {
  assert.equal(evaluateLocal({
    expectedCandidateSha: 'aaa',
    observedCandidateSha: 'bbb',
  }).finalVerdict, 'BLOCKED');
});
