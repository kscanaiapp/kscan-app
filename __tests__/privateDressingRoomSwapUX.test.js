// Phase 3 slot-swap and comparison UX, plus the hook's production wiring.
// Source-contract assertions in the style of this repository's other route
// tests; behavioural proof lives in the Phase 3 integration suite.
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ROUTE = read('app/stylist/dressing-room/index.tsx');
const HOOK = read('hooks/usePrivateDressingRoom.ts');
// Hydration and session teardown live in a production module the hook and the
// lifecycle suite both call (P3-B3).
const LIFECYCLE = read('services/privateDressingRoomLifecycle.ts');

// ── Production reachability ──────────────────────────────────────────────────

test('the hook has a governed import path to every Phase 3 service', () => {
  for (const module of [
    'privateDressingRoomInteractionStore',
    'privateDressingRoomEffectiveLook',
    'privateDressingRoomCandidates',
    'privateDressingRoomComparison',
  ]) {
    assert.ok(HOOK.includes(module), `the hook must reach ${module}`);
  }
});

test('the route reaches Phase 3 only through the hook and pure helpers', () => {
  const imports = ROUTE.match(/^import [\s\S]*?from '[^']+';$/gm) ?? [];
  const importedFrom = imports.join('\n');
  for (const persistence of [
    'privateDressingRoomInteractionStore',
    'privateDressingRoomCompositionStore',
    'privateDressingRoomSessionStore',
    'expo-file-system',
    'closetLibrary',
  ]) {
    assert.equal(importedFrom.includes(persistence), false, `route must not import ${persistence}`);
  }
  assert.match(ROUTE, /usePrivateDressingRoom/);
});

// ── Nested flag gating ───────────────────────────────────────────────────────

test('every Phase 3 hook action short-circuits on the nested flag', () => {
  for (const action of [
    'const openSlotEditor',
    'const previewSlotCandidate',
    'const applySlotCandidate',
    'const restoreOriginalSlot',
    'const undoLastSwap',
    'const resetCorruptInteraction',
    'const openComparison',
    'const setComparedLooks',
  ]) {
    const start = HOOK.indexOf(action);
    assert.ok(start > -1, `missing ${action}`);
    const body = HOOK.slice(start, start + 700);
    assert.match(
      body,
      /PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE/,
      `${action} must check the nested flag`,
    );
  }
});

test('interaction loading itself is gated at one entry point', () => {
  // The gate now lives in the production lifecycle module, where it can be
  // exercised in BOTH states by the integration suite instead of being a
  // compile-time constant no test can flip.
  const body = LIFECYCLE.slice(
    LIFECYCLE.indexOf('export async function loadInteractionSnapshot'),
    LIFECYCLE.indexOf('export async function discardPrivateDressingRoomSession'),
  );
  const guard = body.indexOf('if (!input.interactionsEnabled');
  const load = body.indexOf('await loadInteractionState(');
  assert.ok(guard > -1, 'the single gate must exist');
  assert.ok(load > guard, 'the guard precedes any store read');
  // And the hook passes the real flag through it.
  assert.match(
    HOOK,
    /interactionsEnabled: PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE/,
    'the hook supplies the production flag',
  );
});

