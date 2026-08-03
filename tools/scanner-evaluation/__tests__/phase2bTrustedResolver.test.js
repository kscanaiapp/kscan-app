'use strict';

/**
 * Phase 2B: the trusted server-selection contract.
 *
 * The resolver's job is to be boring and unsurprising in production: always
 * return a usable version, never throw, never let anything a client controls
 * change the answer, and record why whenever it falls back.
 *
 * These tests are written from the attacker's side as much as the operator's —
 * most of them try to activate the candidate through a channel that must not
 * work.
 *
 * No provider transport is involved. Nothing here makes a network call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const candidateRegistry = require('../lib/candidateRegistry');
const resolver = require('../lib/trustedVersionResolver');

const CONTROL = candidateRegistry.CONTROL_VERSION;
const CANDIDATE = candidateRegistry.PHASE2A_VERSION;
const REASONS = resolver.RESOLUTION_REASONS;

// ── Supported identities and the default ────────────────────────────────────

test('the supported identities are exactly the certified control and the registered candidates', () => {
  const resolution = resolver.resolveTrustedVersion(null);
  assert.deepEqual(
    [...resolution.supportedVersions].sort(),
    ['certified-v140', 'phase2a-v1.0.0', 'phase6-scanner-v1.0-a'],
  );
  assert.equal(resolution.controlVersion, 'certified-v140');
});

test('missing trusted configuration resolves the certified control', () => {
  for (const absent of [null, undefined, {}]) {
    const resolution = resolver.resolveTrustedVersion(absent);
    assert.equal(resolution.resolvedVersion, CONTROL);
    assert.equal(resolution.isControl, true);
    assert.equal(resolution.reason, REASONS.NO_TRUSTED_CONFIGURATION);
    // Absent configuration is the normal path, not a failure.
    assert.equal(resolution.fellBackToControl, false);
  }
});

test('explicit supported configuration resolves the candidate', () => {
  const resolution = resolver.resolveTrustedVersion({ scannerVersion: CANDIDATE });
  assert.equal(resolution.resolvedVersion, CANDIDATE);
  assert.equal(resolution.isControl, false);
  assert.equal(resolution.reason, REASONS.EXPLICIT_CANDIDATE);
  assert.equal(resolution.fellBackToControl, false);
});

test('explicitly naming the control is distinguishable from naming nothing', () => {
  const explicit = resolver.resolveTrustedVersion({ scannerVersion: CONTROL });
  assert.equal(explicit.resolvedVersion, CONTROL);
  assert.equal(explicit.reason, REASONS.EXPLICIT_CONTROL);
  assert.notEqual(explicit.reason, REASONS.NO_TRUSTED_CONFIGURATION);
});

// ── Fail closed, never throw ────────────────────────────────────────────────

test('an unknown version fails closed to the control', () => {
  for (const unknown of ['phase2a', 'phase2a-v1.0.1', 'PHASE2A-V1.0.0', 'certified-v141', 'phase2b-v1.0.0']) {
    const resolution = resolver.resolveTrustedVersion({ scannerVersion: unknown });
    assert.equal(resolution.resolvedVersion, CONTROL, `${unknown} must not activate anything`);
    assert.equal(resolution.reason, REASONS.UNKNOWN_VERSION);
    assert.equal(resolution.fellBackToControl, true);
  }
});

test('a near-miss is still a miss: no trimming, case folding or alias resolution', () => {
  for (const value of [' phase2a-v1.0.0', 'phase2a-v1.0.0 ', 'Phase2a-V1.0.0', 'phase2a_v1.0.0']) {
    const resolution = resolver.resolveTrustedVersion({ scannerVersion: value });
    assert.equal(resolution.resolvedVersion, CONTROL, `${JSON.stringify(value)} must not be repaired into a match`);
    assert.equal(resolution.reason, REASONS.UNKNOWN_VERSION);
  }
});

test('a malformed value fails closed to the control', () => {
  for (const malformed of ['', '   ', 0, 1, true, false, [], {}, [CANDIDATE], null]) {
    const resolution = resolver.resolveTrustedVersion({ scannerVersion: malformed });
    assert.equal(resolution.resolvedVersion, CONTROL, `${JSON.stringify(malformed)} must fail closed`);
    assert.equal(resolution.reason, REASONS.MALFORMED_VALUE);
    assert.equal(resolution.fellBackToControl, true);
  }
});

test('a malformed configuration object fails closed to the control', () => {
  for (const malformed of ['phase2a-v1.0.0', 42, true, [], [{ scannerVersion: CANDIDATE }], () => CANDIDATE]) {
    const resolution = resolver.resolveTrustedVersion(malformed);
    assert.equal(resolution.resolvedVersion, CONTROL);
    assert.equal(
      resolution.reason,
      REASONS.MALFORMED_CONFIGURATION,
      `${JSON.stringify(String(malformed))} must be rejected as a configuration`
    );
  }
});

test('the resolver never throws, whatever it is handed', () => {
  const hostile = [
    undefined, null, NaN, Infinity, Symbol('x'), 0n,
    { scannerVersion: { toString: () => CANDIDATE } },
    { get scannerVersion() { throw new Error('exploding getter'); } },
    Object.create(null),
  ];
  for (const input of hostile) {
    let resolution;
    try {
      resolution = resolver.resolveTrustedVersion(input);
    } catch (error) {
      assert.fail(`resolver threw on ${String(input?.toString?.() ?? input)}: ${error.message}`);
    }
    assert.ok(resolution.supportedVersions.includes(resolution.resolvedVersion));
  }
});

// ── Client-controlled data cannot activate the candidate ────────────────────

test('a request body handed to the resolver cannot activate the candidate', () => {
  // A realistic production scan-identify body, with a hostile selection field
  // attached. This is the exact wiring mistake the guard exists to catch.
  const requestBody = {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req-0001',
    intent: 'identify_for_style',
    mode: 'identify_selected_item',
    source: { entryPath: 'scanner_camera', platform: 'ios', appVersion: '1.0.0' },
    evidence: [{ evidenceId: 'ev-1' }],
    privacy: { localFaceMaskApplied: false },
    // The attack.
    scannerVersion: CANDIDATE,
  };
  const resolution = resolver.resolveTrustedVersion(requestBody);
  assert.equal(resolution.resolvedVersion, CONTROL, 'a request body must never activate a candidate');
  assert.equal(resolution.reason, REASONS.UNTRUSTED_INPUT_REJECTED);
  assert.equal(resolution.fellBackToControl, true);
});

test('every client-controlled surface is rejected even when it names a supported version', () => {
  const surfaces = {
    'request headers': { headers: { 'x-scanner-version': CANDIDATE }, scannerVersion: CANDIDATE },
    'query parameters': { query: { scannerVersion: CANDIDATE }, scannerVersion: CANDIDATE },
    'url parameters': { params: { v: CANDIDATE }, scannerVersion: CANDIDATE },
    'a nested body': { body: { scannerVersion: CANDIDATE }, scannerVersion: CANDIDATE },
    'user metadata': { userId: 'u-1', scannerVersion: CANDIDATE },
    'a session': { session: { id: 's-1' }, scannerVersion: CANDIDATE },
    'mobile feature flags': { featureFlags: { scannerV2: true }, scannerVersion: CANDIDATE },
    'a deep link': { deepLink: 'kscan://scan?version=phase2a', scannerVersion: CANDIDATE },
    'app/platform metadata': { platform: 'ios', appVersion: '1.2.3', scannerVersion: CANDIDATE },
    'image metadata': { imageMetadata: { width: 896 }, scannerVersion: CANDIDATE },
    'exif': { exif: { gps: null }, scannerVersion: CANDIDATE },
    'retailer metadata': { retailerId: 'farfetch', scannerVersion: CANDIDATE },
    'commerce metadata': { commerce: { enabled: true }, scannerVersion: CANDIDATE },
    'an access token': { accessToken: 'token', scannerVersion: CANDIDATE },
    'cookies': { cookies: 'a=b', scannerVersion: CANDIDATE },
  };

  for (const [description, config] of Object.entries(surfaces)) {
    const resolution = resolver.resolveTrustedVersion(config);
    assert.equal(resolution.resolvedVersion, CONTROL, `${description} must not activate the candidate`);
    assert.equal(resolution.reason, REASONS.UNTRUSTED_INPUT_REJECTED);
  }

  // Every declared marker is genuinely load-bearing.
  for (const marker of resolver.UNTRUSTED_INPUT_MARKERS) {
    const resolution = resolver.resolveTrustedVersion({ [marker]: 'anything', scannerVersion: CANDIDATE });
    assert.equal(resolution.resolvedVersion, CONTROL, `marker ${marker} must reject the configuration`);
  }
});

test('the guard runs BEFORE the selection field is read', () => {
  // Ordering matters: reading first and validating second would mean a
  // request-shaped object had already selected a candidate.
  const resolution = resolver.resolveTrustedVersion({ requestId: 'r', scannerVersion: CANDIDATE });
  assert.equal(resolution.reason, REASONS.UNTRUSTED_INPUT_REJECTED);
  assert.notEqual(resolution.reason, REASONS.EXPLICIT_CANDIDATE);
  assert.equal(resolver.looksLikeUntrustedInput({ requestId: 'r' }), 'requestId');
  assert.equal(resolver.looksLikeUntrustedInput({ scannerVersion: CANDIDATE }), null);
});

test('a clean trusted configuration with unrelated operational keys still works', () => {
  // The guard must not be so broad that legitimate server config is rejected.
  const resolution = resolver.resolveTrustedVersion({
    scannerVersion: CANDIDATE,
    rolloutNote: 'canary',
    configuredBy: 'ops',
    configuredAt: '2026-07-31T00:00:00.000Z',
  });
  assert.equal(resolution.resolvedVersion, CANDIDATE);
  assert.equal(resolution.reason, REASONS.EXPLICIT_CANDIDATE);
});

// ── Immutability and purity ─────────────────────────────────────────────────

test('the resolved version is immutable for one execution', () => {
  const config = { scannerVersion: CANDIDATE };
  const execution = resolver.createExecutionResolution(config);
  assert.equal(execution.resolvedVersion, CANDIDATE);

  // Mutating the configuration mid-execution must not change what this
  // execution runs.
  config.scannerVersion = CONTROL;
  delete config.scannerVersion;
  assert.equal(execution.resolve().resolvedVersion, CANDIDATE);
  assert.equal(execution.resolve(), execution.resolve(), 'one frozen resolution per execution');

  assert.equal(Object.isFrozen(execution), true);
  assert.equal(Object.isFrozen(execution.resolution), true);
  assert.throws(() => { execution.resolution.resolvedVersion = CONTROL; }, TypeError);
});

test('two executions are independent, with no shared mutable state', () => {
  const a = resolver.createExecutionResolution({ scannerVersion: CANDIDATE });
  const b = resolver.createExecutionResolution(null);
  const c = resolver.createExecutionResolution({ scannerVersion: CANDIDATE });

  assert.equal(a.resolvedVersion, CANDIDATE);
  assert.equal(b.resolvedVersion, CONTROL, 'one execution must not leak into the next');
  assert.equal(c.resolvedVersion, CANDIDATE);
  assert.notEqual(a.resolution, c.resolution, 'resolutions are per-execution, not shared singletons');
});

test('resolution is deterministic and free of environment influence', () => {
  const probes = ['KSCAN_SCANNER_VERSION', 'SCANNER_VERSION', 'PHASE2A', 'NODE_ENV'];
  const saved = probes.map((name) => [name, process.env[name]]);
  try {
    for (const name of probes) process.env[name] = CANDIDATE;
    assert.equal(resolver.resolveTrustedVersion(null).resolvedVersion, CONTROL);
    assert.equal(resolver.resolveTrustedVersion({}).resolvedVersion, CONTROL);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'trustedVersionResolver.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of [
    /process\s*\.\s*env/, /globalThis/, /\bfetch\s*\(/, /supabase/i,
    /require\(['"](?:fs|http|https|net|child_process)['"]\)/, /Date\s*\.\s*now/, /Math\s*\.\s*random/,
  ]) {
    assert.equal(forbidden.test(code), false, `the pure resolver must not reference ${forbidden}`);
  }
});

test('an injected registry governs what is supported', () => {
  // Proves the registry is a real input rather than a hardcoded list, which is
  // what lets a future build add or retire a version without editing this module.
  const controlOnly = resolver.resolveTrustedVersion({ scannerVersion: CANDIDATE }, {
    supportedVersions: [CONTROL],
  });
  assert.equal(controlOnly.resolvedVersion, CONTROL);
  assert.equal(controlOnly.reason, REASONS.UNKNOWN_VERSION);

  const future = resolver.resolveTrustedVersion({ scannerVersion: 'phase2c-v1.0.0' }, {
    supportedVersions: [CONTROL, 'phase2c-v1.0.0'],
  });
  assert.equal(future.resolvedVersion, 'phase2c-v1.0.0');
  assert.equal(future.reason, REASONS.EXPLICIT_CANDIDATE);
});

// ── Telemetry safety ────────────────────────────────────────────────────────

test('selection telemetry carries ids and reasons only', () => {
  const resolution = resolver.resolveTrustedVersion({ scannerVersion: CANDIDATE });
  const telemetry = resolver.selectionTelemetry(resolution);

  assert.deepEqual(Object.keys(telemetry).sort(), [
    'scannerVersion',
    'scannerVersionFellBack',
    'scannerVersionIsControl',
    'scannerVersionReason',
    'trustedResolverVersion',
  ]);
  assert.equal(telemetry.scannerVersion, CANDIDATE);
  assert.equal(Object.isFrozen(telemetry), true);

  const serialized = JSON.stringify(telemetry);
  assert.equal(/instruction|prompt|apikey|token|base64/i.test(serialized), false);
});

test('an observed misconfiguration is echoed back bounded and type-tagged', () => {
  const long = 'x'.repeat(500);
  const resolution = resolver.resolveTrustedVersion({ scannerVersion: long });
  assert.ok(resolution.observedValue.length <= 66, 'an attacker-influenced value must not reach logs unbounded');

  assert.equal(resolver.sanitizeObservedValue(undefined), null);
  assert.equal(resolver.sanitizeObservedValue(''), '<empty>');
  assert.equal(resolver.sanitizeObservedValue(42), '<number>');
  assert.equal(resolver.sanitizeObservedValue([1]), '<array>');
  assert.equal(resolver.sanitizeObservedValue({}), '<object>');
  assert.equal(resolver.sanitizeObservedValue('phase2a-v1.0.0'), 'phase2a-v1.0.0');
});

// ── Scope: this module does not dispatch ────────────────────────────────────

test('the resolver performs no provider dispatch and is not wired into production', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'trustedVersionResolver.js'), 'utf8');
  for (const forbidden of [/generativelanguage/i, /gemini/i, /https?:\/\//, /executeAdapter/, /dispatch\s*\(/]) {
    assert.equal(forbidden.test(code), false, `the pure contract must not reference ${forbidden}`);
  }
  // And no production Edge Function imports it.
  const edgeDir = path.join(__dirname, '..', '..', '..', 'supabase', 'functions');
  if (fs.existsSync(edgeDir)) {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.ts$/.test(entry.name)) continue;
        if (/trustedVersionResolver|candidateArtifact|candidateRegistry/.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(entry.name);
        }
      }
    };
    walk(edgeDir);
    assert.deepEqual(hits, [], 'no production Edge Function may import the Phase 2B contract in this phase');
  }
});
