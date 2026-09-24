// Android photo-library access before the system picker (K SCAN AI Build 34
// Android final hostile audit, B34-AND-PICK-001).
//
// THE DEFECT
//
// launchImageLibraryAsync opens Android's system photo picker (AndroidX
// PickVisualMedia, or ACTION_GET_CONTENT), which hands back exactly the items
// the user taps and needs no permission at all. But four reachable flows asked
// ImagePicker.requestMediaLibraryPermissionsAsync() FIRST and returned early
// unless it said "granted":
//
//   app/library.tsx                                  inspiration upload
//   components/closet/ClosetIntakeModal.tsx          Closet direct intake
//   components/style-chat/StyleChatAttachmentBar.tsx Elise photo attachment
//   app/dressing-rooms/[id].tsx                      room inspiration upload
//
// Below Android 13 expo-image-picker implements that request as
// READ_EXTERNAL_STORAGE + WRITE_EXTERNAL_STORAGE, and this app deliberately
// declares neither (src/main removes both). Android auto-denies a permission
// the manifest does not declare, without a dialog, so on Android 7.0-12L the
// picker never opened: the user was told to allow photo access in Settings,
// where there is nothing to allow. The VTO person picker hit and fixed the same
// defect on its own (services/vto/vtoPersonInput.ts); these four did not.
//
// THE REPAIR keeps the manifest exactly as it is and skips the pre-picker
// request on Android only. iOS is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const REACHABLE_GATED_SITES = [
  'app/library.tsx',
  'components/closet/ClosetIntakeModal.tsx',
  'components/style-chat/StyleChatAttachmentBar.tsx',
  'app/dressing-rooms/[id].tsx',
];

const REQUEST = 'ImagePicker.requestMediaLibraryPermissionsAsync';
const LAUNCH = 'ImagePicker.launchImageLibraryAsync';

const isPlatformOsCheck = (expr, operator) =>
  ts.isBinaryExpression(expr) &&
  expr.operatorToken.kind === operator &&
  expr.left.getText() === 'Platform.OS' &&
  ts.isStringLiteral(expr.right) &&
  expr.right.text === 'android';

// A call is Android-safe when it sits in the THEN branch of
// `if (Platform.OS !== 'android')`, or when an earlier statement of an
// enclosing block is `if (Platform.OS === 'android') return ...;`.
function isSkippedOnAndroid(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (
      ts.isIfStatement(parent) &&
      parent.thenStatement === child &&
      isPlatformOsCheck(parent.expression, ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      return true;
    }
    if (ts.isBlock(parent)) {
      const earlierReturn = parent.statements
        .slice(0, parent.statements.indexOf(child))
        .some(
          (statement) =>
            ts.isIfStatement(statement) &&
            isPlatformOsCheck(statement.expression, ts.SyntaxKind.EqualsEqualsEqualsToken) &&
            (ts.isReturnStatement(statement.thenStatement) ||
              (ts.isBlock(statement.thenStatement) &&
                statement.thenStatement.statements.some(ts.isReturnStatement))),
        );
      if (earlierReturn) return true;
    }
  }
  return false;
}

function callsTo(source, fileName, callee) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === callee) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function unguardedRequests(source, fileName) {
  return callsTo(source, fileName, REQUEST).filter((call) => !isSkippedOnAndroid(call));
}

test('premise: the app declares no storage or media-read permission on Android', () => {
  const main = read('android/app/src/main/AndroidManifest.xml');
  for (const permission of ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE']) {
    assert.match(
      main,
      new RegExp(`android\\.permission\\.${permission}" tools:node="remove"`),
      `${permission} is removed from src/main; if that changes, re-evaluate this repair`,
    );
  }
  assert.doesNotMatch(main, /READ_MEDIA_(IMAGES|VIDEO)/);
});

test('premise: below Android 13 expo-image-picker asks for the undeclared storage permissions', () => {
  const pickerModule = read(
    'node_modules/expo-image-picker/android/src/main/java/expo/modules/imagepicker/ImagePickerModule.kt',
  );
  assert.match(
    pickerModule,
    /getMediaLibraryPermissions[\s\S]{0,200}TIRAMISU[\s\S]{0,120}emptyArray[\s\S]{0,200}READ_EXTERNAL_STORAGE/,
    'if the picker stops asking for storage below Android 13, re-evaluate this repair',
  );
});

test('premise: the library picker itself is a system picker that needs no permission', () => {
  const contract = read(
    'node_modules/expo-image-picker/android/src/main/java/expo/modules/imagepicker/contracts/ImageLibraryContract.kt',
  );
  assert.match(contract, /PickVisualMedia/);
  assert.doesNotMatch(contract, /checkSelfPermission|READ_EXTERNAL_STORAGE|READ_MEDIA_/);
});

for (const rel of REACHABLE_GATED_SITES) {
  test(`${rel}: the pre-picker permission request is skipped on Android`, () => {
    const source = read(rel);
    assert.ok(callsTo(source, rel, REQUEST).length > 0, `${rel} must still ask on iOS (self-check)`);
    assert.deepEqual(unguardedRequests(source, rel).map((call) => call.getText()), []);
  });

  test(`${rel}: the picker itself still opens on Android`, () => {
    const source = read(rel);
    const launches = callsTo(source, rel, LAUNCH);
    assert.ok(launches.length > 0, `${rel} must still open the library picker`);
    assert.ok(launches.every((call) => !isSkippedOnAndroid(call)));
  });
}

test('the remaining gated sites stay unreachable on Android', () => {
  // components/closet/MirrorSelfieExtractionModal.tsx and
  // components/style-chat/StyleChatPhotoIntake.tsx keep an ungated request.
  // That is only safe while Android can never reach them.
  const mirror = read('services/mirror/mirrorSelfieAvailability.ts');
  assert.match(mirror, /MIRROR_SELFIE_SUPPORTED_PLATFORMS[^=]*=\s*\['ios'\]/);

  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles.js');
  const profiles = resolveEasBuildProfiles(JSON.parse(read('eas.json')));
  for (const [name, profile] of Object.entries(profiles)) {
    assert.notEqual(
      (profile.env ?? {}).EXPO_PUBLIC_ELISE_LEGACY_PHOTO_INTAKE_ENABLED,
      'true',
      `profile "${name}" would expose the legacy intake's ungated request on Android`,
    );
  }
});

test('NEGATIVE CONTROL: removing an Android guard is detected', () => {
  const rel = 'components/closet/ClosetIntakeModal.tsx';
  const real = read(rel);
  const mutated = real.replace("if (Platform.OS !== 'android') {", 'if (true) {');
  assert.notEqual(mutated, real, 'the mutation must change the real source (self-check)');
  assert.equal(unguardedRequests(mutated, rel).length, 1);

  const libRel = 'app/library.tsx';
  const lib = read(libRel);
  const libMutated = lib.replace("if (Platform.OS === 'android') return true;", '');
  assert.notEqual(libMutated, lib, 'the mutation must change the real source (self-check)');
  assert.equal(unguardedRequests(libMutated, libRel).length, 1);
});

test('NEGATIVE CONTROL: a guard on the picker itself would be detected', () => {
  const rel = 'app/dressing-rooms/[id].tsx';
  const mutated = "if (Platform.OS !== 'android') { await ImagePicker.launchImageLibraryAsync({}); }";
  const [launch] = callsTo(mutated, rel, LAUNCH);
  assert.equal(isSkippedOnAndroid(launch), true);
});
