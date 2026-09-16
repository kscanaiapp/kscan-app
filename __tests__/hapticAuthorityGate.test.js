const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HAPTICS_AUTHORITY_PATH = path.join(ROOT, 'services', 'haptics.js');

const SCAN_DIRS = ['app', 'components', 'hooks', 'services'];
const DIRECT_HAPTIC_IMPORT = /from\s+['"]expo-haptics['"]|require\(\s*['"]expo-haptics['"]\s*\)/;
const VIBRATION_API_USE = /\bVibration\s*\.\s*vibrate\b/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
    } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

test('services/haptics.js is the only file that imports expo-haptics directly (BLOCK-IX35-00/01)', () => {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
  const offenders = files.filter((filePath) => {
    if (filePath === HAPTICS_AUTHORITY_PATH) return false;
    const source = fs.readFileSync(filePath, 'utf8');
    return DIRECT_HAPTIC_IMPORT.test(source);
  });

  assert.deepEqual(
    offenders.map((filePath) => path.relative(ROOT, filePath)),
    [],
    'a feature file is importing expo-haptics directly instead of going through services/haptics.js',
  );
});

test('no feature file calls the raw React Native Vibration API directly (BLOCK-IX35-00/01)', () => {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
  const offenders = files.filter((filePath) => {
    if (filePath === HAPTICS_AUTHORITY_PATH) return false;
    const source = fs.readFileSync(filePath, 'utf8');
    return VIBRATION_API_USE.test(source);
  });

  assert.deepEqual(
    offenders.map((filePath) => path.relative(ROOT, filePath)),
    [],
    'a feature file is calling Vibration.vibrate directly instead of going through services/haptics.js',
  );
});

test('the haptic authority module exports the restrained semantic vocabulary, nothing more', () => {
  const source = fs.readFileSync(HAPTICS_AUTHORITY_PATH, 'utf8');
  const exported = [...source.matchAll(/^export function (\w+)/gm)].map((match) => match[1]);

  assert.deepEqual(
    exported.sort(),
    ['errorPulse', 'softImpact', 'successPulse', 'selectionTick', 'warningPulse'].sort(),
    'the haptic authority is expected to expose exactly this semantic vocabulary — selection/confirm/success/warning/destructive',
  );
});

test('every exported haptic function routes through the shared fire() guard, not a bare native call', () => {
  const source = fs.readFileSync(HAPTICS_AUTHORITY_PATH, 'utf8');
  const functionBlocks = [...source.matchAll(/^export function (\w+)\(\) \{([\s\S]*?)\n\}/gm)];

  assert.ok(functionBlocks.length > 0, 'expected at least one exported haptic function');
  for (const [, name, body] of functionBlocks) {
    assert.match(
      body,
      /fire\(\(\) => Haptics\./,
      `${name}() must call Haptics.* only inside fire(), so a device without haptic support can never throw out of a tap handler`,
    );
  }
});

test('fire() swallows both a synchronous throw and a rejected promise (BLOCK-IX35-02)', () => {
  const source = fs.readFileSync(HAPTICS_AUTHORITY_PATH, 'utf8');
  const fireBody = source.match(/function fire\(effect\) \{([\s\S]*?)\n\}/);
  assert.ok(fireBody, 'expected a fire(effect) helper');

  assert.match(fireBody[1], /try\s*\{/, 'fire() must guard the synchronous call with try/catch');
  assert.match(fireBody[1], /catch/, 'fire() must catch a synchronous throw');
  assert.match(fireBody[1], /\.catch\(/, 'fire() must catch a rejected promise from the native call');
});
