// Elise photo intake — the review sheet must never present an unexplained
// dead end when identification produced no context.
//
// WHY (P1 follow-on, found by device QA on the Build 25 candidate):
// "Attach to Elise" is gated on `fashionContext`, and only the V2 `identified`
// outcome sets one. Two routes reach the review sheet WITHOUT it:
//
//   1. the legacy identification path (taken whenever Elise Identification V2
//      is dark, or when the backend answers `legacy_fallback`), and
//   2. `manual_details`, entered from `identify_failed` after `no_evidence`
//      or `needs_selection`.
//
// On both, title/category populate and "Save to Closet" enables normally while
// the primary action stays permanently disabled. Observed on device: a filled
// review sheet whose main button could not be activated and gave no reason.
//
// The approved resolution is an explicit recoverable state, NOT force-enabling
// attach with a null context — a fabricated context would claim identification
// provenance the backend never produced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const INTAKE = 'components/style-chat/StyleChatPhotoIntake.tsx';

/**
 * Slice the review / manual_details branch out of the render so assertions
 * cannot be satisfied by an unrelated notice elsewhere in the modal (the
 * sanitizer_rejected and identify_failed branches already render notices).
 */
function reviewBranch(source) {
  const start = source.indexOf("step === 'review' || step === 'manual_details'");
  assert.notEqual(start, -1, 'review/manual_details branch not found');
  const end = source.indexOf('</ScrollView>', start);
  assert.notEqual(end, -1, 'review branch ScrollView not closed');
  return source.slice(start, end);
}

test('the review sheet explains itself when no identified context exists', () => {
  const branch = reviewBranch(read(INTAKE));

  assert.match(
    branch,
    /\{!fashionContext \?/,
    'the review sheet must branch on a missing fashionContext and say something',
  );
  assert.match(
    branch,
    /<InlineNotice[\s\S]*?title="Attach to Elise"[\s\S]*?\/>/,
    'a notice must name the control it is explaining',
  );
  // The recovery must be stated, not merely implied by a greyed button.
  assert.match(
    branch,
    /try another photo/i,
    'the notice must point at the retry that actually recovers the flow',
  );
});

test('the explanation is tied to the disabled control, not a general banner', () => {
  const branch = reviewBranch(read(INTAKE));

  const noticeAt = branch.search(/\{!fashionContext \?/);
  const attachAt = branch.search(/title="Attach to Elise"\s*\n\s*onPress/);
  assert.notEqual(attachAt, -1, 'attach button not found in review branch');
  assert.ok(
    noticeAt !== -1 && noticeAt < attachAt,
    'the explanation must render immediately before the control it explains',
  );
});

test('the fix does not weaken the attach contract', () => {
  const source = read(INTAKE);

  // Attach stays gated on a real context...
  assert.match(
    source,
    /disabled=\{!title\.trim\(\)\s*\|\|\s*!category\.trim\(\)\s*\|\|\s*!fashionContext\}/,
    'attach must still require an identified context',
  );
  // ...and the handler keeps its own guard, so no render path can smuggle a
  // null context through.
  assert.match(source, /if\s*\(!fashionContext\)\s*\{[\s\S]{0,200}?return;/);

  // No fabricated context: the only non-null producer remains the V2 outcome.
  const assignments = source.match(/setFashionContext\(([^)]*)\)/g) ?? [];
  const nonNull = assignments.filter((call) => !/\(\s*null\s*\)/.test(call));
  assert.equal(nonNull.length, 1, 'a second context producer would fabricate provenance');
  assert.match(nonNull[0], /outcome\.context/);
});

test('Closet save remains independent of the missing-context state', () => {
  const branch = reviewBranch(read(INTAKE));

  // The notice must not gate Closet saving — the whole point is that Closet
  // still works while attach cannot.
  assert.match(
    branch,
    /disabled=\{!title\.trim\(\)\s*\|\|\s*!category\.trim\(\)\s*\|\|\s*closetState === 'saved'\}/,
    'Save to Closet must not acquire a fashionContext dependency',
  );
});
