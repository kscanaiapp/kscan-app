'use strict';

// Google Play Console compliance repair (release 31 / 1.0.1 recommendations):
//   GOOGLE-ANDROID-001 deprecated Android 15 edge-to-edge APIs/parameters
//   GOOGLE-ANDROID-002 portrait/resizability restriction on large-screen devices
//   GOOGLE-ANDROID-003 permission posture, incl. the Build 34 Voice Scan
//                      certification microphone exception
// Asserts against real source (regression) and, per each, includes a negative
// control that reintroduces the violation into an in-memory copy to prove the
// assertion actually bites rather than trivially passing on any input.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const GRADLE_PROPS_PATH = path.join(REPO_ROOT, 'android', 'gradle.properties');
const STYLES_PATH = path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'styles.xml');
const APP_JSON_PATH = path.join(REPO_ROOT, 'app.json');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function mainActivityBlock(manifestXml) {
  const match = manifestXml.match(/<activity android:name="\.MainActivity"[^>]*>/);
  assert.ok(match, 'MainActivity <activity> element not found in AndroidManifest.xml');
  return match[0];
}

// ---- GOOGLE-ANDROID-002: MainActivity must not force portrait ----

function assertMainActivityNotPortraitLocked(manifestXml) {
  const activityTag = mainActivityBlock(manifestXml);
  assert.doesNotMatch(
    activityTag,
    /android:screenOrientation="portrait"/,
    'MainActivity must not declare android:screenOrientation="portrait" (GOOGLE-ANDROID-002)',
  );
}

test('MainActivity has no forced portrait orientation', () => {
  assertMainActivityNotPortraitLocked(readFile(MANIFEST_PATH));
});

test('CONTROL A (negative): a reintroduced portrait lock is caught', () => {
  const mutated = readFile(MANIFEST_PATH).replace(
    '<activity android:name=".MainActivity"',
    '<activity android:name=".MainActivity" android:screenOrientation="portrait"',
  );
  assert.throws(() => assertMainActivityNotPortraitLocked(mutated));
});

test('MainActivity keeps configChanges covering orientation/screenSize so removing the lock does not trigger Activity recreation (Regime A)', () => {
  const activityTag = mainActivityBlock(readFile(MANIFEST_PATH));
  const configChanges = activityTag.match(/android:configChanges="([^"]+)"/);
  assert.ok(configChanges, 'MainActivity must declare android:configChanges');
  for (const required of ['orientation', 'screenSize', 'screenLayout']) {
    assert.ok(
      configChanges[1].split('|').includes(required),
      `android:configChanges must include "${required}"`,
    );
  }
});

test('the unused GMS Code Scanner delegate activity is removed from the merged manifest, not forcibly re-oriented', () => {
  const manifestXml = readFile(MANIFEST_PATH);
  const overrideTag = manifestXml.match(
    /<activity android:name="com\.google\.mlkit\.vision\.codescanner\.internal\.GmsBarcodeScanningDelegateActivity"[^>]*\/>/,
  );
  assert.ok(overrideTag, 'expected a manifest-merger override for GmsBarcodeScanningDelegateActivity');
  assert.match(overrideTag[0], /tools:node="remove"/);
  assert.doesNotMatch(
    overrideTag[0],
    /tools:replace="screenOrientation"/,
    'must not force-override a Google-owned compiled Activity instead of removing the unused dependency edge',
  );
});

test('app.json orientation cannot silently restore the portrait lock', () => {
  const appConfig = JSON.parse(readFile(APP_JSON_PATH)).expo;
  assert.notEqual(appConfig.orientation, 'portrait');
});

test('CONTROL C (negative): a reintroduced app.json portrait value is caught', () => {
  const mutated = { orientation: 'portrait' };
  assert.throws(() => assert.notEqual(mutated.orientation, 'portrait'));
});

// ---- GOOGLE-ANDROID-001: no K Scan-owned deprecated edge-to-edge origin ----

function assertNoDeprecatedEdgeToEdgeProperty(gradleProperties) {
  assert.doesNotMatch(
    gradleProperties,
    /^expo\.edgeToEdgeEnabled=/m,
    'expo.edgeToEdgeEnabled is deprecated (removed in Expo SDK 55); edgeToEdgeEnabled is the live property (GOOGLE-ANDROID-001)',
  );
  assert.match(gradleProperties, /^edgeToEdgeEnabled=true$/m, 'edgeToEdgeEnabled=true must remain set');
}

test('android/gradle.properties has no deprecated duplicate edge-to-edge flag', () => {
  assertNoDeprecatedEdgeToEdgeProperty(readFile(GRADLE_PROPS_PATH));
});

test('CONTROL B (negative): a reintroduced deprecated edge-to-edge property is caught', () => {
  const mutated = readFile(GRADLE_PROPS_PATH) + '\nexpo.edgeToEdgeEnabled=true\n';
  assert.throws(() => assertNoDeprecatedEdgeToEdgeProperty(mutated));
});

function assertNoDeprecatedStatusBarThemeColor(stylesXml) {
  assert.doesNotMatch(
    stylesXml,
    /android:statusBarColor/,
    'AppTheme must not set android:statusBarColor -- deprecated under enforced edge-to-edge (GOOGLE-ANDROID-001)',
  );
}

test('AppTheme has no deprecated android:statusBarColor', () => {
  assertNoDeprecatedStatusBarThemeColor(readFile(STYLES_PATH));
});

test('CONTROL B2 (negative): a reintroduced statusBarColor theme item is caught', () => {
  const mutated = readFile(STYLES_PATH).replace(
    '</style>',
    '<item name="android:statusBarColor">#ffffff</item></style>',
  );
  assert.throws(() => assertNoDeprecatedStatusBarThemeColor(mutated));
});

test('no K Scan-owned Android source declares windowOptOutEdgeToEdgeEnforcement', () => {
  for (const file of [MANIFEST_PATH, STYLES_PATH, GRADLE_PROPS_PATH]) {
    assert.doesNotMatch(readFile(file), /windowOptOutEdgeToEdgeEnforcement/);
  }
});


// ── GOOGLE-ANDROID-003: permission posture (Build 34) ───────────────────────
//
// Voice Scan needs RECORD_AUDIO, but ONLY in the staging-certification AAB.
// Encoding that as "the app may now request the microphone" would be exactly
// the broadening this build is designed to avoid, so the accepted posture is
// stated per artifact:
//
//   default / production release  -> NO microphone permission at all
//   staging-certification release -> RECORD_AUDIO, just-in-time, foreground
//                                    only, no service, no background capture
//
// Everything else stays denied in BOTH, including the permission families
// Play treats as sensitive: foreground-service microphone, Bluetooth,
// contacts, SMS, call log, fine/background location, and broad storage/media.

const CERT_MANIFEST_PATH = path.join(
  REPO_ROOT, 'android', 'app', 'src', 'certification', 'AndroidManifest.xml',
);
const RELEASE_MANIFEST_PATH = path.join(
  REPO_ROOT, 'android', 'app', 'src', 'release', 'AndroidManifest.xml',
);

