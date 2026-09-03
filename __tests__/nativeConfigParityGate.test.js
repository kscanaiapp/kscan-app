'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// B34-DEF-002: four fixture negative controls, matching the ones run by hand
// during the patch -- bundle ID, a removed-but-still-granted permission, a
// deep-link path mismatch, and the Android application ID.

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-native-config-parity.js');
const APP_JSON_PATH = path.join(REPO_ROOT, 'app.json');

// Every file the gate reads, relative to whichever root it is pointed at.
// Build 34 added the build-profile manifest exception rules, so the fixture
// root now also needs eas.json (selector-site check) and both manifests the
// declared exception names -- otherwise a fixture run would fail for
// "file missing" rather than for the mutation under test.
const GATE_INPUTS = [
  'app.json',
  'eas.json',
  path.join('config', 'native-config-authority.json'),
  path.join('android', 'app', 'build.gradle'),
  path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  path.join('android', 'app', 'src', 'release', 'AndroidManifest.xml'),
  path.join('android', 'app', 'src', 'certification', 'AndroidManifest.xml'),
];

function runGate(root = REPO_ROOT) {
  try {
    execFileSync(process.execPath, [GATE_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      env: { ...process.env, NATIVE_CONFIG_PARITY_ROOT: root },
    });
    return 0;
  } catch (error) {
    return error.status;
  }
}

/**
 * Runs a negative control against an ISOLATED COPY of the four files the gate
 * reads, never against this repository's own app.json.
 *
 * The previous version wrote the mutated config straight to REPO_ROOT/app.json
 * and restored it in a finally block. node --test runs test FILES concurrently,
 * so that mutation window was observable by every other test file that reads
 * app.json -- oauthCallback.test.js's Apple sign-in contract test failed in the
 * full suite while passing on its own. A fixture root removes the shared-state
 * race entirely; the gate logic under test is unchanged.
 */
function withMutatedAppJson(mutate, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-config-parity-'));
  try {
    for (const relative of GATE_INPUTS) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, relative), destination);
    }
    const config = JSON.parse(fs.readFileSync(APP_JSON_PATH, 'utf8'));
    mutate(config);
    fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify(config, null, 2));
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

// ─────────── Build 34: governed build-profile manifest exception controls ───
//
// Android is NATIVE_AUTHORITATIVE, so app.json cannot express "this
// permission exists in the staging-certification AAB only". The Voice Scan
// certification microphone is carried by a build-type manifest instead
// (android/app/src/certification/AndroidManifest.xml, selected by the
// `kscan.voiceCertification` Gradle selector). That is a real hole in what
// the old gate could see, so the gate gained rules for it -- and rules
// without negative controls are how DEF-WL-07 happened. Each control below
// reintroduces one specific way the exception could go wrong.
//
// NOTE ON SCOPE: none of these can prove what the manifest MERGER does. They
// prove the source-level invariants. The merged manifest of the built AAB is
// an artifact-verification obligation recorded in
// config/native-config-authority.json (artifactVerificationRequired).

const CERT_MANIFEST = path.join('android', 'app', 'src', 'certification', 'AndroidManifest.xml');
const MAIN_MANIFEST = path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml');

/**
 * Copies the gate's inputs into an isolated fixture root, lets the caller
 * rewrite any of them, then runs the gate there. Same isolation rationale as
 * withMutatedAppJson: node --test runs files concurrently, so mutating this
 * repository's own config in place is observable by every other test file.
 */
