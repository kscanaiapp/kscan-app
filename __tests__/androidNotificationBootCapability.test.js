// Unused Android notification BOOT capability containment
// (K SCAN AI Android Repair 08).
//
// THE DEFECT
//
// expo-notifications@0.32.17 contributes android.permission.RECEIVE_BOOT_COMPLETED
// from its OWN library manifest and registers its NotificationsService receiver
// for BOOT_COMPLETED / REBOOT / QUICKBOOT_POWERON / com.htc QUICKBOOT_POWERON /
// MY_PACKAGE_REPLACED. Those five actions are NotificationsService.SETUP_ACTIONS,
// and they lead to exactly one place:
//
//   broadcast
//     -> NotificationsService.onReceive
//     -> NotificationsService.handleIntent          (SETUP_ACTIONS branch)
//     -> NotificationsService.onSetupScheduledNotifications
//     -> ExpoSchedulingDelegate.setupScheduledNotifications()
//     -> store.allNotificationRequests.forEach { scheduleNotification(it) }
//
// i.e. re-arming alarms for notifications the device had scheduled LOCALLY
// before the restart. K Scan has no local/scheduled-notification feature. The
// store is written only by ExpoSchedulingDelegate.scheduleNotification(),
// reachable only from JS scheduleNotificationAsync, which no first-party source
// calls -- so the collection that path iterates is provably empty and boot
// restoration has nothing to restore. Every K Scan notification originates
// REMOTELY (commerce-watch-refresh/pushDelivery.ts -> Expo push -> FCM).
//
// P3 -- native capability minimization / ungoverned transitive permission. Not
// a runtime prompt (RECEIVE_BOOT_COMPLETED is a normal, non-dangerous
// permission), not a privacy breach, not a current notification failure.
//
// WHAT THIS REPAIR IS NOT
//
// It is the PERMISSION only. The same NotificationsService receiver carries
// expo.modules.notifications.NOTIFICATION_EVENT, which is how remote push
// actually works -- FCM -> ExpoFirebaseMessagingService.onMessageReceived ->
// NotificationsService.receive() -> NOTIFICATION_EVENT/RECEIVE_TYPE, and a tap
// -> createNotificationResponseIntent -> NOTIFICATION_EVENT/RECEIVE_RESPONSE_TYPE.
// PART C below exists specifically so that a later "cleanup" which deletes the
// receiver, the FCM service or the NOTIFICATION_EVENT action to finish this
// repair fails instead of shipping.

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
const LIB_MANIFEST = 'node_modules/expo-notifications/android/src/main/AndroidManifest.xml';

const RECEIVE_BOOT_COMPLETED = 'android.permission.RECEIVE_BOOT_COMPLETED';
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
// The real Gradle selector, extracted and executed (shared shape with
// androidCapabilityPermissionMatrix.test.js -- Repair 07's four-state gate).
// The branch conditions and manifest paths are parsed out of the Groovy source
// rather than restated, so a future edit that repoints a branch changes what
// this resolves. Comments are stripped first: build.gradle documents the whole
// matrix in prose that names every manifest path.
// ════════════════════════════════════════════════════════════════════════════

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
    const tokens = branch.condition.split('&&').map((t) => t.trim());
    assert.ok(
      tokens.every((t) => Object.prototype.hasOwnProperty.call(env, t)),
      `unexpected token in selector condition "${branch.condition}"`,
    );
    if (tokens.every((t) => env[t])) return `android/app/${branch.manifest}`;
  }
  return BASE_MANIFEST;
}

/** Effective merged posture for a permission: main + the selected overlay. */
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

const STATES = [
  { push: false, voice: false, label: 'ordinary production / local gradle release' },
  { push: false, voice: true, label: 'future Voice-only production' },
  { push: true, voice: false, label: 'future push-only production' },
  { push: true, voice: true, label: 'staging-certification today' },
];