/** Comments describe what a manifest must NOT contain; only markup declares. */
function withoutComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/** Permissions a manifest actively grants (no tools:node="remove"). */
function grantedPermissions(xml) {
  return [...withoutComments(xml).matchAll(/<uses-permission([^>]*)\/>/g)]
    .filter((match) => !/tools:node="remove"/.test(match[1]))
    .map((match) => (match[1].match(/android:name="([^"]+)"/) || [])[1])
    .filter(Boolean);
}

// Permission families that must never be granted by ANY K Scan manifest.
// Matched as substrings so a variant (e.g. BLUETOOTH_ADVERTISE) is caught
// without having to enumerate every constant Android has ever shipped.
const FORBIDDEN_PERMISSION_PATTERNS = Object.freeze([
  'FOREGROUND_SERVICE_MICROPHONE',
  'CAPTURE_AUDIO_OUTPUT',
  'BLUETOOTH',
  'READ_CONTACTS',
  'WRITE_CONTACTS',
  'GET_ACCOUNTS',
  '_SMS',
  'CALL_LOG',
  'PROCESS_OUTGOING_CALLS',
  'CALL_PHONE',
  'ACCESS_FINE_LOCATION',
  'ACCESS_BACKGROUND_LOCATION',
  'READ_EXTERNAL_STORAGE',
  'WRITE_EXTERNAL_STORAGE',
  'MANAGE_EXTERNAL_STORAGE',
  'READ_MEDIA_',
  'AD_ID',
]);

function assertNoForbiddenPermissions(label, xml) {
  for (const permission of grantedPermissions(xml)) {
    for (const pattern of FORBIDDEN_PERMISSION_PATTERNS) {
      assert.ok(
        !permission.includes(pattern),
        `${label} grants "${permission}", which matches the forbidden family "${pattern}" (GOOGLE-ANDROID-003)`,
      );
    }
  }
}

test('the DEFAULT/production manifests request no microphone permission', () => {
  const main = withoutComments(readFile(MANIFEST_PATH));
  assert.match(
    main,
    /<uses-permission[^>]*android:name="android\.permission\.RECORD_AUDIO"[^>]*tools:node="remove"[^>]*\/>/,
    'src/main must keep RECORD_AUDIO removed -- this is what production ships',
  );
  assert.ok(
    !grantedPermissions(readFile(MANIFEST_PATH)).includes('android.permission.RECORD_AUDIO'),
    'src/main must never GRANT RECORD_AUDIO',
  );
  assert.ok(
    !grantedPermissions(readFile(RELEASE_MANIFEST_PATH)).includes('android.permission.RECORD_AUDIO'),
    'the default release manifest must never grant RECORD_AUDIO',
  );
});

test('CONTROL D (negative): a microphone grant in the default release manifest is caught', () => {
  const mutated = readFile(RELEASE_MANIFEST_PATH).replace(
    '</manifest>',
    '<uses-permission android:name="android.permission.RECORD_AUDIO"/>\n</manifest>',
  );
  assert.throws(() =>
    assert.ok(
      !grantedPermissions(mutated).includes('android.permission.RECORD_AUDIO'),
      'must reject a microphone grant in the default release manifest',
    ),
  );
});

test('app.json continues to declare the microphone BLOCKED, so no CNG surface reintroduces it', () => {
  const androidConfig = JSON.parse(readFile(APP_JSON_PATH)).expo.android;
  assert.ok(
    androidConfig.blockedPermissions.includes('android.permission.RECORD_AUDIO'),
    'RECORD_AUDIO must remain in app.json blockedPermissions',
  );
  assert.ok(
    !androidConfig.permissions.includes('android.permission.RECORD_AUDIO'),
    'RECORD_AUDIO must never be declared in app.json android.permissions',
  );
});

test('the audio plugins keep ANDROID microphone capture disabled at the config layer', () => {
  // Build 34 lesson (project_build34_ios_voice_mic_permission): Expo's
  // `microphonePermission: false` DELETES the iOS platform permission a plugin
  // would otherwise add. This test used to pin BOTH props to false, which had
  // the right goal and the wrong mechanism on the iOS half.
  //
  // What is unchanged and still asserted: neither expo-camera nor expo-audio
  // may add ANDROID audio capture. `recordAudioAndroid` is the prop that does
  // that, and it stays false on both -- so Voice Scan cannot "fix" itself by
  // flipping a plugin and thereby grant RECORD_AUDIO to every Android profile.
  // Android's microphone is granted ONLY by the certification build-profile
  // manifest (asserted by the next test), and the default/production manifest
  // still removes it.
  //
  // What changed: `microphonePermission` is the iOS-side prop, and it is now
  // the shared Voice Scan usage string on both plugins. It must NOT be false,
  // because false deletes the app-wide NSMicrophoneUsageDescription that Voice
  // Scan's own native module depends on -- iOS terminates a process that calls
  // AVAudioSession.requestRecordPermission without it. Pinning both plugins to
  // the SAME string preserves the original intent (no plugin injects its own
  // competing generic copy) and makes the result independent of plugin order.
  const appJson = JSON.parse(readFile(APP_JSON_PATH));
  const expectedIosString = appJson.expo.ios.infoPlist.NSMicrophoneUsageDescription;
  assert.equal(typeof expectedIosString, 'string', 'Voice Scan must declare the iOS microphone string');

  for (const plugin of appJson.expo.plugins) {
    if (!Array.isArray(plugin)) continue;
    const [name, options] = plugin;
    if (name !== 'expo-camera' && name !== 'expo-audio') continue;
    assert.equal(
      options.recordAudioAndroid,
      false,
      `${name} must keep recordAudioAndroid false -- no plugin may grant Android audio capture`,
    );
    assert.equal(
      options.microphonePermission,
      expectedIosString,
      `${name} must carry Voice Scan's iOS microphone string verbatim, never false (which deletes it)`,
    );
  }

  // The Android half of the same statement, stated directly rather than
  // inferred from the plugin props.
  assert.ok(
    appJson.expo.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'),
    'the default/production Android posture must still block RECORD_AUDIO',
  );
  assert.ok(!appJson.expo.android.permissions.includes('android.permission.RECORD_AUDIO'));
});

test('the certification manifest grants the microphone, and nothing else new', () => {
  const certificationXml = readFile(CERT_MANIFEST_PATH);
  const granted = grantedPermissions(certificationXml);
  assert.deepEqual(
    granted,
    ['android.permission.RECORD_AUDIO'],
    'the certification manifest may grant exactly one permission beyond the base manifest',
  );
});

test('no manifest -- default or certification -- grants a forbidden permission family', () => {
  assertNoForbiddenPermissions('src/main/AndroidManifest.xml', readFile(MANIFEST_PATH));
  assertNoForbiddenPermissions('src/release/AndroidManifest.xml', readFile(RELEASE_MANIFEST_PATH));
  assertNoForbiddenPermissions('src/certification/AndroidManifest.xml', readFile(CERT_MANIFEST_PATH));
});

test('CONTROL E (negative): a forbidden permission family is caught in every manifest checked', () => {
  for (const manifestPath of [MANIFEST_PATH, RELEASE_MANIFEST_PATH, CERT_MANIFEST_PATH]) {
    const mutated = readFile(manifestPath).replace(
      '</manifest>',
      '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT"/>\n</manifest>',
    );
    assert.throws(
      () => assertNoForbiddenPermissions('fixture', mutated),
      `the forbidden-family check must bite on ${path.basename(path.dirname(manifestPath))}`,
    );
  }
});

// ── GOOGLE-ANDROID-004: merged-manifest foreground-service governance ───────
//
// TEST-FLIP LEDGER (Android Repair 02):
//   TEST: 'no manifest declares a service, so there is no background-microphone
//         surface at all'
//   OLD EXPECTATION: the first-party manifest (src/main, src/release,
//     src/certification) contains no <service> element and no
//     foregroundServiceType attribute, therefore the shipped app has no
//     foreground-service surface at all.
//   WHY OLD EXPECTATION WAS INSUFFICIENT/WRONG: Android's manifest merger
//     also incorporates <service> elements and <uses-permission> grants from
//     every LIBRARY manifest in the dependency tree. A first-party manifest
//     with no <service> proves nothing about the merged manifest that
//     actually ships -- expo-audio unconditionally contributes
//     FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK,
//     AudioControlsService (foregroundServiceType="mediaPlayback") and
//     AudioRecordingService (foregroundServiceType="microphone");
//     expo-location unconditionally contributes LocationTaskService
//     (foregroundServiceType="location"). None of that is visible to a check
//     that only reads K Scan's own manifest files, and the old assertion
//     would in fact have REJECTED the correct fix (removing those
//     contributions requires <service ... tools:node="remove"/> elements,
//     which the old regex banned outright).
//   NEW EXPECTATION: read the ACTUAL installed manifests of the governed
//     dependencies (expo-audio, expo-location -- the only two packages in
//     the entire node_modules tree that declare foregroundServiceType or a
//     FOREGROUND_SERVICE* permission, reverified below) and prove every
//     foreground-service-relevant permission/service they contribute is
//     explicitly neutralized by a matching tools:node="remove" in K Scan's
//     src/main manifest. A contribution with no matching removal now fails
//     the gate, whether it exists today or arrives with a future dependency
//     upgrade -- the check is driven off the real installed manifest content,
//     not a fixed list of today's known offenders.
//   DEFECT CLOSED: expo-audio's FOREGROUND_SERVICE /
//     FOREGROUND_SERVICE_MEDIA_PLAYBACK permissions and
//     AudioControlsService / AudioRecordingService services, plus
//     expo-location's LocationTaskService, reaching the merged production
//     manifest unreviewed.

/** The only packages in this project's dependency tree that declare a
 * foreground-service permission or a foregroundServiceType-typed <service>,
 * reverified here rather than assumed -- see the sanity test below. */
const GOVERNED_FGS_LIBRARIES = [
  {
    name: 'expo-audio',
    namespace: 'expo.modules.audio',
    manifestPath: path.join(REPO_ROOT, 'node_modules', 'expo-audio', 'android', 'src', 'main', 'AndroidManifest.xml'),
  },
  {
    name: 'expo-location',
    namespace: 'expo.modules.location',
    manifestPath: path.join(REPO_ROOT, 'node_modules', 'expo-location', 'android', 'src', 'main', 'AndroidManifest.xml'),
  },
];

// ── attribute-order-tolerant element parsing ────────────────────────────────
//
// Every extraction below used to assume a fixed attribute order (android:name
// first, at most one other attribute, in a specific position). Real manifests
// don't promise that: android:maxSdkVersion, android:exported, or tools:node
// can appear before or after android:name, and a future library or a
// reordered app declaration must not silently stop being recognized. This is
// a small bounded parser for exactly the one element shape this file reads
// (an opening tag's own attributes) -- not a general XML parser, and none is
// pulled in as a dependency.

/** Every `attrName="value"` pair in a tag's attribute text, in any order,
 * with any number of other attributes interspersed. */
function parseAttributes(attrText) {
  const attrs = {};
  const ATTR_PATTERN = /([:\w.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = ATTR_PATTERN.exec(attrText))) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

/** Every `<uses-permission .../>` element in `xml`, as {name, attrs}.
 * Tolerant of whitespace, attribute order, extra attributes, and
 * self-closing-vs-not formatting. */
function parseUsesPermissionElements(xml) {
  const elements = [];
  for (const match of withoutComments(xml).matchAll(/<uses-permission\b([^>]*)\/?>/g)) {
    const attrs = parseAttributes(match[1]);
    if (!attrs['android:name']) continue;
    elements.push({ name: attrs['android:name'], attrs });
  }
  return elements;
}

/** Every `<service .../>` element in `xml`, as {name, attrs}. Same tolerance
 * as parseUsesPermissionElements; matches self-closing services and services
 * with child elements (e.g. an <intent-filter>) alike, since only the
 * opening tag's attributes are parsed. */
function parseServiceElements(xml) {
  const elements = [];
  for (const match of withoutComments(xml).matchAll(/<service\b([^>]*)\/?>/g)) {
    const attrs = parseAttributes(match[1]);
    if (!attrs['android:name']) continue;
    elements.push({ name: attrs['android:name'], attrs });
  }
  return elements;
}

/** A library manifest's own permission grants. Library manifests never carry
 * tools:node="remove" of their own -- that mechanism belongs to the app
 * manifest that consumes them. */
function libraryPermissions(xml) {
  return parseUsesPermissionElements(xml).map((element) => element.name);
}

/** A library manifest's own <service> declarations, resolved to fully
 * qualified class names via the library's package namespace (a leading "."
 * is manifest-merger shorthand for "this manifest's own package"), each with
 * its foregroundServiceType if declared. */
function libraryServices(xml, namespace) {
  return parseServiceElements(xml).map((element) => ({
    qualifiedName: element.name.startsWith('.') ? `${namespace}${element.name}` : element.name,
    foregroundServiceType: element.attrs['android:foregroundServiceType'] || null,
  }));
}

const FOREGROUND_SERVICE_PERMISSION = /^android\.permission\.FOREGROUND_SERVICE/;

/**
 * THE governance check. For every FGS-relevant permission or
 * foregroundServiceType-typed service any of `libraries` contributes,
 * requires an explicit tools:node="remove" for that exact name in
 * `appManifestXml`. Library manifests never disclaim their own
 * contributions, so the ONLY way a dangerous item passes is if the app
 * manifest explicitly says so -- "library contributes X + app removes X =
 * governed result".
 */
function assertNoUngovernedForegroundServiceSurface(appManifestXml, libraries) {
  const appManifest = withoutComments(appManifestXml);
  const appRemovedPermissions = new Set(
    parseUsesPermissionElements(appManifest)
      .filter((element) => element.attrs['tools:node'] === 'remove')
      .map((element) => element.name),
  );
  const appRemovedServices = new Set(
    parseServiceElements(appManifest)
      .filter((element) => element.attrs['tools:node'] === 'remove')
      .map((element) => element.name),
  );

  for (const lib of libraries) {
    for (const permission of libraryPermissions(lib.xml)) {
      if (!FOREGROUND_SERVICE_PERMISSION.test(permission)) continue;
      assert.ok(
        appRemovedPermissions.has(permission),
        `${lib.name} contributes foreground-service permission "${permission}" with no governed ` +
          'tools:node="remove" in the app manifest -- it would reach the merged manifest unreviewed',
      );
    }
    for (const service of libraryServices(lib.xml, lib.namespace)) {
      if (!service.foregroundServiceType) continue;
      assert.ok(
        appRemovedServices.has(service.qualifiedName),
        `${lib.name} contributes foreground-service-typed <service android:name="${service.qualifiedName}" ` +
          `foregroundServiceType="${service.foregroundServiceType}"> with no governed tools:node="remove" ` +
          'in the app manifest -- it would reach the merged manifest unreviewed',
      );
    }
  }
}

/**
 * Pure-Node recursive scan for every AndroidManifest.xml under `root` whose
 * text mentions a foreground-service surface. No shell, no external process
 * (no grep), no extra dependency -- fs.readdirSync with withFileTypes is
 * enough, and it naturally can't loop on a symlinked node_modules (pnpm-style
 * or otherwise): Dirent.isDirectory() is false for a symlink, so this only
 * ever recurses into real directories. Returns normalized absolute paths.
 */
function findForegroundServiceManifests(root) {
  const FGS_PATTERN = /foregroundServiceType|android\.permission\.FOREGROUND_SERVICE/;
  const matches = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, a race) -- not this gate's concern
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'AndroidManifest.xml') {
        let contents;
        try {
          contents = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (FGS_PATTERN.test(contents)) matches.push(path.resolve(full));
      }
    }
  }
  walk(root);
  return matches;
}

