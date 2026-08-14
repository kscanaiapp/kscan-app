const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function transpileModule(file, mocks = {}) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
    Set,
    Math,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

const contract = transpileModule('services/avatarMotionState.ts');

function loadGaze() {
  const gaze = transpileModule('services/avatarGazeTargets.ts', {
    './avatarMotionState': contract,
  });
  gaze.resetAvatarGazeForTests();
  return gaze;
}

const CAPABLE = { mode: 'idle', reducedMotion: false, gazeCapable: true };

test('local target registration moves gaze and emits once per change', () => {
  const gaze = loadGaze();
  let emissions = 0;
  const unsubscribe = gaze.subscribeToAvatarGazeTarget(() => {
    emissions += 1;
  });
  gaze.setAvatarGazeTarget('composer');
  assert.equal(gaze.getAvatarGazeTargetSnapshot(), 'composer');
  const vector = gaze.resolveAvatarGaze(CAPABLE);
  assert.ok(vector.y > 0, 'composer sits below the avatar');
  assert.equal(emissions, 1);
  // Re-registering the same target does not emit.
  gaze.setAvatarGazeTarget('composer');
  assert.equal(emissions, 1);
  unsubscribe();
});

test('target removal returns gaze to neutral', () => {
  const gaze = loadGaze();
  gaze.setAvatarGazeTarget('product-card');
  assert.notDeepEqual(
    JSON.parse(JSON.stringify(gaze.resolveAvatarGaze(CAPABLE))),
    { x: 0, y: 0 },
  );
  gaze.clearAvatarGazeTarget();
  assert.deepEqual(
    JSON.parse(JSON.stringify(gaze.resolveAvatarGaze(CAPABLE))),
    { x: 0, y: 0 },
  );
});

test('invalid targets fall back to neutral instead of throwing', () => {
  const gaze = loadGaze();
  for (const bad of ['user-face', '', null, undefined, 42, {}, 'window.camera']) {
    gaze.setAvatarGazeTarget(bad);
    assert.equal(gaze.getAvatarGazeTargetSnapshot(), 'neutral', String(bad));
    assert.deepEqual(
      JSON.parse(JSON.stringify(gaze.resolveAvatarGaze(CAPABLE))),
      { x: 0, y: 0 },
    );
  }
});

test('priority arbitration: speaking and interrupted always resolve neutral', () => {
  const gaze = loadGaze();
  gaze.setAvatarGazeTarget('scan-result');
  for (const mode of ['speaking', 'interrupted']) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(gaze.resolveAvatarGaze({ ...CAPABLE, mode }))),
      { x: 0, y: 0 },
      `${mode} outranks gaze`,
    );
  }
  // Lower-priority states may glance.
  for (const mode of ['idle', 'listening', 'thinking', 'reacting']) {
    const vector = gaze.resolveAvatarGaze({ ...CAPABLE, mode });
    assert.ok(vector.x !== 0 || vector.y !== 0, `${mode} permits the glance`);
  }
});

test('Reduce Motion disables visible gaze movement', () => {
  const gaze = loadGaze();
  gaze.setAvatarGazeTarget('saved-confirmation');
  assert.deepEqual(
    JSON.parse(JSON.stringify(gaze.resolveAvatarGaze({ ...CAPABLE, reducedMotion: true }))),
    { x: 0, y: 0 },
  );
});

test('missing eye assets (no gaze capability) resolve neutral — no unapproved head cue', () => {
  const gaze = loadGaze();
  gaze.setAvatarGazeTarget('product-card');
  assert.deepEqual(
    JSON.parse(JSON.stringify(gaze.resolveAvatarGaze({ ...CAPABLE, gazeCapable: false }))),
    { x: 0, y: 0 },
  );
});

test('every semantic vector stays within the restrained contract bounds', () => {
  const gaze = loadGaze();
  for (const target of ['composer', 'product-card', 'scan-result', 'saved-confirmation', 'neutral']) {
    gaze.setAvatarGazeTarget(target);
    const vector = gaze.resolveAvatarGaze(CAPABLE);
    assert.ok(Math.abs(vector.x) <= contract.MOTION_LIMITS.gazeRange, `${target} x bounded`);
    assert.ok(Math.abs(vector.y) <= contract.MOTION_LIMITS.gazeRange, `${target} y bounded`);
    assert.ok(Math.abs(vector.x) <= 0.4 && Math.abs(vector.y) <= 0.4, `${target} reads as a glance`);
  }
});

test('cleanup: unsubscribe releases listeners; navigation-style reset clears state', () => {
  const gaze = loadGaze();
  const unsubscribeA = gaze.subscribeToAvatarGazeTarget(() => {});
  const unsubscribeB = gaze.subscribeToAvatarGazeTarget(() => {});
  assert.equal(gaze.getAvatarGazeListenerCountForTests(), 2);
  unsubscribeA();
  unsubscribeB();
  assert.equal(gaze.getAvatarGazeListenerCountForTests(), 0);
  gaze.setAvatarGazeTarget('composer');
  gaze.clearAvatarGazeTarget();
  assert.equal(gaze.getAvatarGazeTargetSnapshot(), 'neutral');
});

test('no camera, tracking, biometric, or permission surface anywhere in the module', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarGazeTargets.ts'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /expo-camera|react-native-vision|Camera|getUserMedia/);
  assert.doesNotMatch(code, /Permissions|requestPermission/i);
  assert.doesNotMatch(code, /\b(face|facial|biometric|recognition|tracking)\b/i);
  assert.doesNotMatch(code, /fetch\(|supabase|invoke\(|upload/i);
  // Imports: only the motion contract.
  const importBlocks = source.match(/^import[\s\S]*?from '[^']+';/gm) ?? [];
  assert.equal(importBlocks.length, 1);
  assert.match(importBlocks[0], /from '\.\/avatarMotionState';$/);
});
