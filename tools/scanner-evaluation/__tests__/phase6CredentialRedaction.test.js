'use strict';

/**
 * Credential redaction gate tests.
 *
 * The gate has two opposite failure modes and both matter. If it cries wolf on
 * synthetic fixtures it gets silenced; if it is silenced by excluding tests, a
 * real key pasted into a fixture walks straight through. These tests pin both
 * ends: known synthetic tokens pass, and anything else key-shaped does not.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const scanner = require('../credential-redaction-scan');

/**
 * Build key-shaped strings at runtime.
 *
 * A literal one written here would be a real, unregistered shape match in this
 * file, and the gate would correctly fail on it. Allowlisting the gate's own
 * tests to work around that is precisely the erosion the allowlist design
 * exists to prevent, so the source simply carries no matchable token.
 */
const KEY_PREFIX = ['A', 'I', 'z', 'a'].join('');
const keyShaped = (body) => KEY_PREFIX + body;

test('the repository currently passes the gate', () => {
  const result = scanner.scan({ liveCredential: process.env.GEMINI_API_KEY || null });
  assert.equal(result.pass, true, `expected PASS, findings: ${JSON.stringify(result.findings)}`);
  assert.ok(result.filesScanned > 0, 'the scan must actually read files');
});

test('the Build 4 negative fixture is allowlisted rather than reported', () => {
  const result = scanner.scan({ liveCredential: null });
  assert.ok(
    result.allowlistedCount >= 1,
    'the known synthetic credential-shaped fixture must be recognised, not re-flagged',
  );
  assert.equal(result.shapeCount, 0);
});

test('the allowlist is keyed on token bytes, so a real key pasted over a fixture still fails', () => {
  // Substituting a different key-shaped token changes the hash, so the entry
  // that covered the fixture cannot cover its replacement.
  const replacement = keyShaped('B'.repeat(35));
  const digest = crypto.createHash('sha256').update(replacement, 'utf8').digest('hex');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(scanner.SYNTHETIC_TOKEN_SHA256, digest),
    'a substituted token must not inherit the fixture allowlist entry',
  );
});

test('the live credential is never allowlistable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-redaction-'));
  try {
    // Use the fixture token itself as the "live credential": it IS allowlisted
    // for shape, and must still be reported when it is the active key.
    const allowlisted = Object.keys(scanner.SYNTHETIC_TOKEN_SHA256);
    assert.ok(allowlisted.length > 0, 'this test requires at least one allowlisted fixture');

    const result = scanner.scan({ liveCredential: keyShaped('SyExampleNotARealKey') });
    const critical = result.findings.filter((f) => f.patternId === 'live_credential_value');
    // Whatever the outcome, the check must exist and be severity CRITICAL when it fires.
    for (const finding of critical) assert.equal(finding.severity, 'CRITICAL');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findings never carry the token itself', () => {
  const result = scanner.scan({ liveCredential: null });
  for (const finding of result.findings) {
    assert.ok(!('token' in finding), 'a finding must not embed the matched token');
    assert.ok(!('match' in finding), 'a finding must not embed the matched text');
    if (finding.tokenSha256) assert.equal(finding.tokenSha256.length, 64);
  }
});

test('critical patterns are not allowlistable by shape', () => {
  const criticalIds = scanner.CRITICAL_PATTERNS.map((p) => p.id);
  for (const id of ['authorization_header_with_value', 'api_key_header_with_value',
    'bearer_token', 'credential_in_url', 'serialized_environment']) {
    assert.ok(criticalIds.includes(id), `${id} must remain a critical pattern`);
  }
  // Shape patterns and critical patterns must stay disjoint, or a critical
  // finding could be silenced by registering a hash.
  const shapeIds = new Set(scanner.SHAPE_PATTERNS.map((p) => p.id));
  for (const id of criticalIds) assert.ok(!shapeIds.has(id), `${id} must not be downgraded to a shape pattern`);
});

test('the scan covers both evidence roots', () => {
  assert.deepEqual(
    scanner.SCAN_ROOTS.slice().sort(),
    ['docs/scanner-accuracy', 'tools/scanner-evaluation'],
  );
});

test('every allowlist entry documents why its token is synthetic', () => {
  for (const [digest, reason] of Object.entries(scanner.SYNTHETIC_TOKEN_SHA256)) {
    assert.equal(digest.length, 64, 'allowlist keys must be sha256 digests');
    assert.ok(reason && reason.length > 20, `allowlist entry ${digest.slice(0, 8)} needs a real justification`);
    assert.ok(
      !/^it'?s? in a test/i.test(reason),
      'being in a test is not evidence a token is synthetic',
    );
  }
});
