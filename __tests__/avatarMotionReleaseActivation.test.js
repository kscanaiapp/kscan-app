// Build 29 avatar-motion RELEASE ACTIVATION contract.
//
// WHY THIS EXISTS: PR #152 integrated the avatar motion system with a
// deliberately fail-closed flag —
//
//   AVATAR_MOTION_V1_ENABLED = process.env.EXPO_PUBLIC_AVATAR_MOTION_V1 === 'true'
//
// — and no EAS profile set it. The product decision is that avatar motion SHIPS
// in Build 29, so every profile that must exercise it would have shipped dark,
// and nothing in the repository would have objected. A comment saying "enable
// locally" is not a release contract.
//
// The source default stays false on purpose: a feature that turns itself on
// cannot be turned off by configuration. What is asserted here is that the
// PROFILES say so explicitly, and that the speech FIXTURE never does.
//
// Follows the existing closetCandidateFeatureFlags convention: the real flag
// module is transpiled and evaluated against explicit env, so the derived
// capability is exercised rather than pattern-matched out of source text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FLAGS_PATH = path.join(ROOT, 'constants', 'featureFlags.ts');
const EAS_PATH = path.join(ROOT, 'eas.json');

const flagsSource = fs.readFileSync(FLAGS_PATH, 'utf8');
const eas = JSON.parse(fs.readFileSync(EAS_PATH, 'utf8'));

const MOTION_KEY = 'EXPO_PUBLIC_AVATAR_MOTION_V1';
const FIXTURE_KEY = 'EXPO_PUBLIC_AVATAR_SPEECH_FIXTURE';

/** Profiles that build a shipping or certifiable Build 29 artifact. */
const SHIPPING_PROFILES = ['production', 'staging'];
/** Profiles used for emulator / device QA of Build 29. */
const QA_PROFILES = ['preview', 'development'];

function loadFlags(env = {}) {
  const source = ts.transpileModule(flagsSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require,
    process: { env },
    __DEV__: false,
  });
  vm.runInContext(source, context);
  return module.exports;
}

function profileEnv(name) {
  const profile = eas.build?.[name];
  assert.ok(profile, `eas.json has no ${name} profile`);
  return profile.env || {};
}

// ── The activation contract ─────────────────────────────────────────────────

for (const name of SHIPPING_PROFILES) {
  test(`${name} explicitly enables avatar motion for Build 29`, () => {
    assert.equal(
      profileEnv(name)[MOTION_KEY],
      'true',
      `${name} must set ${MOTION_KEY}="true"; the source default is false, so an ` +
        'absent value ships the avatar dark',
    );
  });
}

for (const name of QA_PROFILES) {
  test(`${name} enables avatar motion so QA can exercise it`, () => {
    // Emulator/device certification cannot certify a feature it cannot reach.
    assert.equal(profileEnv(name)[MOTION_KEY], 'true', `${name} must set ${MOTION_KEY}="true"`);
  });
}

// ── The fixture must never ship ─────────────────────────────────────────────

for (const name of SHIPPING_PROFILES) {
  test(`${name} does NOT enable the avatar speech fixture`, () => {
    // Bundled fixture audio bypassing the provider must never reach a shipping
    // or certification artifact. Absent is correct; "false" is also acceptable.
    const value = profileEnv(name)[FIXTURE_KEY];
    assert.notEqual(value, 'true', `${name} must not enable ${FIXTURE_KEY}`);
  });
}

test('no profile whatsoever enables the speech fixture', () => {
  for (const name of Object.keys(eas.build || {})) {
    assert.notEqual(
      profileEnv(name)[FIXTURE_KEY],
      'true',
      `${name} enables ${FIXTURE_KEY}; the fixture is development-only`,
    );
  }
});

// ── The source contract must stay fail-closed ───────────────────────────────

test('AVATAR_MOTION_V1_ENABLED remains explicit opt-in in source', () => {
  // A feature that defaults ON cannot be switched off by configuration, which
  // would make the profiles above decorative.
  assert.equal(loadFlags({}).AVATAR_MOTION_V1_ENABLED, false, 'absent env must be false');
  assert.equal(loadFlags({ [MOTION_KEY]: 'false' }).AVATAR_MOTION_V1_ENABLED, false);
  assert.equal(loadFlags({ [MOTION_KEY]: '1' }).AVATAR_MOTION_V1_ENABLED, false);
  assert.equal(loadFlags({ [MOTION_KEY]: 'TRUE' }).AVATAR_MOTION_V1_ENABLED, false);
  assert.equal(loadFlags({ [MOTION_KEY]: 'true' }).AVATAR_MOTION_V1_ENABLED, true);
});

test('the speech fixture is independently fail-closed', () => {
  assert.equal(loadFlags({}).AVATAR_SPEECH_FIXTURE_ENABLED, false);
  assert.equal(loadFlags({ [MOTION_KEY]: 'true' }).AVATAR_SPEECH_FIXTURE_ENABLED, false);
});

// ── The profile value actually produces the enabled capability ──────────────

for (const name of [...SHIPPING_PROFILES, ...QA_PROFILES]) {
  test(`${name}'s declared value resolves to an enabled avatar capability`, () => {
    // Bridges config to behaviour: asserts the string in eas.json is the exact
    // string the flag module accepts, not merely present.
    const flags = loadFlags(profileEnv(name));
    assert.equal(flags.AVATAR_MOTION_V1_ENABLED, true, `${name} resolves to motion disabled`);
    assert.equal(flags.AVATAR_SPEECH_FIXTURE_ENABLED, false, `${name} resolves the fixture on`);
  });
}

// ── Platform parity ─────────────────────────────────────────────────────────

test('avatar activation is profile-level, so iOS and Android get the same value', () => {
  // The flag must not live under a per-platform block, or one platform would
  // ship the feature and the other would ship it dark from the same profile.
  for (const name of [...SHIPPING_PROFILES, ...QA_PROFILES]) {
    const profile = eas.build[name];
    for (const platform of ['ios', 'android']) {
      const platformBlock = profile[platform];
      if (!platformBlock || typeof platformBlock !== 'object') continue;
      assert.ok(
        !Object.prototype.hasOwnProperty.call(platformBlock.env || {}, MOTION_KEY),
        `${name}.${platform} overrides ${MOTION_KEY}; activation must stay profile-level`,
      );
    }
    assert.equal(
      profileEnv(name)[MOTION_KEY],
      'true',
      `${name} must carry the shared profile-level value`,
    );
  }
});

test('motion activation does not imply voice, and voice does not gate motion', () => {
  // Build 29 invariant: the two systems are independent. Enabling motion must
  // not switch speech on, and a speech flag must not be required for motion.
  const motionOnly = loadFlags({ [MOTION_KEY]: 'true' });
  assert.equal(motionOnly.AVATAR_MOTION_V1_ENABLED, true);
  assert.equal(motionOnly.AVATAR_SPEECH_FIXTURE_ENABLED, false);

  const withFixture = loadFlags({ [FIXTURE_KEY]: 'true' });
  assert.equal(
    withFixture.AVATAR_MOTION_V1_ENABLED,
    false,
    'a speech-side flag must not enable motion',
  );
});