function withMutatedFixture(mutate, run = runGate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-config-parity-'));
  try {
    for (const relative of GATE_INPUTS) {
      const source = path.join(REPO_ROOT, relative);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    mutate({
      root,
      read: (relative) => fs.readFileSync(path.join(root, relative), 'utf8'),
      write: (relative, contents) => {
        const destination = path.join(root, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, contents);
      },
      readJson: (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')),
      writeJson: (relative, value) =>
        fs.writeFileSync(path.join(root, relative), JSON.stringify(value, null, 2)),
    });
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the declared Voice certification exception is what the repository actually has', () => {
  // Positive control for everything below: the real, unmutated tree passes,
  // and the exception really is declared (so the controls are not passing
  // vacuously against a tree with no exception at all).
  assert.equal(runGate(), 0);
  const authority = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'config', 'native-config-authority.json'), 'utf8'),
  );
  const exceptions = authority.platforms.android.buildProfileManifestExceptions.exceptions;
  // ANDROID-VOICE-01 added a second, generalized exception alongside the
  // original certification-only one. Both grant the same permission through
  // the same manifest; they differ only in which native selector reaches it
  // and which EAS profiles that selector is approved for.
  assert.equal(exceptions.length, 2, 'exactly two build-profile exceptions are approved');

  const certification = exceptions.find((e) => e.id === 'VOICE_SCAN_CERTIFICATION_MICROPHONE');
  assert.ok(certification, 'the original certification-only exception must still be declared');
  assert.deepEqual(certification.additionalGrantedPermissions, ['android.permission.RECORD_AUDIO']);
  assert.deepEqual(certification.selectorSetByEasProfiles, ['staging-certification']);

  const capability = exceptions.find((e) => e.id === 'VOICE_SCAN_PRODUCTION_READINESS_CAPABILITY');
  assert.ok(capability, 'the ANDROID-VOICE-01 generalized capability exception must be declared');
  assert.equal(capability.selectorGradleProperty, 'kscan.voiceNativeCapability');
  assert.equal(capability.selectorEnvironmentVariable, 'KSCAN_VOICE_NATIVE_CAPABILITY');
  assert.deepEqual(capability.additionalGrantedPermissions, ['android.permission.RECORD_AUDIO']);
  assert.deepEqual(
    capability.selectorSetByEasProfiles,
    [],
    'no EAS profile may commit KSCAN_VOICE_NATIVE_CAPABILITY -- it is supplied out of band only',
  );
  assert.deepEqual(
    capability.mustRemainRemovedEverywhere,
    certification.mustRemainRemovedEverywhere,
    'both exceptions must forbid the identical set of background/foreground-capture permissions',
  );
});

test('negative control: the certification manifest granting an UNDECLARED permission fails the gate', () => {
  const exitCode = withMutatedFixture(({ read, write }) => {
    write(
      CERT_MANIFEST,
      read(CERT_MANIFEST).replace(
        '</manifest>',
        '<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION"/>\n</manifest>',
      ),
    );
  });
  assert.equal(exitCode, 1);
});

test('negative control: a microphone FOREGROUND SERVICE permission in the certification manifest fails the gate', () => {
  // The single most important thing this profile must never acquire: a
  // permission that would let the app capture audio while backgrounded.
  const exitCode = withMutatedFixture(({ read, write }) => {
    write(
      CERT_MANIFEST,
      read(CERT_MANIFEST).replace(
        '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" tools:node="remove"/>',
        '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE"/>',
      ),
    );
  });
  assert.equal(exitCode, 1);
});

test('negative control: a <service> element in the certification manifest fails the gate', () => {
  const exitCode = withMutatedFixture(({ read, write }) => {
    write(
      CERT_MANIFEST,
      read(CERT_MANIFEST).replace(
        '</manifest>',
        '<application><service android:name=".VoiceService"/></application>\n</manifest>',
      ),
    );
  });
  assert.equal(exitCode, 1);
});

test('negative control: the certification manifest dropping a base-release declaration fails the gate', () => {
  // Selecting the certification manifest REPLACES src/release wholesale, so
  // silently losing one of its declarations is a real, invisible regression.
  const exitCode = withMutatedFixture(({ read, write }) => {
    write(
      CERT_MANIFEST,
      read(CERT_MANIFEST).replace(
        '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" tools:node="remove"/>',
        '',
      ),
    );
  });
  assert.equal(exitCode, 1);
});

test('PRODUCTION NEGATIVE CONTROL: promoting RECORD_AUDIO into app.json permissions fails the gate', () => {
  // This is the control that protects the whole design. The point of the
  // exception mechanism is that production is NOT broadened; the moment the
  // microphone is declared for every profile, the mechanism has been defeated
  // and the gate must say so.
  const exitCode = withMutatedFixture(({ readJson, writeJson }) => {
    const config = readJson('app.json');
    config.expo.android.permissions.push('android.permission.RECORD_AUDIO');
    writeJson('app.json', config);
  });
  assert.equal(exitCode, 1);
});

test('PRODUCTION NEGATIVE CONTROL: un-blocking RECORD_AUDIO in app.json fails the gate', () => {
  const exitCode = withMutatedFixture(({ readJson, writeJson }) => {
    const config = readJson('app.json');
    config.expo.android.blockedPermissions = config.expo.android.blockedPermissions.filter(
      (permission) => permission !== 'android.permission.RECORD_AUDIO',
    );
    writeJson('app.json', config);
  });
  assert.equal(exitCode, 1);
});

