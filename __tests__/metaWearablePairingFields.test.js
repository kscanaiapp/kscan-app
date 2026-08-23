'use strict';

// Coverage for services/metaWearablePairingFields.ts.
//
// WHY THIS FILE EXISTS. `pair.create` copies the pair.request payload into
// `wearable_pairings`, and K Scan AI Staging enforces (verified 2026-08-23
// against pg_constraint):
//
//   wearable_pairings_device_model_check
//     CHECK (char_length(device_model)       >= 1 AND char_length(device_model)       <= 80)
//   wearable_pairings_device_app_version_check
//     CHECK (char_length(device_app_version) >= 1 AND char_length(device_app_version) <= 40)
//
// The companion sent a hard-coded `appVersion: ''`, which is zero-length, so
// EVERY pair.create was rejected by Postgres and surfaced as a generic
// `PAIR_CREATE_FAILED` — pairing could never complete. Neither constraint is in
// the committed migration, so this could not be caught by any environment built
// from source; only real staging rejects it.
//
// These tests pin the clamping so an empty (or whitespace-only, or overlong)
// value can never leave the device again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'services', 'metaWearablePairingFields.ts');
const COMPANION_SRC = path.join(__dirname, '..', 'services', 'metaWearableCompanion.ts');

function loadModule() {
  const output = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: (id) => {
      throw new Error(`Unexpected runtime require in metaWearablePairingFields.ts: ${id}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(output, sandbox, { filename: 'metaWearablePairingFields.ts' });
  return mod.exports;
}

const M = loadModule();

test('THE DEFECT: an empty app version never leaves the device', () => {
  // '' is exactly what the companion hard-coded, and exactly what Postgres
  // rejected with wearable_pairings_device_app_version_check.
  assert.equal(M.toPairingAppVersion(''), M.DEFAULT_APP_VERSION);
  assert.ok(M.toPairingAppVersion('').length >= M.APP_VERSION_MIN);
});

test('a missing, null, or non-string app version falls back rather than becoming ""', () => {
  for (const value of [undefined, null, 0, false, {}, []]) {
    const version = M.toPairingAppVersion(value);
    assert.ok(version.length >= M.APP_VERSION_MIN, `empty for ${JSON.stringify(value)}`);
  }
});

test('a whitespace-only app version falls back too (it collapses to zero length)', () => {
  assert.equal(M.toPairingAppVersion('   \n\t '), M.DEFAULT_APP_VERSION);
});

test('a real app version is passed through untouched', () => {
  assert.equal(M.toPairingAppVersion('1.0.1'), '1.0.1');
  assert.equal(M.toPairingAppVersion('  1.0.1  '), '1.0.1');
});

test('an overlong app version is truncated inside the 40-character bound', () => {
  const version = M.toPairingAppVersion('9'.repeat(200));
  assert.equal(version.length, M.APP_VERSION_MAX);
});

test('device model obeys the same 1..80 bound', () => {
  assert.equal(M.toPairingDeviceModel(''), M.DEFAULT_DEVICE_MODEL);
  assert.equal(M.toPairingDeviceModel('   '), M.DEFAULT_DEVICE_MODEL);
  assert.equal(M.toPairingDeviceModel(undefined), M.DEFAULT_DEVICE_MODEL);
  assert.equal(M.toPairingDeviceModel('K Scan Meta HUD candidate'), 'K Scan Meta HUD candidate');
  assert.equal(M.toPairingDeviceModel('M'.repeat(500)).length, M.DEVICE_MODEL_MAX);
});

test('truncation never leaves a trailing-space-only remainder', () => {
  // A value whose first 40 characters are all whitespace would truncate to a
  // blank string and violate the >= 1 bound all over again.
  const padded = `${' '.repeat(60)}1.0.1`;
  const version = M.toPairingAppVersion(padded);
  assert.ok(version.trim().length >= 1);
  assert.ok(version.length <= M.APP_VERSION_MAX);
});

test('the pairing frame is built from the clamps, not from a literal', () => {
  const companion = fs.readFileSync(COMPANION_SRC, 'utf8');
  assert.match(companion, /model:\s*toPairingDeviceModel\(/);
  assert.match(companion, /appVersion:\s*toPairingAppVersion\(/);
  // Comments are stripped first: the file deliberately quotes the old
  // `appVersion: ''` when explaining the defect, and that prose must not be
  // mistaken for the defect itself.
  const code = companion
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  assert.ok(
    !/appVersion:\s*(''|"")/.test(code),
    "the hard-coded empty appVersion is back — pair.create will fail on staging's CHECK constraint",
  );
});
