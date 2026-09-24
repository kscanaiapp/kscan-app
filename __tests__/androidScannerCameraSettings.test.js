'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Android scanner camera gate (app.js) - B34-SHARED-SCANNER-ANDROID-DENIAL-001,
 * ANDROID_EFFECT_SHARED_REPAIR.
 *
 * Once Android stops showing the camera permission dialog (the user chose
 * "Don't ask again", so expo-camera reports canAskAgain === false),
 * requestPermission() resolves without any UI. The gate only opened Settings on
 * iOS, so an Android user in that state was left on a "Grant Access" button that
 * did nothing while the copy said "Enable it in settings to continue".
 *
 * The gate now opens Settings on both mobile platforms once the prompt can no
 * longer be shown. Everything else is unchanged: canAskAgain === true still
 * calls requestPermission() on both, and any other platform (web, ...) keeps
 * the pre-repair behaviour.
 *
 * The decision is asserted as behaviour, not as text: the real initializer of
 * `openSettingsInstead` is lifted out of app.js and evaluated over the whole
 * platform x canAskAgain matrix.
 */

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

/** The expression this gate had before the repair (iOS only). */
const PRE_REPAIR_EXPRESSION = "Platform.OS === 'ios' && permission.canAskAgain === false";

const PLATFORMS = ['ios', 'android', 'web', 'windows', 'macos'];
const CAN_ASK_AGAIN = [false, true, undefined];

/** The `if (!permission.granted) { ... }` block of the scanner screen. */
function permissionGate(source) {
  const start = source.indexOf('if (!permission.granted) {');
  assert.notEqual(start, -1, 'the scanner permission gate exists');
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end + 4);
}

/** The initializer of `const openSettingsInstead = ...;` inside the gate. */
function openSettingsExpression(gate) {
  const match = /const openSettingsInstead =\s*([\s\S]*?);\n/.exec(gate);
  assert.ok(match, 'the gate declares openSettingsInstead');
  return match[1].trim();
}

function opensSettings(expression, platformOS, canAskAgain) {
  const evaluate = new Function('Platform', 'permission', `return (${expression});`);
  return evaluate({ OS: platformOS }, { granted: false, canAskAgain });
}

/** The behaviour the gate must have, as a list of violated invariants. */
function invariantProblems(expression) {
  const problems = [];
  const at = (os, canAskAgain) => opensSettings(expression, os, canAskAgain);

  if (at('android', false) !== true) problems.push('ANDROID + canAskAgain=false must open Settings');
  if (at('android', true) !== false) problems.push('ANDROID + canAskAgain=true must call requestPermission');
  if (at('ios', false) !== true) problems.push('IOS + canAskAgain=false must open Settings');
  if (at('ios', true) !== false) problems.push('IOS + canAskAgain=true must call requestPermission');

  for (const os of PLATFORMS) {
    for (const canAskAgain of CAN_ASK_AGAIN) {
      const isMobile = os === 'ios' || os === 'android';
      const expected = isMobile && canAskAgain === false;
      if (at(os, canAskAgain) !== expected) {
        problems.push(`${os} + canAskAgain=${String(canAskAgain)} must be ${expected}`);
      }
    }
  }
  return problems;
}

test('Android opens Settings once the camera prompt can no longer be shown', () => {
  const expression = openSettingsExpression(permissionGate(APP_SOURCE));
  assert.equal(opensSettings(expression, 'android', false), true);
  assert.equal(opensSettings(expression, 'android', true), false);
});

test('iOS behaviour is identical to the pre-repair source across the whole matrix', () => {
  const expression = openSettingsExpression(permissionGate(APP_SOURCE));
  for (const canAskAgain of CAN_ASK_AGAIN) {
    assert.equal(
      opensSettings(expression, 'ios', canAskAgain),
      opensSettings(PRE_REPAIR_EXPRESSION, 'ios', canAskAgain),
      `iOS with canAskAgain=${String(canAskAgain)} changed`,
    );
  }
});

test('every platform other than iOS and Android keeps the pre-repair behaviour', () => {
  const expression = openSettingsExpression(permissionGate(APP_SOURCE));
  for (const os of PLATFORMS.filter((name) => name !== 'ios' && name !== 'android')) {
    for (const canAskAgain of CAN_ASK_AGAIN) {
      assert.equal(
        opensSettings(expression, os, canAskAgain),
        opensSettings(PRE_REPAIR_EXPRESSION, os, canAskAgain),
        `${os} with canAskAgain=${String(canAskAgain)} changed`,
      );
    }
  }
});

test('the only behavioural change is Android with canAskAgain=false', () => {
  const expression = openSettingsExpression(permissionGate(APP_SOURCE));
  const changed = [];
  for (const os of PLATFORMS) {
    for (const canAskAgain of CAN_ASK_AGAIN) {
      if (opensSettings(expression, os, canAskAgain) !== opensSettings(PRE_REPAIR_EXPRESSION, os, canAskAgain)) {
        changed.push(`${os}/${String(canAskAgain)}`);
      }
    }
  }
  assert.deepEqual(changed, ['android/false']);
});

test('the full invariant set holds for the real gate', () => {
  assert.deepEqual(invariantProblems(openSettingsExpression(permissionGate(APP_SOURCE))), []);
});

test('the button still routes to Settings or requestPermission, and Linking/Platform are imported', () => {
  const gate = permissionGate(APP_SOURCE);
  assert.match(gate, /openSettingsInstead \? \(\) => Linking\.openSettings\(\) : requestPermission/);
  assert.match(gate, /openSettingsInstead \? 'Open Settings' : 'Grant Access'/);
  assert.match(gate, /Enable it in settings to continue/);

  const reactNativeImport = /import \{([^}]*)\} from 'react-native';/.exec(APP_SOURCE);
  assert.ok(reactNativeImport, 'app.js imports from react-native');
  assert.match(reactNativeImport[1], /\bLinking\b/);
  assert.match(reactNativeImport[1], /\bPlatform\b/);
});

test('NEGATIVE CONTROL: the pre-repair iOS-only gate is reported for Android', () => {
  assert.deepEqual(invariantProblems(PRE_REPAIR_EXPRESSION), [
    'ANDROID + canAskAgain=false must open Settings',
    'android + canAskAgain=false must be true',
  ]);
});

test('NEGATIVE CONTROL: a gate that also changed iOS or web is reported', () => {
  const everywhere = 'permission.canAskAgain === false';
  assert.notDeepEqual(invariantProblems(everywhere), [], 'opening Settings on web must be reported');

  const androidOnly = "Platform.OS === 'android' && permission.canAskAgain === false";
  assert.deepEqual(invariantProblems(androidOnly), [
    'IOS + canAskAgain=false must open Settings',
    'ios + canAskAgain=false must be true',
  ]);
});
