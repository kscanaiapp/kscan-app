/**
 * New Dressing Room modal — keyboard coverage (BUG-03) and stale draft
 * state (BUG-04) regressions.
 *
 * Repo convention for screen-level UI in this codebase is static
 * source-text/structural assertion (see __tests__/deletionModalLayout.test.js)
 * since neither Jest nor React Testing Library is installed. These
 * assertions are written against the actual composed JSX/effect structure
 * (not a trivial substring check) so they fail against the pre-fix
 * CreateRoomModal, which had no keyboard-avoidance and only reset its draft
 * on the success path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const screen = fs.readFileSync(path.join(ROOT, 'app/dressing-rooms/index.tsx'), 'utf8');

// Isolate the CreateRoomModal function body (from its declaration to the
// matching closing brace of the outer function, approximated by the next
// top-level function declaration).
const modalFnMatch = screen.match(/function CreateRoomModal\([\s\S]*?\n}\n\nfunction DressingRoomsContent/);
const modalFn = modalFnMatch ? modalFnMatch[0] : '';

test('CreateRoomModal function is found', () => {
  assert.ok(modalFn.length > 200, 'CreateRoomModal source block was not found');
});

// -- BUG-03: keyboard coverage -----------------------------------------------

test('modal content is wrapped in a KeyboardAvoidingView with a platform-aware behavior', () => {
  assert.match(modalFn, /<KeyboardAvoidingView[\s\S]*?behavior=\{Platform\.OS === 'ios' \? 'padding' : 'height'\}/);
});

test('the KeyboardAvoidingView wraps the Modal backdrop, not the other way around', () => {
  const modalOpenIndex = modalFn.indexOf('<Modal');
  const kavOpenIndex = modalFn.indexOf('<KeyboardAvoidingView');
  const kavCloseIndex = modalFn.lastIndexOf('</KeyboardAvoidingView>');
  const modalCloseIndex = modalFn.lastIndexOf('</Modal>');
  assert.ok(modalOpenIndex >= 0 && kavOpenIndex > modalOpenIndex, 'KeyboardAvoidingView must render inside <Modal>');
  assert.ok(kavCloseIndex > 0 && modalCloseIndex > kavCloseIndex, 'KeyboardAvoidingView must close before </Modal>');
});

test('modal fields and action buttons are inside a ScrollView that persists taps through the keyboard', () => {
  assert.match(modalFn, /<ScrollView[\s\S]*?keyboardShouldPersistTaps="handled"/);
  const scrollOpen = modalFn.indexOf('<ScrollView');
  const titleFieldIndex = modalFn.indexOf('label="Title"');
  const createButtonIndex = modalFn.indexOf('title={saving ? \'Creating\' : \'Create Room\'}');
  const cancelButtonIndex = modalFn.indexOf('title="Cancel"');
  const scrollClose = modalFn.indexOf('</ScrollView>');
  assert.ok(scrollOpen >= 0 && scrollOpen < titleFieldIndex, 'Title field must render inside the ScrollView');
  assert.ok(createButtonIndex > 0 && createButtonIndex < scrollClose, 'Create Room button must remain reachable inside the ScrollView');
  assert.ok(cancelButtonIndex > 0 && cancelButtonIndex < scrollClose, 'Cancel button must remain reachable inside the ScrollView');
});

test('scroll content bottom padding accounts for the real safe-area inset, not a fixed pixel offset', () => {
  assert.match(modalFn, /useSafeAreaInsets|insets\.bottom/);
  assert.match(modalFn, /paddingBottom:\s*Math\.max\(SPACING\.xl,\s*insets\.bottom \+ SPACING\.md\)/);
});

// -- BUG-04: stale draft state -----------------------------------------------

test('draft state resets on every open via a single effect keyed on `visible`', () => {
  const effectMatch = modalFn.match(/useEffect\(\(\) => \{\s*if \(visible\) \{([\s\S]*?)\}\s*\}, \[visible\]\);/);
  assert.ok(effectMatch, 'expected a useEffect keyed on [visible] that resets state when visible becomes true');
  const body = effectMatch[1];
  assert.match(body, /setTitle\(''\)/);
  assert.match(body, /setDescription\(''\)/);
  assert.match(body, /setError\(null\)/);
  assert.match(body, /setSaving\(false\)/);
  assert.match(body, /savingRef\.current = false/);
});

test('handleSave no longer manually resets the draft on success — the open-effect owns resetting', () => {
  const handleSaveMatch = modalFn.match(/const handleSave = async \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(handleSaveMatch, 'handleSave was not found');
  const body = handleSaveMatch[0];
  assert.doesNotMatch(body, /setTitle\(''\)/, 'a second, path-specific reset would only cover the success path and miss Cancel/Back');
  assert.doesNotMatch(body, /setDescription\(''\)/);
});

test('a recoverable failure leaves the modal open so the draft-reset effect does not clear the current draft', () => {
  const handleSaveMatch = modalFn.match(/const handleSave = async \(\) => \{[\s\S]*?\n  \};/);
  const body = handleSaveMatch[0];
  const catchBlock = body.match(/catch \(err: any\) \{([\s\S]*?)\}/)[1];
  assert.doesNotMatch(catchBlock, /onClose\(\)/, 'a recoverable failure must not close the modal (which would wipe the draft on next open)');
  assert.match(catchBlock, /setError\(DRESSING_ROOM_SAVE_ERROR\)/);
});

test('Android Back (onRequestClose) and Cancel both route through the same onClose, so both are covered by the reset-on-open effect', () => {
  assert.match(modalFn, /<Modal visible=\{visible\} transparent animationType="fade" onRequestClose=\{onClose\}>/);
  assert.match(modalFn, /title="Cancel"[\s\S]*?onPress=\{onClose\}/);
});

test('single-flight create guard is intact — no duplicate room-creation requests', () => {
  assert.match(modalFn, /if \(!canSave \|\| savingRef\.current\) return;/);
  assert.match(modalFn, /savingRef\.current = true;/);
});
