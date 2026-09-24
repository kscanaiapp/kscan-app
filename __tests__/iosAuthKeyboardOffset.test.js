'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const {
  jsxAttribute,
  jsxElementsNamed,
  jsxTagNameOf,
  parseSource,
  readSource,
} = require('./helpers/componentRenderer');

/**
 * The auth screen's two KeyboardAvoidingViews passed `Platform.OS === 'ios' ? 40 : 0`
 * as `keyboardVerticalOffset`. That number was never derived from anything; this file
 * derives what it should be, and pins the layout facts the derivation rests on.
 *
 * THE ARITHMETIC. React Native 0.81's KeyboardAvoidingView pads its bottom by
 *
 *     frame.y + frame.height - (keyboard.screenY - keyboardVerticalOffset)
 *
 * where `frame` is the avoider's layout relative to its PARENT (pinned against
 * node_modules below). If the avoider is the LAST child of a parent that fills the
 * screen, then frame.y + frame.height is the parent's height H whatever sits above
 * the avoider in the parent's flow (the in-flow header shifts frame.y and shrinks
 * frame.height by the same amount). With keyboard.screenY = H - keyboardHeight the
 * padding is
 *
 *     keyboardHeight + keyboardVerticalOffset
 *
 * so the offset is exactly the distance from the top of the SCREEN to the parent's
 * origin (it converts the keyboard's screen-space Y into the parent's coordinates),
 * and any other value is padding that stands between the ScrollView and the keyboard:
 * a dead band the height of the constant.
 *
 * THE FACTS. Both avoiders sit directly under the screen root View, after the in-flow
 * header, as the last thing in that root; the root fills the window and carries no
 * padding or margin of its own; nothing above the route pads it (no native header, no
 * content style or modal presentation, no layout of its own for /auth, no host View or
 * styled provider above the navigator; the providers do render flex-1 wrappers, which
 * are geometry-neutral). The parent's origin is therefore the top of the screen: the
 * offset is 0. The 40 did not correspond to an external obstruction, because there is
 * none: nothing follows the avoider, and the ScrollView already reserves its own bottom
 * room.
 *
 * WHERE THE 40 CAME FROM. It equals LAYOUT.modalBottomPadding (SPACING.xxxl), which
 * styles.body sets as its paddingBottom, and both arrived together in the bulk sync
 * that introduced the screen. KeyboardAvoidingView composes its computed paddingBottom
 * OVER the style, so the style's value never applied while the avoider is enabled; the
 * offset was most likely the author's way of keeping that gap above the keyboard. That
 * is design spacing, not an obstruction. With 0 the ScrollView's bottom edge is flush
 * with the top of the keyboard and its own bottom content padding does the spacing.
 *
 * WHAT THIS DOES NOT SETTLE. That is a source and geometry argument, not a look at the
 * screen. How the form sits with the keyboard up (dynamic type, iPhone SE) is a
 * physical-device check, and on iPad in Slide Over / Stage Manager the screen root is
 * not at screen y = 0, where no constant is right.
 *
 * If a premise below stops being true the right offset changes and this test must be
 * re-derived rather than "fixed" by editing the number.
 */

const SCREEN = 'app/auth/index.tsx';

function mutated(source, from, to) {
  const next = source.replace(from, to);
  assert.notEqual(next, source, `mutation ${String(from)} matched nothing: the negative control is vacuous`);
  return next;
}

// ── The offset ──────────────────────────────────────────────────────────────

function avoiders(source) {
  return jsxElementsNamed(parseSource(source, SCREEN), 'KeyboardAvoidingView');
}

function evaluatedOffset(element, os, top) {
  const attribute = jsxAttribute(element, 'keyboardVerticalOffset');
  assert.ok(
    attribute && attribute.initializer && ts.isJsxExpression(attribute.initializer),
    'the avoider declares keyboardVerticalOffset={...}',
  );
  return vm.runInNewContext(attribute.initializer.expression.getText(), {
    Platform: { OS: os },
    insets: { top, bottom: 34, left: 0, right: 0 },
  });
}

/** Everything that would make an avoider's offset wrong, for a given screen source. */
function offsetProblems(source) {
  const found = avoiders(source);
  const problems = [];
  if (found.length !== 2) {
    problems.push(`expected the confirmation panel and the main card to have one avoider each, found ${found.length}`);
  }
  found.forEach((element, index) => {
    for (const os of ['ios', 'android']) {
      for (const top of [0, 20, 47, 59]) {
        const value = evaluatedOffset(element, os, top);
        if (value !== 0) problems.push(`avoider ${index + 1}: ${os} offset is ${value} with a ${top}pt top inset (expected 0)`);
      }
    }
  });
  return problems;
}

