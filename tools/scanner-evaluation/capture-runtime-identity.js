'use strict';

/**
 * Offline, hash-only current-runtime identity capture.
 *
 * This command materializes immutable Git-object snapshots, intercepts the
 * Gemini fetch before the network, and prints only hashes and configuration
 * identity. It never reads benchmark images, credentials, or holdout labels.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const governedStorage = require('./lib/governedStorage');
const runtimeIdentity = require('./lib/runtimeRequestIdentity');

const ROOT = governedStorage.ROOT;
const HARNESS = path.join(ROOT, 'tools/scanner-evaluation/adapter/deno/certifiedHarness.ts');

function capture(snapshotRoot, outputRoot, name, requestContract, extra = []) {
  const output = path.join(outputRoot, `${name}.json`);
  const dependencyNodeModules = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(dependencyNodeModules)) {
    throw new Error('node_modules is required for the offline Deno runtime capture');
  }
  fs.symlinkSync(dependencyNodeModules, path.join(snapshotRoot, 'node_modules'), 'junction');
  execFileSync('deno', [
    'run',
    `--allow-read=${snapshotRoot},${path.dirname(HARNESS)},${dependencyNodeModules}`,
    `--allow-write=${outputRoot}`,
    '--allow-env',
    '--node-modules-dir=manual',
    '--no-lock',
    HARNESS,
    '--cert-root', snapshotRoot,
    '--provider', 'capture',
    '--request-contract', requestContract,
    '--mode', 'identify_selected_item',
    '--out', output,
    ...extra,
  ], { cwd: ROOT, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

function completeCapture(captureResult, ref) {
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

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-runtime-identity-'));
  try {
    const certified = runtimeIdentity.materializeReferenceClosure({
      ref: runtimeIdentity.CERTIFIED_SHA,
      destination: path.join(temp, 'certified'),
    });
    const android = runtimeIdentity.materializeReferenceClosure({
      ref: runtimeIdentity.PROTECTED_ANDROID_SHA,
      destination: path.join(temp, 'android'),
    });
    const ios = runtimeIdentity.materializeReferenceClosure({
      ref: runtimeIdentity.PROTECTED_IOS_SHA,
      destination: path.join(temp, 'ios'),
    });
    const historical = completeCapture(capture(certified.root, temp, 'historical-v2', 'v2', [
      '--intent', 'identify_for_style',
      '--source-entry-path', 'scanner_camera',
    ]), runtimeIdentity.CERTIFIED_SHA);
    const current = completeCapture(
      capture(android.root, temp, 'current-legacy', 'legacy'),
      runtimeIdentity.PROTECTED_ANDROID_SHA,
    );
    const report = {
      reportVersion: '1.0.0',
      executionMode: 'offline-fetch-intercept',
      providerCallCount: 0,
      source: {
        certified,
        protectedAndroid: android,
        protectedIos: ios,
        protectedSourceClosuresByteIdentical: android.aggregateSha256 === ios.aggregateSha256,
      },
      mobileDispatch: {
        protectedAndroid: runtimeIdentity.protectedMobileDispatchIdentity(runtimeIdentity.PROTECTED_ANDROID_SHA),
        protectedIos: runtimeIdentity.protectedMobileDispatchIdentity(runtimeIdentity.PROTECTED_IOS_SHA),
      },
      historical,
      current,
      comparison: runtimeIdentity.compareRuntimeRequestIdentities(historical, current),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = { main };
