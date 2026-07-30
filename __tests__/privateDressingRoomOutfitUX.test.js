// Private Dressing Room outfit UX (Phase 2, Stage 7).
//
// Source-contract assertions in the style of this repository's other route
// tests: the suite has no React renderer, so what is asserted is the structure
// the screen commits to — which states render, what a card shows, what is
// announced, and what may never appear.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ROUTE = 'app/stylist/dressing-room/index.tsx';
const SOURCE = read(ROUTE);

// ── Composition states ───────────────────────────────────────────────────────

test('every composition status has a rendered branch', () => {
  for (const [status, marker] of [
    ['building', 'testID="composition-building"'],
    ['corrupt', 'testID="composition-corrupt"'],
    ['insufficient', 'testID="composition-insufficient"'],
    ['failed', 'testID="composition-failed"'],
    ['ready', 'testID="composition-ready"'],
  ]) {
    assert.ok(SOURCE.includes(marker), `missing branch for ${status}`);
  }
  assert.match(SOURCE, /compositionStatus === 'idle'/);
  assert.match(SOURCE, /compositionStatus === 'stale'/);
});

test('the building state is announced politely and shows progress', () => {
  const body = SOURCE.slice(
    SOURCE.indexOf("compositionStatus === 'building'"),
    SOURCE.indexOf("compositionStatus === 'corrupt'"),
  );
  assert.match(body, /accessibilityLiveRegion="polite"/);
  assert.match(body, /<ActivityIndicator/);
  assert.match(body, /PRIVATE_WORKSPACE_COPY\.building/);
});

test('a stale composition explains itself and offers exactly one rebuild', () => {
  assert.match(SOURCE, /PRIVATE_WORKSPACE_COPY\.compositionStale/);
  assert.match(SOURCE, /testID="rebuild-outfits-button"/);
  assert.equal((SOURCE.match(/testID="rebuild-outfits-button"/g) ?? []).length, 1);
});

test('a corrupt composition offers reset-and-rebuild and never erases silently', () => {
  const body = SOURCE.slice(
    SOURCE.indexOf('testID="composition-corrupt"'),
    SOURCE.indexOf("compositionStatus === 'insufficient'"),
  );
  assert.match(body, /PRIVATE_WORKSPACE_COPY\.compositionCorrupt/);
  assert.match(body, /testID="reset-composition-button"/);
  assert.match(body, /resetComposition\(\)/);
});

test('an insufficient Closet is supportive and offers a way forward', () => {
  const body = SOURCE.slice(
    SOURCE.indexOf('testID="composition-insufficient"'),
    SOURCE.indexOf('testID="composition-failed"'),
  );
  assert.match(body, /PRIVATE_WORKSPACE_COPY\.insufficient|PRIVATE_WORKSPACE_COPY\.unsupportedAnchor/);
  assert.match(body, /testID="return-to-closet-button"/);
  // No shopping surface may appear here.
  assert.equal(/Find Missing|Shop|Buy/i.test(body), false);
});

test('a failed composition offers retry, not an automatic loop', () => {
  const body = SOURCE.slice(
    SOURCE.indexOf('testID="composition-failed"'),
    SOURCE.indexOf('const active ='),
  );
  assert.match(body, /testID="retry-composition-button"/);
  assert.match(body, /retry\(\)/);
  assert.equal(/setTimeout|setInterval/.test(body), false, 'no automatic retry loop');
});

test('a Closet load failure never renders a missing-slot message', () => {
  // The Closet-failure branch belongs to the workspace status switch and is
  // rendered instead of the outfit section, not alongside it.
  assert.match(SOURCE, /case 'closet_failed':/);
  const closetFailed = SOURCE.slice(
    SOURCE.indexOf("case 'closet_failed':"),
    SOURCE.indexOf("case 'session_unrecoverable':"),
  );
  assert.equal(/describeMissingSlots|missingSlots/.test(closetFailed), false);
  assert.match(closetFailed, /PRIVATE_WORKSPACE_COPY\.closetFailed/);
});

// ── Look cards ───────────────────────────────────────────────────────────────

test('a look card shows label, selection, completeness, count and missing count', () => {
  const card = SOURCE.slice(SOURCE.indexOf('testID="look-selector"'), SOURCE.indexOf('active-look-detail'));
  assert.match(card, /Look \$\{look\.rank \+ 1\}/);
  assert.match(card, /look\.isActive \? styles\.lookCardSelected/);
  assert.match(card, /look\.itemCount/);
  assert.match(card, /describeMissingSlots\(look\.missingSlots\)/);
  assert.match(card, /look\.completeness === 'complete' \? 'complete outfit' : 'partial outfit'/);
});

