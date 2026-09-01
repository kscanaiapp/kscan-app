'use strict';

/**
 * Voice Scan native wiring + rollout containment.
 *
 * WHY THIS FILE EXISTS.
 *
 * The Voice Scan recovery found `modules/kscan-voice-native/` fully present in
 * the tree -- Swift module, Kotlin module, expo-module.config.json, podspec,
 * TypeScript surface -- and completely INERT. `package.json` did not depend on
 * it, so npm never linked it into `node_modules`, so Expo autolinking never
 * discovered it, so the native code was never compiled into the app.
 *
 * Every other Voice test still passed. They exercise the pure modules
 * (state machine, transcript, telemetry, submission routing) and read source
 * text; none of them can observe autolinking. The failure mode is
 * `requireNativeModule('KScanVoiceNative')` throwing at RUNTIME, on the first
 * Voice tap, on a real device -- the one place no JS test looks.
 *
 * A file-copy is not a recovery. These tests assert the module is WIRED.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'modules', 'kscan-voice-native');
const PACKAGE_NAME = 'kscan-voice-native';
/** The name KScanVoiceNativeModule.ts passes to requireNativeModule(). */
const NATIVE_MODULE_NAME = 'KScanVoiceNative';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ── dependency registration ─────────────────────────────────────────────────

test('the Voice native module is registered as a dependency', () => {
  const spec = pkg.dependencies?.[PACKAGE_NAME];
  assert.equal(
    typeof spec,
    'string',
    `${PACKAGE_NAME} must be a dependency -- without it npm never links the module `
      + 'into node_modules and Expo autolinking cannot find the native code',
  );
  assert.match(
    spec,
    /^file:\.\/modules\/kscan-voice-native$/,
    'must be the local file: spec, so the checked-in module is what gets linked',
  );
});

test('the lockfile records the local Voice module link', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const entry =
    lock.packages?.[`node_modules/${PACKAGE_NAME}`] ?? lock.packages?.[`modules/${PACKAGE_NAME}`];
  assert.ok(
    entry,
    'package-lock.json must record the module -- a package.json edit without a regenerated '
      + 'lockfile leaves `npm ci` (what CI and EAS run) installing nothing',
  );
});

// ── the module itself is a complete, loadable Expo module ───────────────────

test('the Expo module config declares both native platforms', () => {
  const config = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'expo-module.config.json'), 'utf8'));
  assert.deepEqual([...config.platforms].sort(), ['android', 'apple']);
  assert.ok(config.apple?.modules?.includes('KScanVoiceNativeModule'), 'apple module must be declared');
  assert.ok(
    config.android?.modules?.includes('expo.modules.kscanvoicenative.KScanVoiceNativeModule'),
    'android module must be declared by fully-qualified class name',
  );
  // The podspec must exist or the iOS pod install stage fails.
  assert.ok(fs.existsSync(path.join(MODULE_DIR, config.apple.podspec)), 'declared podspec must exist');
});

test('both native implementations are present', () => {
  assert.ok(fs.existsSync(path.join(MODULE_DIR, 'ios', 'KScanVoiceNativeModule.swift')));
  assert.ok(
    fs.existsSync(
      path.join(MODULE_DIR, 'android', 'src', 'main', 'java', 'expo', 'modules', 'kscanvoicenative', 'KScanVoiceNativeModule.kt'),
    ),
  );
});

test('the native module name the JS asks for matches what both platforms register', () => {
  // requireNativeModule() resolves by the NAME the native side registers, not
  // by the package name. A rename on one side and not the other fails only at
  // runtime, per-platform.
  const bridge = fs.readFileSync(path.join(MODULE_DIR, 'src', 'KScanVoiceNativeModule.ts'), 'utf8');
  assert.match(bridge, new RegExp(`requireNativeModule<[^>]*>\\('${NATIVE_MODULE_NAME}'\\)`));

  const swift = fs.readFileSync(path.join(MODULE_DIR, 'ios', 'KScanVoiceNativeModule.swift'), 'utf8');
  assert.match(swift, new RegExp(`Name\\("${NATIVE_MODULE_NAME}"\\)`), 'Swift must register the same name');

  const kotlin = fs.readFileSync(
    path.join(MODULE_DIR, 'android', 'src', 'main', 'java', 'expo', 'modules', 'kscanvoicenative', 'KScanVoiceNativeModule.kt'),
    'utf8',
  );
  assert.match(kotlin, new RegExp(`Name\\("${NATIVE_MODULE_NAME}"\\)`), 'Kotlin must register the same name');
});

