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
