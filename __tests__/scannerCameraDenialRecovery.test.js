// B34-FE-CAM-001 — a permanently denied camera must not remove the Scanner.
//
// WHY THIS FILE EXISTS. `app.js` is the screen mounted at /scan
// (app/scan/index.tsx re-exports it). It opened with an unconditional early
// return: if the camera permission was not granted, the WHOLE screen was
// replaced by a card whose only control was "Grant Access" ->
// requestPermission.
//
// On iOS that control is a no-op after a permanent denial --
// requestCameraPermissionsAsync() resolves immediately with the same denied
// status and canAskAgain: false, and presents no system prompt -- while the
// copy told the user to "enable it in settings" and gave them no way to get
// there. The root Stack sets headerShown: false and BackHandler is
// Android-only, so the screen had no visible exit either.
//
// And every governed profile sets EXPO_PUBLIC_SCAN_ROOM_V2_UI=true, so what
// that early return actually replaced was <ScanLanding> -- Upload Image, Text
// Scan and Home, none of which need camera permission -- plus
// <LiveScanCamera>, which ALREADY branches on canAskAgain and already offers
// Open Settings / Upload / Back. On the shipped surface the gate's only effect
// was to delete working routes.
//
// So this file tests the GATE CONDITION and the recovery affordances, because
// the gate is exactly what was wrong. The V2 assertion is derived from
// eas.json rather than assumed, so it answers correctly if the rollout changes.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const scanScreen = read('app.js');
const scanScreenCode = stripComments(scanScreen);
const liveCameraCode = stripComments(read('components/scan-room/LiveScanCamera.tsx'));

const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles');

/** Profiles that actually ship an artifact to a person. */
const SHIPPING_PROFILES = ['staging', 'staging-certification', 'testflight-staging', 'production'];

test('the shipped surface is the V2 Scan Room — derived from eas.json, never assumed', () => {
  const resolved = resolveEasBuildProfiles(JSON.parse(read('eas.json')));
  for (const name of SHIPPING_PROFILES) {
    assert.ok(resolved[name], `profile ${name} must exist`);
    assert.equal(
      resolved[name].env?.EXPO_PUBLIC_SCAN_ROOM_V2_UI,
      'true',
      `${name} must ship the V2 Scan Room; if this changes, the legacy gate below becomes live and must be re-reviewed`,
    );
  }
});

test('THE DEFECT: the legacy permission gate never runs on the V2 surface', () => {
  assert.match(
    scanScreenCode,
    /const cameraPermissionScreenApplies = !SCAN_ROOM_V2_UI_ENABLED && !photo;/,
    'the gate must stand down for the V2 Scan Room and once an image exists',
  );
  for (const guard of [
    /if \(!permission && cameraPermissionScreenApplies\)/,
    /if \(permission && !permission\.granted && cameraPermissionScreenApplies\)/,
  ]) {
    assert.match(scanScreenCode, guard, 'both permission screens must honour the gate condition');
  }
});

test('an image already chosen is never bounced back to the permission screen', () => {
  // The upload recovery route sets `photo` and moves to preview. If the gate
  // ignored `photo`, the very next render would return here again and the
  // recovery would be a loop.
  assert.match(scanScreenCode, /cameraPermissionScreenApplies = [^;]*!photo/);
});

test('a permanent denial offers Settings, not a button that does nothing', () => {
  assert.match(scanScreenCode, /const canPrompt = permission\.canAskAgain !== false;/);
  assert.match(scanScreenCode, /canPrompt[\s\S]{0,200}?label="Allow Camera"[\s\S]{0,300}?label="Open Settings"/);
  assert.match(scanScreenCode, /Linking\.openSettings\(\)/, 'the settings route must actually be taken');
  assert.match(
    scanScreenCode,
    /import \{[\s\S]{0,400}?Linking,[\s\S]{0,200}?\} from 'react-native'/,
    'Linking must be imported, not assumed global',
  );
});

test('the permission screen is never a dead end: an exit and a working alternative exist', () => {
  const gateBlock = scanScreenCode.slice(
    scanScreenCode.indexOf('if (permission && !permission.granted && cameraPermissionScreenApplies)'),
    scanScreenCode.indexOf('const renderViewfinder'),
  );
  assert.ok(gateBlock.length > 0, 'the denial block must be locatable');
  assert.match(gateBlock, /label="Upload a photo instead"[\s\S]{0,200}?onPress=\{selectGalleryPhoto\}/);
  assert.match(gateBlock, /label="Not now"[\s\S]{0,200}?onPress=\{handleHome\}/);
});

test('the undetermined-permission screen also offers an exit', () => {
  const block = scanScreenCode.slice(
    scanScreenCode.indexOf('if (!permission && cameraPermissionScreenApplies)'),
    scanScreenCode.indexOf('if (permission && !permission.granted'),
  );
  assert.match(block, /label="Not now"/);
});

test('the gallery route the recovery offers does not itself need camera permission', () => {
  // selectGalleryPhoto goes through ImagePicker.launchImageLibraryAsync, which
  // uses the iOS system picker. Offering it as the recovery would be a lie if
  // it first asked for the camera.
  const hook = stripComments(read('hooks/useKScan.js'));
  const body = hook.slice(hook.indexOf('const selectGalleryPhoto'), hook.indexOf('const selectGalleryPhoto') + 1800);
  assert.match(body, /ImagePicker\.launchImageLibraryAsync/);
  assert.doesNotMatch(body, /requestCameraPermissions|useCameraPermissions|requestPermission\(/);
});

test('the V2 camera keeps owning permission for the surface that actually ships', () => {
  // The gate standing down is only correct because this component handles it.
  assert.match(liveCameraCode, /permission\?\.canAskAgain \? 'Allow Camera' : 'Open Settings'/);
  assert.match(liveCameraCode, /permission\?\.canAskAgain \? requestPermission : \(\) => \{ void Linking\.openSettings\(\); \}/);
  assert.match(liveCameraCode, /title=\{uploadAvailable \? 'Upload Image' : 'Upload Unavailable'\}/);
  assert.match(liveCameraCode, /title="Back"/);
});

test('NEGATIVE CONTROL: the assertions bite against the pre-repair screen', () => {
  const preRepair = `
  if (!permission.granted) {
    return (
      <View>
        <Text>Camera access is currently disabled. Enable it in settings to continue.</Text>
        <ActionButton label="Grant Access" onPress={requestPermission} />
      </View>
    );
  }`;
  assert.throws(() => assert.match(preRepair, /canAskAgain/), 'the old screen had no permanent-denial branch');
  assert.throws(() => assert.match(preRepair, /Linking\.openSettings/), 'and no settings route');
  assert.throws(() => assert.match(preRepair, /Upload a photo instead/), 'and no working alternative');
});
