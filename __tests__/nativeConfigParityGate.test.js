'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// B34-DEF-002: four fixture negative controls, matching the ones run by hand
// during the patch -- bundle ID, a removed-but-still-granted permission, a
// deep-link path mismatch, and the Android application ID.

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-native-config-parity.js');
const APP_JSON_PATH = path.join(REPO_ROOT, 'app.json');

// The four files the gate reads, relative to whichever root it is pointed at.
const GATE_INPUTS = [
  'app.json',
  path.join('config', 'native-config-authority.json'),
  path.join('android', 'app', 'build.gradle'),
  path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'),
];

function runGate(root = REPO_ROOT) {
  try {
    execFileSync(process.execPath, [GATE_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      env: { ...process.env, NATIVE_CONFIG_PARITY_ROOT: root },
    });
    return 0;
  } catch (error) {
    return error.status;
  }
}

/**
 * Runs a negative control against an ISOLATED COPY of the four files the gate
 * reads, never against this repository's own app.json.
 *
 * The previous version wrote the mutated config straight to REPO_ROOT/app.json
 * and restored it in a finally block. node --test runs test FILES concurrently,
 * so that mutation window was observable by every other test file that reads
 * app.json -- oauthCallback.test.js's Apple sign-in contract test failed in the
 * full suite while passing on its own. A fixture root removes the shared-state
 * race entirely; the gate logic under test is unchanged.
 */
function withMutatedAppJson(mutate, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-config-parity-'));
  try {
    for (const relative of GATE_INPUTS) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, relative), destination);
    }
    const config = JSON.parse(fs.readFileSync(APP_JSON_PATH, 'utf8'));
    mutate(config);
    fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify(config, null, 2));
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('B34-DEF-002: gate passes against the current, real config', () => {
  assert.equal(runGate(), 0);
});

test('B34-DEF-002 negative control: bundle ID mismatch fails the gate', () => {
  const exitCode = withMutatedAppJson(
    (config) => {
      config.expo.ios.bundleIdentifier = 'com.kscanai.fixture-mismatch';
    },
    runGate,
  );
  assert.equal(exitCode, 1);
});

test('B34-DEF-002 negative control: a permission removed from app.json but still granted in the manifest fails the gate', () => {
  const exitCode = withMutatedAppJson(
    (config) => {
      config.expo.android.permissions = config.expo.android.permissions.filter(
        (permission) => permission !== 'android.permission.ACCESS_COARSE_LOCATION',
      );
    },
    runGate,
  );
  assert.equal(exitCode, 1);
});

test('B34-DEF-002 negative control: deep-link route declaration mismatch fails the gate', () => {
  const exitCode = withMutatedAppJson(
    (config) => {
      const filter = config.expo.android.intentFilters.find((entry) => entry.autoVerify);
      filter.data[0].pathPrefix = '/mismatched-path';
    },
    runGate,
  );
  assert.equal(exitCode, 1);
});

test('B34-DEF-002 negative control: Android application ID mismatch fails the gate', () => {
  const exitCode = withMutatedAppJson(
    (config) => {
      config.expo.android.package = 'com.kscanai.mismatch';
    },
    runGate,
  );
  assert.equal(exitCode, 1);
});
