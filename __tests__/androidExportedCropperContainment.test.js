// Exported third-party crop activity containment (K SCAN AI Build 34 Android
// final hostile audit, B34-AND-SEC-001).
//
// expo-image-picker depends on com.vanniktech:android-image-cropper, whose
// library manifest declares com.canhub.cropper.CropImageActivity with
// android:exported="true" and no permission, so the merged K Scan manifest
// exported it to every other app on the device. The activity takes its input
// from the launching intent and runs as K Scan.
//
// K Scan has no use for that: nothing outside the app needs to start it, every
// first-party picker call leaves allowsEditing off, and Expo's own crop screen
// is the separate, non-exported ExpoCropImageActivity. src/main therefore
// overrides the library's exported flag. Gradle is not run in CI, so the
// merged-manifest result was verified locally with :app:processReleaseMainManifest;
// these tests pin the source that produces it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MAIN_MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const PICKER_GRADLE = 'node_modules/expo-image-picker/android/build.gradle';
const CROPPER_ACTIVITY = 'com.canhub.cropper.CropImageActivity';
const FIRST_PARTY_DIRS = ['app', 'components', 'hooks', 'services', 'contexts', 'src', 'lib'];

const stripXmlComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');

function activityDeclaration(xml, name) {
  const matches = [...stripXmlComments(xml).matchAll(/<activity\b([^>]*?)\/?>/g)]
    .map((m) => m[1])
    .filter((attrs) => (attrs.match(/android:name="([^"]+)"/) || [])[1] === name);
  if (matches.length !== 1) return null;
  const attr = (key) => (matches[0].match(new RegExp(`${key}="([^"]*)"`)) || [])[1] ?? null;
  return { exported: attr('android:exported'), replace: attr('tools:replace'), node: attr('tools:node') };
}

function containmentProblems(xml) {
  const decl = activityDeclaration(xml, CROPPER_ACTIVITY);
  if (!decl) return [`${CROPPER_ACTIVITY} must be declared exactly once in ${MAIN_MANIFEST}`];
  const problems = [];
  if (decl.exported !== 'false') problems.push('android:exported must be "false"');
  if (!(decl.replace ?? '').split(',').map((s) => s.trim()).includes('android:exported')) {
    problems.push('tools:replace must name android:exported, or the library value wins the merge');
  }
  if (decl.node !== null) problems.push('the activity must stay declared, not removed');
  return problems;
}

function listSources(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSources(rel);
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [rel] : [];
  });
}

test('src/main keeps the transitive crop activity unexported', () => {
  assert.deepEqual(containmentProblems(read(MAIN_MANIFEST)), []);
});

test('the override is still needed: expo-image-picker still pulls the cropper library', () => {
  assert.match(
    read(PICKER_GRADLE),
    /com\.vanniktech:android-image-cropper/,
    'if the picker no longer depends on the cropper, re-evaluate and remove this override deliberately',
  );
});

test('no first-party picker call turns cropping on, so the override changes no K Scan flow', () => {
  const offenders = FIRST_PARTY_DIRS.flatMap(listSources).filter((rel) =>
    /allowsEditing\s*:\s*true/.test(read(rel)),
  );
  assert.deepEqual(offenders, []);
});

test('NEGATIVE CONTROL: the check fails when the override is removed or re-exported', () => {
  const real = read(MAIN_MANIFEST);
  const removed = real.replace(/<activity android:name="com\.canhub\.cropper\.CropImageActivity"[^>]*\/>/, '');
  assert.notEqual(removed, real, 'the mutation must change the real manifest (self-check)');
  assert.notDeepEqual(containmentProblems(removed), []);

  const reExported = real.replace(
    /(android:name="com\.canhub\.cropper\.CropImageActivity" )android:exported="false"/,
    '$1android:exported="true"',
  );
  assert.notEqual(reExported, real, 'the mutation must change the real manifest (self-check)');
  assert.notDeepEqual(containmentProblems(reExported), []);

  const unreplaced = real.replace(
    /(android:name="com\.canhub\.cropper\.CropImageActivity" android:exported="false") tools:replace="android:exported"/,
    '$1',
  );
  assert.notEqual(unreplaced, real, 'the mutation must change the real manifest (self-check)');
  assert.notDeepEqual(containmentProblems(unreplaced), []);
});
