/**
 * Build 32 Android edge-to-edge modernization contract.
 *
 * Guards against the specific defect Google Play flagged: a deprecated
 * opaque-status-bar theme attribute coexisting with RN's edge-to-edge
 * authority. Checks production-reachable config/source, not historical
 * docs or node_modules.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function walkSourceFiles(dir, out = []) {
  const SKIP_DIRS = new Set(['node_modules', 'android', 'ios', '.git', '__tests__', 'scripts']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkSourceFiles(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('AppTheme does not set the deprecated android:statusBarColor/navigationBarColor theme items', () => {
  const styles = read('android/app/src/main/res/values/styles.xml');
  assert.doesNotMatch(styles, /android:statusBarColor/);
  assert.doesNotMatch(styles, /android:navigationBarColor/);
});

test('gradle.properties declares the single live edge-to-edge authority with no dead/opt-out flags', () => {
  const props = read('android/gradle.properties');
  assert.match(props, /^edgeToEdgeEnabled=true$/m);
  assert.doesNotMatch(props, /expo\.edgeToEdgeEnabled/);
  assert.doesNotMatch(props, /windowOptOutEdgeToEdgeEnforcement/i);
});

test('AndroidManifest does not opt out of edge-to-edge enforcement or force a legacy cutout mode', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.doesNotMatch(manifest, /windowOptOutEdgeToEdgeEnforcement/i);
  assert.doesNotMatch(manifest, /layoutInDisplayCutoutMode/i);
});

test('production source never passes StatusBar backgroundColor/translucent props', () => {
  const offenders = [];
  for (const file of walkSourceFiles(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/<StatusBar\b/.test(src)) continue;
    const tags = src.match(/<StatusBar\b[\s\S]*?\/?>/g) || [];
    for (const tag of tags) {
      if (/backgroundColor\s*=|translucent\s*=/.test(tag)) {
        offenders.push(`${path.relative(ROOT, file)}: ${tag.replace(/\s+/g, ' ')}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the app root wires exactly one SafeAreaProvider and no components import the legacy react-native SafeAreaView', () => {
  const rootLayout = read('app/_layout.tsx');
  const providerMatches = rootLayout.match(/<SafeAreaProvider\b/g) || [];
  assert.equal(providerMatches.length, 1);

  const offenders = [];
  for (const file of walkSourceFiles(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    if (/SafeAreaView/.test(src) && /from\s+['"]react-native['"]/.test(src)) {
      const importLine = src.split('\n').find((l) => l.includes('SafeAreaView') && l.includes('react-native'));
      if (importLine && !importLine.includes('safe-area-context')) {
        offenders.push(`${path.relative(ROOT, file)}: ${importLine.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
