// Independent Android push / Voice native permission capability
// (K SCAN AI Android Repair 07).
//
// THE DEFECT
//
// android/app/src/main/AndroidManifest.xml GRANTED
// android.permission.POST_NOTIFICATIONS outright, so every Android artifact --
// including ordinary production, which ships no remote-push consumer at all --
// was configured to declare a runtime permission for a capability that does not
// exist in that build. Repairs 05 and 06 had already made the RUNTIME inert
// (no permission request, no Expo push token, no device registration); what
// remained was the declaration layer, which Repair 05 explicitly recorded as
// future debt because the native architecture to express it did not exist yet.
//
// It could not be closed by deleting the line: expo-notifications' own library
// manifest declares POST_NOTIFICATIONS independently, so only an explicit
// tools:node="remove" neutralises the merged result -- the same merged-manifest
// governance Repair 02 established for the foreground-service permissions.
//
// THE ARCHITECTURE
//
// An Android build-type source set has exactly ONE manifest slot. Voice and
// remote push are independent capabilities that may each be on or off, so the
// four combinations are carried by four manifests selected in
// android/app/build.gradle:
//
//   push  voice   manifest             grants
//   ----  -----   -------------------  --------------------------
//   OFF   OFF     src/release          neither
//   OFF   ON      src/certification    RECORD_AUDIO
//   ON    OFF     src/push             POST_NOTIFICATIONS
//   ON    ON      src/voicePush        both
//
// These tests execute the REAL Gradle selector logic and the REAL manifests.
// The selector is extracted from android/app/build.gradle and evaluated over
// the boolean pair, so the mapping under test is the one the build performs
// rather than a restatement of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const GRADLE = 'android/app/build.gradle';
const AUTHORITY = 'config/native-config-authority.json';
const MAIN_MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const BASE_MANIFEST = 'android/app/src/release/AndroidManifest.xml';

const POST_NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS';
const RECORD_AUDIO = 'android.permission.RECORD_AUDIO';

const stripXmlComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');

function usesPermissions(xml) {
  return [...stripXmlComments(xml).matchAll(/<uses-permission([^>]*)\/>/g)].map((m) => ({
    name: (m[1].match(/android:name="([^"]+)"/) || [])[1],
    node: (m[1].match(/tools:node="([^"]+)"/) || [])[1] ?? null,
  }));
}

const grants = (xml) => usesPermissions(xml).filter((p) => p.node === null || p.node === 'replace').map((p) => p.name);
const removes = (xml) => usesPermissions(xml).filter((p) => p.node === 'remove').map((p) => p.name);

// ════════════════════════════════════════════════════════════════════════════
// The real Gradle selector, extracted and executed
// ════════════════════════════════════════════════════════════════════════════

/**
 * Evaluates the REAL four-way selection in android/app/build.gradle for a
 * (push, voice) pair.
 *
 * The branch conditions and their manifest paths are parsed out of the Groovy
 * source rather than restated here, so a future edit that reorders the branches
 * or repoints one at a different file changes what this resolves. Groovy
 * comments are stripped first: the block documents the whole matrix in prose
 * that names every manifest path, and a naive scan would read the table as
 * logic.
 */
/**
 * The `sourceSets` block, located by brace balance rather than by assuming
 * which sibling block follows it -- `packagingOptions` precedes it in this
 * file, so a naive slice between the two is empty.
 */
