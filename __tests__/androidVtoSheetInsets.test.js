// VTO sheet vs the Android navigation bar (K SCAN AI Build 34 Android final
// hostile audit, B34-AND-UI-001).
//
// React Native 0.81 draws every Modal edge-to-edge on Android once the
// edge-to-edge flag is on: ReactModalHostView's navigationBarTranslucent
// getter returns `field || isEdgeToEdgeFeatureFlagOn`, and this app sets
// edgeToEdgeEnabled=true. VirtualTryOnSheet is a transparent Modal whose
// backdrop anchors the sheet to the bottom of the screen, and the sheet kept
// only a static 16dp bottom padding, so on a 3-button navigation bar (48dp)
// the bottom of the Try on / Shop / Close row sat under the bar, where taps go
// to the system rather than to the app.
//
// The sheet now adds the bottom safe-area inset on Android. iOS is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SHEET = 'components/vto/VirtualTryOnSheet.tsx';

const SHEET_INSET_RE =
  /style=\{\[\s*styles\.sheet,\s*Platform\.OS === 'android' && \{ paddingBottom: SPACING\.lg \+ insets\.bottom \},?\s*\]\}/;

function insetProblems(source) {
  const problems = [];
  if (!/import \{ useSafeAreaInsets \} from 'react-native-safe-area-context';/.test(source)) {
    problems.push('useSafeAreaInsets must come from react-native-safe-area-context');
  }
  if (!/const insets = useSafeAreaInsets\(\);/.test(source)) {
    problems.push('the sheet must read the safe-area insets');
  }
  if (!SHEET_INSET_RE.test(source)) {
    problems.push('the sheet must add insets.bottom to its bottom padding on Android');
  }
  return problems;
}

test('premise: React Native forces edge-to-edge Modals when the flag is on', () => {
  const modalHost = read(
    'node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/modal/ReactModalHostView.kt',
  );
  assert.match(modalHost, /navigationBarTranslucent: Boolean = false\s+get\(\) = field \|\| isEdgeToEdgeFeatureFlagOn/);
  assert.match(read('android/gradle.properties'), /^edgeToEdgeEnabled=true$/m);
});

test('premise: the sheet is anchored to the bottom of the screen', () => {
  const source = read(SHEET);
  assert.match(source, /<Modal[\s\S]{0,80}transparent/);
  assert.match(source, /backdrop: \{[^}]*justifyContent: 'flex-end'/);
});

test('the VTO sheet clears the Android navigation bar', () => {
  assert.deepEqual(insetProblems(read(SHEET)), []);
});

test('NEGATIVE CONTROL: dropping the Android inset is detected', () => {
  const real = read(SHEET);
  const mutated = real.replace(" + insets.bottom", '');
  assert.notEqual(mutated, real, 'the mutation must change the real source (self-check)');
  assert.notDeepEqual(insetProblems(mutated), []);

  const unguarded = real.replace("Platform.OS === 'android' && ", '');
  assert.notEqual(unguarded, real, 'the mutation must change the real source (self-check)');
  assert.notDeepEqual(insetProblems(unguarded), [], 'iOS must stay unchanged: the inset is Android-only');
});