test('PRODUCTION NEGATIVE CONTROL: granting RECORD_AUDIO in the MAIN manifest fails the gate', () => {
  const exitCode = withMutatedFixture(({ read, write }) => {
    write(
      MAIN_MANIFEST,
      read(MAIN_MANIFEST).replace(
        '<uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="remove"/>',
        '<uses-permission android:name="android.permission.RECORD_AUDIO"/>',
      ),
    );
  });
  assert.equal(exitCode, 1);
});

test('negative control: any profile other than staging-certification setting the selector fails the gate', () => {
  // Flag-leak control at the native layer: the selector is what turns the
  // microphone on, so it leaking into `production` is the native equivalent
  // of an EXPO_PUBLIC flag leaking there.
  const exitCode = withMutatedFixture(({ readJson, writeJson }) => {
    const eas = readJson('eas.json');
    eas.build.production.env.KSCAN_VOICE_CERTIFICATION = 'true';
    writeJson('eas.json', eas);
  });
  assert.equal(exitCode, 1);
});

test('negative control: removing the selector from staging-certification fails the gate', () => {
  // The inverse: a declared exception whose selector nothing sets would give
  // a certification AAB with no microphone and a Voice flag that is on --
  // the exact "looks enabled, cannot work" state this repo keeps catching.
  const exitCode = withMutatedFixture(({ readJson, writeJson }) => {
    const eas = readJson('eas.json');
    delete eas.build['staging-certification'].env.KSCAN_VOICE_CERTIFICATION;
    writeJson('eas.json', eas);
  });
  assert.equal(exitCode, 1);
});

test('negative control: an exception manifest that stops granting its declared permission fails the gate', () => {
  // ANDROID-VOICE-01 (b2): additionalGrantedPermissions is a promise, not
  // just an allowlist -- a manifest that no longer grants what it declares
  // must fail exactly like one that grants something undeclared already did.
  const exitCode = withMutatedFixture(({ read, write }) => {
    write(
      CERT_MANIFEST,
      read(CERT_MANIFEST).replace(
        '<uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="replace"/>',
        '<!-- RECORD_AUDIO grant removed by negative control -->',
      ),
    );
  });
  assert.equal(exitCode, 1);
});

// ── ANDROID-VOICE-01: the generalized capability exception's own controls ──

test('negative control: committing KSCAN_VOICE_NATIVE_CAPABILITY to the production profile fails the gate', () => {
  // The whole point of selectorSetByEasProfiles being empty for this
  // exception is that NO committed profile may carry the selector yet --
  // production included, since that is exactly the future activation this
  // repair must not perform itself.
  const exitCode = withMutatedFixture(({ readJson, writeJson }) => {
    const eas = readJson('eas.json');
    eas.build.production.env = { ...(eas.build.production.env || {}), KSCAN_VOICE_NATIVE_CAPABILITY: 'true' };
    writeJson('eas.json', eas);
  });
  assert.equal(exitCode, 1);
});

test('negative control: committing KSCAN_VOICE_NATIVE_CAPABILITY to staging-certification fails the gate', () => {
  // Even the one profile that already has a working Voice-capable path (via
  // the separate, unaffected KSCAN_VOICE_CERTIFICATION selector) is not an
  // approved site for the NEW selector, because selectorSetByEasProfiles for
  // VOICE_SCAN_PRODUCTION_READINESS_CAPABILITY is deliberately empty today.
  const exitCode = withMutatedFixture(({ readJson, writeJson }) => {
    const eas = readJson('eas.json');
    eas.build['staging-certification'].env.KSCAN_VOICE_NATIVE_CAPABILITY = 'true';
    writeJson('eas.json', eas);
  });
  assert.equal(exitCode, 1);
});

test('negative control: an UNDECLARED build-profile manifest fails the gate', () => {
  const exitCode = withMutatedFixture(({ write }) => {
    write(
      path.join('android', 'app', 'src', 'sneaky', 'AndroidManifest.xml'),
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' +
        '  <uses-permission android:name="android.permission.READ_CONTACTS"/>\n' +
        '</manifest>\n',
    );
  });
  assert.equal(exitCode, 1);
});

test('negative control: a declared exception build.gradle never selects fails the gate', () => {
  // A manifest nothing points at cannot take effect. Without this, the
  // certification build could ship with no microphone while every source
  // check reported the exception as configured.
  const exitCode = withMutatedFixture(({ read, write }) => {
    write(
      path.join('android', 'app', 'build.gradle'),
      read(path.join('android', 'app', 'build.gradle')).replace(
        "manifest.srcFile 'src/certification/AndroidManifest.xml'",
        '// selector removed by fixture',
      ),
    );
  });
  assert.equal(exitCode, 1);
});
