'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// B34-DEF-014: the reachability gate must fail on an unapproved critical/high
// finding, on reachability-path drift, and on an audit it cannot establish —
// and pass on the real, current tree.
//
// The negative controls used to drive the real gate, which meant every one of
// them ran a live `npm audit`. That was both slow (minutes per invocation) and
// non-deterministic: npm's audit endpoint intermittently errors, the gate then
// saw npm's JSON *error object* instead of a report, found no `vulnerabilities`
// key, and concluded "0 findings — PASS". Whichever control happened to land on
// a failed audit call reported a green gate, which is exactly how PR #289's CI
// went red on a different subtest each run.
//
// The failure paths are now exercised through the gate's own pure evaluation
// functions with fixture audit reports, so they assert real behaviour without
// depending on npm's network at all. The one control that still spawns the real
// script points npm at an unroutable registry, which fails immediately and
// deterministically -- it proves the end-to-end exit code and classification
// without depending on whether the live endpoint happens to be healthy.
//
// The live end-to-end positive control is `npm run verify:dependency-reachability`,
// which CI runs as its own step; it is deliberately not duplicated here.

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-dependency-reachability.js');
const EXCEPTIONS_PATH = path.join(REPO_ROOT, 'config', 'dependency-reachability-exceptions.json');

const gate = require('../scripts/check-dependency-reachability.js');

function runGateCapturing(env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [GATE_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
    return { status: 0, output: stdout.toString() };
  } catch (error) {
    return {
      status: error.status,
      output: `${error.stdout ? error.stdout.toString() : ''}${error.stderr ? error.stderr.toString() : ''}`,
    };
  }
}

/** A minimal but structurally valid `npm audit --json` report. */
function auditReport(vulnerabilities = {}, totals = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...totals },
    },
  };
}

function loadRealManifest() {
  const manifest = JSON.parse(fs.readFileSync(EXCEPTIONS_PATH, 'utf8'));
  const byPackage = new Map();
  for (const entry of manifest.exceptions) {
    for (const name of entry.packages || []) byPackage.set(name, entry);
  }
  return { manifest, byPackage };
}

/** Evaluate against the real manifest with a controllable import oracle. */
function evaluate(report, importedPackages = []) {
  const { manifest, byPackage } = loadRealManifest();
  const imported = new Set(importedPackages);
  return gate.evaluateReachability({
    report,
    manifest,
    byPackage,
    isImported: (name) => imported.has(name),
  });
}

// ------------------------------------------------------------ positive

test('B34-DEF-014: the committed manifest accepts the real tree\'s critical/high set', () => {
  // The live end-to-end positive control is `npm run verify:dependency-reachability`,
  // which CI runs as its own step. Duplicating that live audit here doubled a
  // multi-minute network call for no extra signal, so the manifest-covers-the-tree
  // claim is asserted directly instead: every high finding the real tree currently
  // produces must resolve to an approved exception, with none left unapproved.
  const realHighFindings = [
    '@expo/cli', '@expo/metro', '@expo/metro-config', 'brace-expansion', 'expo',
    'image-size', 'js-yaml', 'metro', 'metro-config', 'metro-transform-worker',
    'nanoid', 'postcss', 'ws',
  ];
  const report = auditReport(
    Object.fromEntries(realHighFindings.map((name) => [name, { severity: 'high' }])),
    { high: realHighFindings.length, total: realHighFindings.length },
  );

  const isImported = gate.makeImportChecker(gate.readAppSource());
  const { manifest, byPackage } = loadRealManifest();
  const { failures, accepted } = gate.evaluateReachability({ report, manifest, byPackage, isImported });

  assert.deepEqual(failures, [], 'the real tree\'s high findings must all be approved and unreachable');
  assert.equal(accepted.length, realHighFindings.length);
});

// ------------------------------------------------- negative A: exception removed

test('B34-DEF-014 negative control: removing an approved exception fails the gate', () => {
  const { manifest } = loadRealManifest();
  const stripped = {
    ...manifest,
    exceptions: manifest.exceptions.filter((entry) => !entry.packages.includes('metro')),
  };
  const byPackage = new Map();
  for (const entry of stripped.exceptions) {
    for (const name of entry.packages || []) byPackage.set(name, entry);
  }

  const report = auditReport({ metro: { severity: 'high' } }, { high: 1, total: 1 });
  const { failures } = gate.evaluateReachability({
    report,
    manifest: stripped,
    byPackage,
    isImported: () => false,
  });

  assert.equal(failures.length, 1, 'metro with no approved exception must fail');
  assert.match(failures[0], /metro \(high\): no approved exception on file/);
});