// ════════════════════════════════════════════════════════════════════════════
// PART A — the installed dependency is the authority (§3, §4, §25, §31)
// ════════════════════════════════════════════════════════════════════════════

test('INSTALLED: expo-notifications resolves to the locked version, un-upgraded', () => {
  // §31/§37: the repair must reason over the ACTUALLY installed dependency, and
  // must not move it. package.json, the lockfile and node_modules must agree.
  const declared = require(path.join(ROOT, 'package.json')).dependencies['expo-notifications'];
  assert.equal(declared, '~0.32.17', 'Repair 08 must not change the declared expo-notifications range');

  const lock = require(path.join(ROOT, 'package-lock.json'));
  assert.equal(lock.packages['node_modules/expo-notifications'].version, '0.32.17');

  if (exists('node_modules/expo-notifications/package.json')) {
    assert.equal(require(path.join(ROOT, 'node_modules/expo-notifications/package.json')).version, '0.32.17');
  }
});

test('CONTRIBUTION: while the dependency declares the boot permission, src/main must explicitly remove it', () => {
  // §25. This is the narrow dependency-governance check, and it is deliberately
  // written as an OBSERVATION of the installed library plus a REQUIREMENT on our
  // own source -- never as a permanent requirement on dependency internals. If a
  // future expo-notifications stops declaring the permission, the removal simply
  // becomes redundant and this test still passes; what must never happen is the
  // dependency declaring it while K Scan stays silent, because silence is not
  // suppression -- the library contribution would still reach the merged manifest.
  const main = read(MAIN_MANIFEST);
  const contributes = exists(LIB_MANIFEST) && grants(read(LIB_MANIFEST)).includes(RECEIVE_BOOT_COMPLETED);

  if (contributes) {
    assert.ok(
      removes(main).includes(RECEIVE_BOOT_COMPLETED),
      'expo-notifications contributes RECEIVE_BOOT_COMPLETED, so only an explicit tools:node="remove" in ' +
        'android/app/src/main/AndroidManifest.xml neutralises it -- omitting our own declaration is not enough',
    );
    assert.ok(
      require(path.join(ROOT, 'app.json')).expo.android.blockedPermissions.includes(RECEIVE_BOOT_COMPLETED),
      'app.json must mirror the blocked default posture (§13)',
    );
  }

  assert.ok(!grants(main).includes(RECEIVE_BOOT_COMPLETED), 'src/main must never GRANT the boot permission');
});

test('BOOT PATH: the contributed actions lead only to scheduled-notification restoration', () => {
  // §5. Proves the premise against the installed source rather than upstream
  // docs: the boot/reboot/package-replaced actions are SETUP_ACTIONS, and the
  // SETUP_ACTIONS branch does exactly one thing.
  const service = 'node_modules/expo-notifications/android/src/main/java/expo/modules/notifications/service/NotificationsService.kt';
  const delegate = 'node_modules/expo-notifications/android/src/main/java/expo/modules/notifications/service/delegates/ExpoSchedulingDelegate.kt';
  if (!exists(service) || !exists(delegate)) return; // dependency internals are observed, never required

  const source = read(service);
  assert.match(source, /val SETUP_ACTIONS = listOf\(/, 'the boot actions must be a named set');
  for (const action of [
    'Intent.ACTION_BOOT_COMPLETED',
    'Intent.ACTION_REBOOT',
    'Intent.ACTION_MY_PACKAGE_REPLACED',
    '"android.intent.action.QUICKBOOT_POWERON"',
    '"com.htc.intent.action.QUICKBOOT_POWERON"',
  ]) {
    assert.ok(source.includes(action), `${action} must be part of SETUP_ACTIONS`);
  }
  assert.match(
    source,
    /if \(SETUP_ACTIONS\.contains\(intent\.action\)\) \{\s*onSetupScheduledNotifications\(context, intent\)/,
    'the SETUP_ACTIONS branch must lead to onSetupScheduledNotifications and nothing else',
  );
  assert.match(
    source,
    /onSetupScheduledNotifications\(context: Context, intent: Intent\) =\s*getSchedulingDelegate\(context\)\.setupScheduledNotifications\(\)/,
    'onSetupScheduledNotifications must delegate to the scheduling delegate',
  );
  assert.match(
    read(delegate),
    /override fun setupScheduledNotifications\(\) \{\s*store\.allNotificationRequests\.forEach/,
    'setupScheduledNotifications must only re-arm previously stored LOCAL schedules',
  );
});

test('INDEPENDENCE: neither remote delivery nor tap handling consults the boot permission', () => {
  // §6. Both answers must be NO before removal is permitted. The strongest
  // available source-level proof: the permission name appears NOWHERE in the
  // library's Kotlin -- it is a manifest-only capability -- so no delivery or
  // response code path can be gated on it.
  const javaRoot = 'node_modules/expo-notifications/android/src/main/java';
  if (!exists(javaRoot)) return;

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(kt|java)$/.test(entry.name) && read(rel).includes('RECEIVE_BOOT_COMPLETED')) offenders.push(rel);
    }
  };
  walk(javaRoot);

  assert.deepEqual(
    offenders,
    [],
    'RECEIVE_BOOT_COMPLETED must not be referenced by any library code path -- if a future version starts ' +
      'checking it at runtime, this repair needs re-proving before the removal can stand',
  );
});