test('every Phase 3 control in the route is gated on interactionsEnabled', () => {
  for (const marker of [
    'testID="slot-swap-button"',
    'testID="slot-fill-button"',
    'testID="undo-button"',
    'testID="compare-entry-button"',
  ]) {
    assert.ok(ROUTE.includes(marker), `missing ${marker}`);
  }
  assert.match(ROUTE, /interactionsEnabled \? \(/);
  assert.match(ROUTE, /interactionsEnabled && canUndo/);
  assert.match(ROUTE, /interactionsEnabled && canCompareLooks/);
  assert.match(ROUTE, /visible=\{interactionsEnabled && slotEditor\.status !== 'closed'\}/);
});

// ── Slot rows ────────────────────────────────────────────────────────────────

test('the anchor slot shows a locked label and no enabled swap control', () => {
  assert.match(ROUTE, /testID="anchor-locked-label"/);
  const anchorBranch = ROUTE.slice(
    ROUTE.indexOf('const isAnchor ='),
    ROUTE.indexOf('testID="fillable-slot"'),
  );
  // The swap button lives in the ELSE branch of the anchor check.
  assert.match(anchorBranch, /isAnchor \? \([\s\S]*?anchor-locked-label[\s\S]*?\) : \(/);
});

test('an overridden slot is marked as edited', () => {
  assert.match(ROUTE, /const edited = !!overrideFor\(active\.lookId, entry\.slot\)/);
  assert.match(ROUTE, /edited \? ' · edited' : ''/);
});

test('an explicitly missing slot offers Choose item', () => {
  assert.match(ROUTE, /active\.missingSlots\.map\(\(slot\)/);
  assert.match(ROUTE, /PRIVATE_WORKSPACE_COPY\.chooseItem/);
});

// ── Slot editor ──────────────────────────────────────────────────────────────

test('the editor covers loading, anchor-locked, no-candidates and failure', () => {
  for (const status of ["'loading'", "'anchor_locked'", "'no_candidates'", "'failed'"]) {
    assert.ok(ROUTE.includes(`slotEditor.status === ${status}`), `missing ${status} branch`);
  }
});

test('the no-candidate state is explanatory and links to Closet intake', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="no-candidates"'), ROUTE.indexOf('slotEditor.status === \'failed\''));
  assert.match(body, /PRIVATE_WORKSPACE_COPY\.noAlternatives/);
  assert.match(body, /testID="add-to-closet-button"/);
  // Closet intake lives on library section=closet, not Scanner or Recent.
  assert.match(
    body,
    /router\.push\(\{\s*pathname:\s*'\/library',\s*params:\s*\{\s*section:\s*'closet'\s*\}\s*\}\)/,
  );
  assert.equal(/scan/i.test(body), false, 'must not hardcode Scanner');
});

test('candidates show title, brand and colour but never retailer data', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="candidate-list"'), ROUTE.indexOf('testID="apply-swap-button"'));
  assert.match(body, /candidate\.item\.title/);
  assert.match(body, /candidate\.item\.brand/);
  assert.match(body, /candidate\.item\.primaryColor/);
  for (const forbidden of ['price', 'retailer', 'productUrl', 'affiliate']) {
    assert.equal(body.includes(forbidden), false, `must not show ${forbidden}`);
  }
});

test('tapping a candidate previews only; Apply is a separate control', () => {
  assert.match(ROUTE, /onPress=\{\(\) => previewSlotCandidate\(candidate\.closetItemId\)\}/);
  assert.match(ROUTE, /testID="apply-swap-button"/);
  assert.match(ROUTE, /onPress=\{\(\) => void applySlotCandidate\(\)\}/);
  // Apply requires a live preview and blocks repeat submission.
  assert.match(ROUTE, /disabled=\{busy \|\| !preview \|\| slotEditor\.status === 'applying'\}/);
});

test('apply takes no candidate argument from the route', () => {
  // The route cannot hand an arbitrary id to persistence: the hook applies the
  // validated CURRENT preview.
  assert.equal(/applySlotCandidate\([^)]+\)/.test(ROUTE), false);
  assert.match(HOOK, /const applySlotCandidate = useCallback\(async \(\) =>/);
});

test('cancel clears the preview and changes nothing persisted', () => {
  assert.match(ROUTE, /testID="cancel-swap-button"/);
  assert.match(ROUTE, /onPress=\{closeSlotEditor\}/);
  const close = HOOK.slice(HOOK.indexOf('const closeSlotEditor'), HOOK.indexOf('const previewSlotCandidate'));
  assert.match(close, /setPreview\(null\)/);
  assert.equal(/applySlotOverride|restoreBaseSlot|undoLastSwapStore/.test(close), false);
});