test('auth screen: both keyboard avoiders add no offset of their own', () => {
  assert.deepEqual(offsetProblems(readSource(SCREEN)), []);
});

// ── The premises that make 0 the right number ──────────────────────────────

const meaningfulChildren = (element) =>
  element.children.filter((child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces));

function styleSheetObject(source) {
  const file = parseSource(source, SCREEN);
  for (const node of file.statements) {
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      if (declaration.name.getText() !== 'styles' || !declaration.initializer) continue;
      const [argument] = declaration.initializer.arguments ?? [];
      if (argument && ts.isObjectLiteralExpression(argument)) return argument;
    }
  }
  return assert.fail('the screen declares no `const styles = StyleSheet.create({...})`');
}

function styleKeys(source, name) {
  const property = styleSheetObject(source).properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && candidate.name.getText() === name,
  );
  assert.ok(property && ts.isObjectLiteralExpression(property.initializer), `styles.${name} is declared`);
  return new Map(
    property.initializer.properties
      .filter(ts.isPropertyAssignment)
      .map((entry) => [entry.name.getText(), entry.initializer.getText()]),
  );
}

/** The layout premises, as problems. */
function layoutProblems(source) {
  const problems = [];
  avoiders(source).forEach((avoider, index) => {
    const label = `avoider ${index + 1}`;
    const parent = avoider.parent;
    const parentStyle = ts.isJsxElement(parent) ? jsxAttribute(parent, 'style') : null;
    if (
      !ts.isJsxElement(parent) ||
      jsxTagNameOf(parent) !== 'View' ||
      parentStyle?.initializer?.expression?.getText() !== 'styles.root'
    ) {
      problems.push(`${label} is not a direct child of the screen root <View style={styles.root}>`);
      return;
    }
    const siblings = meaningfulChildren(parent);
    if (siblings.at(-1) !== avoider) {
      problems.push(`${label} is not the last thing in the screen root: something below it would move its bottom edge off the screen's`);
    }
    const above = siblings.at(-2);
    const aboveIsElement = above && (ts.isJsxElement(above) || ts.isJsxSelfClosingElement(above));
    const aboveStyle = aboveIsElement ? jsxAttribute(above, 'style') : null;
    const aboveText = aboveStyle?.initializer?.expression?.getText() ?? '';
    if (!aboveIsElement || jsxTagNameOf(above) !== 'View' || !/styles\.header(?![A-Za-z])/.test(aboveText) || !/insets\.top/.test(aboveText)) {
      problems.push(`${label} does not follow the in-flow header <View style={[styles.header, { paddingTop: ...insets.top... }]}>`);
    }
    const bodyStyle = jsxAttribute(avoider, 'style');
    if (bodyStyle?.initializer?.expression?.getText() !== 'styles.body') {
      problems.push(`${label} is not styled by styles.body`);
    }
  });

  const root = styleKeys(source, 'root');
  if (root.get('flex') !== '1') problems.push('styles.root must fill the window (flex: 1)');
  for (const key of root.keys()) {
    if (/^(padding|margin|top|position|transform|bottom)/.test(key)) {
      problems.push(`styles.root must not move or inset the screen (found ${key})`);
    }
  }
  const header = styleKeys(source, 'header');
  if (header.has('position')) problems.push('styles.header must stay in the layout flow (found position)');
  const body = styleKeys(source, 'body');
  if (body.get('flex') !== '1') problems.push('styles.body must fill the rest of the root (flex: 1)');
  for (const key of body.keys()) {
    if (/^(margin|top|bottom|position)/.test(key)) {
      problems.push(`styles.body must not leave a gap below the avoider (found ${key})`);
    }
  }
  return problems;
}

test('premise: both avoiders fill the rest of the screen root below the in-flow header, with nothing after them', () => {
  assert.deepEqual(layoutProblems(readSource(SCREEN)), []);
});

test('premise: the header spends the top safe-area inset itself, in flow', () => {
  const source = readSource(SCREEN);
  const headers = jsxElementsNamed(parseSource(source, SCREEN), 'View').filter((element) =>
    /styles\.header(?![A-Za-z])/.test(jsxAttribute(element, 'style')?.initializer?.expression?.getText() ?? ''),
  );
  assert.equal(headers.length, 2, 'one in-flow header per return');
  for (const header of headers) {
    const text = jsxAttribute(header, 'style').initializer.expression.getText();
    assert.match(text, /paddingTop: Math\.max\(insets\.top, LAYOUT\.safeTop\)/);
  }
});

