'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * iOS keyboard traps in bottom-anchored sheets.
 *
 * A React Native Modal is its own native window, so nothing outside it moves
 * its content when the keyboard appears. On iOS these sheets had no way out:
 *  - "Watch this listing" uses a decimal pad, which has no return key;
 *  - the Inspiration note and the Dressing Room / Look "Description" fields
 *    are multiline, so return inserts a newline instead of closing the keyboard.
 * The keyboard covered the field being typed into and the Save / Watch /
 * Upload / Cancel buttons. Android has the back button and an action key, so
 * the repair is iOS-only: `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`
 * leaves Android's KeyboardAvoidingView inert.
 *
 * Structural contract over the sources; the sheets cannot be mounted without a
 * native renderer.
 */

const ROOT = path.resolve(__dirname, '..');
const IOS_ONLY_BEHAVIOR = "behavior={Platform.OS === 'ios' ? 'padding' : undefined}";

// `anchor` identifies the sheet's own <Modal>; `input` is the JSX of the field
// that traps the keyboard (both occur once per file, outside comments).
const SHEETS = [
  { file: 'components/ProductShelf.tsx', anchor: 'testID="watch-intent-just-watching"', input: 'keyboardType="decimal-pad"' },
  { file: 'components/InspirationUploadModal.tsx', anchor: "'Add to Room Inspiration'", input: 'placeholder="Add a note (optional)"', scrolls: true },
  { file: 'app/dressing-rooms/[id].tsx', anchor: '>Edit Dressing Room<', input: 'label="Description" value={description} onChangeText={setDescription} multiline' },
  { file: 'app/dressing-rooms/[id].tsx', anchor: '>Create Look<', input: 'label="Description" value={description} onChangeText={setDescription} multiline' },
  { file: 'app/looks/[id].tsx', anchor: '>Edit Look<', input: 'label="Description" value={description} onChangeText={setDescription} multiline' },
];

/** The JSX of the one <Modal> that contains `anchor`. */
function modalContaining(source, anchor) {
  const at = source.indexOf(anchor);
  assert.notEqual(at, -1, `anchor ${anchor} not found`);
  const start = source.lastIndexOf('<Modal', at);
  const end = source.indexOf('</Modal>', at);
  assert.ok(start !== -1 && end !== -1, `no <Modal> around ${anchor}`);
  return source.slice(start, end);
}

/** An element's opening tag; these tags carry no `>` inside their props. */
function openingTag(jsx, at) {
  return jsx.slice(at, jsx.indexOf('>', at) + 1);
}

/** Problems with a sheet's keyboard handling; empty when the sheet is safe on iOS. */
function keyboardProblems(modal, sheet) {
  const problems = [];
  const avoiderAt = modal.indexOf('<KeyboardAvoidingView');
  const avoiderEnd = modal.indexOf('</KeyboardAvoidingView>');
  const inputAt = modal.indexOf(sheet.input);
  if (inputAt === -1) problems.push(`the sheet no longer has ${sheet.input}`);
  if (avoiderAt === -1 || avoiderEnd === -1) {
    problems.push('no KeyboardAvoidingView');
    return problems;
  }
  if (!openingTag(modal, avoiderAt).includes(IOS_ONLY_BEHAVIOR)) {
    problems.push('avoidance is not iOS-only padding');
  }
  if (!(avoiderAt < inputAt && inputAt < avoiderEnd)) problems.push('the input is outside the avoider');
  if (sheet.scrolls) {
    const scrollAt = modal.indexOf('<ScrollView');
    if (scrollAt === -1 || !(avoiderAt < scrollAt && scrollAt < inputAt)) {
      problems.push('the tall sheet has no scroll container around its input');
    } else if (!openingTag(modal, scrollAt).includes('keyboardShouldPersistTaps="handled"')) {
      problems.push('the scroll container swallows the first tap on Upload while the keyboard is up');
    }
  }
  return problems;
}

for (const sheet of SHEETS) {
  test(`iOS keyboard: ${sheet.file} ${sheet.anchor} keeps its input and buttons above the keyboard`, () => {
    const source = fs.readFileSync(path.join(ROOT, sheet.file), 'utf8');
    assert.deepEqual(keyboardProblems(modalContaining(source, sheet.anchor), sheet), []);
  });
}

test('the avoidance is inert on Android', () => {
  for (const sheet of SHEETS) {
    const modal = modalContaining(fs.readFileSync(path.join(ROOT, sheet.file), 'utf8'), sheet.anchor);
    assert.ok(modal.includes(IOS_ONLY_BEHAVIOR), `${sheet.file} ${sheet.anchor}`);
    assert.doesNotMatch(modal, /behavior=\{Platform\.OS === 'ios' \? 'padding' : '(height|position)'\}/);
  }
});

test('negative control: a sheet without the avoider is reported', () => {
  const sheet = SHEETS[0];
  const modal = modalContaining(fs.readFileSync(path.join(ROOT, sheet.file), 'utf8'), sheet.anchor);
  const stripped = modal
    .replace(/<KeyboardAvoidingView[\s\S]*?>\n/, '')
    .replace('</KeyboardAvoidingView>', '');
  assert.deepEqual(keyboardProblems(stripped, sheet), ['no KeyboardAvoidingView']);
});

test('negative control: the tall Inspiration sheet without its scroll container is reported', () => {
  const sheet = SHEETS[1];
  const modal = modalContaining(fs.readFileSync(path.join(ROOT, sheet.file), 'utf8'), sheet.anchor);
  const stripped = modal.replace('<ScrollView', '<View');
  assert.deepEqual(keyboardProblems(stripped, sheet), ['the tall sheet has no scroll container around its input']);
});
