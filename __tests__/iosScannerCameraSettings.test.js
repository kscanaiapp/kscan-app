'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * iOS scanner camera gate (app.js).
 *
 * After a camera denial iOS never shows the prompt again, so requestPermission()
 * resolves without any UI. The "Grant Access" button did nothing while the copy
 * said "Enable it in settings to continue", with no way to get there. On iOS the
 * button now opens Settings once the prompt can no longer be shown; Android,
 * which can prompt again, still calls requestPermission().
 */

const ROOT = path.resolve(__dirname, '..');

/** The `if (!permission.granted) { ... }` block of the scanner screen. */
function permissionGate(source) {
  const start = source.indexOf('if (!permission.granted) {');
  assert.notEqual(start, -1, 'the scanner permission gate exists');
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end + 4);
}

function gateProblems(gate) {
  const problems = [];
  if (!gate.includes("Platform.OS === 'ios' && permission.canAskAgain === false")) {
    problems.push('the gate does not detect an iOS denial that can no longer prompt');
  }
  if (!/openSettingsInstead \? \(\) => Linking\.openSettings\(\) : requestPermission/.test(gate)) {
    problems.push('the button does not open Settings on iOS after a denial');
  }
  if (!gate.includes("openSettingsInstead ? 'Open Settings' : 'Grant Access'")) {
    problems.push('the button label does not say where it goes');
  }
  return problems;
}

test('iOS scanner camera gate opens Settings once the prompt cannot be shown again', () => {
  const gate = permissionGate(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
  assert.deepEqual(gateProblems(gate), []);
  assert.match(gate, /Enable it in settings to continue/);
});

test('negative control: a gate that only re-requests permission is reported', () => {
  const gate = permissionGate(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'))
    .replace('() => Linking.openSettings()', 'requestPermission');
  assert.deepEqual(gateProblems(gate), ['the button does not open Settings on iOS after a denial']);
});