// -------------------------------------------- negative B: runtime reachability

test('B34-DEF-014 negative control: an excepted package imported by app source fails the gate', () => {
  // nanoid is an approved high-severity BUILD_DEV_ONLY exception whose evidence
  // is literally "Zero matches importing 'nanoid' from app/...". Make that false
  // and the exception must stop holding.
  const report = auditReport({ nanoid: { severity: 'high' } }, { high: 1, total: 1 });

  const clean = evaluate(report, []);
  assert.deepEqual(clean.failures, [], 'unimported build-only package still passes');
  assert.ok(clean.accepted.some((a) => a.name === 'nanoid'));

  const drifted = evaluate(report, ['nanoid']);
  assert.equal(drifted.failures.length, 1);
  assert.match(drifted.failures[0], /now directly imported from shipped app source/);
});

test('B34-DEF-014: reachability is enforced even when this run\'s audit omits the package', () => {
  // The old gate only checked reachability for packages present in the current
  // audit output, so a BUILD_DEV_ONLY package that became app-reachable went
  // unchecked whenever its advisory happened not to be reported. The manifest's
  // claim does not depend on the advisory feed, and neither does the check.
  const emptyReport = auditReport({}, {});

  const clean = evaluate(emptyReport, []);
  assert.deepEqual(clean.failures, []);

  const drifted = evaluate(emptyReport, ['nanoid']);
  assert.equal(drifted.failures.length, 1, 'app-reachable build-only package must fail with no audit finding at all');
  assert.match(drifted.failures[0], /declared BUILD_DEV_ONLY.*directly imported from shipped/s);
});

test('B34-DEF-014: moderate-severity entries stay out of scope', () => {
  // expo-router and expo-linking are genuinely imported by app source and sit in
  // a moderate-severity entry. Widening reachability enforcement must not start
  // failing the gate on them.
  const drifted = evaluate(auditReport({}, {}), ['expo-router', 'expo-linking']);
  assert.deepEqual(drifted.failures, [], 'moderate entries are not blocking-severity');
});

// ------------------------------------ negative C: audit transport unavailable

test('B34-DEF-014 negative control: an unreachable audit endpoint fails the gate closed', () => {
  // Deterministic: an unroutable registry gives an immediate ECONNREFUSED, so
  // this asserts real transport-failure behaviour without depending on whether
  // npm's live endpoint happens to be healthy.
  const { status, output } = runGateCapturing({
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_fetch_retries: '0',
  });

  assert.notEqual(status, 0, 'an audit that cannot be established must never pass');
  assert.equal(status, 2, 'audit-unavailable is an operational failure (exit 2)');
  assert.match(output, /AUDIT_UNAVAILABLE|AUDIT_UNEXPECTED_SHAPE|AUDIT_UNPARSEABLE/);
  assert.match(output, /Failing closed/);
});

test('B34-DEF-014: npm\'s JSON error payload is not accepted as a clean audit', () => {
  // This is the precise fail-open. npm prints this, with a non-zero exit, when
  // the audit endpoint errors. It parses; it is not an audit report.
  const npmTransportError = {
    message: 'request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: socket hang up',
    error: { summary: '', detail: '' },
  };
  assert.equal(gate.isValidAuditReport(npmTransportError), false);

  const parsed = gate.parseAuditOutput(JSON.stringify(npmTransportError));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'AUDIT_UNEXPECTED_SHAPE');
  assert.match(parsed.detail, /socket hang up/);
});

test('B34-DEF-014: a bounded retry is attempted before declaring the audit unavailable', () => {
  let calls = 0;
  const flaky = () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error('audit endpoint returned an error');
      error.stdout = Buffer.from(JSON.stringify({ message: 'boom', error: {} }));
      throw error;
    }
    return Buffer.from(JSON.stringify(auditReport({}, {})));
  };
  const result = gate.runAudit({ exec: flaky, attempts: 3 });
  assert.equal(result.ok, true, 'a transient transport error should cost a retry, not a false red');
  assert.equal(calls, 3);

  const alwaysBroken = () => {
    const error = new Error('audit endpoint returned an error');
    error.stdout = Buffer.from(JSON.stringify({ message: 'boom', error: {} }));
    throw error;
  };
  const failed = gate.runAudit({ exec: alwaysBroken, attempts: 2 });
  assert.equal(failed.ok, false, 'a persistently unavailable audit must fail closed');
  assert.equal(failed.attempts, 2);
});