const HOST_LAYOUT_ELEMENTS = ['View', 'SafeAreaView', 'ScrollView', 'KeyboardAvoidingView'];

/**
 * What above the route could move the screen root off the top of the screen.
 *
 * Every navigator (<Stack>) and <AuthGate /> in the root layout is checked from the
 * syntax tree: the navigator draws no native header, applies no content style and no
 * modal presentation, and nothing above it is a host layout element or takes a style
 * of its own. The providers above it render flex-1 wrappers (PostHogProvider,
 * SafeAreaProvider), which are geometry-neutral; a padding, position or extra host
 * View there is what this catches.
 */
function routeHostProblems(layout) {
  const problems = [];
  const file = parseSource(layout, 'app/_layout.tsx');
  const stacks = jsxElementsNamed(file, 'Stack');
  if (stacks.length === 0) problems.push('the root layout renders no <Stack>');

  for (const stack of stacks) {
    const options = jsxAttribute(stack, 'screenOptions')?.initializer?.expression?.getText() ?? '';
    if (!/headerShown: false/.test(options)) problems.push(`a navigator draws a native header: ${options || '(no screenOptions)'}`);
    if (/contentStyle|presentation|headerTransparent|headerTopInsetEnabled/.test(options)) {
      problems.push(`a navigator restyles or re-presents its screens: ${options}`);
    }
    if (jsxAttribute(stack, 'style') || jsxAttribute(stack, 'contentStyle')) {
      problems.push('a navigator takes a style of its own');
    }
  }
  if (/presentation\s*:/.test(layout)) problems.push('a route is presented as a modal card');

  const gates = jsxElementsNamed(file, 'AuthGate');
  if (gates.length !== 1) problems.push(`the root layout must render <AuthGate /> exactly once (found ${gates.length})`);

  // Everything that wraps a navigator or the gate.
  for (const anchor of [...stacks, ...gates]) {
    for (let node = anchor.parent; node; node = node.parent) {
      if (!ts.isJsxElement(node)) continue;
      const name = jsxTagNameOf(node);
      if (HOST_LAYOUT_ELEMENTS.includes(name)) {
        problems.push(`a <${name}> above the navigator would shift every screen`);
      }
      if (jsxAttribute(node, 'style') || jsxAttribute(node, 'contentStyle')) {
        problems.push(`<${name}> above the navigator takes a style of its own`);
      }
    }
  }
  return [...new Set(problems)];
}

test('premise: nothing above the route pads the screen -- no native header, no modal presentation, no route layout, no host wrapper', () => {
  assert.deepEqual(routeHostProblems(readSource('app/_layout.tsx')), []);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'app', 'auth', '_layout.tsx')), 'the auth route has no layout of its own');
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
    problems.push("the frame is no longer the view's own onLayout rectangle (parent-relative)");
  }
  return problems;
}

test('premise: React Native still computes the padding the way this offset assumes', () => {
  assert.deepEqual(formulaProblems(readSource(KAV_SOURCE)), []);
});

// ── Negative controls ──────────────────────────────────────────────────────

test('negative control: a changed React Native formula is reported', () => {
  const broken = mutated(
    readSource(KAV_SOURCE),
    /keyboardFrame\.screenY - \(this\.props\.keyboardVerticalOffset \?\? 0\)/,
    'keyboardFrame.screenY + (this.props.keyboardVerticalOffset ?? 0)',
  );
  assert.deepEqual(formulaProblems(broken), ['the keyboard Y is no longer the screen Y minus keyboardVerticalOffset']);
});

test('negative control: restoring the 40pt iOS offset on either avoider is reported, and only that avoider', () => {
  const original = readSource(SCREEN);
  const restore = (text) =>
    text.replace(/keyboardVerticalOffset=\{[^}]*\}/, "keyboardVerticalOffset={Platform.OS === 'ios' ? 40 : 0}");

  const first = restore(original);
  assert.notEqual(first, original, 'the mutation must change the source');
  assert.match(offsetProblems(first).join('\n'), /avoider 1: ios offset is 40/);
  assert.doesNotMatch(offsetProblems(first).join('\n'), /avoider 2/);

  const at = original.lastIndexOf('keyboardVerticalOffset={');
  const second = original.slice(0, at) + restore(original.slice(at));
  assert.notEqual(second, original, 'the mutation must change the source');
  assert.match(offsetProblems(second).join('\n'), /avoider 2: ios offset is 40/);
  assert.doesNotMatch(offsetProblems(second).join('\n'), /avoider 1/);
});

