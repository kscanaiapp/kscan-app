// B34-FE-A11Y-001 — a modal backdrop must not swallow the controls inside it.
//
// WHY THIS FILE EXISTS. React Native's Pressable defaults `accessible` to true:
//
//     node_modules/react-native/Libraries/Components/Pressable/Pressable.js
//     accessible: accessible !== false,
//
// and on iOS an accessible container is ONE VoiceOver element — its descendants
// are not individually focusable. Two modals wrapped their entire card in a
// bare `<Pressable style={styles.backdrop}>` for tap-outside-to-dismiss, which
// made every control inside unreachable to VoiceOver:
//
//   * RoomItemDetailModal — Ask Elise, Select, REMOVE (destructive), Close
//   * StyleChatStyleDnaCard — RESET local signals (destructive), Done
//
// Nothing caught it. A backdrop that dismisses on tap looks correct in review
// and in every sighted test; the defect exists only in the accessibility tree.
//
// So this file asserts the RULE, on every modal backdrop in the repository
// rather than on the two known files, and it re-derives the React Native
// default it depends on so an upstream change cannot silently invalidate it.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SKIP_DIRS = new Set(['node_modules', '.git', '__tests__', 'android', 'supabase', 'docs', 'artifacts']);

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (/\.(tsx|jsx|js)$/.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(ROOT);
  return out;
}

/**
 * Every opening tag of `<Name ...>` with its full prop text.
 *
 * A regex cannot do this: `onPress={() => close()}` contains a `>` inside a
 * brace expression, so a non-greedy `[\s\S]*?>` truncates the tag mid-prop and
 * reports missing props that are plainly there. This walks the tag instead,
 * tracking brace, string and template depth, and stops at the `>` that really
 * closes it.
 */
function openingTags(source, name) {
  const tags = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  let match;
  while ((match = re.exec(source)) !== null) {
    let index = re.lastIndex;
    let depth = 0;
    let quote = null;
    while (index < source.length) {
      const ch = source[index];
      if (quote) {
        if (ch === '\\') index += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
      } else if (ch === '>' && depth === 0) {
        break;
      }
      index += 1;
    }
    tags.push({ attrs: source.slice(match.index + name.length + 1, index), index: match.index });
  }
  return tags;
}

/** Every `<Pressable ...>` opening tag whose props name it a backdrop or sheet. */
function backdropPressables(source) {
  return openingTags(source, 'Pressable').filter(({ attrs }) =>
    /styles\.(backdrop|sheet|overlay|scrim)\b/.test(attrs),
  );
}

test('the React Native default this rule depends on is still what we think it is', () => {
  // If upstream ever flips Pressable to accessible={false} by default, the
  // assertions below become unnecessary rather than wrong — but we would want
  // to know, not to keep asserting a workaround for a fixed bug.
  const pressable = read('node_modules/react-native/Libraries/Components/Pressable/Pressable.js');
  assert.match(
    pressable,
    /accessible:\s*accessible\s*!==\s*false/,
    'Pressable no longer defaults to accessible=true — re-review this rule',
  );
});

test('THE RULE: no modal backdrop or sheet container is an accessibility element', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const source = read(path.relative(ROOT, file));
    if (!source.includes('<Modal')) continue;
    for (const { attrs, index } of backdropPressables(source)) {
      if (/accessible=\{false\}/.test(attrs)) continue;
      offenders.push(`${path.relative(ROOT, file)}:${source.slice(0, index).split('\n').length}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a backdrop/sheet Pressable is accessible by default and hides every control inside it:\n  ${offenders.join('\n  ')}`,
  );
});

test('the two repaired modals keep their dismiss behaviour AND expose their controls', () => {
  const room = read('components/dressing-rooms/RoomItemDetailModal.tsx');
  assert.match(room, /<Pressable style=\{styles\.backdrop\} onPress=\{onClose\} accessible=\{false\}>/);
  assert.match(room, /<View style=\{styles\.card\} accessibilityViewIsModal>/);
  // The destructive control and the explicit escape both still exist.
  assert.match(room, /accessibilityLabel="Close item detail"/);
  assert.match(room, /onPress=\{onRemove\}/);

  const dna = read('components/style-chat/StyleChatStyleDnaCard.tsx');
  assert.match(dna, /style=\{styles\.backdrop\} onPress=\{\(\) => setDetailsOpen\(false\)\} accessible=\{false\}/);
  assert.match(dna, /style=\{styles\.sheet\}[\s\S]{0,200}?accessible=\{false\}/);
  assert.match(dna, /accessibilityLabel="Close Signature Style details"/);
});

test('every control inside those modals still declares a role and a label', () => {
  // A focusable control is only an improvement if VoiceOver can also describe
  // it. These two modals carry destructive actions, so this is checked here
  // rather than left to the general accessibility contract tests.
  for (const rel of [
    'components/dressing-rooms/RoomItemDetailModal.tsx',
    'components/style-chat/StyleChatStyleDnaCard.tsx',
  ]) {
    const source = read(rel);
    const tags = [
      ...openingTags(source, 'Pressable'),
      ...openingTags(source, 'TouchableOpacity'),
    ];
    assert.ok(tags.length > 0, `${rel} must contain interactive controls`);
    for (const { attrs, index } of tags) {
      if (!/onPress=/.test(attrs)) continue;
      if (/accessible=\{false\}/.test(attrs)) continue; // the backdrop/sheet
      const line = source.slice(0, index).split('\n').length;
      assert.match(attrs, /accessibilityRole=/, `${rel}:${line} has no accessibilityRole`);
      assert.match(attrs, /accessibilityLabel=/, `${rel}:${line} has no accessibilityLabel`);
    }
  }
});

test('NEGATIVE CONTROL: the sweep finds a bare backdrop when one exists', () => {
  const sample = '<Modal>\n  <Pressable style={styles.backdrop} onPress={close}>\n    <View />\n  </Pressable>\n</Modal>';
  const found = backdropPressables(sample);
  assert.equal(found.length, 1);
  assert.doesNotMatch(found[0].attrs, /accessible=\{false\}/);
  // And it accepts the repaired shape.
  const fixed = '<Pressable style={styles.backdrop} onPress={close} accessible={false}>';
  assert.match(backdropPressables(fixed + '</Pressable>')[0].attrs, /accessible=\{false\}/);
});

test('NEGATIVE CONTROL: the tag reader does not truncate at a `>` inside a prop', () => {
  // The bug this parser replaces: `onPress={() => x()}` made a regex stop at
  // the arrow, hiding every prop after it and inventing missing-role failures.
  const sample = '<Pressable\n  onPress={() => setOpen(true)}\n  accessibilityRole="button"\n  accessibilityLabel="Open"\n>';
  const [tag] = openingTags(sample, 'Pressable');
  assert.match(tag.attrs, /accessibilityRole="button"/);
  assert.match(tag.attrs, /accessibilityLabel="Open"/);
  // A naive regex would not see them.
  const naive = /<Pressable\b([\s\S]*?)>/.exec(sample)[1];
  assert.doesNotMatch(naive, /accessibilityRole/);
});
