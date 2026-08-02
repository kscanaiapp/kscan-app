'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const governedStorage = require('../lib/governedStorage');
const runtimeIdentity = require('../lib/runtimeRequestIdentity');

const ROOT = governedStorage.ROOT;
const HARNESS = path.join(ROOT, 'tools/scanner-evaluation/adapter/deno/certifiedHarness.ts');
const DEPENDENCY_ROOT = 'C:/src/KScan-scanner-phase2a-v1-live-evaluation';

function capture(snapshotRoot, outDir, name, requestContract, extra = []) {
  const out = path.join(outDir, `${name}.json`);
  const dependencyNodeModules = path.join(DEPENDENCY_ROOT, 'node_modules');
  const snapshotNodeModules = path.join(snapshotRoot, 'node_modules');
  if (!fs.existsSync(snapshotNodeModules)) fs.symlinkSync(dependencyNodeModules, snapshotNodeModules, 'junction');
  execFileSync('deno', [
    'run',
    `--allow-read=${snapshotRoot},${path.dirname(HARNESS)},${dependencyNodeModules}`,
    `--allow-write=${outDir}`,
    '--allow-env',
    '--node-modules-dir=manual',
    '--no-lock',
    HARNESS,
    '--cert-root', snapshotRoot,
    '--provider', 'capture',
    '--request-contract', requestContract,
    '--mode', 'identify_selected_item',
    '--out', out,
    ...extra,
  ], { cwd: DEPENDENCY_ROOT, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function completeIdentity(captureResult, ref) {
  return {
    ...captureResult,
    providerParserSha256: runtimeIdentity.componentIdentity(
      ref,
      runtimeIdentity.PROVIDER_PARSER_PATHS,
    ).aggregateSha256,
    responseContractSha256: runtimeIdentity.componentIdentity(
      ref,
      runtimeIdentity.RESPONSE_CONTRACT_PATHS,
    ).aggregateSha256,
  };
}

test('protected mobile configuration deterministically selects the legacy selected-item path', () => {
  for (const ref of [runtimeIdentity.PROTECTED_ANDROID_SHA, runtimeIdentity.PROTECTED_IOS_SHA]) {
    const dispatch = runtimeIdentity.protectedMobileDispatchIdentity(ref);
    assert.equal(dispatch.backendEnabled, true);
    assert.equal(typeof dispatch.multiImageEnabled, 'boolean');
    assert.equal(dispatch.v2Enabled, false);
    assert.equal(dispatch.v2DefaultFailsClosed, true);
    assert.equal(dispatch.selectedItemLegacyShapePresent, true);
    assert.equal(dispatch.selectedRuntimeContract, 'legacy-selected-item');
  }
});

test('protected Android and iOS provider source closures are byte-identical', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-runtime-snapshot-'));
  try {
    const android = runtimeIdentity.materializeReferenceClosure({
      ref: runtimeIdentity.PROTECTED_ANDROID_SHA,
      destination: path.join(temp, 'android'),
    });
    const ios = runtimeIdentity.materializeReferenceClosure({
      ref: runtimeIdentity.PROTECTED_IOS_SHA,
      destination: path.join(temp, 'ios'),
    });
    assert.equal(android.aggregateSha256, ios.aggregateSha256);
    assert.equal(android.materializedFrom, 'git object store');
    assert.equal(ios.materializedFrom, 'git object store');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('protected legacy-shaped provider payload is captured and historical reuse fails closed on contract drift', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-runtime-capture-'));
  try {
    const certified = runtimeIdentity.materializeReferenceClosure({
      ref: runtimeIdentity.CERTIFIED_SHA,
      destination: path.join(temp, 'certified'),
    });
    const current = runtimeIdentity.materializeReferenceClosure({
      ref: runtimeIdentity.PROTECTED_ANDROID_SHA,
      destination: path.join(temp, 'current'),
    });

    const historicalCapture = capture(certified.root, temp, 'historical-v2', 'v2', [
      '--intent', 'identify_for_style',
      '--source-entry-path', 'scanner_camera',
    ]);
    const currentCapture = capture(current.root, temp, 'current-legacy', 'legacy');

    for (const result of [historicalCapture, currentCapture]) {
      assert.match(result.serializedRequestPayloadSha256, /^[0-9a-f]{64}$/);
      assert.match(result.promptSha256, /^[0-9a-f]{64}$/);
      assert.match(result.responseSchemaSha256, /^[0-9a-f]{64}$/);
      assert.match(result.generationConfigSha256, /^[0-9a-f]{64}$/);
      assert.equal(result.captureCount, 1);
      assert.equal(result.externalNetworkCallCount, 0);
      assert.equal(result.unexpectedNetworkAttemptCount, 0);
      assert.deepEqual(result.blockedHosts, []);
    }

    const comparison = runtimeIdentity.compareRuntimeRequestIdentities(
      completeIdentity(historicalCapture, runtimeIdentity.CERTIFIED_SHA),
      completeIdentity(currentCapture, runtimeIdentity.PROTECTED_ANDROID_SHA),
    );
    assert.equal(comparison.checks.providerPayload, true);
    assert.equal(comparison.checks.responseSchema, true);
    assert.equal(comparison.checks.samplingConfiguration, true);
    assert.equal(comparison.checks.model, true);
    assert.equal(comparison.checks.providerParser, true);
    assert.equal(comparison.checks.requestContract, false);
    assert.equal(comparison.checks.responseContract, false);
    assert.equal(comparison.reusable, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('runtime snapshots refuse mutable refs and existing destinations', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-runtime-refusal-'));
  try {
    assert.throws(
      () => runtimeIdentity.materializeReferenceClosure({ ref: 'HEAD', destination: path.join(temp, 'head') }),
      /full lowercase 40-character/,
    );
    runtimeIdentity.materializeReferenceClosure({
      ref: runtimeIdentity.CERTIFIED_SHA,
      destination: path.join(temp, 'snapshot'),
    });
    assert.throws(
      () => runtimeIdentity.materializeReferenceClosure({
        ref: runtimeIdentity.CERTIFIED_SHA,
        destination: path.join(temp, 'snapshot'),
      }),
      /immutable/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