// ---------------------------------------- negative D: malformed audit output

test('B34-DEF-014 negative control: malformed audit output fails the gate', () => {
  for (const malformed of ['', '   ', 'not json at all', '{"vulnerabilities":', '<html>502 Bad Gateway</html>']) {
    const parsed = gate.parseAuditOutput(malformed);
    assert.equal(parsed.ok, false, `must reject: ${JSON.stringify(malformed)}`);
    assert.ok(
      ['AUDIT_UNAVAILABLE', 'AUDIT_UNPARSEABLE'].includes(parsed.reason),
      `unexpected reason ${parsed.reason} for ${JSON.stringify(malformed)}`,
    );
  }
});

// ------------------------------------- negative E: unexpected but valid JSON

test('B34-DEF-014 negative control: structurally valid but unsupported audit JSON fails the gate', () => {
  const unsupported = [
    {},
    [],
    null,
    { advisories: {}, metadata: {} }, // npm v6 shape
    { vulnerabilities: {} }, // no metadata
    { metadata: { vulnerabilities: {} } }, // no vulnerabilities
    { vulnerabilities: 'nope', metadata: { vulnerabilities: {} } },
    { vulnerabilities: {}, metadata: { vulnerabilities: 'nope' } },
  ];
  for (const shape of unsupported) {
    assert.equal(gate.isValidAuditReport(shape), false, `must reject shape: ${JSON.stringify(shape)}`);
    const parsed = gate.parseAuditOutput(JSON.stringify(shape));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'AUDIT_UNEXPECTED_SHAPE');
  }

  // ...and the supported shape is still accepted.
  assert.equal(gate.isValidAuditReport(auditReport({}, {})), true);
  assert.equal(gate.parseAuditOutput(JSON.stringify(auditReport({}, {}))).ok, true);
});

// ------------------------------- negative F: unapproved high/critical finding

test('B34-DEF-014 negative control: an unapproved high/critical finding fails the gate', () => {
  const highReport = auditReport(
    { 'totally-new-package': { severity: 'high' } },
    { high: 1, total: 1 },
  );
  const high = evaluate(highReport, []);
  assert.equal(high.failures.length, 1);
  assert.match(high.failures[0], /totally-new-package \(high\): no approved exception on file/);

  const criticalReport = auditReport(
    { 'another-new-package': { severity: 'critical' } },
    { critical: 1, total: 1 },
  );
  const critical = evaluate(criticalReport, []);
  assert.equal(critical.failures.length, 1);
  assert.match(critical.failures[0], /another-new-package \(critical\)/);

  // Moderate and low remain out of scope, as before.
  const moderate = evaluate(
    auditReport({ 'noisy-moderate': { severity: 'moderate' } }, { moderate: 1, total: 1 }),
    [],
  );
  assert.deepEqual(moderate.failures, []);
});

// -------------------------------------------------- manifest is fail-closed too

test('B34-DEF-014: a missing or unparseable exceptions manifest fails the gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-reach-'));

  const missing = gate.loadExceptions(path.join(dir, 'absent.json'));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'MANIFEST_MISSING');

  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, '{ not json', 'utf8');
  const bad = gate.loadExceptions(badPath);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'MANIFEST_UNPARSEABLE');

  const shapePath = path.join(dir, 'shape.json');
  fs.writeFileSync(shapePath, JSON.stringify({ exceptions: 'nope' }), 'utf8');
  assert.equal(gate.loadExceptions(shapePath).reason, 'MANIFEST_UNPARSEABLE');

  // The real manifest still loads.
  assert.equal(gate.loadExceptions().ok, true);
});

test('B34-DEF-014: the committed manifest still covers the real tree with no app-reachable build-only package', () => {
  const { manifest } = loadRealManifest();
  const isImported = gate.makeImportChecker(gate.readAppSource());
  const offenders = [];
  for (const entry of manifest.exceptions) {
    if (entry.classification !== 'BUILD_DEV_ONLY') continue;
    if (!gate.BLOCKING_SEVERITIES.has(entry.severity)) continue;
    for (const name of entry.packages || []) {
      if (isImported(name)) offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], 'a high/critical BUILD_DEV_ONLY package is imported by app source');
});