// ── autolinking actually resolves it ────────────────────────────────────────
//
// The decisive check. Everything above can be true while the module is still
// invisible to the build; this runs Expo's own resolver.

function autolinkingFinds(platform) {
  // Invoke the local resolver through node rather than `npx`: on Windows
  // spawnSync cannot execute npx.cmd without a shell, and resolving the bin
  // directly also pins the test to this repo's autolinking version.
  const cli = path.join(ROOT, 'node_modules', 'expo-modules-autolinking', 'bin', 'expo-modules-autolinking.js');
  assert.ok(fs.existsSync(cli), 'expo-modules-autolinking must be installed');
  const out = execFileSync(process.execPath, [cli, 'search', '-p', platform], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.includes(PACKAGE_NAME);
}

test('Expo autolinking resolves the Voice module for apple', () => {
  assert.ok(autolinkingFinds('apple'), `autolinking must find ${PACKAGE_NAME} for apple`);
});

test('Expo autolinking resolves the Voice module for android', () => {
  assert.ok(autolinkingFinds('android'), `autolinking must find ${PACKAGE_NAME} for android`);
});

// ── bridge/runtime version compatibility (addendum §38) ─────────────────────

test('the Voice module peer-depends on the runtime the app actually ships', () => {
  const modulePkg = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'package.json'), 'utf8'));
  for (const peer of ['expo', 'react', 'react-native']) {
    assert.ok(modulePkg.peerDependencies?.[peer], `${peer} must be a peer dependency`);
  }
  // expo-modules-core is the bridge surface KScanVoiceNativeModule.ts compiles
  // against. It must be resolvable from the app, or the TS build breaks before
  // any native compile does.
  assert.ok(
    fs.existsSync(path.join(ROOT, 'node_modules', 'expo-modules-core', 'package.json')),
    'expo-modules-core must be installed for the native bridge to type-check',
  );
});

// ── rollout containment: NC-VOICE-007 (addendum §42) ────────────────────────
//
// Recovery restores the IMPLEMENTATION. It does not decide production
// availability -- that stays an owner decision. These pin that separation as
// an executable check rather than a convention.

const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
const { resolveEasBuildProfile } = require('../scripts/resolve-eas-build-profiles');

test('production never enables Voice Scan', () => {
  const production = resolveEasBuildProfile(eas, 'production');
  assert.notEqual(
    production.env?.EXPO_PUBLIC_VOICESCAN_ENABLED,
    'true',
    'Voice Scan rollout to production is a separate owner decision, not a consequence of recovery',
  );
});

test('Voice Scan is enabled in exactly the certification profile, nowhere else', () => {
  const enabled = Object.keys(eas.build).filter(
    (name) => resolveEasBuildProfile(eas, name).env?.EXPO_PUBLIC_VOICESCAN_ENABLED === 'true',
  );
  assert.deepEqual(
    enabled,
    ['staging-certification'],
    'exactly one profile may carry Voice Scan; add new ones deliberately',
  );
});

test('the flag resolver fails closed on anything but the exact string "true"', () => {
  // Guards the §19 contract at the source, independent of any profile.
  const flags = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');
  assert.match(
    flags,
    /export function resolveVoiceScanEnabled\([\s\S]*?\)\s*:\s*boolean\s*\{\s*return value === 'true';\s*\}/,
    'resolveVoiceScanEnabled must be an exact-string comparison, never a truthiness check',
  );
});