/** Every foreground-service-declaring manifest under `root` that is NOT one
 * of `governedManifestPaths`. Factored out so the real reverify test and its
 * negative control (CONTROL L below) exercise the exact same comparison. */
function findUngovernedForegroundServiceManifests(root, governedManifestPaths) {
  const governed = new Set(governedManifestPaths.map((p) => path.resolve(p)));
  return findForegroundServiceManifests(root).filter((p) => !governed.has(p));
}

test('reverify the governed dependency set: no other installed package declares a foreground-service surface', () => {
  // If a third package started declaring foregroundServiceType or a
  // FOREGROUND_SERVICE* permission, GOVERNED_FGS_LIBRARIES above would be
  // silently incomplete. Scanning the whole tree here means that arrives as
  // a loud failure instead.
  const unexpected = findUngovernedForegroundServiceManifests(
    path.join(REPO_ROOT, 'node_modules'),
    GOVERNED_FGS_LIBRARIES.map((lib) => lib.manifestPath),
  );
  assert.deepEqual(
    unexpected,
    [],
    `a package outside GOVERNED_FGS_LIBRARIES declares a foreground-service surface: ${unexpected.join(', ')} -- add it to the governed set`,
  );
});

test('CONTROL L (negative): a third library manifest discovered by the pure-Node scanner is treated as ungoverned', () => {
  // A self-contained fixture tree (never the real node_modules) proves the
  // scanner itself -- not just the governed list -- actually finds a new
  // contributor and reports it as unexpected.
  const os = require('node:os');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-fgs-scan-'));
  try {
    const nestedDir = path.join(tmpRoot, 'some-other-lib', 'android', 'src', 'main');
    fs.mkdirSync(nestedDir, { recursive: true });
    const manifestPath = path.join(nestedDir, 'AndroidManifest.xml');
    fs.writeFileSync(
      manifestPath,
      [
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        '  <application>',
        '    <service android:name=".SurpriseService" android:foregroundServiceType="mediaPlayback" />',
        '  </application>',
        '</manifest>',
        '',
      ].join('\n'),
    );

    const found = findForegroundServiceManifests(tmpRoot);
    assert.deepEqual(found, [path.resolve(manifestPath)], 'the scanner must find the new manifest');

    const unexpected = findUngovernedForegroundServiceManifests(
      tmpRoot,
      GOVERNED_FGS_LIBRARIES.map((lib) => lib.manifestPath),
    );
    assert.deepEqual(
      unexpected,
      [path.resolve(manifestPath)],
      'a manifest discovered outside the governed set must be reported as ungoverned',
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('MERGED-MANIFEST-FGS-GOVERNANCE: every library-contributed foreground-service permission/service is explicitly neutralized', () => {
  const libraries = GOVERNED_FGS_LIBRARIES.map((lib) => ({ ...lib, xml: readFile(lib.manifestPath) }));
  assertNoUngovernedForegroundServiceSurface(readFile(MANIFEST_PATH), libraries);
});

test('sanity: a properly governed (removed) contribution does not trip the gate', () => {
  // Proves the check function can pass -- otherwise the negative controls
  // below would "bite" trivially by always throwing.
  const fixtureLib = {
    name: 'fixture-lib',
    namespace: 'com.example.fixture',
    xml: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
      <application>
        <service android:name=".SomeMediaService" android:foregroundServiceType="mediaPlayback" />
      </application>
    </manifest>`,
  };
  const governedAppManifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" tools:node="remove"/>
    <application>
      <service android:name="com.example.fixture.SomeMediaService" tools:node="remove"/>
    </application>
  </manifest>`;
  assert.doesNotThrow(() =>
    assertNoUngovernedForegroundServiceSurface(governedAppManifest, [fixtureLib]),
  );
});

test('CONTROL H (negative): a NEW, ungoverned FOREGROUND_SERVICE_* permission contribution is caught', () => {
  // Deliberately NOT one of the two permissions this repair already governs
  // (FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK) -- reusing either
  // would pass for the wrong reason, since the real app manifest already
  // removes those for its own governed contributions. This simulates the
  // actual drift scenario: a dependency upgrade adds a foreground-service
  // permission type nobody has reviewed yet.
  const fixtureLib = {
    name: 'fixture-camera-lib',
    namespace: 'com.example.fixture',
    xml: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
    </manifest>`,
  };
  // The real, governed app manifest has no removal for this fixture package's
  // permission -- it was never told the fixture exists.
  assert.throws(() =>
    assertNoUngovernedForegroundServiceSurface(readFile(MANIFEST_PATH), [fixtureLib]),
  );
});

test('CONTROL I (negative): an ungoverned media-playback <service> contribution is caught', () => {
  const fixtureLib = {
    name: 'fixture-lib',
    namespace: 'com.example.fixture',
    xml: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <application>
        <service android:name="example.UnexpectedAudioService" android:foregroundServiceType="mediaPlayback" />
      </application>
    </manifest>`,
  };
  assert.throws(() =>
    assertNoUngovernedForegroundServiceSurface(readFile(MANIFEST_PATH), [fixtureLib]),
  );
});

test('CONTROL J (negative): an ungoverned microphone foreground-service is caught', () => {
  const fixtureLib = {
    name: 'fixture-mic-lib',
    namespace: 'com.example.fixture',
    xml: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <application>
        <service android:name=".SomeMicService" android:foregroundServiceType="microphone" />
      </application>
    </manifest>`,
  };
  assert.throws(() =>
    assertNoUngovernedForegroundServiceSurface(readFile(MANIFEST_PATH), [fixtureLib]),
  );
});

test('CONTROL K (negative): an ungoverned location foreground-service is caught', () => {
  const fixtureLib = {
    name: 'fixture-location-lib',
    namespace: 'com.example.fixture',
    xml: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <application>
        <service android:name=".SomeLocationService" android:foregroundServiceType="location" />
      </application>
    </manifest>`,
  };
  assert.throws(() =>
    assertNoUngovernedForegroundServiceSurface(readFile(MANIFEST_PATH), [fixtureLib]),
  );
});

test('CONTROL M (negative): an FGS permission with an additional attribute is still detected', () => {
  // android:maxSdkVersion sits between the tag name and android:name -- a
  // fixed "android:name is the only/first attribute" pattern would silently
  // stop matching this and let it through ungoverned.
  const fixtureLib = {
    name: 'fixture-maxsdk-lib',
    namespace: 'com.example.fixture',
    xml: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission android:maxSdkVersion="34" android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
    </manifest>`,
  };
  assert.throws(() =>
    assertNoUngovernedForegroundServiceSurface(readFile(MANIFEST_PATH), [fixtureLib]),
  );
});

test('CONTROL N (negative): reordered attributes in a library permission are still detected', () => {
  // android:name is not the first attribute, and there is no whitespace
  // immediately after the tag name -- both must still parse.
  const fixtureLib = {
    name: 'fixture-reordered-lib',
    namespace: 'com.example.fixture',
    xml: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission  android:maxSdkVersion="34"   android:name="android.permission.FOREGROUND_SERVICE_CAMERA"/>
    </manifest>`,
  };
  assert.throws(() =>
    assertNoUngovernedForegroundServiceSurface(readFile(MANIFEST_PATH), [fixtureLib]),
  );
});

test('reordered attributes in an app tools:node="remove" declaration are still recognized', () => {
  // The inverse of CONTROL N: tools:node="remove" appears BEFORE android:name
  // on both the permission and the service removal. A parser that only
  // recognized the "android:name then tools:node" order would treat these as
  // ungoverned and fail this test with a false positive.
  const fixtureLib = {
    name: 'fixture-camera-lib',
    namespace: 'com.example.fixture',
    xml: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
      <application>
        <service android:name=".SomeCameraService" android:foregroundServiceType="camera" />
      </application>
    </manifest>`,
  };
  const governedAppManifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
    <uses-permission tools:node="remove" android:name="android.permission.FOREGROUND_SERVICE_CAMERA"/>
    <application>
      <service tools:node="remove" android:name="com.example.fixture.SomeCameraService"/>
    </application>
  </manifest>`;
  assert.doesNotThrow(() =>
    assertNoUngovernedForegroundServiceSurface(governedAppManifest, [fixtureLib]),
  );
});

test('the certification and release manifests carry no additional foreground-service surface of their own', () => {
  // The governance check above covers src/main, which the merger applies to
  // every build type. This closes the other half: the build-type-specific
  // manifests must not themselves ADD back a <service> or
  // foregroundServiceType that src/main just removed.
  for (const manifestPath of [RELEASE_MANIFEST_PATH, CERT_MANIFEST_PATH]) {
    const xml = withoutComments(readFile(manifestPath));
    assert.doesNotMatch(xml, /<service\b(?![^>]*tools:node="remove")/, `${manifestPath} must declare no active <service>`);
    assert.doesNotMatch(
      xml,
      /foregroundServiceType/,
      `${manifestPath} must declare no foregroundServiceType`,
    );
  }
});

// ── GOOGLE-ANDROID-005: certification audio-routing permission (Repair 03) ──
//
// MODIFY_AUDIO_SETTINGS used to be removed by the certification manifest,
// grouped with FOREGROUND_SERVICE_MICROPHONE and CAPTURE_AUDIO_OUTPUT under a
// comment about capture paths. It is not a capture permission -- expo-audio
// contributes it for PLAYBACK ROUTING, and the certification artifact still
// plays Elise/stylist speech. The invariant below is therefore conditional,
// not a snapshot: IF Elise speech is reachable in the certification variant,
// THEN that variant must not strip the routing permission. Both halves are
// traced from real source so a future change to either one moves the
// conclusion with it.

const AUTHORITY_PATH = path.join(REPO_ROOT, 'config', 'native-config-authority.json');
const CERTIFICATION_EAS_PROFILE = 'staging-certification';
const AUDIO_ROUTING_PERMISSION = 'android.permission.MODIFY_AUDIO_SETTINGS';

/** Permissions a manifest explicitly removes, attribute-order tolerant. */
function removedPermissionNames(xml) {
  return new Set(
    parseUsesPermissionElements(xml)
      .filter((element) => element.attrs['tools:node'] === 'remove')
      .map((element) => element.name),
  );
}

/**
 * Whether the certification variant can execute Elise/stylist speech
 * playback -- derived from the real EAS profile resolution, the real flag
 * wiring, the real preference default and the real playback entry point,
 * never asserted as a constant.
 */
function certificationEliseSpeechReachability() {
  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles');
  const eas = JSON.parse(readFile(path.join(REPO_ROOT, 'eas.json')));
  const profile = resolveEasBuildProfiles(eas)[CERTIFICATION_EAS_PROFILE];
  const env = (profile && profile.env) || {};

  // 1. The certification profile (which extends staging) turns the stylist on.
  const stylistFlagOn = env.EXPO_PUBLIC_AI_STYLIST_ENABLED === 'true';
  // 2. ...and that env var really is what gates the stylist UI.
  const flags = readFile(path.join(REPO_ROOT, 'constants', 'featureFlags.ts'));
  const stylistFlagWired =
    /AI_STYLIST_UI_ENABLED =\s*\n?\s*process\.env\.EXPO_PUBLIC_AI_STYLIST_ENABLED === 'true'/.test(flags);
  // 3. Speech itself is gated by a runtime preference, not a build flag, and
  //    that preference defaults ON when the device has no recorded choice.
  const voiceStore = readFile(path.join(REPO_ROOT, 'stores', 'stylistVoicePreferenceStore.ts'));
  const voiceDefaultsOn = /enabled: value !== 'off'/.test(voiceStore);
  // 4. And the playback entry point configures the audio mode unconditionally,
  //    as its very first statement -- this is what needs the permission.
  const playback = readFile(path.join(REPO_ROOT, 'services', 'avatars', 'stylistAudioPlayback.ts'));
  const configuresAudioModeFirst =
    /export async function playStylistAudio\([\s\S]*?\)\s*:\s*Promise<StylistAudioPlaybackHandle>\s*\{\s*await setAudioModeAsync\(/.test(
      playback,
    );

  return {
    stylistFlagOn,
    stylistFlagWired,
    voiceDefaultsOn,
    configuresAudioModeFirst,
    reachable: stylistFlagOn && stylistFlagWired && voiceDefaultsOn && configuresAudioModeFirst,
  };
}

test('CERTIFICATION-ELISE-REACHABLE: the certification variant can execute stylist speech playback', () => {
  const reach = certificationEliseSpeechReachability();
  assert.ok(
    reach.stylistFlagOn,
    `${CERTIFICATION_EAS_PROFILE} must resolve EXPO_PUBLIC_AI_STYLIST_ENABLED=true (it extends staging)`,
  );
  assert.ok(reach.stylistFlagWired, 'AI_STYLIST_UI_ENABLED must still be wired to that env var');
  assert.ok(
    reach.voiceDefaultsOn,
    'the stylist voice preference must still default ON for a device with no recorded choice',
  );
  assert.ok(
    reach.configuresAudioModeFirst,
    'playStylistAudio must still call setAudioModeAsync as its first statement',
  );
  assert.ok(reach.reachable);
});

/**
 * THE Repair 03 invariant. Conditional on reachability: if Elise speech can
 * run in the certification variant, that variant must not remove the routing
 * permission its playback path depends on.
 */
function assertCertificationRetainsAudioRouting(certificationXml, eliseSpeechReachable) {
  if (!eliseSpeechReachable) return;
  assert.ok(
    !removedPermissionNames(certificationXml).has(AUDIO_ROUTING_PERMISSION),
    `the certification manifest removes ${AUDIO_ROUTING_PERMISSION} while Elise/stylist speech is ` +
      'reachable in that variant. expo-audio contributes it for playback ROUTING ' +
      '(setAudioModeAsync -> AudioManager.setMode()/setSpeakerphoneOn()), not for capture -- ' +
      'stripping it degrades the audio routing of the exact artifact that still plays Elise speech.',
  );
}

test('CERTIFICATION-AUDIO-ROUTING: the certification manifest does not strip the playback routing permission', () => {
  const reach = certificationEliseSpeechReachability();
  assertCertificationRetainsAudioRouting(readFile(CERT_MANIFEST_PATH), reach.reachable);
});

test('CONTROL O (negative): reintroducing the MODIFY_AUDIO_SETTINGS removal is caught while playback is reachable', () => {
  const mutated = readFile(CERT_MANIFEST_PATH).replace(
    '</manifest>',
    `<uses-permission android:name="${AUDIO_ROUTING_PERMISSION}" tools:node="remove"/>\n</manifest>`,
  );
  assert.throws(() => assertCertificationRetainsAudioRouting(mutated, true));
  // ...and the same manifest is accepted when speech is NOT reachable, so the
  // check is genuinely conditional rather than an unconditional ban.
  assert.doesNotThrow(() => assertCertificationRetainsAudioRouting(mutated, false));
});

// ── capture boundaries are untouched by Repair 03 ───────────────────────────

const CERTIFICATION_CAPTURE_REMOVALS = Object.freeze([
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.CAPTURE_AUDIO_OUTPUT',
]);

function assertCertificationCaptureBoundaries(certificationXml) {
  const removed = removedPermissionNames(certificationXml);
  for (const permission of CERTIFICATION_CAPTURE_REMOVALS) {
    assert.ok(
      removed.has(permission),
      `the certification manifest must keep "${permission}" removed -- Repair 03 changed the ` +
        'routing permission only and must never relax a capture control',
    );
  }
}

test('REPAIR-03-CAPTURE-BOUNDARY: certification capture controls are unchanged', () => {
  const certificationXml = readFile(CERT_MANIFEST_PATH);
  assertCertificationCaptureBoundaries(certificationXml);

  // RECORD_AUDIO remains exactly the one governed grant, still via the
  // build-type tools:node="replace" (not widened into an unconditional grant).
  assert.match(
    withoutComments(certificationXml),
    /<uses-permission[^>]*android:name="android\.permission\.RECORD_AUDIO"[^>]*tools:node="replace"[^>]*\/>/,
    'the certification RECORD_AUDIO grant must keep its governed tools:node="replace" shape',
  );

  // And the governed contract still names both capture permissions for every
  // declared Voice exception -- the source of truth this file must agree with.
  const authority = JSON.parse(readFile(AUTHORITY_PATH));
  const exceptions =
    authority.platforms.android.buildProfileManifestExceptions.exceptions;
  assert.ok(exceptions.length > 0, 'the governed Voice exceptions must still be declared');
  for (const exception of exceptions) {
    for (const permission of CERTIFICATION_CAPTURE_REMOVALS) {
      assert.ok(
        (exception.mustRemainRemovedEverywhere || []).includes(permission),
        `exception "${exception.id}" must keep "${permission}" in mustRemainRemovedEverywhere`,
      );
    }
    // Repair 03 must not have smuggled the routing permission into a forbidden
    // list to "preserve" the old overlay.
    assert.ok(
      !(exception.mustRemainRemovedEverywhere || []).includes(AUDIO_ROUTING_PERMISSION),
      `exception "${exception.id}" must not add ${AUDIO_ROUTING_PERMISSION} to mustRemainRemovedEverywhere -- ` +
        'it is a playback-routing permission, not a capture control',
    );
  }
});

test('CONTROL P (negative): a restored FOREGROUND_SERVICE_MICROPHONE in certification is caught', () => {
  const mutated = readFile(CERT_MANIFEST_PATH).replace(
    /<uses-permission android:name="android\.permission\.FOREGROUND_SERVICE_MICROPHONE" tools:node="remove"\/>/,
    '',
  );
  assert.throws(() => assertCertificationCaptureBoundaries(mutated));
});

test('CONTROL Q (negative): a restored CAPTURE_AUDIO_OUTPUT in certification is caught', () => {
  const mutated = readFile(CERT_MANIFEST_PATH).replace(
    /<uses-permission android:name="android\.permission\.CAPTURE_AUDIO_OUTPUT" tools:node="remove"\/>/,
    '',
  );
  assert.throws(() => assertCertificationCaptureBoundaries(mutated));
});

// ── production and Repair 02 invariants are unchanged by Repair 03 ──────────

const REPAIR_02_MAIN_PERMISSION_REMOVALS = Object.freeze([
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
]);
const REPAIR_02_MAIN_SERVICE_REMOVALS = Object.freeze([
  'expo.modules.audio.service.AudioControlsService',
  'expo.modules.audio.service.AudioRecordingService',
  'expo.modules.location.services.LocationTaskService',
]);

test('REPAIR-03-PRODUCTION-UNCHANGED: the main manifest still retains audio routing by omission', () => {
  const mainXml = readFile(MANIFEST_PATH);
  // Production keeps MODIFY_AUDIO_SETTINGS the way Repair 02 left it: never
  // declared, therefore never removed, therefore contributed by expo-audio's
  // own manifest through the ordinary merge.
  assert.ok(
    !removedPermissionNames(mainXml).has(AUDIO_ROUTING_PERMISSION),
    'src/main must not remove the audio routing permission (Repair 02 decision)',
  );
  assert.ok(
    !grantedPermissions(mainXml).includes(AUDIO_ROUTING_PERMISSION),
    'src/main must not GRANT the routing permission either -- expo-audio contributes it',
  );
});

test('REPAIR-03-KEEPS-REPAIR-02: all five foreground-service removals survive, and stay governed', () => {
  const mainXml = readFile(MANIFEST_PATH);
  const removedPermissions = removedPermissionNames(mainXml);
  for (const permission of REPAIR_02_MAIN_PERMISSION_REMOVALS) {
    assert.ok(removedPermissions.has(permission), `Repair 02 removal of "${permission}" was lost`);
  }
  const removedServices = new Set(
    parseServiceElements(mainXml)
      .filter((element) => element.attrs['tools:node'] === 'remove')
      .map((element) => element.name),
  );
  for (const service of REPAIR_02_MAIN_SERVICE_REMOVALS) {
    assert.ok(removedServices.has(service), `Repair 02 removal of service "${service}" was lost`);
  }

  // Stronger than presence: the Repair 02 governance check still passes
  // against the real installed library manifests.
  const libraries = GOVERNED_FGS_LIBRARIES.map((lib) => ({ ...lib, xml: readFile(lib.manifestPath) }));
  assert.doesNotThrow(() => assertNoUngovernedForegroundServiceSurface(mainXml, libraries));
});

test('CONTROL R (negative): deleting a Repair 02 foreground-service removal is caught', () => {
  const mutated = readFile(MANIFEST_PATH).replace(
    '<service android:name="expo.modules.audio.service.AudioControlsService" tools:node="remove"/>',
    '',
  );
  const libraries = GOVERNED_FGS_LIBRARIES.map((lib) => ({ ...lib, xml: readFile(lib.manifestPath) }));
  // Caught by the governance check (library contributes it, app no longer removes it)...
  assert.throws(() => assertNoUngovernedForegroundServiceSurface(mutated, libraries));
  // ...and by the explicit presence check above.
  const removedServices = new Set(
    parseServiceElements(mutated)
      .filter((element) => element.attrs['tools:node'] === 'remove')
      .map((element) => element.name),
  );
  assert.ok(!removedServices.has('expo.modules.audio.service.AudioControlsService'));
});

test('the Voice native module requests the microphone just-in-time and releases it on background', () => {
  // Source proof for the two behavioural claims the Data Safety declaration
  // and the Play permission review both rest on.
  const kotlin = readFile(
    path.join(REPO_ROOT, 'modules', 'kscan-voice-native', 'android', 'src', 'main',
      'java', 'expo', 'modules', 'kscanvoicenative', 'KScanVoiceNativeModule.kt'),
  );
  // JIT: permission is requested from an explicit API call, never at startup.
  assert.match(kotlin, /AsyncFunction\("requestPermissions"\)/);
  assert.doesNotMatch(kotlin, /OnCreate[\s\S]{0,400}askForPermissions/,
    'the microphone must never be requested during module creation');
  // Release on background, independent of any single Activity.
  assert.match(kotlin, /ProcessLifecycleOwner/);
  assert.match(kotlin, /override fun onStop\(owner: LifecycleOwner\) \{\s*teardownSession/);
  // The module's own manifest contributes no permission of its own.
  const moduleManifest = readFile(
    path.join(REPO_ROOT, 'modules', 'kscan-voice-native', 'android', 'src', 'main', 'AndroidManifest.xml'),
  );
  assert.doesNotMatch(moduleManifest, /uses-permission/,
    'the Voice module must not contribute a permission of its own -- the app manifest decides');
});

test('Voice Scan uses on-device recognition only: no cloud recognizer, no network fallback', () => {
  // This is the fact the Play Data Safety answer depends on. If it ever
  // stops being true, "audio is not collected" stops being true with it.
  const kotlin = readFile(
    path.join(REPO_ROOT, 'modules', 'kscan-voice-native', 'android', 'src', 'main',
      'java', 'expo', 'modules', 'kscanvoicenative', 'KScanVoiceNativeModule.kt'),
  );
  assert.match(kotlin, /createOnDeviceSpeechRecognizer/);
  assert.match(kotlin, /isOnDeviceRecognitionAvailable/);
  assert.match(kotlin, /EXTRA_PREFER_OFFLINE/);
  // createSpeechRecognizer( may use a cloud-backed engine -- it must not
  // appear except as part of createOnDeviceSpeechRecognizer(.
  const cloudCalls = (kotlin.match(/(?<!OnDevice)SpeechRecognizer\.createSpeechRecognizer\(/g) || []);
  assert.equal(cloudCalls.length, 0, 'no cloud-capable recognizer may be constructed');
});

test('CONTROL F (negative): a cloud recognizer would be caught', () => {
  const mutated = 'val r = SpeechRecognizer.createSpeechRecognizer(context)';
  const cloudCalls = (mutated.match(/(?<!OnDevice)SpeechRecognizer\.createSpeechRecognizer\(/g) || []);
  assert.equal(cloudCalls.length, 1, 'the cloud-recognizer detector must actually match one');
});

test('no raw microphone audio is logged or persisted anywhere in the Voice path', () => {
  const voiceSources = [
    path.join(REPO_ROOT, 'hooks', 'useVoiceScan.ts'),
    path.join(REPO_ROOT, 'services', 'voice', 'voiceTelemetry.ts'),
    path.join(REPO_ROOT, 'services', 'voice', 'voiceNativeModule.ts'),
    path.join(REPO_ROOT, 'services', 'voice', 'voiceTranscript.ts'),
  ];
  for (const file of voiceSources) {
    const source = readFile(file);
    assert.doesNotMatch(source, /AsyncStorage/, `${file} must not persist voice state`);
    assert.doesNotMatch(source, /SecureStore|FileSystem\.write/, `${file} must not write voice data to disk`);
  }
  // The telemetry allowlist cannot carry text: 'transcript' is not a
  // permitted property name, so a transcript passed by mistake is dropped.
  const telemetry = readFile(path.join(REPO_ROOT, 'services', 'voice', 'voiceTelemetry.ts'));
  const properties = telemetry.match(/VOICE_EVENT_PROPERTIES = \[([\s\S]*?)\]/);
  assert.ok(properties, 'the telemetry property allowlist must exist');
  assert.doesNotMatch(properties[1], /transcript|text|query|audio/i,
    'no content-bearing property may be allowlisted for voice telemetry');
});


test('the ONLY reachable microphone-request path is the JIT one in the Voice session', () => {
  // usePermissionPreferences exports a SECOND microphone request --
  // requestMicrophonePermission, a direct PermissionsAndroid.request that was
  // written for onboarding. Build 33 removed the onboarding Microphone card,
  // so it currently has no caller, and while VOICESCAN_ENABLED was a
  // hardcoded false its internal guard made it inert regardless.
  //
  // Build 34 turns that flag on for the certification profile, so the guard no
  // longer holds it shut -- only the absence of a caller does. Wiring it to
  // onboarding would request the microphone at app setup rather than on the
  // user's explicit Voice tap, which is exactly the posture Play review and
  // this build's Data Safety answer both depend on NOT being true.
  //
  // So: assert it stays caller-less. If Voice ever legitimately needs a
  // non-JIT path, that is a deliberate change that should fail here first.
  const hook = readFile(path.join(REPO_ROOT, 'hooks', 'usePermissionPreferences.ts'));
  assert.match(hook, /requestMicrophonePermission/, 'the second path still exists -- keep watching it');
  assert.match(
    hook,
    /if \(Platform\.OS !== 'android' \|\| !VOICESCAN_ENABLED\)/,
    'it must keep its own guard even though the guard is no longer sufficient',
  );

  const searchRoots = ['app', 'components', 'hooks', 'services'];
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const relative = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
      if (relative === 'hooks/usePermissionPreferences.ts') continue; // the definition itself
      if (/requestMicrophonePermission/.test(fs.readFileSync(full, 'utf8'))) callers.push(relative);
    }
  };
  for (const root of searchRoots) walk(path.join(REPO_ROOT, root));

  assert.deepEqual(
    callers,
    [],
    `requestMicrophonePermission is a NON-JIT microphone request and must stay caller-less; found: ${callers.join(', ')}`,
  );
});

test('CONTROL G (negative): a new caller of the non-JIT microphone path would be caught', () => {
  const fixture = ['app/onboarding/index.tsx'];
  assert.throws(() => assert.deepEqual(fixture, []), 'the caller scan must reject a non-empty result');
});

test('the JIT path is the one Voice actually uses', () => {
  // Positive half: Voice requests the microphone through the native module's
  // own requestPermissions, called from startSession after an explicit tap.
  const hook = readFile(path.join(REPO_ROOT, 'hooks', 'useVoiceScan.ts'));
  assert.match(hook, /requestVoiceRecordingPermission/);
  assert.doesNotMatch(hook, /PermissionsAndroid/, 'Voice must not open a second permission path of its own');
  const startSession = hook.slice(hook.indexOf('const startSession'), hook.indexOf('const stopSession'));
  assert.match(startSession, /await requestVoiceRecordingPermission\(\)/);
});

// ── GOOGLE-ANDROID-006: notification icon/color native materialization ─────
//
// app.json's expo-notifications plugin config (icon, color) is not itself
// native state -- Android is native-authoritative here
// (config/native-config-authority.json). These tests prove the declared
// icon/color are actually MATERIALIZED into the committed native project: a
// drawable/color resource exists with the exact name expo-notifications
// generates, and the manifest metadata expo-notifications/Firebase Messaging
// actually read points at that exact resource -- never at the launcher icon,
// never at a stale value. Expected names are DERIVED from the installed
// expo-notifications package itself (require()'d directly below) rather than
// duplicated as arbitrary strings, so a future expo-notifications upgrade
// that renames its metadata keys or resource names is caught by this same
// suite instead of silently drifting past it.

const notificationPlugin = require('../node_modules/expo-notifications/plugin/build/withNotificationsAndroid.js');
const COLORS_PATH = path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'colors.xml');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function getNotificationPluginConfig() {
  const appConfig = JSON.parse(readFile(APP_JSON_PATH)).expo;
  const entry = (appConfig.plugins || []).find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-notifications',
  );
  assert.ok(entry, 'app.json must declare the expo-notifications plugin with config props');
  return entry[1] || {};
}

/** The exact drawable-DPI folder names the installed plugin writes to
 * (writeNotificationIconImageFilesAsync derives them from its own mipmap
 * dpiValues via `folderName.replace('mipmap', 'drawable')`). */
function notificationDrawableFolders() {
  return Object.values(notificationPlugin.dpiValues).map(({ folderName }) =>
    folderName.replace('mipmap', 'drawable'),
  );
}

function notificationIconDrawablePaths() {
  return notificationDrawableFolders().map((folder) =>
    path.join(
      REPO_ROOT, 'android', 'app', 'src', 'main', 'res', folder,
      `${notificationPlugin.NOTIFICATION_ICON}.png`,
    ),
  );
}

test('NOTIFICATION-CONFIG-DECLARED: app.json declares the expo-notifications icon and color', () => {
  const config = getNotificationPluginConfig();
  assert.equal(config.icon, './assets/notification-icon.png');
  assert.equal(config.color, '#3F0B2F');
});

// ── native icon ──────────────────────────────────────────────────────────

function assertNotificationDrawablesExist(paths) {
  assert.ok(paths.length > 0, 'the installed plugin must declare at least one DPI bucket');
  for (const drawablePath of paths) {
    assert.ok(fs.existsSync(drawablePath), `expected notification icon drawable missing: ${drawablePath}`);
  }
}

test('NOTIFICATION-ICON-MATERIALIZED: the exact drawable the installed plugin generates exists at every DPI bucket', () => {
  assertNotificationDrawablesExist(notificationIconDrawablePaths());
});

test('CONTROL S (negative): a missing notification drawable is caught', () => {
  const real = notificationIconDrawablePaths();
  const fixture = [
    ...real.slice(1),
    path.join(path.dirname(real[0]), 'notification_icon_MISSING.png'),
  ];
  assert.throws(() => assertNotificationDrawablesExist(fixture));
});

function assertNotificationIconManifestWiring(manifestXml) {
  const iconResource = notificationPlugin.NOTIFICATION_ICON_RESOURCE;
  for (const key of [
    notificationPlugin.META_DATA_FCM_NOTIFICATION_ICON,
    notificationPlugin.META_DATA_LOCAL_NOTIFICATION_ICON,
  ]) {
    const re = new RegExp(
      `<meta-data android:name="${escapeRegExp(key)}" android:resource="${escapeRegExp(iconResource)}"/>`,
    );
    assert.ok(
      re.test(manifestXml),
      `expected <meta-data android:name="${key}" android:resource="${iconResource}"/> in the main manifest`,
    );
  }
  assert.doesNotMatch(
    manifestXml,
    /notification[^>]*ic_launcher|ic_launcher[^>]*notification/i,
    'no notification metadata may reference the launcher icon',
  );
  // Belt-and-suspenders: no meta-data anywhere in the file may resolve to the
  // launcher mipmap at all, notification-named or not.
  for (const match of manifestXml.matchAll(/<meta-data[^>]*android:resource="([^"]+)"[^>]*\/>/g)) {
    assert.notEqual(match[1], '@mipmap/ic_launcher', 'a meta-data item resolves to the launcher icon');
  }
}

test('NOTIFICATION-ICON-MANIFEST-WIRING: both metadata keys reference the exact drawable, never the launcher icon', () => {
  assertNotificationIconManifestWiring(withoutComments(readFile(MANIFEST_PATH)));
});

test('CONTROL T (negative): a launcher-icon fallback in notification metadata is caught', () => {
  const mutated = withoutComments(readFile(MANIFEST_PATH)).replace(
    /android:resource="@drawable\/notification_icon"/g,
    'android:resource="@mipmap/ic_launcher"',
  );
  assert.throws(() => assertNotificationIconManifestWiring(mutated));
});

test('CONTROL V (negative): manifest metadata pointing to a nonmatching resource is caught', () => {
  // Only the FIRST occurrence is mutated -- proves a single mismatched
  // meta-data line among several is still caught, not just a wholesale swap.
  const mutated = withoutComments(readFile(MANIFEST_PATH)).replace(
    'android:resource="@drawable/notification_icon"',
    'android:resource="@drawable/some_other_icon"',
  );
  assert.throws(() => assertNotificationIconManifestWiring(mutated));
});

// ── native color ─────────────────────────────────────────────────────────

function assertNotificationColorMatches(colorsXml, expectedColor) {
  const colorName = notificationPlugin.NOTIFICATION_ICON_COLOR;
  const re = new RegExp(`<color name="${escapeRegExp(colorName)}">([^<]+)</color>`);
  const match = colorsXml.match(re);
  assert.ok(match, `expected <color name="${colorName}"> in colors.xml`);
  assert.equal(
    match[1].toLowerCase(),
    expectedColor.toLowerCase(),
    `native notification color "${match[1]}" must equal app.json's "${expectedColor}"`,
  );
}

test('NOTIFICATION-COLOR-MATERIALIZED: the exact color resource the installed plugin generates exists and equals app.json', () => {
  const config = getNotificationPluginConfig();
  assertNotificationColorMatches(readFile(COLORS_PATH), config.color);
});

test('CONTROL U (negative): a color-value drift from app.json is caught', () => {
  const mutated = readFile(COLORS_PATH).replace('#3F0B2F', '#000000');
  assert.throws(() => assertNotificationColorMatches(mutated, '#3F0B2F'));
});

test('the notification color resource never repurposes an existing branding color', () => {
  const colorsXml = readFile(COLORS_PATH);
  for (const existing of ['colorPrimary', 'colorPrimaryDark', 'iconBackground']) {
    assert.ok(colorsXml.includes(`name="${existing}"`), `${existing} must still be declared`);
  }
  // The notification color must be its OWN resource, not an alias/reference
  // to one of the existing ones.
  const notifMatch = colorsXml.match(
    new RegExp(`<color name="${notificationPlugin.NOTIFICATION_ICON_COLOR}">([^<]+)</color>`),
  );
  assert.ok(notifMatch);
  assert.doesNotMatch(notifMatch[1], /^@color\//, 'the notification color must be a literal value, not a reference to another color resource');
});

function assertNotificationColorManifestWiring(manifestXml) {
  const colorResource = notificationPlugin.NOTIFICATION_ICON_COLOR_RESOURCE;
  for (const key of [
    notificationPlugin.META_DATA_FCM_NOTIFICATION_ICON_COLOR,
    notificationPlugin.META_DATA_LOCAL_NOTIFICATION_ICON_COLOR,
  ]) {
    const re = new RegExp(
      `<meta-data android:name="${escapeRegExp(key)}" android:resource="${escapeRegExp(colorResource)}"/>`,
    );
    assert.ok(
      re.test(manifestXml),
      `expected <meta-data android:name="${key}" android:resource="${colorResource}"/> in the main manifest`,
    );
  }
}

test('NOTIFICATION-COLOR-MANIFEST-WIRING: both metadata keys reference the exact color resource', () => {
  assertNotificationColorManifestWiring(withoutComments(readFile(MANIFEST_PATH)));
});

// ── icon quality (Android notification-small-icon semantics) ───────────────
//
// A small, deterministic, dependency-free PNG decoder (Node's built-in zlib
// only) -- enough to check notification-small-icon semantics (white
// foreground, transparent background), not a general-purpose image library.

function decodeNotificationIconPng(buffer) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.slice(0, 8).equals(sig)) {
    throw new Error('not a valid PNG file (bad signature)');
  }
  let offset = 8;
  let width, height, bitDepth, colorType, interlace;
  const idatChunks = [];
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('truncated PNG (chunk header)');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (dataStart + length > buffer.length) throw new Error('truncated PNG (chunk data)');
    const data = buffer.slice(dataStart, dataStart + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (!width || !height) throw new Error('PNG has zero or missing dimensions');
  if (interlace !== 0) throw new Error('interlaced PNG not supported by this deterministic check');
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(
      `unsupported PNG format for notification-icon check: bitDepth=${bitDepth} colorType=${colorType} ` +
        '(expected 8-bit RGBA)',
    );
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error('PNG pixel data shorter than declared dimensions');
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  let prevLine = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const line = raw.slice(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const outLine = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? outLine[x - bpp] : 0;
      const b = prevLine[x];
      const c = x >= bpp ? prevLine[x - bpp] : 0;
      let value = line[x];
      switch (filterType) {
        case 0: break;
        case 1: value = (value + a) & 0xff; break;
        case 2: value = (value + b) & 0xff; break;
        case 3: value = (value + Math.floor((a + b) / 2)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          value = (value + pr) & 0xff;
          break;
        }
        default: throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      outLine[x] = value;
    }
    outLine.copy(pixels, y * stride);
    prevLine = outLine;
  }
  return { width, height, pixels, bpp };
}

/** Android notification-small-icon semantics: white foreground on a fully
 * transparent background. Not a brand/pixel-perfect check -- just the
 * structural properties Android/Play require. */
function assertPixelsSuitableForNotificationIcon({ width, height, pixels, bpp }, label) {
  assert.ok(width > 0 && height > 0, `${label}: zero/invalid dimensions`);
  const total = width * height;
  let opaqueCount = 0;
  let transparentCount = 0;
  let nonWhiteVisibleCount = 0;
  for (let i = 0; i < total; i++) {
    const idx = i * bpp;
    const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2], a = pixels[idx + 3];
    if (a === 255) opaqueCount++;
    if (a === 0) transparentCount++;
    if (a > 10 && !(r >= 245 && g >= 245 && b >= 245)) nonWhiteVisibleCount++;
  }
  assert.ok(
    transparentCount > 0,
    `${label}: zero transparent pixels -- a notification small icon must have a transparent background`,
  );
  assert.notEqual(
    opaqueCount, total,
    `${label}: every pixel is fully opaque -- solid/opaque background is not valid notification-icon semantics`,
  );
  assert.equal(
    nonWhiteVisibleCount, 0,
    `${label}: contains non-white visible pixels -- notification small icons must be white-on-transparent`,
  );
}

function assertNotificationIconFileSuitable(pngPath) {
  const buffer = fs.readFileSync(pngPath);
  const decoded = decodeNotificationIconPng(buffer);
  assertPixelsSuitableForNotificationIcon(decoded, path.relative(REPO_ROOT, pngPath));
}

test('NOTIFICATION-ICON-QUALITY: every materialized drawable is white-on-transparent at every DPI bucket', () => {
  for (const drawablePath of notificationIconDrawablePaths()) {
    assertNotificationIconFileSuitable(drawablePath);
  }
});

test('the icon-quality check fails closed on a missing file', () => {
  assert.throws(() =>
    assertNotificationIconFileSuitable(
      path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'res', 'drawable-mdpi', 'does_not_exist.png'),
    ),
  );
});

test('the icon-quality check fails on obviously corrupt/unusable image data', () => {
  assert.throws(() => decodeNotificationIconPng(Buffer.from('not a png at all')));
});

test('CONTROL W (negative): a solid opaque/color-background icon fails the small-icon semantic check', () => {
  // 4x4 fully-opaque, solid brand-colored fixture -- exactly the
  // "background plate" shape Android notification-small-icon rules forbid.
  const width = 4, height = 4, bpp = 4;
  const pixels = Buffer.alloc(width * height * bpp);
  for (let i = 0; i < width * height; i++) {
    const idx = i * bpp;
    pixels[idx] = 0x3f; pixels[idx + 1] = 0x0b; pixels[idx + 2] = 0x2f; pixels[idx + 3] = 255;
  }
  assert.throws(() => assertPixelsSuitableForNotificationIcon({ width, height, pixels, bpp }, 'fixture'));
});

test('the icon-quality check fails on non-white visible pixels (colored glyph)', () => {
  const width = 4, height = 4, bpp = 4;
  const pixels = Buffer.alloc(width * height * bpp); // defaults to transparent black
  // one fully-opaque BLUE pixel amid an otherwise transparent canvas
  pixels[0] = 0; pixels[1] = 0; pixels[2] = 255; pixels[3] = 255;
  assert.throws(() => assertPixelsSuitableForNotificationIcon({ width, height, pixels, bpp }, 'fixture'));
});

test('the icon-quality check fails on zero transparency even when fully white', () => {
  const width = 4, height = 4, bpp = 4;
  const pixels = Buffer.alloc(width * height * bpp);
  for (let i = 0; i < width * height; i++) {
    const idx = i * bpp;
    pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255; pixels[idx + 3] = 255;
  }
  assert.throws(() => assertPixelsSuitableForNotificationIcon({ width, height, pixels, bpp }, 'fixture'));
});

test('a genuinely suitable white-on-transparent fixture passes (sanity: the check can pass)', () => {
  const width = 4, height = 4, bpp = 4;
  const pixels = Buffer.alloc(width * height * bpp); // transparent black
  // top-left 2x2 quadrant: opaque white glyph; rest stays transparent
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const idx = (y * width + x) * bpp;
    pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255; pixels[idx + 3] = 255;
  }
  assert.doesNotThrow(() => assertPixelsSuitableForNotificationIcon({ width, height, pixels, bpp }, 'fixture'));
});

// ── Repair 02 / Repair 03 invariants survive Repair 04 ──────────────────────

test('REPAIR-04-KEEPS-PRIOR-REPAIRS: Repair 02 and Repair 03 invariants are unaffected', () => {
  const mainXml = readFile(MANIFEST_PATH);
  for (const permission of REPAIR_02_MAIN_PERMISSION_REMOVALS) {
    assert.ok(removedPermissionNames(mainXml).has(permission), `Repair 02 removal of "${permission}" was lost`);
  }
  const removedServices = new Set(
    parseServiceElements(mainXml)
      .filter((element) => element.attrs['tools:node'] === 'remove')
      .map((element) => element.name),
  );
  for (const service of REPAIR_02_MAIN_SERVICE_REMOVALS) {
    assert.ok(removedServices.has(service), `Repair 02 removal of service "${service}" was lost`);
  }
  assertCertificationCaptureBoundaries(readFile(CERT_MANIFEST_PATH));
  const reach = certificationEliseSpeechReachability();
  assertCertificationRetainsAudioRouting(readFile(CERT_MANIFEST_PATH), reach.reachable);
  // POST_NOTIFICATIONS is unaffected by this repair -- still actively granted.
  assert.ok(
    grantedPermissions(mainXml).includes('android.permission.POST_NOTIFICATIONS'),
    'POST_NOTIFICATIONS must remain granted -- Repair 04 does not touch notification permission behavior',
  );
});
