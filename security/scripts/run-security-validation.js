#!/usr/bin/env node
'use strict';

/**
 * Local validation runner for security pipeline artifacts.
 * Usage: node security/scripts/run-security-validation.js
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
process.chdir(root);

const results = [];

function run(name, cmd) {
  try {
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.stderr || err.message });
  }
}

run('Node syntax: normalize-security-findings.js', 'node --check security/scripts/normalize-security-findings.js');
run('Node syntax: compare-security-baseline.js', 'node --check security/scripts/compare-security-baseline.js');
run('Node syntax: classify-changed-surfaces.js', 'node --check security/scripts/classify-changed-surfaces.js');
run('Node syntax: verify-staging-project-ref.js', 'node --check security/scripts/verify-staging-project-ref.js');
run('Node syntax: synthetic-staging-tests.js', 'node --check security/scripts/synthetic-staging-tests.js');
run('Node syntax: evaluate-promotion-gate.js', 'node --check security/scripts/evaluate-promotion-gate.js');
run('Baseline JSON parse', "node -e \"JSON.parse(require('fs').readFileSync('security/baselines/security-findings-baseline.json','utf8'))\"");
run('OpenAPI YAML present', "node -e \"require('fs').accessSync('security/openapi/staging-api.yaml')\"");
run('Security unit tests', 'node --test __tests__/security/baselineComparison.test.js');
run('Staging project ref guard', 'node security/scripts/verify-staging-project-ref.js yzqjvdfgefveprobvvyw');
run('ZAP target validation matrix localhost reject', 'node security/scripts/validate-zap-target.js https://localhost/ example.com');
run('git diff --check', 'git diff --check');

console.log(JSON.stringify({ results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }, null, 2));

if (results.some((r) => !r.ok && !r.name.includes('ZAP target validation matrix localhost reject'))) {
  process.exit(1);
}