test('Restore Original appears in the editor when an override exists', () => {
  assert.match(ROUTE, /overrideFor\(slotEditor\.lookId, slotEditor\.slot\) \? \(/);
  assert.match(ROUTE, /testID="restore-original-button"/);
  // Slot-scoped label, never "reset outfit".
  assert.match(ROUTE, /Restore the original \$\{/);
});

// ── Undo ─────────────────────────────────────────────────────────────────────

test('Undo shows only with history and no redo control exists', () => {
  assert.match(ROUTE, /interactionsEnabled && canUndo \? \(/);
  // Asserted on IDENTIFIERS and control titles, not prose: the hook comments
  // say "never a redo" precisely to disclaim it.
  const titles = [...ROUTE.matchAll(/title=(?:"([^"]*)"|\{([^}]*)\})/g)].map((m) => m[1] ?? m[2]);
  for (const title of titles) {
    assert.equal(/redo/i.test(String(title)), false, `no redo control: ${title}`);
  }
  for (const identifier of ['redoStack', 'redoLast', 'canRedo', 'onRedo', 'redoSwap']) {
    assert.equal(ROUTE.includes(identifier), false, identifier);
    assert.equal(HOOK.includes(identifier), false, identifier);
  }
});

// ── Preview lifecycle ────────────────────────────────────────────────────────

test('backgrounding clears preview and closes the editor', () => {
  const body = HOOK.slice(HOOK.indexOf('Backgrounding clears an unapplied preview'), HOOK.length);
  assert.match(body, /AppState\.addEventListener\('change'/);
  assert.match(body, /if \(next !== 'active'\)/);
  assert.match(body, /setPreview\(null\)/);
  assert.match(body, /setSlotEditor\(CLOSED_EDITOR\)/);
});

test('route unmount clears ephemeral state only', () => {
  const start = HOOK.indexOf('Route exit clears ephemeral state');
  // Bound the slice to the effect itself; the return block that follows
  // legitimately exposes resetCorruptInteraction as an action.
  const body = HOOK.slice(start, HOOK.indexOf('return {', start));
  assert.match(body, /setPreview\(null\)/);
  assert.match(body, /setSlotEditor\(CLOSED_EDITOR\)/);
  assert.equal(
    /discardInteractionState|resetCorruptInteractionState|applySlotOverride/.test(body),
    false,
    'unmount must not touch persistence',
  );
});

test('opening another slot clears the previous preview', () => {
  const body = HOOK.slice(HOOK.indexOf('const openSlotEditor'), HOOK.indexOf('const closeSlotEditor'));
  const clear = body.indexOf('setPreview(null)');
  const open = body.indexOf('setSlotEditor({ status: \'loading\'');
  assert.ok(clear > -1 && open > clear, 'the preview clears before the new editor opens');
});

test('a preview is never persisted', () => {
  const body = HOOK.slice(HOOK.indexOf('const previewSlotCandidate'), HOOK.indexOf('const clearSlotPreview'));
  for (const call of ['applySlotOverride', 'restoreBaseSlot', 'setComparedLooksStore', 'persist']) {
    assert.equal(body.includes(call), false, `preview must not call ${call}`);
  }
});

// ── Missing swapped item ─────────────────────────────────────────────────────

test('a missing swapped item offers Restore Original and Choose Another', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="swapped-item-missing"'), ROUTE.indexOf('{renderBody()}'));
  assert.match(body, /PRIVATE_WORKSPACE_COPY\.swappedItemMissing/);
  assert.match(body, /testID="missing-restore-button"/);
  assert.match(body, /testID="missing-choose-button"/);
  // Never a silent substitution.
  assert.equal(/setAnchor|selectLook\(/.test(body), false);
});

test('a Closet load failure is not turned into a missing-item state', () => {
  assert.match(LIFECYCLE, /input\.closetOk \? reconciled\.missingOverrides : \[\]/);
  // Production must thread the TYPED Closet result. `closetOk` is no longer
  // reachable as a caller-supplied value anywhere in the hydration path — the
  // divergence that let this defect ship (P3-B3).
  const hydrate = LIFECYCLE.slice(LIFECYCLE.indexOf('export async function hydratePrivateDressingRoom'));
  const threaded = [...hydrate.matchAll(/closetOk: ([A-Za-z.]+)/g)].map(([, value]) => value);
  assert.ok(threaded.length >= 1, 'hydration must thread a Closet-ok value');
  for (const value of threaded) {
    assert.equal(value, 'closetResult.ok', 'it must come from the typed result');
  }
});

test('successful apply, restore and undo re-reconcile missing swapped items', () => {
  for (const action of ['const applySlotCandidate', 'const restoreOriginalSlot', 'const undoLastSwap']) {
    const start = HOOK.indexOf(action);
    assert.ok(start > -1, `missing ${action}`);
    const body = HOOK.slice(start, start + 4500);
    assert.match(
      body,
      /reconcileInteractionState\(/,
      `${action} must re-reconcile missing after a successful mutate`,
    );
  }
});

test('session discard clears interaction memory and deletes interaction files', () => {
  // Memory clearing is the hook's; the persisted cleanup is the shared
  // production sequence both the hook and the lifecycle suite run.
  const hook = HOOK.slice(HOOK.indexOf('const endSession = useCallback'), HOOK.indexOf('const discardSession'));
  assert.match(hook, /setInteraction\(\{ \.\.\.IDLE_INTERACTION/);
  assert.match(hook, /discardPrivateDressingRoomSession\(/);
  const body = LIFECYCLE.slice(
    LIFECYCLE.indexOf('export async function discardPrivateDressingRoomSession'),
    LIFECYCLE.indexOf('export async function hydratePrivateDressingRoom'),
  );
  assert.match(body, /discardInteractionState/);
  assert.match(body, /input\.interactionsEnabled/, 'Phase 3 OFF cleans up no interaction storage');
});

test('an actor transition clears Phase 3 ephemeral and pending confirmation', () => {
  const body = HOOK.slice(
    HOOK.indexOf('/** An actor transition invalidates every snapshot'),
    HOOK.indexOf('const view = useMemo'),
  );
  assert.match(body, /setInteraction\(IDLE_INTERACTION\)/);
  assert.match(body, /setPreview\(null\)/);
  assert.match(body, /setSlotEditor\(CLOSED_EDITOR\)/);
  assert.match(body, /setComparing\(false\)/);
  assert.match(body, /setPendingContextChange\(null\)/);
});

test('a route-supplied anchor goes through context-change confirmation', () => {
  const start = HOOK.indexOf('Apply a route-supplied Closet item ONCE');
  assert.ok(start > -1, 'missing route-supplied anchor effect');
  const body = HOOK.slice(start, start + 900);
  assert.match(body, /requestContextChange\(\{\s*kind:\s*'anchor'/);
  assert.equal(
    /void setAnchor\(intent\)/.test(body),
    false,
    'route must not bypass confirmation via raw setAnchor',
  );
});

// ── Corrupt interaction ──────────────────────────────────────────────────────

test('corrupt edits keep the Phase 2 outfits and offer only Reset Edits', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="interaction-corrupt"'), ROUTE.indexOf('testID="swapped-item-missing"'));
  assert.match(body, /PRIVATE_WORKSPACE_COPY\.interactionCorrupt/);
  assert.match(body, /testID="reset-edits-button"/);
  assert.equal(/rebuildOutfits/.test(body), false, 'must not force an outfit rebuild');
});

// ── Comparison ───────────────────────────────────────────────────────────────

test('Compare appears only when two looks exist, with no disabled teaser', () => {
  assert.match(ROUTE, /interactionsEnabled && canCompareLooks \? \(/);
  assert.match(HOOK, /canCompareLooks: PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE && canCompare\(effectiveLooks\)/);
});

test('the shared anchor is pinned once, not repeated as two rows', () => {
  assert.match(ROUTE, /testID="comparison-anchor-pin"/);
  assert.match(ROUTE, /\.filter\(\(row\) => !row\.anchor\)/);
});

test('comparison rows announce both looks and the difference', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="comparison-rows"'), ROUTE.indexOf('testID="close-comparison-button"'));
  assert.match(body, /PRIVATE_SLOT_LABELS\[row\.slot\]/);
  assert.match(body, /comparison\?\.leftLabel/);
  assert.match(body, /comparison\?\.rightLabel/);
  assert.match(body, /PRIVATE_COMPARISON_COPY\.differs/);
});

test('comparison uses the SAME Phase 2 tablet breakpoint', () => {
  assert.match(ROUTE, /const TABLET_MIN_WIDTH = 768/);
  assert.equal((ROUTE.match(/TABLET_MIN_WIDTH = /g) ?? []).length, 1, 'exactly one breakpoint');
  assert.match(ROUTE, /isWide \? styles\.compareColumnsWide : styles\.compareColumns/);
  assert.match(ROUTE, /compareColumnsWide: \{ flexDirection: 'row'/);
  assert.match(ROUTE, /compareColumns: \{ flexDirection: 'column' \}/);
});

test('comparison declares no winner', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="comparison-view"'), ROUTE.indexOf('Destructive context change'));
  assert.equal(/\b(best|better|winner|winning|recommended)\b/i.test(body), false);
});

// ── Context change ───────────────────────────────────────────────────────────

test('anchor and occasion changes route through the confirmation gate', () => {
  assert.match(ROUTE, /void requestContextChange\(\{ kind: 'anchor'/);
  assert.match(ROUTE, /void requestContextChange\(\{\s*kind: 'occasion'/);
  // The raw mutators are no longer wired directly to the chips.
  assert.equal(/onPress=\{\(\) => void setAnchor\(/.test(ROUTE), false);
  assert.equal(/onPress=\{\(\) => void \(selected \? clearOccasion/.test(ROUTE), false);
});

test('the confirmation names the consequence and offers both choices', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="context-change-confirm"'), ROUTE.length);
  assert.match(body, /PRIVATE_WORKSPACE_COPY\.editsDiscardedAnchor/);
  assert.match(body, /PRIVATE_WORKSPACE_COPY\.editsDiscardedOccasion/);
  assert.match(body, /testID="confirm-context-change-button"/);
  assert.match(body, /testID="cancel-context-change-button"/);
});

test('confirmation is requested only when PERSISTED work would be lost', () => {
  const body = HOOK.slice(HOOK.indexOf('const requestContextChange'), HOOK.indexOf('const confirmContextChange'));
  assert.match(body, /hasPreview: false/);
  assert.match(body, /contextChangeDiscardsWork/);
});

test('confirming clears editor, preview, comparison and interaction state first', () => {
  const body = HOOK.slice(HOOK.indexOf('const applyContextChange'), HOOK.indexOf('const requestContextChange'));
  const clear = body.indexOf('setInteraction({ ...IDLE_INTERACTION');
  const mutate = body.indexOf("change.kind === 'anchor'");
  assert.ok(clear > -1 && mutate > clear, 'state is dropped before the session mutation');
  assert.match(body, /setSlotEditor\(CLOSED_EDITOR\)/);
  assert.match(body, /setPreview\(null\)/);
});

// ── Excluded controls ────────────────────────────────────────────────────────

test('no later-phase control appears', () => {
  const titles = [...ROUTE.matchAll(/title=(?:"([^"]*)"|\{([^}]*)\})/g)].map((m) => m[1] ?? m[2]);
  for (const title of titles) {
    assert.equal(
      /^\s*(Ask Elise|Save Look|Find Missing Piece|Buy|Checkout|Share|Vote|Redo)\s*$/i.test(title),
      false,
      `must not offer ${title}`,
    );
  }
  for (const forbidden of ['saveLook', 'findMissingPiece', 'checkout', 'affiliate', 'styleChat', 'shareToken']) {
    assert.equal(ROUTE.includes(forbidden), false, `must not reference ${forbidden}`);
  }
});

test('no bottom tab and no collaborative navigation is introduced', () => {
  const targets = [...ROUTE.matchAll(/router\.(?:push|replace)\(\s*'([^']+)'/g)].map((m) => m[1]);
  for (const target of targets) {
    assert.equal(/^\/dressing-rooms|^\/rooms|^\/\(public\)/.test(target), false, target);
  }
  assert.equal(/<Tabs|expo-router\/tabs/.test(ROUTE), false);
});

// ── Accessibility ────────────────────────────────────────────────────────────

test('swap and fill actions name their target slot', () => {
  assert.match(ROUTE, /accessibilityLabel=\{`Swap \$\{PRIVATE_SLOT_LABELS\[entry\.slot\]\}`\}/);
  assert.match(ROUTE, /accessibilityLabel=\{`Choose \$\{PRIVATE_SLOT_LABELS\[slot\]\}`\}/);
});

test('candidate preview state is announced', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="candidate-option"') - 900, ROUTE.indexOf('testID="candidate-option"'));
  assert.match(body, /accessibilityState=\{\{ selected: previewed/);
  assert.match(body, /previewed \? 'previewed' : ''/);
});

test('Apply and Cancel have distinct labels', () => {
  assert.match(ROUTE, /accessibilityLabel="Apply this swap"/);
  assert.match(ROUTE, /accessibilityLabel="Cancel and close without changing this piece"/);
});

test('undo, restore and comparison controls are labelled', () => {
  // Undo's label is conditional: when the prior item has left the Closet it
  // announces that it is unavailable and why (P3-B2), so both branches are
  // asserted rather than one literal string.
  assert.match(ROUTE, /'Undo the last outfit change'/);
  assert.match(
    ROUTE,
    /`Undo the last outfit change, unavailable\. \$\{PRIVATE_WORKSPACE_COPY\.undoBlockedPriorItemMissing\}`/,
  );
  assert.match(ROUTE, /accessibilityLabel="Compare two outfits"/);
  assert.match(ROUTE, /accessibilityLabel="Close the comparison"/);
  assert.match(ROUTE, /accessibilityLabel="Reset your outfit edits"/);
});

test('all Phase 3 touch targets meet 48dp', () => {
  const heights = ROUTE.match(/minHeight: (\d+)/g) ?? [];
  assert.ok(heights.length >= 5);
  for (const declaration of heights) {
    assert.ok(Number(declaration.split(':')[1].trim()) >= 48, declaration);
  }
});

test('every modal is dismissable', () => {
  const requests = ROUTE.match(/onRequestClose=/g) ?? [];
  assert.equal(requests.length, 3, 'slot editor, comparison and confirmation');
});
