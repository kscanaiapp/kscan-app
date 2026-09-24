'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { IOSConfig } = require('@expo/config-plugins');

const {
  verify,
  LAST_RELEASED_IOS_MARKETING_VERSION,
  getIosMarketingVersion,
  compareMarketingVersions,
} = require('../scripts/verify-apple-readiness');

/**
 * Build 34 iOS: the marketing version must open a new App Store train.
 *
 * K Scan AI 1.0.1 (build 33) was released on the App Store on 2026-09-15.
 * From that moment App Store Connect refuses any upload whose
 * CFBundleShortVersionString is not strictly higher than 1.0.1 (ITMS-90062
 * "must contain a higher version than that of the previously approved
 * version", ITMS-90186 "train version is closed for new build submissions").
 * The release candidate still generated 1.0.1, and because the
 * production-certification profile is `distribution: store`, TestFlight is the
 * only way that build reaches a device -- so the EAS build would have been
 * spent on an artifact that cannot be uploaded.
 *
 * The repair is iOS-only: `expo.ios.version` takes precedence over the shared
 * `expo.version` for CFBundleShortVersionString, while Android keeps its
 * native-authoritative versionName in android/app/build.gradle.
 *
 * Nothing here rewrites app.json. The negative controls run Expo's own
 * version resolver against an in-memory copy, so no concurrently running test
 * file can observe a mutated config.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

function readExpoConfig() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'app.json'), 'utf8')).expo;
}

function introspectInfoPlist() {
  // Same invocation as voiceScanMicrophonePermission.test.js: node + the local
  // Expo CLI, because spawnSync cannot run npx.cmd without a shell on Windows.
  const cli = path.join(REPO_ROOT, 'node_modules', 'expo', 'bin', 'cli');
  const raw = execFileSync(
    process.execPath,
    [cli, 'config', '--type', 'introspect', '--json'],
    { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const start = raw.indexOf('{');
  assert.notEqual(start, -1, 'expo config produced no JSON document');
  return JSON.parse(raw.slice(start)).ios.infoPlist;
}

test('the generated Info.plist carries a marketing version above the released App Store version', { timeout: 180000 }, () => {
  const infoPlist = introspectInfoPlist();
  assert.equal(
    compareMarketingVersions(infoPlist.CFBundleShortVersionString, LAST_RELEASED_IOS_MARKETING_VERSION),
    1,
    `CFBundleShortVersionString ${infoPlist.CFBundleShortVersionString} must be higher than the released ${LAST_RELEASED_IOS_MARKETING_VERSION}; App Store Connect refuses the upload otherwise`,
  );
});

test("Expo's own version resolver agrees with the readiness gate", () => {
  const expo = readExpoConfig();
  assert.equal(IOSConfig.Version.getVersion(expo), getIosMarketingVersion(expo));
  assert.equal(compareMarketingVersions(IOSConfig.Version.getVersion(expo), LAST_RELEASED_IOS_MARKETING_VERSION), 1);
});

test('negative control: without expo.ios.version the candidate reuses the closed 1.0.1 train', () => {
  const unrepaired = readExpoConfig();
  delete unrepaired.ios.version;

  const version = IOSConfig.Version.getVersion(unrepaired);
  assert.equal(version, LAST_RELEASED_IOS_MARKETING_VERSION, 'the unrepaired candidate generated 1.0.1');
  assert.ok(
    !(compareMarketingVersions(version, LAST_RELEASED_IOS_MARKETING_VERSION) > 0),
    'the gate condition must refuse the released version',
  );
});

test('the version comparison is numeric per segment and refuses anything not strictly higher', () => {
  assert.equal(compareMarketingVersions('1.0.1', '1.0.1'), 0);
  assert.equal(compareMarketingVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareMarketingVersions('1.0', '1.0.1'), -1);
  assert.equal(compareMarketingVersions('1.0.2', '1.0.1'), 1);
  assert.equal(compareMarketingVersions('1.1', '1.0.1'), 1);
  assert.equal(compareMarketingVersions('1.0.10', '1.0.9'), 1);
});

test('the fix is iOS-only: the shared version and Android versionName are untouched', () => {
  const expo = readExpoConfig();
  const gradle = fs.readFileSync(path.join(REPO_ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1];

  assert.equal(expo.version, LAST_RELEASED_IOS_MARKETING_VERSION, 'shared expo.version stays as released');
  assert.equal(versionName, expo.version, 'Android versionName stays aligned with the shared version');
  assert.equal(expo.android?.version, undefined, 'no Android version override is introduced');
});

test('App Store metadata targets the same version the binary carries', () => {
  const storeConfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'store.config.json'), 'utf8'));
  assert.equal(storeConfig.apple.version, getIosMarketingVersion(readExpoConfig()));
});

test('the readiness gate reports the marketing-version check as passing', () => {
  const result = verify();
  const versionCheck = result.checks.find((item) => item.label.startsWith('iOS marketing version'));
  assert.ok(versionCheck, 'the readiness gate must check the iOS marketing version');
  assert.equal(versionCheck.ok, true);
});
