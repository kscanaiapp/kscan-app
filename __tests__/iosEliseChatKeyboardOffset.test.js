'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * WP-ELISE-07 -- the Elise chat composer floated above the iOS keyboard by the
 * top safe-area inset.
 *
 * WHAT WAS WRONG. React Native 0.81's KeyboardAvoidingView pads its bottom by
 *
 *     frame.y + frame.height - (keyboard.screenY - keyboardVerticalOffset)
 *
 * where `frame` is the view's layout relative to its PARENT. So the offset is
 * the distance from the top of the SCREEN to that PARENT's origin: it converts
 * the keyboard's screen-space Y into the parent's coordinate space.
 *
 * The chat screen's avoider sits directly under the screen root, which starts
 * at y = 0 (every route uses `headerShown: false`, and nothing above the root
 * pads it), and the in-flow StyleChatHeader already spends the top inset inside
 * that root. The correct offset is therefore 0. The screen passed `insets.top`,
 * which counted the inset a second time: the padding became keyboard height
 * plus the inset, so the composer floated that far (about 47-59pt on a Face ID
 * iPhone) above the keyboard. The other full-screen avoiders that sit directly
 * under a screen root (LuxuryScreen, OnboardingShell, the dressing-room and
 * shared-room screens) pass 0. The two auth-screen avoiders pass 40 on iOS, from
 * the same bulk sync that introduced the chat screen's inset; that is a candidate
 * for the same kind of gap, was not analysed here, and is left alone.
 *
 * WHAT THIS DOES NOT SETTLE. The offset is decided by the arithmetic above and
 * the layout facts asserted below; how the composer looks with the keyboard up
 * (dynamic type, iPhone SE, the composer's own bottom padding of roughly 20-42pt
 * that is dead space while the keyboard is up) is a physical device question and
 * is carried forward as DEVICE_VERIFICATION_PENDING.
 *
 * WHAT IT ASSUMES. That the app is full screen. On iPad in Slide Over or Stage
 * Manager the screen root is not at screen y = 0, so no constant offset is right
 * there (a measured window offset would be); the old `insets.top` masked at most
 * a few tens of points of that. iPad multitasking is a device check, not
 * something this constant can be made correct for.
 *
 * If a premise below stops being true -- the root gains top padding, the route
 * gains a native header or a modal presentation, or React Native changes the
 * formula (pinned against node_modules below) -- the right offset changes, and
 * this test must be re-derived rather than "fixed" by editing the number.
 */

const ROOT = path.resolve(__dirname, '..');
const SCREEN = 'app/style-chat/[sessionId].tsx';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** An element's opening tag; these tags carry no `>` inside their props. */
function openingTag(source, at) {
  return source.slice(at, source.indexOf('>', at) + 1);
}

/** The chat avoider's `keyboardVerticalOffset` expression, evaluated. */
function evaluatedOffset(source, os, top) {
  const avoiders = source.match(/<KeyboardAvoidingView/g) || [];
  assert.equal(avoiders.length, 1, 'the chat screen has exactly one KeyboardAvoidingView');
  const tag = openingTag(source, source.indexOf('<KeyboardAvoidingView'));
  const expression = tag.match(/keyboardVerticalOffset=\{([^}]*)\}/);
  assert.ok(expression, 'the avoider declares a keyboardVerticalOffset');
  return vm.runInNewContext(expression[1], {
    Platform: { OS: os },
    insets: { top, bottom: 34, left: 0, right: 0 },
  });
}

/** Everything that would make the offset wrong, for a given screen source. */
function offsetProblems(source) {
  const problems = [];
  for (const top of [0, 20, 47, 59, 62]) {
    const ios = evaluatedOffset(source, 'ios', top);
    if (ios !== 0) problems.push(`iOS offset is ${ios} with a ${top}pt top inset (expected 0)`);
    const android = evaluatedOffset(source, 'android', top);
    if (android !== 0) problems.push(`Android offset is ${android} (expected 0)`);
  }
  return problems;
}

test('iOS Elise chat: the composer avoider adds no offset of its own', () => {
  assert.deepEqual(offsetProblems(read(SCREEN)), []);
});

