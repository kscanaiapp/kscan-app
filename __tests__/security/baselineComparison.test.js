#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { compare, isBlockingNewFinding } = require('../../security/scripts/compare-security-baseline');
const { fingerprint } = require('../../security/scripts/normalize-security-findings');
const { classifyFile } = require('../../security/scripts/classify-changed-surfaces');
const { DEFAULT_STAGING_REF, PRODUCTION_REF } = require('../../security/scripts/verify-staging-project-ref');
const { evaluateLocal } = require('../../security/scripts/evaluate-promotion-gate');

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
  assert.equal(result.newBlockingFindings.length, 0);
});

test('compare: new critical fixture blocks', () => {
  const baseline = { version: 'test', findings: [] };
  const normalized = {
    findings: [{
      scanner: 'Semgrep',
      ruleId: 'kscan.new-critical',
      normalizedPath: 'supabase/functions/x/index.ts',
      fileOrPackage: 'supabase/functions/x/index.ts',
      severity: 'CRITICAL',
      runtimeClassification: 'BACKEND RUNTIME',
      fingerprint: fingerprint(['Semgrep', 'kscan.new-critical', 'supabase/functions/x/index.ts', '1']),
    }],
    scanners: [],
    errors: [],
  };
  const result = compare(normalized, baseline);
  assert.equal(result.finalPromotionVerdict, 'BLOCKED');
  assert.equal(result.newBlockingFindings.length, 1);
});

test('compare: new high runtime fixture blocks', () => {
  const baseline = { version: 'test', findings: [] };
  const normalized = {
    findings: [{
      scanner: 'Trivy',
      ruleId: 'CVE-NEW-HIGH',
      normalizedPath: 'services/api.ts',
      fileOrPackage: 'lodash',
      severity: 'HIGH',
      runtimeClassification: 'MOBILE RUNTIME',
      fingerprint: fingerprint(['Trivy', 'CVE-NEW-HIGH', 'services/api.ts', 'lodash', '']),
    }],
    scanners: [],
    errors: [],
  };
  const result = compare(normalized, baseline);
  assert.equal(result.finalPromotionVerdict, 'BLOCKED');
});

test('compare: malformed scanner error is operational failure', () => {
  const baseline = { version: 'test', findings: [] };
  const normalized = { findings: [], scanners: [], errors: [{ scanner: 'Semgrep', status: 'malformed' }] };
  const result = compare(normalized, baseline);
  assert.equal(result.finalPromotionVerdict, 'OPERATIONAL FAILURE');
});

test('classifyFile: supabase function is staging impact', () => {
  const tags = classifyFile('supabase/functions/stylechat-generate/index.ts');
  assert.ok(tags.includes('SUPABASE FUNCTION'));
});

test('classifyFile: docs only', () => {
  const tags = classifyFile('docs/security/runbook.md');
  assert.ok(tags.includes('DOCUMENTATION ONLY'));
});

test('verify staging ref constants', () => {
  assert.equal(DEFAULT_STAGING_REF, 'yzqjvdfgefveprobvvyw');
  assert.equal(PRODUCTION_REF, 'wyyuqfdxucjksghsmhry');
});

test('evaluateLocal: missing artifact operational failure', () => {
  const verdict = evaluateLocal({ missingRequiredArtifact: true });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
});

test('evaluateLocal: successful scan permits promotion', () => {
  const verdict = evaluateLocal({});
  assert.equal(verdict.finalVerdict, 'PASS');
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