test('the anchor image is first and visually prominent', () => {
  const card = SOURCE.slice(SOURCE.indexOf('testID="look-selector"'), SOURCE.indexOf('active-look-detail'));
  assert.match(card, /const anchorEntry = look\.items\[0\]/);
  assert.match(card, /<LookThumb entry=\{anchorEntry\} large \/>/);
});

test('up to three supporting images are shown with an overflow count', () => {
  const card = SOURCE.slice(SOURCE.indexOf('testID="look-selector"'), SOURCE.indexOf('active-look-detail'));
  assert.match(card, /look\.items\.slice\(1, 4\)/);
  assert.match(card, /overflow > 0/);
  assert.match(card, /\+\$\{overflow\}/);
});

test('a missing image renders a placeholder, never blank space', () => {
  const thumb = SOURCE.slice(SOURCE.indexOf('function LookThumb'), SOURCE.indexOf('export default function'));
  assert.match(thumb, /if \(!uri\)/);
  assert.match(thumb, /styles\.thumbPlaceholder/);
  assert.match(thumb, /no image available/);
  // No stock photography is invented for a garment we do not have a picture of.
  assert.equal(/unsplash|placeholder\.com|https?:\/\//.test(thumb), false);
});

test('label codes are rendered through bounded copy, not raw', () => {
  assert.match(SOURCE, /PRIVATE_LOOK_LABELS\[code\] \?\? code/);
});

test('a look whose garment disappeared says so on the card', () => {
  assert.match(SOURCE, /look\.stale \? \(/);
  assert.match(SOURCE, /PRIVATE_WORKSPACE_COPY\.lookStale/);
});

// ── Active look detail ───────────────────────────────────────────────────────

test('the active look lists every occupied slot explicitly', () => {
  const detail = SOURCE.slice(SOURCE.indexOf('testID="active-look-detail"'), SOURCE.indexOf('const renderBody'));
  assert.match(detail, /active\.items\.map\(/);
  assert.match(detail, /PRIVATE_SLOT_LABELS\[entry\.slot\]/);
  assert.match(detail, /testID="active-look-slot"/);
});

test('the slot name is announced BEFORE the garment name', () => {
  const detail = SOURCE.slice(SOURCE.indexOf('testID="active-look-detail"'), SOURCE.indexOf('const renderBody'));
  // Phase 3 composes the label from parts (slot, anchor lock, edited state).
  // The slot label must still lead.
  assert.match(detail, /`\$\{PRIVATE_SLOT_LABELS\[entry\.slot\]\}: \$\{/);
  const labelStart = detail.indexOf('accessibilityLabel={[');
  const slotFirst = detail.indexOf('${PRIVATE_SLOT_LABELS[entry.slot]}:', labelStart);
  const titleAfter = detail.indexOf('entry.item?.title', labelStart);
  assert.ok(labelStart > -1 && slotFirst > -1 && titleAfter > slotFirst);
});

test('the active look states how many Closet items it uses', () => {
  assert.match(SOURCE, /Uses \$\{active\.itemCount\} Closet item/);
});

test('a partial active look states exactly what is missing', () => {
  const detail = SOURCE.slice(SOURCE.indexOf('testID="active-look-detail"'), SOURCE.indexOf('const renderBody'));
  assert.match(detail, /active\.completeness === 'partial'/);
  assert.match(detail, /describeMissingSlots\(active\.missingSlots\)/);
  assert.match(detail, /Built from the pieces already in your Closet/);
});

test('a deleted garment shows as unavailable rather than a stale title', () => {
  const detail = SOURCE.slice(SOURCE.indexOf('testID="active-look-detail"'), SOURCE.indexOf('const renderBody'));
  assert.match(detail, /entry\.item\?\.title \?\? PRIVATE_WORKSPACE_COPY\.lookStale/);
});

// ── Selection ────────────────────────────────────────────────────────────────

test('tapping a look selects it through the coordinator', () => {
  assert.match(SOURCE, /onPress=\{\(\) => void selectLook\(look\.lookId\)\}/);
});

test('the active look defaults to the persisted selection', () => {
  assert.match(SOURCE, /looks\.find\(\(look\) => look\.isActive\) \?\? looks\[0\] \?\? null/);
});

// ── Responsive ───────────────────────────────────────────────────────────────

test('the tablet breakpoint is declared once and documented', () => {
  assert.match(SOURCE, /const TABLET_MIN_WIDTH = 768/);
  assert.match(SOURCE, /const isWide = width >= TABLET_MIN_WIDTH/);
});

test('phones scroll look cards horizontally; tablets use a wrapping grid', () => {
  assert.match(SOURCE, /horizontal=\{!isWide\}/);
  assert.match(SOURCE, /isWide \? styles\.lookGrid : styles\.lookRow/);
  assert.match(SOURCE, /lookGrid: \{ flexDirection: 'row', flexWrap: 'wrap'/);
});

test('cards have a fixed width so they are neither compressed nor stretched', () => {
  assert.match(SOURCE, /lookCard: \{[\s\S]*?width: 220/);
  assert.match(SOURCE, /lookCardWide: \{ width: 260 \}/);
});

test('touch targets stay at or above 48dp', () => {
  const minHeights = SOURCE.match(/minHeight: (\d+)/g) ?? [];
  assert.ok(minHeights.length >= 3);
  for (const declaration of minHeights) {
    assert.ok(Number(declaration.split(':')[1].trim()) >= 48, declaration);
  }
});

// ── Excluded functionality ───────────────────────────────────────────────────

test('later-phase controls are absent unless their own nested gates render them', () => {
  const titles = [...SOURCE.matchAll(/title=(?:"([^"]*)"|\{([^}]*)\})/g)].map((m) => m[1] ?? m[2]);
  for (const title of titles) {
    assert.equal(
      /^\s*(Swap|Compare|Ask Elise|Save Look|Save|Find Missing Piece|Buy|Checkout)\s*$/i.test(title),
      false,
      `Phase 2 must not offer ${title}`,
    );
  }
  for (const forbidden of [
    'swapHistory',
    'findMissingPiece',
    'checkout',
    'affiliate',
    'purchaseOptions',
    'styleChat',
  ]) {
    assert.equal(SOURCE.includes(forbidden), false, `must not reference ${forbidden}`);
  }
  assert.match(SOURCE, /savedLooksEnabled \? \([\s\S]*?Save Look/);
});

test('no disabled teaser control is rendered', () => {
  assert.equal(/disabled=\{true\}/.test(SOURCE), false, 'no permanently disabled teasers');
});

test('the route still adds no bottom tab and navigates to no collaborative route', () => {
  // Asserted on NAVIGATION TARGETS and imports: the header comment names the
  // collaborative routes precisely in order to disclaim them.
  const targets = [...SOURCE.matchAll(/router\.(?:push|replace)\(\s*'([^']+)'/g)].map((m) => m[1]);
  for (const target of targets) {
    assert.equal(
      /^\/dressing-rooms|^\/rooms|^\/\(public\)/.test(target),
      false,
      `must not navigate to ${target}`,
    );
  }
  const imports = SOURCE.match(/^import [\s\S]*?from '[^']+';$/gm) ?? [];
  for (const line of imports.join('\n').split('\n')) {
    for (const forbidden of ['outfitDecisions', 'dressingRoomCollaboration', 'styleObjects']) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}`);
    }
  }
  assert.equal(/<Tabs|expo-router\/tabs/.test(SOURCE), false, 'no bottom tab is introduced');
});

test('the screen still calls no persistence directly', () => {
  const imports = SOURCE.match(/^import [\s\S]*?from '[^']+';$/gm) ?? [];
  const importedFrom = imports.join('\n');
  for (const persistence of [
    'privateDressingRoomCompositionStore',
    'privateDressingRoomSessionStore',
    'privateDressingRoomComposer',
    'expo-file-system',
    'closetLibrary',
  ]) {
    assert.equal(importedFrom.includes(persistence), false, `must not import ${persistence}`);
  }
});

test('the screen renders only garments the coordinator resolved', () => {
  // Items come from `looks`, which resolveCompositionLooks built from current
  // projections. The screen never reads a closetItemId into a fabricated item.
  assert.match(SOURCE, /looks\.map\(\(look\)/);
  assert.equal(/new Image\(|require\('\.\.\/\.\.\/\.\.\/assets/.test(SOURCE), false);
});

// ── Preserved Phase 1 surfaces ───────────────────────────────────────────────

test('the Stylist and Closet entries are untouched by Phase 2', () => {
  const stylist = read('app/stylist/index.tsx');
  const library = read('app/library.tsx');
  assert.match(stylist, /testID="private-dressing-room-entry"/);
  assert.match(library, /viewLabel: 'Build an outfit'/);
  assert.equal((library.match(/viewLabel="Add to Room"/g) ?? []).length, 3);
});

test('discard confirmation and session controls survive', () => {
  assert.match(SOURCE, /testID="discard-session-button"/);
  assert.match(SOURCE, /testID="confirm-discard-button"/);
  assert.match(SOURCE, /testID="clear-anchor-button"/);
});