// ── The premises that make 0 the right number ──────────────────────────────

test('premise: the avoider sits under the screen root, below the in-flow header', () => {
  const source = read(SCREEN);
  const rootAt = source.indexOf('<View testID="style-chat-screen" style={styles.safe}>');
  const headerAt = source.indexOf('<StyleChatHeader', rootAt);
  const avoiderAt = source.indexOf('<KeyboardAvoidingView', rootAt);
  assert.ok(rootAt !== -1 && headerAt > rootAt && avoiderAt > headerAt);
});

test('premise: the screen root has no top padding or margin of its own', () => {
  const source = read(SCREEN);
  const safe = source.match(/\n {2}safe: \{([^}]*)\}/);
  assert.ok(safe, 'styles.safe is declared');
  assert.doesNotMatch(safe[1], /padding(Top|Vertical)?\s*:|margin(Top|Vertical)?\s*:|\btop\s*:/);
});

test('premise: the in-flow header spends the top safe-area inset itself', () => {
  const header = read('components/style-chat/StyleChatHeader.tsx');
  assert.match(header, /useSafeAreaInsets\(\)/);
  assert.match(header, /paddingTop: Math\.max\(SPACING\.xl, insets\.top \+ SPACING\.sm\)/);
});

test('premise: no native header or modal presentation shifts the screen down', () => {
  const layout = read('app/_layout.tsx');
  const stacks = layout.match(/<Stack screenOptions=\{\{[^}]*\}\}/g) || [];
  assert.ok(stacks.length > 0);
  for (const stack of stacks) assert.match(stack, /headerShown: false/);
  assert.doesNotMatch(layout, /presentation\s*:/, 'no route is presented as a modal card');
  assert.ok(!fs.existsSync(path.join(ROOT, 'app/style-chat/_layout.tsx')), 'the chat route has no layout of its own');
});

// ── The formula the whole argument rests on ────────────────────────────────

const KAV_SOURCE = 'node_modules/react-native/Libraries/Components/Keyboard/KeyboardAvoidingView.js';

/** The pieces of React Native's avoider math that make 0 the right offset. */
function formulaProblems(source) {
  const problems = [];
  if (!/const keyboardY =\s*keyboardFrame\.screenY - \(this\.props\.keyboardVerticalOffset \?\? 0\);/.test(source)) {
    problems.push('the keyboard Y is no longer the screen Y minus keyboardVerticalOffset');
  }
  if (!/return Math\.max\(frame\.y \+ frame\.height - keyboardY, 0\);/.test(source)) {
    problems.push('the padding is no longer the overlap of the parent-relative frame with that keyboard Y');
  }
  if (!/this\._frame = event\.nativeEvent\.layout;/.test(source)) {
    problems.push('the frame is no longer the view\'s own onLayout rectangle (parent-relative)');
  }
  return problems;
}

test('premise: React Native still computes the padding the way this offset assumes', () => {
  assert.deepEqual(formulaProblems(read(KAV_SOURCE)), []);
});

test('negative control: a changed React Native formula is reported', () => {
  const source = read(KAV_SOURCE);
  const mutated = source.replace(
    /keyboardFrame\.screenY - \(this\.props\.keyboardVerticalOffset \?\? 0\)/,
    'keyboardFrame.screenY + (this.props.keyboardVerticalOffset ?? 0)',
  );
  assert.ok(mutated !== source, 'the mutation must actually apply');
  assert.deepEqual(formulaProblems(mutated), ['the keyboard Y is no longer the screen Y minus keyboardVerticalOffset']);
});

// ── Negative control ───────────────────────────────────────────────────────

test('negative control: restoring the safe-area inset as the offset fails the check', () => {
  const original = read(SCREEN);
  const restored = original.replace(
    /keyboardVerticalOffset=\{[^}]*\}/,
    "keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}",
  );
  assert.ok(restored !== original || /insets\.top/.test(original), 'the mutation must produce the old expression');
  const problems = offsetProblems(restored);
  assert.ok(problems.length > 0, 'the old expression must be reported');
  assert.match(problems.join('\n'), /iOS offset is 59 with a 59pt top inset/);
});
