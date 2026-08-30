'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// B34-DEF-002: four fixture negative controls, matching the ones run by hand
// during the patch -- bundle ID, a removed-but-still-granted permission, a
// deep-link path mismatch, and the Android application ID.

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-native-config-parity.js');
const APP_JSON_PATH = path.join(REPO_ROOT, 'app.json');

function runGate() {
  try {
    execFileSync(process.execPath, [GATE_SCRIPT], { cwd: REPO_ROOT, stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

function withMutatedAppJson(mutate, run) {
  const original = fs.readFileSync(APP_JSON_PATH, 'utf8');
  try {
    const config = JSON.parse(original);
    mutate(config);
    fs.writeFileSync(APP_JSON_PATH, JSON.stringify(config, null, 2));
    return run();
  } finally {
    fs.writeFileSync(APP_JSON_PATH, original);
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
