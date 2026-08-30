'use strict';

// Workflow-contract guards for the security CI pipeline.
//
// These assert shell-level properties that CI cannot discover for itself: a
// broken security step usually fails *closed*, which looks identical to a real
// finding until someone reads the log. The OSV SIGPIPE defect cost a required
// check on PR #90 while reporting no vulnerability at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

const workflowFiles = fs.readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => ({ name, content: fs.readFileSync(path.join(WORKFLOWS, name), 'utf8') }));

// A long-running scanner piped into a short-circuiting reader dies of SIGPIPE.
// Under `set -o pipefail` that surfaces as exit 141 with no findings produced.
const SIGPIPE_PRONE = /\b(osv-scanner|semgrep|trivy|gitleaks|syft|grype)\b[^\n|]*\|\s*head\b/;

test('no security scanner is piped into head', () => {
  for (const { name, content } of workflowFiles) {
    assert.doesNotMatch(
      content,
      SIGPIPE_PRONE,
      `${name}: piping a scanner into head causes SIGPIPE (exit 141) under pipefail. `
      + 'Capture the output first, then take the first line in the shell.',
    );
  }
});

test('osv-scanner version capture is SIGPIPE-safe', () => {
  const securityCode = workflowFiles.find((file) => file.name === 'security-code.yml');
  assert.ok(securityCode, 'security-code.yml must exist');
  assert.doesNotMatch(
    securityCode.content,
    /osv-scanner --version\s*\|\s*head/,
    'osv-scanner --version must not be piped into head',
  );
  assert.match(
    securityCode.content,
    /VERSION_OUTPUT="\$\(osv-scanner --version\)"/,
    'capture the full version output, then slice it in the shell',
  );
});

// The repair must not have been "achieved" by disarming the scanner.
test('the OSV step is still fail-closed and still scans', () => {
  const securityCode = workflowFiles.find((file) => file.name === 'security-code.yml');
  const step = securityCode.content.slice(securityCode.content.indexOf('Run OSV-Scanner'));
  const block = step.slice(0, step.indexOf('\n      - name:') === -1 ? step.length : step.indexOf('\n      - name:'));

  assert.match(block, /set -euo pipefail/, 'the OSV step must keep strict mode');
  assert.doesNotMatch(block, /osv-scanner[^\n]*\|\|\s*true/, 'OSV failures must not be swallowed with || true');
  assert.doesNotMatch(block, /continue-on-error:\s*true/, 'the OSV step must not be made advisory');
  assert.match(block, /osv-scanner\s+scan/, 'the OSV step must still run a scan');
});

test('required security jobs are not conditionally skippable', () => {
  const securityCode = workflowFiles.find((file) => file.name === 'security-code.yml');
  assert.doesNotMatch(
    securityCode.content,
    /if:\s*\$\{\{\s*false\s*\}\}/,
    'no security job may be hard-disabled',
  );
});

// Staging Gate V2 Section 4: the base/head regression check needs the PR's
// base commit to actually be present in the checkout, not just its shallow
// tip.
test('project-checks checkout uses full history (fetch-depth: 0)', () => {
  const securityCode = workflowFiles.find((file) => file.name === 'security-code.yml');
  const jobStart = securityCode.content.indexOf('project-checks:');
  const jobEnd = securityCode.content.indexOf('\n  gitleaks:');
  const jobBlock = securityCode.content.slice(jobStart, jobEnd === -1 ? undefined : jobEnd);
  assert.match(jobBlock, /fetch-depth:\s*0/, 'project-checks must fetch full history for git worktree add <base_sha> to resolve');
});

// Staging Gate V2 Section 6: a docs-only PR should not require mobile
// contract tests to run at all (still a real `skipped` conclusion, not a
// missing check-run - branch protection is satisfied either way).
test('contract-tests is gated off for docs-only classifications', () => {
  const stagingGate = workflowFiles.find((file) => file.name === 'security-staging-gate.yml');
  assert.ok(stagingGate, 'security-staging-gate.yml must exist');
  const jobStart = stagingGate.content.indexOf('\n  contract-tests:');
  const jobEnd = stagingGate.content.indexOf('\n  staging-security-gate:');
  const jobBlock = stagingGate.content.slice(jobStart, jobEnd);
  assert.match(
    jobBlock,
    /if:\s*needs\.classify-changes\.outputs\.classifications\s*!=\s*'DOCUMENTATION ONLY'/,
    'contract-tests must skip (not fail) for a purely documentation-only diff',
  );
});

// The aggregation step must tolerate that skip - a job this workflow itself
// chooses not to run can never be "not success" in a way that blocks.
test('staging-security-gate treats a skipped Contract tests result as passing, not blocking', () => {
  const stagingGate = workflowFiles.find((file) => file.name === 'security-staging-gate.yml');
  assert.doesNotMatch(
    stagingGate.content,
    /if\s*\[\s*"\$CONTRACT"\s*!=\s*"success"\s*\]/,
    'CONTRACT must not be compared with != "success" - that reads a legitimate skip as a failure',
  );
  assert.match(
    stagingGate.content,
    /if\s*\[\s*"\$CONTRACT"\s*=\s*"failure"\s*\]/,
    'CONTRACT should be compared the same tolerant way MIGRATION/HEALTH/SYNTHETIC already are',
  );
});