test('negative control: using the safe-area inset as the offset (the Elise defect) is reported', () => {
  const broken = mutated(
    readSource(SCREEN),
    /keyboardVerticalOffset=\{[^}]*\}/,
    "keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}",
  );
  assert.match(offsetProblems(broken).join('\n'), /ios offset is 59 with a 59pt top inset/);
});

test('negative control: an element placed after the avoider (a tab bar, a footer) breaks the premise', () => {
  const broken = mutated(
    readSource(SCREEN),
    /<\/KeyboardAvoidingView>(\s*)<\/View>(\s*)\);(\s*)\}(\s*)\/\/ ── Main auth card/,
    '</KeyboardAvoidingView>$1<View style={{ height: 40 }} />$1</View>$2);$3}$4// ── Main auth card',
  );
  assert.match(layoutProblems(broken).join('\n'), /not the last thing in the screen root/);
});

test('negative control: padding on the screen root breaks the premise', () => {
  const broken = mutated(readSource(SCREEN), /  root: \{\n    flex: 1,/, '  root: {\n    flex: 1,\n    paddingTop: 20,');
  assert.match(layoutProblems(broken).join('\n'), /styles\.root must not move or inset the screen \(found paddingTop\)/);
});

test('negative control: an absolutely positioned header breaks the premise', () => {
  const broken = mutated(readSource(SCREEN), /  header: \{\n/, "  header: {\n    position: 'absolute',\n");
  assert.match(layoutProblems(broken).join('\n'), /styles\.header must stay in the layout flow/);
});

test('negative control: a native header, a modal presentation, or a padded host wrapper above the route breaks the premise', () => {
  const layout = readSource('app/_layout.tsx');
  assert.deepEqual(routeHostProblems(layout), []);

  const modal = mutated(
    layout,
    /return <Stack screenOptions=\{\{ headerShown: false \}\} \/>;\n\}\n/,
    "return <Stack screenOptions={{ headerShown: false, presentation: 'modal' }} />;\n}\n",
  );
  assert.match(routeHostProblems(modal).join('\n'), /presented as a modal card/);

  const header = mutated(
    layout,
    /return <Stack screenOptions=\{\{ headerShown: false \}\} \/>;\n\}\n/,
    'return <Stack screenOptions={{ headerShown: true }} />;\n}\n',
  );
  assert.match(routeHostProblems(header).join('\n'), /draws a native header/);

  const wrapped = mutated(layout, /<AuthGate \/>/, '<View style={{ paddingTop: 20 }}><AuthGate /></View>');
  assert.match(routeHostProblems(wrapped).join('\n'), /a <View> above the navigator/);
});

test('negative control: padding applied to a navigator branch other than the last one is reported too', () => {
  const layout = readSource('app/_layout.tsx');

  // A padded View around the Stack of the first (auth-callback) branch.
  const branchWrapper = mutated(
    layout,
    /return <Stack screenOptions=\{\{ headerShown: false \}\} \/>;\n  \}\n\n  if \(guardState\.action === 'loading'\)/,
    "return <View style={{ flex: 1, paddingTop: 20 }}><Stack screenOptions={{ headerShown: false }} /></View>;\n  }\n\n  if (guardState.action === 'loading')",
  );
  assert.match(routeHostProblems(branchWrapper).join('\n'), /a <View> above the navigator/);

  // A content style on a navigator, in the loading branch (which a screenOptions regex would not even parse).
  const contentStyle = mutated(
    layout,
    /<Stack screenOptions=\{\{ headerShown: false \}\} \/>\n        <View testID="auth-gate-loading"/,
    '<Stack screenOptions={{ headerShown: false, contentStyle: { paddingTop: 20 } }} />\n        <View testID="auth-gate-loading"',
  );
  assert.match(routeHostProblems(contentStyle).join('\n'), /restyles or re-presents its screens/);

  // A style on the safe-area provider that every screen sits under.
  const providerStyle = mutated(layout, /<SafeAreaProvider>/, '<SafeAreaProvider style={{ paddingTop: 20 }}>');
  assert.match(routeHostProblems(providerStyle).join('\n'), /<SafeAreaProvider> above the navigator takes a style of its own/);

  // Rendering the gate twice, or not at all, changes what the argument is about.
  assert.match(routeHostProblems(mutated(layout, /<AuthGate \/>/, '<AuthGate /><AuthGate />')).join('\n'), /exactly once/);
});
