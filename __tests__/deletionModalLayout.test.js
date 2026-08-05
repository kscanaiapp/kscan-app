/**
 * Account-deletion confirmation modal (app/privacy.tsx) UI-symmetry regression.
 *
 * Repo convention for screen-level UI in this codebase is static source-text
 * assertion (see __tests__/sharedWithMeListUi.test.js) rather than a
 * React Testing Library render, since neither Jest nor RTL is installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const screen = fs.readFileSync(path.join(ROOT, 'app/privacy.tsx'), 'utf8');

const modalBlock = screen.match(/<Modal[\s\S]*?<\/Modal>/)?.[0] ?? '';

test('deletion modal block exists', () => {
  assert.ok(modalBlock.length > 100, 'Modal for account deletion confirmation was not found');
});

test('action container is a full-width vertical stack, not a row', () => {
  assert.match(
    screen,
    /modalActions:\s*\{\s*flexDirection:\s*'column',\s*width:\s*'100%',\s*gap:\s*12,\s*\}/,
  );
  assert.doesNotMatch(modalBlock, /style=\{styles\.modalActions\}[\s\S]{0,400}flexDirection:\s*'row'/);
});

test('both action buttons are present in the modal', () => {
  assert.match(modalBlock, /<SecondaryButton[\s\S]*?title="CANCEL"/);
  assert.match(modalBlock, /<PrimaryButton[\s\S]*?title="DELETE ACCOUNT"/);
});

test('Cancel appears above Delete Account in source order', () => {
  const cancelIndex = modalBlock.indexOf('title="CANCEL"');
  const deleteIndex = modalBlock.indexOf('title="DELETE ACCOUNT"');
  assert.ok(cancelIndex >= 0 && deleteIndex >= 0, 'both buttons must be found');
  assert.ok(cancelIndex < deleteIndex, 'Cancel must render before Delete Account');
});

test('both buttons share identical dimension and typography style objects', () => {
  assert.match(modalBlock, /<SecondaryButton[\s\S]*?style=\{styles\.modalButton\}[\s\S]*?textStyle=\{styles\.modalButtonText\}/);
  assert.match(modalBlock, /<PrimaryButton[\s\S]*?style=\{styles\.modalDeleteButton\}[\s\S]*?textStyle=\{styles\.modalButtonText\}/);

  const dims = ["width: '100%'", 'minHeight: 52', 'height: 52', 'paddingHorizontal: SPACING.xl', "alignItems: 'center'", "justifyContent: 'center'"];
  const cancelStyleBlock = screen.match(/modalButton:\s*\{([\s\S]*?)\},/)?.[1] ?? '';
  const deleteStyleBlock = screen.match(/modalDeleteButton:\s*\{([\s\S]*?)\},/)?.[1] ?? '';
  for (const line of dims) {
    assert.ok(cancelStyleBlock.includes(line), `Cancel button style missing "${line}"`);
    assert.ok(deleteStyleBlock.includes(line), `Delete Account button style missing "${line}"`);
  }

  const typography = screen.match(/modalButtonText:\s*\{([\s\S]*?)\},/)?.[1] ?? '';
  assert.match(typography, /fontSize:\s*17/);
  assert.match(typography, /fontWeight:\s*'600'/);
  assert.match(typography, /textAlign:\s*'center'/);
});

test('Delete Account is a solid destructive button, not inline text or a link', () => {
  assert.doesNotMatch(screen, /TertiaryButton/);
  assert.match(screen, /modalDeleteButton:\s*\{[\s\S]*?backgroundColor:\s*LUXURY\.colors\.error/);
});

test('Cancel closes the dialog and makes no deletion request', () => {
  const cancelBlock = modalBlock.match(/<SecondaryButton[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(cancelBlock, /onPress=\{\(\) => \{\s*if \(!deletionSubmitting\) setDeletionConfirmVisible\(false\);\s*\}\}/);
  assert.doesNotMatch(cancelBlock, /confirmDeletion|submitAccountDeletionRequest/);
});

test('Delete Account submits at most once per request cycle', () => {
  assert.match(screen, /const confirmDeletion = async \(\) => \{\s*if \(deletionSubmitting\) return;/);
});

test('repeated presses are blocked while submitting', () => {
  const deleteBlock = modalBlock.match(/<PrimaryButton[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(deleteBlock, /disabled=\{deletionSubmitting\}/);
  assert.match(deleteBlock, /loading=\{deletionSubmitting\}/);
});

test('both buttons carry accessibility label and hint', () => {
  const cancelBlock = modalBlock.match(/<SecondaryButton[\s\S]*?\/>/)?.[0] ?? '';
  const deleteBlock = modalBlock.match(/<PrimaryButton[\s\S]*?\/>/)?.[0] ?? '';
  for (const block of [cancelBlock, deleteBlock]) {
    assert.match(block, /accessibilityLabel="[^"]+"/);
    assert.match(block, /accessibilityHint="[^"]+"/);
  }
});

test('new body copy appears and legacy "reviewed and processed" copy is absent', () => {
  assert.match(
    screen,
    /Your account will be deactivated immediately\. You will have 30 days to restore it before your account and associated data are permanently deleted, subject to required legal retention\./,
  );
  assert.doesNotMatch(screen, /reviewed and processed/);
});

test('modal title matches the required copy', () => {
  assert.match(modalBlock, /Request account deletion\?/);
});
