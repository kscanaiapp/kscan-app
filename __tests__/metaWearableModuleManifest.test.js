'use strict';

// Coverage for the Meta module's Android manifest gating.
//
// WHY THIS FILE EXISTS. modules/kscan-meta-wearable is an Expo local module, so
// expo-modules-autolinking links it into EVERY K Scan Android build — the
// `kscan.mwdat.enabled` flag gates the DAT source set and dependencies, not
// whether the library is part of the app. Anything its main manifest declares
// is therefore merged into the shipping app unconditionally.
//
// Its main manifest declared BLUETOOTH and BLUETOOTH_CONNECT. The merged debug
// manifest of a flag-OFF build confirmed it: the app requested Nearby-devices
// access on Android 12+ for hardware it has no code to talk to, and neither
// permission is declared anywhere else in K Scan — so both came solely from
// this module and would have shipped to Play as a new sensitive-permission
// request on a feature users cannot reach.
//
// These tests pin the split that fixed it: the always-merged manifest declares
// nothing, and the DAT permissions live in a manifest only selected when the
// flag is on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_ANDROID = path.join(__dirname, '..', 'modules', 'kscan-meta-wearable', 'android');
const MAIN_MANIFEST = path.join(MODULE_ANDROID, 'src', 'main', 'AndroidManifest.xml');
const MWDAT_MANIFEST = path.join(MODULE_ANDROID, 'src', 'mwdat', 'AndroidManifest.xml');
const BUILD_GRADLE = path.join(MODULE_ANDROID, 'build.gradle');

const read = (p) => fs.readFileSync(p, 'utf8');
const permissionsIn = (xml) =>
  [...xml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);

test('the always-merged manifest requests no permissions at all', () => {
  const declared = permissionsIn(read(MAIN_MANIFEST));
  assert.deepEqual(declared, [], `flag-off manifest still declares: ${declared.join(', ')}`);
});

test('the always-merged manifest contributes no Meta DAT metadata either', () => {
  assert.ok(
    !/com\.meta\.wearable/.test(read(MAIN_MANIFEST)),
    'DAT App Model metadata is merged into builds with no DAT SDK',
  );
});

test('the DAT permissions exist, but only in the flag-gated manifest', () => {
  const declared = permissionsIn(read(MWDAT_MANIFEST));
  assert.ok(declared.includes('android.permission.BLUETOOTH_CONNECT'));
  assert.ok(declared.includes('android.permission.BLUETOOTH'));
  assert.match(read(MWDAT_MANIFEST), /com\.meta\.wearable\.mwdat\.DAM_ENABLED/);
});

test('the legacy BLUETOOTH permission stays capped at API 30', () => {
  assert.match(
    read(MWDAT_MANIFEST),
    /android:name="android\.permission\.BLUETOOTH"[^>]*android:maxSdkVersion="30"/,
  );
});

test('the gated manifest is selected by the same flag as the DAT source set', () => {
  const gradle = read(BUILD_GRADLE);
  const gated = gradle.slice(gradle.indexOf('if (mwdatEnabled) {'));
  assert.match(gated, /sourceSets\.main\.java\.srcDirs \+= 'src\/mwdat\/java'/);
  assert.match(gated, /sourceSets\.main\.manifest\.srcFile 'src\/mwdat\/AndroidManifest\.xml'/);
});

test('nothing outside the flag block points the build at the DAT manifest', () => {
  const gradle = read(BUILD_GRADLE);
  const beforeGate = gradle.slice(0, gradle.indexOf('if (mwdatEnabled) {'));
  assert.ok(
    !/src\/mwdat\/AndroidManifest\.xml/.test(beforeGate),
    'the DAT manifest is selected before the flag is consulted',
  );
});
