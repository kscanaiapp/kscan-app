// K+ boundary FEATURE FLAG suite.
//
// Proves KPLUS_EARLY_ACCESS_ENABLED fails closed on anything but the exact
// string 'true', and that VOICESCAN_ENABLED is a SEPARATE gate that fails
// closed the same way.
//
// Build 34 Android certification converged the accepted Voice Scan
// implementation (PR #218) onto this lineage, so VOICESCAN_ENABLED is now an
// env-driven resolver rather than the hardcoded `false` it was while there
// was nothing to switch on. The two flags answer different questions and are
// asserted independently here:
//
//   KPLUS_EARLY_ACCESS_ENABLED  does the K+ boundary EXIST in this build
//   VOICESCAN_ENABLED           is the Voice capability BUILT in this build
//   the user's entitlement      may THIS user use it (runtime, not a flag)
//
// All three must be true for Voice to run. Build 34 K+ Early Access shell
// (section 8) reads both flags from components/text-scan/TextScanFeatureRow.tsx
// so the K+ Voice pill cannot advertise a capability the build lacks -- see
// kplusSurfaceWiring.test.js.

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

// CONVERGENCE (Build 34 Android certification). This test previously
// asserted `export const VOICESCAN_ENABLED = false;` as a literal. That was
// never a policy decision to keep Voice Scan off permanently -- it recorded
// that this lineage had no Voice Scan implementation to switch on, so a flag
// would have advertised a capability the build could not execute. The
// accepted implementation (PR #218) is now converged onto this lineage, so
// the constant is an env-driven resolver like every other staged rollout.
//
// What the test protects is unchanged, and is what actually mattered:
// K+ and Voice are INDEPENDENT gates, and Voice fails closed by default.
test('VOICESCAN_ENABLED is env-driven and defaults OFF, independently of K+', () => {
  // K+ on, Voice unset -> Voice still off. The K+ boundary existing must
  // never imply a K+-gated capability is available.
  const flags = loadFlags({ EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'true' });
  assert.equal(flags.VOICESCAN_ENABLED, false);
  assert.doesNotMatch(
    flagsSource,
    /export const VOICESCAN_ENABLED = false;/,
    'Voice Scan is implemented on this lineage; a hardcoded constant would make the flag unreachable',
  );
  assert.match(flagsSource, /export const VOICESCAN_ENABLED = resolveVoiceScanEnabled\(\);/);
});

test('resolveVoiceScanEnabled fails closed on anything but the exact string "true"', () => {
  const flags = loadFlags({});
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', 'true ']) {
    assert.equal(flags.resolveVoiceScanEnabled(value), false, `expected false for ${JSON.stringify(value)}`);
  }
  assert.equal(flags.resolveVoiceScanEnabled('true'), true);
});

test('VOICESCAN_ENABLED turns on only via EXPO_PUBLIC_VOICESCAN_ENABLED=true', () => {
  assert.equal(loadFlags({ EXPO_PUBLIC_VOICESCAN_ENABLED: 'true' }).VOICESCAN_ENABLED, true);
  assert.equal(loadFlags({ EXPO_PUBLIC_VOICESCAN_ENABLED: 'false' }).VOICESCAN_ENABLED, false);
});

test('Voice Scan without K+ is still refused -- the flag is not an entitlement', () => {
  // Voice ON, K+ OFF. The flag decides whether the capability is BUILT; the
  // entitlement decides whether this user may use it. useVoiceScan dispatches
  // NOT_KPLUS before any permission request or listening session, and
  // VoiceScanButton routes the tap to the upgrade sheet instead.
  const flags = loadFlags({ EXPO_PUBLIC_VOICESCAN_ENABLED: 'true' });
  assert.equal(flags.VOICESCAN_ENABLED, true);
  assert.equal(flags.KPLUS_EARLY_ACCESS_ENABLED, false);

  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useVoiceScan.ts'), 'utf8');
  assert.match(
    hook,
    /if \(!isKPlusActive\) \{\s*dispatch\(\{ type: 'NOT_KPLUS' \}\);\s*return;\s*\}/,
    'startSession must refuse before requesting the microphone when K+ is inactive',
  );
  // And the K+ check must come BEFORE any capability/permission call.
  const startSession = hook.slice(hook.indexOf('const startSession'), hook.indexOf('const stopSession'));
  assert.ok(
    startSession.indexOf("dispatch({ type: 'NOT_KPLUS' })") <
      startSession.indexOf('requestVoiceRecordingPermission'),
    'the entitlement check must precede the permission request',
  );
});
