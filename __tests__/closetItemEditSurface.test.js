// BUG-16 — the edit path must be REACHABLE, not merely implemented.
//
// __tests__/closetItemEditing.test.js proves the store behaviour end to end
// against a real filesystem. That is necessary and not sufficient: the defect
// QA reported was that a saved Closet item had no discoverable way to be
// edited at all, so this file checks the wiring between the grid, the sheet and
// the store — the part a behavioural store test cannot see.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the Closet grid offers an edit affordance on every card', () => {
  const library = read('app/library.tsx');

  const closetCards = library.match(/status="Closet"[\s\S]{0,400}?\/>/g) ?? [];
  assert.ok(closetCards.length >= 2, 'expected both Closet grid cards');
  for (const card of closetCards) {
    assert.match(card, /onEdit=\{/, 'a Closet card renders without an edit affordance');
    assert.match(card, /onDelete=\{/, 'the existing remove affordance must be preserved');
  }
});

test('the card renders edit as its own control, separate from the card tap', () => {
  const card = read('components/luxury/SavedLookCard.tsx');
  assert.match(card, /onEdit\?:\s*\(\)\s*=>\s*void/);
  // Its own Pressable: the card body opens the outfit builder, so an edit tap
  // must not fall through to that.
  assert.match(card, /onPress=\{onEdit\}/);
  assert.match(card, /accessibilityLabel=\{`Edit \$\{title\}`\}/);
  // Comfortable target inside an already-pressable card.
  assert.match(card, /editButton:[\s\S]{0,160}minHeight:\s*44/);
});

test('the edit sheet is mounted and bound to the selected item', () => {
  const library = read('app/library.tsx');
  assert.match(library, /import \{ ClosetItemEditModal \}/);
  assert.match(library, /<ClosetItemEditModal/);
  assert.match(library, /item=\{editingClosetItem\}/);
  assert.match(library, /onSave=\{handleSaveClosetItemEdit\}/);
  // Held by id, so the sheet re-reads the current snapshot rather than editing
  // a copy captured when it opened.
  assert.match(library, /editingClosetItemId/);
  assert.match(library, /closet\.items\.find\(\(item: any\) => item\.id === editingClosetItemId\)/);
});

test('save routes through the actor-guarded store update, not a direct write', () => {
  const library = read('app/library.tsx');
  assert.match(library, /closet\.update\(id, patch\)/);

  const hook = read('hooks/useCloset.js');
  assert.match(hook, /updateClosetItem/);
  assert.match(hook, /actorRequest,\s*\n\s*ownerId: actorId,/);
  // A successful edit re-reads from disk instead of patching state optimistically.
  assert.match(hook, /result\.ok && isActorRequestCurrent\(actorRequest\)[\s\S]{0,80}await refresh\(\)/);
  assert.match(hook, /addFromScan,\s*update,\s*remove/);
});

test('the sheet edits metadata only — no media, no scan, no taxonomy', () => {
  const modal = read('components/closet/ClosetItemEditModal.tsx');
  assert.match(modal, /label="Name"/);
  assert.match(modal, /label="Category \(optional\)"/);
  // The creation sheet collects exactly these two, and so does this one.
  const fields = modal.match(/<TextField/g) ?? [];
  assert.equal(fields.length, 2, 'the edit sheet must not gain fields intake never offered');
  for (const forbidden of ['manipulateAsync', 'ImagePicker', 'imageUri:', 'repairClosetItemTaxonomy']) {
    assert.equal(modal.includes(forbidden), false, `the edit sheet must not reach ${forbidden}`);
  }
});

test('cancel is lossless and a failed save keeps the draft on screen', () => {
  const modal = read('components/closet/ClosetItemEditModal.tsx');
  // Cancel reverts to the stored values and closes without calling onSave.
  assert.match(modal, /const cancel = useCallback\(\(\) => \{[\s\S]{0,260}setTitle\(item\?\.title \?\? ''\)/);
  assert.match(modal, /onRequestClose=\{cancel\}/);
  const cancelBody = modal.slice(modal.indexOf('const cancel'), modal.indexOf('const save'));
  assert.equal(cancelBody.includes('onSave'), false, 'cancel must not write');
  // The failure branch sets an error and leaves the drafts untouched.
  assert.match(modal, /setError\(messageFor\(result\.reason\)\)/);
  const saveBody = modal.slice(modal.indexOf('const save'), modal.indexOf('const previewUri'));
  assert.equal(/setTitle\(/.test(saveBody), false, 'a failed save must not clear what was typed');
});

test('NEGATIVE CONTROL: removing the affordance or the route fails these checks', () => {
  // The Closet card exactly as it was before this repair.
  const preRepairCard = `
    <SavedLookCard
      testID="closet-card"
      title={a.title}
      status="Closet"
      onDelete={() => handleDeleteClosetItem(a.id)}
      {...closetOutfitAction(a.id)}
    />`;
  assert.throws(
    () => assert.match(preRepairCard, /onEdit=\{/),
    'the affordance check must fail when the card has no edit control',
  );

  // ...and the hook before `update` was exposed.
  const preRepairHook = `return { items, loading, busy, error, addFromUri, addFromScan, remove, refresh };`;
  assert.throws(
    () => assert.match(preRepairHook, /addFromScan,\s*update,\s*remove/),
    'the route check must fail when the hook exposes no update',
  );
});
