'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

/**
 * Camera permission must gate only the Scanner views that show the live camera
 * (Production Scanner debugger, P-PERM-1).
 *
 * Before: the scanner screen returned a "Camera access is currently disabled"
 * dead end for EVERY state while the camera was not granted. A user who declined
 * the camera could not reach Upload Image or Describe an Item on the landing, and
 * a photo picked from the gallery could never be analysed or shown.
 */

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

function loadHelper() {
  const filename = path.join(ROOT, 'services/scannerCameraRequirement.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { exports: mod.exports, module: mod }, { filename });
  return mod.exports;
}

const { isScannerCameraRequired } = loadHelper();
const required = (roomV2Ui, status, v2CameraVisible, hasPhoto) =>
  isScannerCameraRequired({ roomV2Ui, status, v2CameraVisible, hasPhoto });

const V2_STATUSES = ['idle', 'capturing', 'preview', 'processing', 'result', 'non-fashion', 'error'];

test('V2 landing needs no camera: Upload Image and Describe an Item stay reachable', () => {
  assert.equal(required(true, 'idle', false, false), false);
});

test('V2 live camera needs the camera', () => {
  assert.equal(required(true, 'idle', true, false), true);
  assert.equal(required(true, 'capturing', true, false), true);
  assert.equal(required(true, 'capturing', false, false), true);
});

test('V2 views for a picked or captured image need no camera', () => {
  for (const status of ['preview', 'non-fashion', 'error']) {
    for (const visible of [true, false]) {
      assert.equal(required(true, status, visible, true), false, `${status}/visible=${visible} with a photo`);
    }
  }
  assert.equal(required(true, 'processing', false, true), false);
  assert.equal(required(true, 'processing', true, true), false);
  assert.equal(required(true, 'result', false, true), false);
  assert.equal(required(true, 'result', true, true), false);
});

test('V2 without an image falls back to the camera only if it was opened', () => {
  for (const status of ['preview', 'non-fashion', 'error']) {
    assert.equal(required(true, status, true, false), true, `${status}: camera was open`);
    assert.equal(required(true, status, false, false), false, `${status}: landing`);
  }
});

test('an unknown status keeps the gate (renderContent default is the camera screen)', () => {
  assert.equal(required(true, 'something-new', false, false), true);
  assert.equal(required(true, '', true, true), true);
});

test('legacy (flag off) screens are unchanged: the gate always applies', () => {
  for (const status of [...V2_STATUSES, 'unknown']) {
    for (const visible of [true, false]) {
      for (const hasPhoto of [true, false]) {
        assert.equal(required(false, status, visible, hasPhoto), true, `${status}/${visible}/${hasPhoto}`);
      }
    }
  }
});

// ── Keep the helper in step with the real screen ─────────────────────────────

function v2SwitchBlock() {
  const start = APP_SOURCE.indexOf('if (SCAN_ROOM_V2_UI_ENABLED) {\n      switch (status) {');
  assert.notEqual(start, -1, 'renderContent has a V2 switch');
  const end = APP_SOURCE.indexOf('// Existing flow (flag disabled)', start);
  assert.notEqual(end, -1, 'renderContent has the legacy flow after the V2 switch');
  return APP_SOURCE.slice(start, end);
}

test('the helper handles exactly the statuses the V2 renderContent switch renders', () => {
  const rendered = [...v2SwitchBlock().matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]).sort();
  assert.deepEqual(rendered, [...V2_STATUSES].sort(), 'a new V2 status must be classified in scannerCameraRequirement.ts');
});

test('statuses that render no camera in V2 do not render LiveScanCamera/renderCameraScreen', () => {
  const block = v2SwitchBlock();
  const caseBody = (label) => {
    const from = block.indexOf(`case '${label}':`);
    assert.notEqual(from, -1, `case ${label}`);
    const next = block.slice(from + 1).search(/\n {8}case '|\n {8}default:/);
    return block.slice(from, next === -1 ? undefined : from + 1 + next);
  };
  for (const status of ['processing', 'result']) {
    assert.doesNotMatch(caseBody(status), /LiveScanCamera|renderCameraScreen/, `${status} must not show the camera`);
  }
  assert.match(caseBody('capturing'), /LiveScanCamera/);
});

// ── The screen actually uses it, and the denied screens offer a way back ──────

test('both permission gates apply only where the camera is required', () => {
  assert.match(APP_SOURCE, /import \{ isScannerCameraRequired \} from '\.\/services\/scannerCameraRequirement';/);
  assert.match(APP_SOURCE, /const cameraRequired = isScannerCameraRequired\(\{[\s\S]*?\}\);/);
  assert.match(APP_SOURCE, /if \(cameraRequired && !permission\) \{/);
  assert.match(APP_SOURCE, /if \(cameraRequired && !permission\.granted\) \{/);
  assert.doesNotMatch(APP_SOURCE, /\n  if \(!permission\) \{/, 'no ungated first gate remains');
  assert.doesNotMatch(APP_SOURCE, /\n  if \(!permission\.granted\) \{/, 'no ungated denied gate remains');
});

test('the gates are evaluated after the state they depend on is declared', () => {
  const gate = APP_SOURCE.indexOf('const cameraRequired = isScannerCameraRequired(');
  for (const declaration of [
    'const [v2CameraVisible, setV2CameraVisible] = useState(false);',
    'const [permission, requestPermission, getPermission] = useCameraPermissions();',
  ]) {
    const at = APP_SOURCE.indexOf(declaration);
    assert.notEqual(at, -1, declaration);
    assert.ok(at < gate, `${declaration} must precede the gate`);
  }
});

test('each denied screen under the V2 UI offers Back to the landing', () => {
  const backs = APP_SOURCE.match(
    /\{SCAN_ROOM_V2_UI_ENABLED \? \(\s*<ActionButton label="Back" onPress=\{\(\) => setV2CameraVisible\(false\)\} variant="tertiary" \/>\s*\) : null\}/g,
  );
  assert.equal(backs?.length, 2, 'the not-asked-yet and the denied screens both carry Back');
});

test('NEGATIVE CONTROL: the pre-repair gate shape is reported by the same assertions', () => {
  const preRepair = APP_SOURCE
    .replace('if (cameraRequired && !permission) {', 'if (!permission) {')
    .replace('if (cameraRequired && !permission.granted) {', 'if (!permission.granted) {');
  assert.match(preRepair, /\n  if \(!permission\.granted\) \{/);
  assert.doesNotMatch(preRepair, /if \(cameraRequired && !permission\.granted\) \{/);
});