// ════════════════════════════════════════════════════════════════════════════
// PART B — first-party reachability, now and in the future (§7, §26, §27, §28)
// ════════════════════════════════════════════════════════════════════════════

// The RUNTIME tree only. Tests, docs, scripts and node_modules do not prove
// production reachability and are deliberately excluded (§7).
const RUNTIME_DIRS = [
  'app', 'components', 'constants', 'contexts', 'contracts', 'data',
  'hooks', 'lib', 'modules', 'services', 'src', 'stores', 'types',
];

// Every API whose presence would mean a notification is scheduled to fire LATER
// on the device -- i.e. state that would need restoring after a reboot.
const LOCAL_SCHEDULING_APIS = [
  'scheduleNotificationAsync',
  'cancelScheduledNotificationAsync',
  'cancelAllScheduledNotificationsAsync',
  'getAllScheduledNotificationsAsync',
  'getNextTriggerDateAsync',
  'DailyNotificationTrigger',
  'WeeklyNotificationTrigger',
  'YearlyNotificationTrigger',
  'CalendarNotificationTrigger',
  'TimeIntervalNotificationTrigger',
  'SchedulableTriggerInputTypes',
];

function runtimeSourceFiles() {
  const files = [];
  const walk = (dir) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '__mocks__') continue;
        walk(rel);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name)) {
        files.push(rel);
      }
    }
  };
  for (const dir of RUNTIME_DIRS) walk(dir);
  assert.ok(files.length > 0, 'the runtime source scan must actually find files');
  return files;
}

