// K+ boundary FEATURE FLAG suite.
//
// Proves KPLUS_EARLY_ACCESS_ENABLED and VOICESCAN_ENABLED each fail closed on
// anything but the exact string 'true', and that the two are independent in
// both directions. VOICESCAN_ENABLED became env-resolved (was a hardcoded
// false) for the Build 34 staging TestFlight profile; Voice Scan itself is
// still unimplemented. Build 34 K+ Early Access shell (section 8) DOES now read this flag
// from components/text-scan/TextScanFeatureRow.tsx, to hide the K+ Voice
// Scan pill while Voice Scan itself is disabled -- see kplusSurfaceWiring.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FLAGS_PATH = path.join(ROOT, 'constants', 'featureFlags.ts');
const flagsSource = fs.readFileSync(FLAGS_PATH, 'utf8');

function loadFlags(env = {}) {
  const source = ts.transpileModule(flagsSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: () => ({}),
    process: { env },
    __DEV__: false,
    console,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(source, sandbox, { filename: 'constants/featureFlags.ts' });
  return sandbox.module.exports;
}

test('KPLUS_EARLY_ACCESS_ENABLED defaults off', () => {
  const flags = loadFlags({});
  assert.equal(flags.KPLUS_EARLY_ACCESS_ENABLED, false);
});

test('resolveKPlusEarlyAccessEnabled fails closed on anything but the exact string "true"', () => {
  const flags = loadFlags({});
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', 'true ']) {
    assert.equal(flags.resolveKPlusEarlyAccessEnabled(value), false, `expected false for ${JSON.stringify(value)}`);
  }
  assert.equal(flags.resolveKPlusEarlyAccessEnabled('true'), true);
});

test('KPLUS_EARLY_ACCESS_ENABLED turns on only via EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED=true', () => {
  assert.equal(loadFlags({ EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'true' }).KPLUS_EARLY_ACCESS_ENABLED, true);
  assert.equal(loadFlags({ EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'false' }).KPLUS_EARLY_ACCESS_ENABLED, false);
});

// Build 34 staging TestFlight: VOICESCAN_ENABLED was converted from a hardcoded
// `false` to an environment-resolved, fail-closed flag so a SINGLE profile
// (`testflight-staging`) can carry it without turning it on everywhere. The
// previous assertion here pinned the literal `export const VOICESCAN_ENABLED =
// false;` declaration; that is deliberately replaced by the behavioural
// assertions below, which are strictly stronger — they prove the default is
// still off AND that every near-miss value fails closed, which the literal
// check never did.
//
// What has NOT changed: Voice Scan is still not implemented (no recorder, no
// STT dependency, no transcription function). Enabling the flag only swaps a
// "Coming Soon" card for a K+ acquisition card. The guarantee that no
// microphone path exists is asserted by __tests__/iosAppReviewSurface.test.js,
// which is untouched, and the production profile is asserted to keep the flag
// off in __tests__/testflightStagingProfile.test.js.

test('VOICESCAN_ENABLED defaults off when the env value is absent', () => {
  const flags = loadFlags({ EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'true' });
  assert.equal(flags.VOICESCAN_ENABLED, false);
});

test('resolveVoiceScanEnabled fails closed on anything but the exact string "true"', () => {
  const flags = loadFlags({});
  for (const value of [undefined, '', 'false', 'FALSE', 'TRUE', 'True', '1', 'yes', 'true ', ' true']) {
    assert.equal(flags.resolveVoiceScanEnabled(value), false, `expected false for ${JSON.stringify(value)}`);
  }
  assert.equal(flags.resolveVoiceScanEnabled('true'), true);
});

test('VOICESCAN_ENABLED turns on only via EXPO_PUBLIC_VOICESCAN_ENABLED=true', () => {
  assert.equal(loadFlags({ EXPO_PUBLIC_VOICESCAN_ENABLED: 'true' }).VOICESCAN_ENABLED, true);
  assert.equal(loadFlags({ EXPO_PUBLIC_VOICESCAN_ENABLED: 'false' }).VOICESCAN_ENABLED, false);
});

test('VOICESCAN_ENABLED is not coupled to the K+ boundary flag in either direction', () => {
  // A K+ member must not acquire Voice Scan implicitly, and enabling Voice Scan
  // must not imply K+. TextScanFeatureRow requires BOTH before it renders the
  // K+ pill; these are the independent halves of that conjunction.
  assert.equal(loadFlags({ EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'true' }).VOICESCAN_ENABLED, false);
  assert.equal(loadFlags({ EXPO_PUBLIC_VOICESCAN_ENABLED: 'true' }).KPLUS_EARLY_ACCESS_ENABLED, false);
});
