// Private Dressing Room sheets vs the Android navigation bar (K SCAN AI Build 34
// Android final pre-EAS closure, B34-AND-UI-002 - the same defect class as
// B34-AND-UI-001, found in a second surface).
//
// React Native 0.81 draws every Modal edge-to-edge on Android once the
// edge-to-edge flag is on: ReactModalHostView's navigationBarTranslucent getter
// returns `field || isEdgeToEdgeFeatureFlagOn`, and this app sets
// edgeToEdgeEnabled=true. The four bottom-sheet Modals of the Private Dressing
// Room (slot editor, comparison, context-change confirm, Elise occasion) share
// one `sheet` style with a static 16dp padding, so their last action - a 52dp
// SecondaryButton - spans 16-68dp above the physical screen bottom. A 48dp
// 3-button navigation bar therefore covers 32dp of it, label included, and taps
// there go to the system rather than to the app.
//
// The sheets now add the bottom safe-area inset on Android. iOS is unchanged
// (the added style entry is `false` there).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SCREEN = 'app/stylist/dressing-room/index.tsx';
const SHEET_TEST_IDS = ['slot-editor', 'comparison-view', 'context-change-confirm', 'elise-occasion-sheet'];

const SHEET_STYLE_RE =
  /const sheetStyle = \[\s*styles\.sheet,\s*Platform\.OS === 'android' && \{ paddingBottom: SPACING\.lg \+ insets\.bottom \},?\s*\];/;

function insetProblems(source) {
  const problems = [];
  if (!/import \{ useSafeAreaInsets \} from 'react-native-safe-area-context';/.test(source)) {
    problems.push('useSafeAreaInsets must come from react-native-safe-area-context');
  }
  if (!/import \{[^}]*\bPlatform\b[^}]*\} from 'react-native';/.test(source)) {
    problems.push('Platform must be imported from react-native');
  }
  const hook = source.indexOf('const insets = useSafeAreaInsets();');
  const gate = source.indexOf('if (!PRIVATE_DRESSING_ROOM_V1) {');
  if (hook === -1) {
    problems.push('the screen must read the safe-area insets');
  } else if (gate !== -1 && hook > gate) {
    problems.push('the insets hook must run before the flag early return (hook order)');
  }
  if (!SHEET_STYLE_RE.test(source)) {
    problems.push('the sheet style must add insets.bottom to its bottom padding on Android');
  }
  for (const id of SHEET_TEST_IDS) {
    const usesSheetStyle = new RegExp(`<View style=\\{sheetStyle\\} testID="${id}"`).test(source);
    if (!usesSheetStyle) problems.push(`the ${id} sheet must use sheetStyle`);
  }
  if (/<View style=\{styles\.sheet\}/.test(source)) {
    problems.push('no sheet may keep the static styles.sheet');
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

test('premise: the four sheets are transparent bottom-anchored Modals sharing one static-padding style', () => {
  const source = read(SCREEN);
  assert.equal((source.match(/<Modal\b/g) ?? []).length, 4, 'the screen has exactly four Modals');
  assert.match(source, /sheetBackdrop: \{[^}]*justifyContent: 'flex-end'/);
  assert.match(source, /\n  sheet: \{[^}]*padding: SPACING\.lg,/);
  for (const id of SHEET_TEST_IDS) {
    assert.ok(source.includes(`testID="${id}"`), `${id} sheet exists`);
  }
});

test('premise: each sheet ends with a 52dp secondary button', () => {
  const theme = read('constants/theme.ts');
  assert.match(theme, /secondary: \{[^}]*height: 52,/);
});

test('the Private Dressing Room sheets clear the Android navigation bar', () => {
  assert.deepEqual(insetProblems(read(SCREEN)), []);
});

test('NEGATIVE CONTROL: dropping the Android inset is detected', () => {
  const real = read(SCREEN);
  const mutated = real.replace(' + insets.bottom', '');
  assert.notEqual(mutated, real, 'the mutation must change the real source (self-check)');
  assert.notDeepEqual(insetProblems(mutated), []);
});

test('NEGATIVE CONTROL: applying the inset on iOS as well is detected (iOS must stay unchanged)', () => {
  const real = read(SCREEN);
  const unguarded = real.replace("Platform.OS === 'android' && ", '');
  assert.notEqual(unguarded, real, 'the mutation must change the real source (self-check)');
  assert.notDeepEqual(insetProblems(unguarded), []);
});

test('NEGATIVE CONTROL: a sheet left on the static style is detected', () => {
  const real = read(SCREEN);
  const mutated = real.replace('<View style={sheetStyle} testID="comparison-view"', '<View style={styles.sheet} testID="comparison-view"');
  assert.notEqual(mutated, real, 'the mutation must change the real source (self-check)');
  assert.notDeepEqual(insetProblems(mutated), []);
});

test('NEGATIVE CONTROL: calling the hook after the flag early return is detected', () => {
  const real = read(SCREEN);
  const hookLine = '  const insets = useSafeAreaInsets();\n';
  assert.ok(real.includes(hookLine), 'the hook line exists (self-check)');
  const withoutHook = real.replace(hookLine, '');
  const gateStart = withoutHook.indexOf('  if (!PRIVATE_DRESSING_ROOM_V1) {');
  assert.notEqual(gateStart, -1, 'the flag gate exists (self-check)');
  const gateEnd = withoutHook.indexOf('\n  }\n', gateStart) + '\n  }\n'.length;
  const withHookAfterGate = withoutHook.slice(0, gateEnd) + hookLine + withoutHook.slice(gateEnd);
  assert.notEqual(withHookAfterGate, real);
  assert.ok(
    insetProblems(withHookAfterGate).some((problem) => problem.includes('hook order')),
    'a hook below the flag gate must be reported',
  );
});