test('REACHABILITY: no first-party production source schedules a local notification', () => {
  // §26. This is the future-regression half of Repair 08. If someone adds a
  // local-notification feature while boot restoration stays globally blocked,
  // that feature is silently broken across every device reboot -- so this must
  // fail, forcing the correct workflow instead: explicit product authorization,
  // explicit native capability design, then an intentional governance update.
  const authority = require(path.join(ROOT, AUTHORITY));
  const suppressed = (authority.platforms.android.globallySuppressedTransitivePermissions?.permissions || [])
    .some((entry) => entry.permission === RECEIVE_BOOT_COMPLETED);
  if (!suppressed) return; // if the capability is ever deliberately granted, scheduling is legitimate

  const offenders = [];
  for (const file of runtimeSourceFiles()) {
    const source = read(file);
    for (const api of LOCAL_SCHEDULING_APIS) {
      // Word-boundary match so a longer identifier that merely contains one of
      // these names is not counted.
      if (new RegExp(`\\b${api}\\b`).test(source)) offenders.push(`${file} -> ${api}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'A local/scheduled notification API is now reachable from production source while ' +
      'RECEIVE_BOOT_COMPLETED is globally suppressed, so those notifications would not survive a device ' +
      'restart. Do not delete this assertion: authorize the feature, design the native capability, and ' +
      'update config/native-config-authority.json deliberately.',
  );
});

test('REACHABILITY: legitimate remote-notification APIs stay permitted', () => {
  // §27. The guard above must never degrade into "no expo-notifications
  // imports" -- that would break remote push. This asserts the positive half:
  // the shipping remote-push surface is still present and still allowed.
  const consumers = ['services/watchlist/pushRegistration.ts', 'services/watchlist/watchNotificationRouting.ts'];
  const combined = consumers.map(read).join('\n');

  for (const api of [
    'getPermissionsAsync',
    'requestPermissionsAsync',
    'setNotificationChannelAsync',
    'getExpoPushTokenAsync',
    'addPushTokenListener',
    'addNotificationReceivedListener',
    'addNotificationResponseReceivedListener',
    'getLastNotificationResponseAsync',
    'setNotificationHandler',
  ]) {
    assert.ok(combined.includes(api), `${api} is a legitimate remote-notification API and must remain reachable`);
    assert.ok(!LOCAL_SCHEDULING_APIS.includes(api), `${api} must never be added to the local-scheduling ban list`);
  }
});

test('ARCHITECTURE: Watchlist alerts remain remote, not device-local reminders', () => {
  // §28. Repair 08 is capability REDUCTION. A tempting "fix" for a future
  // reboot-survival requirement would be to turn the backend-driven alert into
  // a local reminder; that would re-create the very capability this removes.
  const producer = 'supabase/functions/commerce-watch-refresh/pushDelivery.ts';
  assert.ok(exists(producer), 'the governed Watchlist push producer must still exist');
  assert.match(read(producer), /https:\/\/exp\.host\/--\/api\/v2\/push\/send/, 'alerts must still originate remotely');
});

// ════════════════════════════════════════════════════════════════════════════
// PART C — the remote notification path must survive this repair (§14, §32)
// ════════════════════════════════════════════════════════════════════════════

test('RECEIVER PRESERVED: the library notification components are not removed or replaced', () => {
  // §32/§14. Repair 08 removes a PERMISSION. Someone "finishing" it later by
  // deleting the receiver, the FCM service or the NOTIFICATION_EVENT action
  // would break remote handling, presentation, tap/response routing and
  // therefore Watchlist alerts. Nothing in K Scan's manifests may suppress or
  // redeclare them.
  const components = [
    'expo.modules.notifications.service.NotificationsService',
    'expo.modules.notifications.service.ExpoFirebaseMessagingService',
    'expo.modules.notifications.NOTIFICATION_EVENT',
    '.service.NotificationsService',
    '.service.ExpoFirebaseMessagingService',
  ];

  const sourceSetsDir = path.join(ROOT, 'android', 'app', 'src');
  for (const sourceSet of fs.readdirSync(sourceSetsDir)) {
    const rel = `android/app/src/${sourceSet}/AndroidManifest.xml`;
    if (!exists(rel)) continue;
    const xml = stripXmlComments(read(rel));
    for (const component of components) {
      assert.ok(
        !xml.includes(component),
        `${rel} references "${component}". Repair 08 is a permission removal; the notification receiver, the ` +
          'FCM service and the NOTIFICATION_EVENT action carry ordinary remote delivery and tap handling and ' +
          'must reach the merged manifest untouched from the library.',
      );
    }
  }
});

test('RECEIVER PRESERVED: the library still declares the remote-push event path', () => {
  // The other half of the same guarantee: the components we refuse to touch
  // must actually still be there to be merged in.
  if (!exists(LIB_MANIFEST)) return;
  const lib = read(LIB_MANIFEST);
  assert.match(lib, /android:name="\.service\.NotificationsService"/, 'the notification receiver must be declared');
  assert.match(lib, /android:name="expo\.modules\.notifications\.NOTIFICATION_EVENT"/, 'the ordinary event action must be declared');
  assert.match(lib, /android:name="\.service\.ExpoFirebaseMessagingService"/, 'the FCM service must be declared');
  assert.match(lib, /android:name="com\.google\.firebase\.MESSAGING_EVENT"/, 'the FCM messaging event must be declared');
});

// ════════════════════════════════════════════════════════════════════════════
// PART D — effective posture across all four capability states (§12, §18, §33)
// ════════════════════════════════════════════════════════════════════════════

for (const state of STATES) {
  test(`STATE push=${state.push ? 'ON ' : 'OFF'} voice=${state.voice ? 'ON ' : 'OFF'} -> RECEIVE_BOOT_COMPLETED ABSENT (${state.label})`, () => {
    // §12/§33. Unlike POST_NOTIFICATIONS there is no matrix here: remote push
    // does not imply locally scheduled notifications, so the answer is the same
    // in all four states.
    assert.equal(effectivePosture(state.push, state.voice, RECEIVE_BOOT_COMPLETED), 'ABSENT');
  });
}

test('DECOUPLED: remote push capability never carries boot restoration with it', () => {
  // §18/§22. The architectural invariant Repair 08 adds on top of Repair 07's
  // matrix. Push-capable states must still grant POST_NOTIFICATIONS -- proving
  // this repair did not narrow remote push -- while boot stays absent, proving
  // the two capabilities are independent.
  assert.equal(effectivePosture(true, false, POST_NOTIFICATIONS), 'PRESENT');
  assert.equal(effectivePosture(true, true, POST_NOTIFICATIONS), 'PRESENT');
  assert.equal(effectivePosture(true, false, RECEIVE_BOOT_COMPLETED), 'ABSENT');
  assert.equal(effectivePosture(true, true, RECEIVE_BOOT_COMPLETED), 'ABSENT');
});

test('REPAIR 07 MATRIX: the four-state push/Voice permission matrix is unchanged', () => {
  // §22. Repair 08 must not perturb the matrix it builds on.
  const expected = [
    { push: false, voice: false, post: 'ABSENT', record: 'ABSENT' },
    { push: false, voice: true, post: 'ABSENT', record: 'PRESENT' },
    { push: true, voice: false, post: 'PRESENT', record: 'ABSENT' },
    { push: true, voice: true, post: 'PRESENT', record: 'PRESENT' },
  ];
  for (const row of expected) {
    assert.equal(effectivePosture(row.push, row.voice, POST_NOTIFICATIONS), row.post);
    assert.equal(effectivePosture(row.push, row.voice, RECORD_AUDIO), row.record);
  }
});

test('NO OVERLAY re-grants the boot permission', () => {
  // §12/§34 (controls AV, AW). No build-type manifest -- push, voicePush,
  // certification or any future source set -- may re-grant it.
  const sourceSetsDir = path.join(ROOT, 'android', 'app', 'src');
  for (const sourceSet of fs.readdirSync(sourceSetsDir)) {
    if (sourceSet === 'main') continue;
    const rel = `android/app/src/${sourceSet}/AndroidManifest.xml`;
    if (!exists(rel)) continue;
    assert.ok(
      !grants(read(rel)).includes(RECEIVE_BOOT_COMPLETED),
      `${rel} grants RECEIVE_BOOT_COMPLETED -- remote push and scheduled-local restoration are different ` +
        'capabilities, and no build profile may re-grant a globally suppressed permission',
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART E — governance record and prior-repair invariants (§19, §22, §23, §29)
// ════════════════════════════════════════════════════════════════════════════

test('AUTHORITY: the suppression is recorded as global, not as a build-profile exception', () => {
  // §29. It must NOT be misrepresented as a profile exception, because no
  // profile may re-grant it. This is a distinct governance shape.
  const authority = require(path.join(ROOT, AUTHORITY));
  const android = authority.platforms.android;

  const entries = android.globallySuppressedTransitivePermissions?.permissions || [];
  const entry = entries.find((item) => item.permission === RECEIVE_BOOT_COMPLETED);
  assert.ok(entry, 'RECEIVE_BOOT_COMPLETED must be recorded as a globally suppressed transitive permission');
  assert.equal(entry.contributingDependency, 'expo-notifications');
  assert.equal(entry.mustNeverBeGrantedByAnyProfile, true);
  assert.equal(entry.removedIn, MAIN_MANIFEST);

  for (const exception of android.buildProfileManifestExceptions.exceptions) {
    assert.ok(
      !(exception.additionalGrantedPermissions || []).includes(RECEIVE_BOOT_COMPLETED),
      `exception "${exception.id}" must not grant a globally suppressed permission`,
    );
  }

  // §14 restated as governance: the components the repair must not touch are
  // named in the record itself, so the constraint survives independently of
  // this test file.
  for (const component of [
    'expo.modules.notifications.service.NotificationsService',
    'expo.modules.notifications.NOTIFICATION_EVENT',
    'expo.modules.notifications.service.ExpoFirebaseMessagingService',
  ]) {
    assert.ok(entry.componentsThatMustSurvive.includes(component), `${component} must be recorded as must-survive`);
  }
});

test('PRIOR REPAIRS: Repair 02 and Repair 04 native state is untouched', () => {
  const main = read(MAIN_MANIFEST);
  const bare = stripXmlComments(main);

  // Repair 02 (§23) -- foreground-service removals must not be reintroduced.
  for (const permission of [
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  ]) {
    assert.ok(removes(main).includes(permission), `${permission} must stay removed`);
  }
  for (const service of [
    'expo.modules.audio.service.AudioControlsService',
    'expo.modules.audio.service.AudioRecordingService',
    'expo.modules.location.services.LocationTaskService',
  ]) {
    assert.match(bare, new RegExp(`<service android:name="${service.replace(/\./g, '\\.')}" tools:node="remove"\\s*/>`));
  }

  // Repair 04 (§19) -- notification icon/color metadata and resources.
  for (const key of [
    'com.google.firebase.messaging.default_notification_icon',
    'expo.modules.notifications.default_notification_icon',
    'com.google.firebase.messaging.default_notification_color',
    'expo.modules.notifications.default_notification_color',
  ]) {
    assert.ok(bare.includes(`android:name="${key}"`), `${key} metadata must survive Repair 08`);
  }
  // The icon ships as density buckets, not a single bare drawable/ entry.
  const densities = ['hdpi', 'mdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  for (const density of densities) {
    assert.ok(
      exists(`android/app/src/main/res/drawable-${density}/notification_icon.png`),
      `the drawable-${density} notification icon resource must survive`,
    );
  }
  assert.match(
    read('android/app/src/main/res/values/colors.xml'),
    /<color name="notification_icon_color">/,
    'the notification icon colour resource must survive',
  );
});

test('PRIOR REPAIRS: Repair 05 and Repair 06 runtime containment is untouched', () => {
  // §20/§21. Repair 08 is a native declaration change only -- it must not have
  // needed a test seam in the activation or availability modules.
  for (const rel of [
    'services/notifications/remotePushCapability.ts',
    'services/watchlist/pushRegistration.ts',
    'services/watchlist/watchlistAvailability.ts',
  ]) {
    assert.ok(exists(rel), `${rel} must still exist`);
  }
  assert.ok(
    !read('services/notifications/remotePushCapability.ts').includes('RECEIVE_BOOT_COMPLETED'),
    'the runtime activation module must not learn about a native-only permission',
  );
});