function selectorBlock(gradle) {
  const start = gradle.indexOf('sourceSets {');
  assert.ok(start >= 0, 'build.gradle must declare a sourceSets block');
  let depth = 0;
  for (let i = start; i < gradle.length; i += 1) {
    if (gradle[i] === '{') depth += 1;
    else if (gradle[i] === '}') {
      depth -= 1;
      if (depth === 0) return gradle.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced sourceSets block in build.gradle');
}

function resolveReleaseManifest(pushOn, voiceOn) {
  const gradle = read(GRADLE)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  const block = selectorBlock(gradle);
  assert.ok(block.includes('releaseCapabilityManifest'), 'the capability selector must exist in build.gradle');

  const branches = [...block.matchAll(/(if|else if)\s*\(([^)]+)\)\s*\{\s*releaseCapabilityManifest\s*=\s*'([^']+)'/g)]
    .map((m) => ({ condition: m[2].trim(), manifest: m[3] }));
  assert.equal(branches.length, 3, 'exactly three capability branches plus the default are expected');

  const env = { pushNativeCapabilityMaterialized: pushOn, voiceNativeCapabilityMaterialized: voiceOn };
  for (const branch of branches) {
    // Conditions are restricted to the two capability identifiers and `&&`.
    const tokens = branch.condition.split('&&').map((t) => t.trim());
    assert.ok(
      tokens.every((t) => Object.prototype.hasOwnProperty.call(env, t)),
      `unexpected token in selector condition "${branch.condition}" -- the selector must depend on the two capability booleans only`,
    );
    if (tokens.every((t) => env[t])) return `android/app/${branch.manifest}`;
  }
  return BASE_MANIFEST;
}

/** Effective merged posture for a permission, main + the selected overlay. */
function effectivePosture(pushOn, voiceOn, permission) {
  const overlay = read(resolveReleaseManifest(pushOn, voiceOn));
  // A build-type manifest outranks src/main, so the overlay decides when it
  // speaks about the permission at all.
  if (grants(overlay).includes(permission)) return 'PRESENT';
  if (removes(overlay).includes(permission)) return 'ABSENT';
  const main = read(MAIN_MANIFEST);
  if (removes(main).includes(permission)) return 'ABSENT';
  if (grants(main).includes(permission)) return 'PRESENT';
  return 'ABSENT';
}

// ════════════════════════════════════════════════════════════════════════════
// PART A — the mandatory four-state matrix (§5)
// ════════════════════════════════════════════════════════════════════════════

const MATRIX = [
  { push: false, voice: false, post: 'ABSENT', record: 'ABSENT', label: 'ordinary production / local gradle release' },
  { push: false, voice: true, post: 'ABSENT', record: 'PRESENT', label: 'future Voice-only production' },
  { push: true, voice: false, post: 'PRESENT', record: 'ABSENT', label: 'future push-only production' },
  { push: true, voice: true, post: 'PRESENT', record: 'PRESENT', label: 'staging-certification today' },
];

for (const state of MATRIX) {
  test(`MATRIX push=${state.push ? 'ON ' : 'OFF'} voice=${state.voice ? 'ON ' : 'OFF'} -> POST_NOTIFICATIONS ${state.post}, RECORD_AUDIO ${state.record} (${state.label})`, () => {
    assert.equal(effectivePosture(state.push, state.voice, POST_NOTIFICATIONS), state.post);
    assert.equal(effectivePosture(state.push, state.voice, RECORD_AUDIO), state.record);
  });
}

test('MATRIX: the four states select four DISTINCT manifests', () => {
  const selected = MATRIX.map((s) => resolveReleaseManifest(s.push, s.voice));
  assert.equal(new Set(selected).size, 4, 'each capability combination needs its own manifest slot file');
  for (const rel of selected) assert.ok(exists(rel), `${rel} must exist`);
});

// ════════════════════════════════════════════════════════════════════════════
// PART B — capability independence (§15)
// ════════════════════════════════════════════════════════════════════════════

test('INDEPENDENCE: Voice never grants push and push never grants Voice', () => {
  // The two single-capability states are the whole proof: if either boolean
  // leaked into the other's grant, one of these would carry both permissions.
  assert.equal(effectivePosture(false, true, POST_NOTIFICATIONS), 'ABSENT');
  assert.equal(effectivePosture(true, false, RECORD_AUDIO), 'ABSENT');
});

test('INDEPENDENCE: the two capability booleans are derived separately', () => {
  const gradle = read(GRADLE);
  assert.match(gradle, /def voiceNativeCapabilityMaterialized = kscanVoiceCertification \|\| kscanVoiceNativeCapability/);
  assert.match(gradle, /def pushNativeCapabilityMaterialized = remotePushCapabilityEnabled/);
  assert.match(gradle, /def remotePushCapabilityEnabled = smartWatchlistEnabled/);
  // Neither may be defined in terms of the other.
  assert.ok(!/def pushNativeCapabilityMaterialized\s*=\s*[^\n]*voice/i.test(gradle));
  assert.ok(!/def voiceNativeCapabilityMaterialized\s*=\s*[^\n]*push/i.test(gradle));
});

test('PROVENANCE: push permission is never keyed on a profile name or a credential', () => {
  // §13/§17. "Why is POST_NOTIFICATIONS present?" must answer
  // "because pushNativeCapabilityMaterialized is true", never "because this
  // happened to be staging-certification" or "because a credential exists".
  const gradle = read(GRADLE)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const selector = selectorBlock(gradle);
  for (const forbidden of ['EAS_BUILD_PROFILE', 'easBuildProfile', 'CERTIFICATION_PROFILE', 'PRODUCTION_PROFILE', 'googleServicesConfigured', 'GOOGLE_SERVICES_JSON']) {
    assert.ok(!selector.includes(forbidden), `manifest selection must not depend on "${forbidden}"`);
  }
  const pushDef = gradle.slice(gradle.indexOf('def pushNativeCapabilityMaterialized'));
  assert.ok(!pushDef.slice(0, 200).includes('googleServicesConfigured'));
});

/**
 * Evaluates the REAL `def pushNativeCapabilityMaterialized = ...` expression
 * from build.gradle over a controlled environment.
 *
 * Parsed rather than restated, so a future edit that widens the derivation --
 * for example to `|| googleServicesConfigured` -- changes what this resolves
 * and is caught behaviourally, not merely as source text.
 */
function resolvePushCapability({ smartWatchlistEnabled, googleServicesConfigured, easBuildProfile }) {
  const gradle = read(GRADLE);
  const match = gradle.match(/def pushNativeCapabilityMaterialized = ([^\n]+)/);
  assert.ok(match, 'build.gradle must derive pushNativeCapabilityMaterialized');
  const expression = match[1].trim();
  const scope = {
    remotePushCapabilityEnabled: smartWatchlistEnabled,
    smartWatchlistEnabled,
    googleServicesConfigured,
    easBuildProfile,
    voiceNativeCapabilityMaterialized: false,
    kscanVoiceCertification: false,
    kscanVoiceNativeCapability: false,
    CERTIFICATION_PROFILE: 'staging-certification',
    PRODUCTION_PROFILE: 'production',
  };
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  return Boolean(new Function(...names, `return (${expression});`)(...names.map((n) => scope[n])));
}

test('CREDENTIAL: a provisioned credential with push OFF activates nothing', () => {
  // §17, behaviourally. Credentials are configuration, not feature activation.
  assert.equal(
    resolvePushCapability({ smartWatchlistEnabled: false, googleServicesConfigured: true, easBuildProfile: 'production' }),
    false,
    'GOOGLE_SERVICES_JSON present must never re-grant the permission on its own',
  );
  assert.equal(
    resolvePushCapability({ smartWatchlistEnabled: false, googleServicesConfigured: true, easBuildProfile: 'staging-certification' }),
    false,
    'and neither must the certification profile name',
  );
  assert.equal(
    resolvePushCapability({ smartWatchlistEnabled: true, googleServicesConfigured: false, easBuildProfile: 'production' }),
    true,
    'the capability follows the product flag and nothing else',
  );
});

test('CREDENTIAL: FCM presence alone activates no permission', () => {
  // A credential is configuration, not product availability. The selector does
  // not read it, so a build with GOOGLE_SERVICES_JSON present and push off
  // resolves exactly the same manifest as one without it.
  assert.equal(resolveReleaseManifest(false, false), BASE_MANIFEST);
  assert.equal(effectivePosture(false, false, POST_NOTIFICATIONS), 'ABSENT');
});

test('FCM INVARIANT: push ON still fails closed without Firebase configuration', () => {
  // Repair 05's guard is untouched and still keys on the same boolean the
  // native permission now keys on, so a push-capable artifact cannot be built
  // without FCM.
  const gradle = read(GRADLE);
  assert.match(gradle, /if \(remotePushCapabilityEnabled && !googleServicesConfigured\) \{\s*\n\s*throw new GradleException/);
  assert.match(gradle, /if \(googleServicesConfigured\) \{\s*\n\s*apply plugin: 'com\.google\.gms\.google-services'/);
});

// ════════════════════════════════════════════════════════════════════════════
// PART C — default posture and the transitive contribution (§11, §29, §30)
// ════════════════════════════════════════════════════════════════════════════

test('DEFAULT: src/main removes both capability permissions', () => {
  const main = read(MAIN_MANIFEST);
  for (const permission of [POST_NOTIFICATIONS, RECORD_AUDIO]) {
    assert.ok(removes(main).includes(permission), `${permission} must be tools:node="remove" by default`);
    assert.ok(!grants(main).includes(permission), `${permission} must not also be granted`);
  }
});

test('TRANSITIVE: the default posture neutralizes a library-contributed permission', () => {
  // Repair 02's merged-manifest governance: library contributes X + app removes
  // X = governed removal. Written against the INTENDED posture rather than
  // today's dependency internals -- if a future expo-notifications stops
  // declaring the permission, the removal is simply redundant, and ordinary
  // production must still be permission-minimized either way.
  const LIB = 'node_modules/expo-notifications/android/src/main/AndroidManifest.xml';
  const contributes = exists(LIB) && grants(read(LIB)).includes(POST_NOTIFICATIONS);
  assert.equal(
    effectivePosture(false, false, POST_NOTIFICATIONS),
    'ABSENT',
    'ordinary production must be permission-minimized regardless of what the dependency declares',
  );
  if (contributes) {
    assert.ok(
      removes(read(MAIN_MANIFEST)).includes(POST_NOTIFICATIONS),
      'while the dependency contributes the permission, only an explicit removal can neutralize it — ' +
        'deleting our own declaration would leave the library contribution in the merged manifest',
    );
  }
});

test('DIRECT GRADLE: no EAS profile and no selectors resolves the minimized default', () => {
  // §33. Absence of EAS_BUILD_PROFILE must never accidentally select a
  // capability manifest: the selector reads only the two booleans, and both
  // default false.
  assert.equal(resolveReleaseManifest(false, false), BASE_MANIFEST);
  assert.equal(effectivePosture(false, false, POST_NOTIFICATIONS), 'ABSENT');
  assert.equal(effectivePosture(false, false, RECORD_AUDIO), 'ABSENT');
});

test('FAIL-CLOSED: malformed selector values resolve false', () => {
  // The established exact-string resolver is unchanged by this repair.
  const gradle = read(GRADLE);
  assert.match(gradle, /def isCertificationSelectorEnabled\(Object gradleProperty, String environmentValue\)/);
  assert.match(gradle, /resolved != null && resolved\.trim\(\)\.equalsIgnoreCase\('true'\)/);
  assert.match(gradle, /System\.getenv\('EXPO_PUBLIC_SMART_WATCHLIST_V1'\)/);
});

// ════════════════════════════════════════════════════════════════════════════
// PART D — overlay consistency and prior-repair invariants (§19, §25)
// ════════════════════════════════════════════════════════════════════════════

const OVERLAYS = [
  'android/app/src/certification/AndroidManifest.xml',
  'android/app/src/push/AndroidManifest.xml',
  'android/app/src/voicePush/AndroidManifest.xml',
];

test('OVERLAYS: every capability manifest is a strict superset of the release base', () => {
  const base = read(BASE_MANIFEST);
  for (const rel of OVERLAYS) {
    const overlay = read(rel);
    for (const permission of removes(base)) {
      assert.ok(removes(overlay).includes(permission), `${rel} drops the base removal of ${permission}`);
    }
    for (const permission of grants(base)) {
      assert.ok(grants(overlay).includes(permission), `${rel} drops the base grant of ${permission}`);
    }
  }
});

test('OVERLAYS: no capability manifest re-grants a Repair 02 removal or declares a service', () => {
  // CONTROL AQ's target. Repair 02's removals live in src/main and an overlay
  // only adds, so the danger is an overlay that GRANTS one back.
  const REPAIR_02 = [
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  ];
  for (const rel of [BASE_MANIFEST, ...OVERLAYS]) {
    const xml = read(rel);
    for (const permission of REPAIR_02) {
      assert.ok(!grants(xml).includes(permission), `${rel} must never re-grant ${permission}`);
    }
    assert.doesNotMatch(stripXmlComments(xml), /<service[\s>]/, `${rel} must declare no service`);
  }
});

test('OVERLAYS: no capability manifest grants an undeclared permission', () => {
  const authority = JSON.parse(read(AUTHORITY));
  const exceptions = authority.platforms.android.buildProfileManifestExceptions.exceptions;
  const base = new Set(grants(read(BASE_MANIFEST)));
  for (const rel of OVERLAYS) {
    const declared = new Set(
      exceptions
        .filter((e) => e.exceptionManifest === rel)
        .flatMap((e) => e.additionalGrantedPermissions || []),
    );
    assert.ok(declared.size > 0, `${rel} must be declared in the governed authority`);
    for (const permission of grants(read(rel))) {
      if (base.has(permission)) continue;
      assert.ok(declared.has(permission), `${rel} grants undeclared permission ${permission}`);
    }
  }
});

test('REPAIR 03: the Voice manifests keep the audio-routing posture', () => {
  for (const rel of ['android/app/src/certification/AndroidManifest.xml', 'android/app/src/voicePush/AndroidManifest.xml']) {
    const executable = stripXmlComments(read(rel));
    assert.ok(
      !executable.includes('MODIFY_AUDIO_SETTINGS'),
      `${rel} must not re-remove the playback-routing permission Elise speech needs`,
    );
    assert.ok(removes(read(rel)).includes('android.permission.FOREGROUND_SERVICE_MICROPHONE'));
    assert.ok(removes(read(rel)).includes('android.permission.CAPTURE_AUDIO_OUTPUT'));
  }
  // The push-only manifest grants no audio at all, so it carries no capture
  // boundary — and must not smuggle in an audio grant either.
  const pushOnly = read('android/app/src/push/AndroidManifest.xml');
  assert.ok(!grants(pushOnly).some((p) => /AUDIO/.test(p)), 'the push manifest must grant no audio permission');
});

test('REPAIR 04: notification resources survive the permission containment', () => {
  // §20. The icon and colour describe how a notification LOOKS in any build
  // that is legitimately push-capable. Removing the default permission is no
  // reason to delete them.
  const main = read(MAIN_MANIFEST);
  for (const key of [
    'com.google.firebase.messaging.default_notification_icon',
    'expo.modules.notifications.default_notification_icon',
    'com.google.firebase.messaging.default_notification_color',
    'expo.modules.notifications.default_notification_color',
  ]) {
    assert.ok(main.includes(key), `${key} must remain declared`);
  }
  assert.match(read('android/app/src/main/res/values/colors.xml'), /name="notification_icon_color"/);
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    assert.ok(exists(`android/app/src/main/res/drawable-${density}/notification_icon.png`));
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART E — profile resolution and Repair 05/06 regression (§31, §34)
// ════════════════════════════════════════════════════════════════════════════

function profileCapabilities(name) {
  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles.js');
  const env = (resolveEasBuildProfiles(JSON.parse(read('eas.json')))[name] || {}).env || {};
  return {
    push: env.EXPO_PUBLIC_SMART_WATCHLIST_V1 === 'true',
    voice: env.KSCAN_VOICE_CERTIFICATION === 'true' || env.KSCAN_VOICE_NATIVE_CAPABILITY === 'true',
  };
}

test('PROFILES: production resolves push OFF / voice OFF and the minimized posture', () => {
  const { push, voice } = profileCapabilities('production');
  assert.equal(push, false);
  assert.equal(voice, false);
  assert.equal(effectivePosture(push, voice, POST_NOTIFICATIONS), 'ABSENT');
  assert.equal(effectivePosture(push, voice, RECORD_AUDIO), 'ABSENT');
});

test('PROFILES: staging-certification resolves push ON / voice ON and grants both', () => {
  const { push, voice } = profileCapabilities('staging-certification');
  assert.equal(push, true);
  assert.equal(voice, true);
  assert.equal(resolveReleaseManifest(push, voice), 'android/app/src/voicePush/AndroidManifest.xml');
  assert.equal(effectivePosture(push, voice, POST_NOTIFICATIONS), 'PRESENT');
  assert.equal(effectivePosture(push, voice, RECORD_AUDIO), 'PRESENT');
});

test('PROFILES: no committed profile activates either capability outside certification', () => {
  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles.js');
  const profiles = resolveEasBuildProfiles(JSON.parse(read('eas.json')));
  for (const [name] of Object.entries(profiles)) {
    const { push, voice } = profileCapabilities(name);
    if (name === 'staging-certification') continue;
    assert.equal(push, false, `${name} must not activate remote push`);
    assert.equal(voice, false, `${name} must not activate Voice`);
  }
});

test('REPAIR 05 REGRESSION: runtime push activation is unchanged', () => {
  const cap = 'services/notifications/remotePushCapability.ts';
  const source = read(cap);
  assert.match(source, /import \{ SMART_WATCHLIST_V1 \} from '\.\.\/\.\.\/constants\/featureFlags';/);
  assert.match(source, /REMOTE_PUSH_GATED_PLATFORMS: readonly string\[\] = \['android'\] as const;/);
  assert.ok(!source.includes('watchlistAvailability'), 'Repair 05 must remain untouched by Repair 07');
});

test('REPAIR 06 REGRESSION: Watchlist containment is unchanged', () => {
  const availability = read('services/watchlist/watchlistAvailability.ts');
  assert.match(availability, /import \{ SMART_WATCHLIST_V1 \} from '\.\.\/\.\.\/constants\/featureFlags';/);
  assert.match(availability, /return smartWatchlistActive === true;/);
});

test('app.json parity: the default artifact declares the permission blocked, not granted', () => {
  const app = JSON.parse(read('app.json'));
  assert.ok(app.expo.android.blockedPermissions.includes(POST_NOTIFICATIONS));
  assert.ok(!app.expo.android.permissions.includes(POST_NOTIFICATIONS));
  // Same governance shape RECORD_AUDIO already uses.
  assert.ok(app.expo.android.blockedPermissions.includes(RECORD_AUDIO));
  assert.ok(!app.expo.android.permissions.includes(RECORD_AUDIO));
});
