'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');

function read() {
  return fs.readFileSync(APP, 'utf8');
}

function foregroundRefreshBlock(source) {
  const marker = '// Android does not relaunch the app after a user grants camera access in';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'foreground permission-refresh block exists');
  const end = source.indexOf('  const [isCameraReady, setIsCameraReady]', start);
  assert.ok(end > start, 'permission-refresh block terminates before the next scanner hook');
  return source.slice(start, end);
}

function assertRefreshContract(source) {
  const rnImport = /import \{([\s\S]*?)\} from 'react-native';/.exec(source);
  assert.ok(rnImport, 'react-native import exists');
  assert.match(rnImport[1], /\bAppState\b/);

  assert.match(
    source,
    /const \[permission, requestPermission, getPermission\] = useCameraPermissions\(\);/,
    'scanner must retain expo-camera getPermission for foreground refresh',
  );

  const block = foregroundRefreshBlock(source);
  assert.match(block, /Platform\.OS !== 'android'/);
  assert.match(block, /AppState\.addEventListener\('change'/);
  assert.match(block, /nextState !== 'active' \|\| permission\?\.granted/);
  assert.match(block, /getPermission\(\)\.catch/);
  assert.match(block, /return \(\) => subscription\.remove\(\)/);
  assert.match(block, /\[getPermission, permission\?\.granted\]/);
}

test('Android scanner refreshes camera permission when returning from Settings', () => {
  assertRefreshContract(read());
});

test('NEGATIVE CONTROL: dropping the foreground permission read is detected', () => {
  const source = read();
  const mutated = source.replace('      getPermission().catch(() => {', '      Promise.resolve().catch(() => {');
  assert.notEqual(mutated, source);
  assert.throws(() => assertRefreshContract(mutated));
});

test('NEGATIVE CONTROL: widening the listener to every platform is detected', () => {
  const source = read();
  const mutated = source.replace("    if (Platform.OS !== 'android') return undefined;\n", '');
  assert.notEqual(mutated, source);
  assert.throws(() => assertRefreshContract(mutated));
});
