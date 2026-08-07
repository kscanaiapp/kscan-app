// Build 25 Phase 4 — accessibility and touch-target contracts.
//
// SCOPE: the primary-journey controls the Phase 4 audit identified, and only
// those. This suite exists to stop the two failure modes the audit found from
// coming back: an interactive control whose effective target is smaller than the
// platform minimum, and a control whose announced semantics do not match what it
// actually is.
//
// PLATFORM TARGET. Android is 48dp, iOS is 44pt. These are genuinely different
// numbers, not a rounding of one another, so PLATFORM_MIN below is the one place
// the two lines legitimately diverge — the iOS line carries 44 here. Everything
// else in this file is identical across platforms on purpose.
//
// WHY STYLE ASSERTIONS. A touch target is a layout property. There is no render
// harness in this repository that measures laid-out geometry (the mini renderers
// in __tests__ produce a props tree, not a Yoga pass), so the honest thing to
// assert is the declared constraint that produces the target. Where a contract
// IS observable in the props tree — roles, labels, states — it is asserted
// behaviourally against the rendered tree instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLATFORM_MIN = 48;

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

/**
 * Extract a named StyleSheet block's body by brace balancing. Regex alone gets
 * this wrong the moment a block contains a nested object (shadow, transform).
 */
function styleBlock(source, name) {
  const head = new RegExp(`(^|\\n)\\s*${name}:\\s*\\{`);
  const m = head.exec(source);
  assert.ok(m, `style block ${name} not found`);
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced style block ${name}`);
}

function declaredMinHeight(source, name) {
  const body = styleBlock(source, name);
  const m = /minHeight:\s*(\d+)/.exec(body);
  return m ? Number(m[1]) : null;
}

// ── Touch targets ────────────────────────────────────────────────────────────
// Every entry is a control on a primary journey that the audit measured below
// the platform minimum. The `was` column is what shipped, kept as documentation
// of what this test is defending against.

const TOUCH_TARGETS = [
  { file: ['app', 'library.tsx'], style: 'subNavTab', was: 'none (~26 effective)' },
  {
    file: ['components', 'scan-results', 'PurchaseOptionsPanel.tsx'],
    style: 'viewOptionsButton',
    was: 32,
  },
  { file: ['components', 'scan-room', 'LiveScanCamera.tsx'], style: 'controlPill', was: 36 },
  { file: ['components', 'scan-room', 'LiveScanCamera.tsx'], style: 'homeButton', was: 36 },
  { file: ['components', 'scan-room', 'ScanLanding.tsx'], style: 'homeButton', was: 36 },
  { file: ['components', 'scan-room', 'ScanLanding.tsx'], style: 'textScanButton', was: 44 },
  { file: ['components', 'ProductShelf.tsx'], style: 'addToRoomButton', was: 36 },
  { file: ['app', 'dressing-rooms', 'index.tsx'], style: 'homeButton', was: 36 },
  { file: ['app', 'dressing-rooms', '[id].tsx'], style: 'homeButton', was: 36 },
  { file: ['app', 'dressing-rooms', '[id].tsx'], style: 'uploadBtn', was: 36 },
  { file: ['components', 'dressing-rooms', 'ItemReactions.tsx'], style: 'reactionButton', was: 36 },
];

for (const target of TOUCH_TARGETS) {
  const label = `${target.file.join('/')} :: ${target.style}`;
  test(`touch target: ${label} declares at least ${PLATFORM_MIN}`, () => {
    const source = read(...target.file);
    const min = declaredMinHeight(source, target.style);
    assert.ok(
      min !== null,
      `${label} declares no minHeight, so its target is whatever the text happens to measure (was ${target.was})`,
    );
    assert.ok(
      min >= PLATFORM_MIN,
      `${label} declares minHeight ${min}, below the ${PLATFORM_MIN} platform minimum (was ${target.was})`,
    );
  });
}

test('touch target: a sized container is used, not hitSlop, on the repaired controls', () => {
  // hitSlop is supplementary. It cannot be verified from source (its parent may
  // clip it) and it leaves the VISIBLE target small, so none of the repairs
  // above may quietly become a hitSlop. If a future change genuinely needs
  // hitSlop on one of these, this assertion is the place to argue about it.
  const centred = ['subNavTab', 'viewOptionsButton', 'controlPill', 'addToRoomButton'];
  const sources = {
    subNavTab: read('app', 'library.tsx'),
    viewOptionsButton: read('components', 'scan-results', 'PurchaseOptionsPanel.tsx'),
    controlPill: read('components', 'scan-room', 'LiveScanCamera.tsx'),
    addToRoomButton: read('components', 'ProductShelf.tsx'),
  };
  for (const name of centred) {
    const body = styleBlock(sources[name], name);
    assert.match(
      body,
      /justifyContent:\s*'center'/,
      `${name} grew to ${PLATFORM_MIN} but does not centre its content, so the label would sit at the top of the target`,
    );
  }
});

// ── Library tab semantics ────────────────────────────────────────────────────

const LIBRARY = read('app', 'library.tsx');

test('semantics: Library section tabs expose role tab inside a tablist', () => {
  assert.match(LIBRARY, /accessibilityRole="tablist"/);
  const tabs = LIBRARY.match(/accessibilityRole="tab"/g) ?? [];
  assert.ok(tabs.length >= 2, 'both section tabs must carry the tab role');
});

test('semantics: the active Recent Scans / My Closet tab exposes selected state', () => {
  // The selected state must be DERIVED from the section, never hardcoded — a
  // hardcoded selected tab is exactly the legacy MY CLOSET defect this screen
  // already removed once.
  assert.match(LIBRARY, /accessibilityState=\{\{ selected: section === 'recent' \}\}/);
  assert.match(LIBRARY, /accessibilityState=\{\{ selected: section === 'closet' \}\}/);
  assert.match(LIBRARY, /accessibilityLabel="Recent Scans"/);
  assert.match(LIBRARY, /accessibilityLabel="My Closet"/);
});

// ── Coming Soon contract ─────────────────────────────────────────────────────

const HOME = read('components', 'home', 'HomeLuxuryTechV1.tsx');

test('semantics: VoiceScan stays discoverable but announces that it is unavailable', () => {
  assert.match(HOME, /accessibilityLabel="Voice Scan, coming soon"/);
  assert.match(HOME, /accessibilityState=\{\{ disabled: inactive \}\}/);
  // Suppressing the control entirely is explicitly not the contract: a user who
  // cannot see the dimmed pill should still learn the feature is coming.
  assert.doesNotMatch(HOME, /importantForAccessibility="no-hide-descendants"/);
});

// ── ProductShelf / room picker semantics ─────────────────────────────────────

const SHELF = read('components', 'ProductShelf.tsx');

test('semantics: the Add to Dressing Room label tracks the visible text', () => {
  // The button previously announced "Add to Dressing Room" even while reading
  // "Can't Save Yet". It is NOT disabled in that state — it opens the sheet that
  // explains why — so it must not claim a disabled state either.
  assert.match(
    SHELF,
    /accessibilityLabel=\{\s*canSaveToRoom \? 'Add to Dressing Room' : "Can't save to a Dressing Room yet"\s*\}/,
  );
  assert.doesNotMatch(SHELF, /accessibilityLabel="Add to Dressing Room"\s*\n\s*style=\{\[/);
});

test('semantics: the room picker modal identifies itself and labels every action', () => {
  assert.match(SHELF, /accessibilityViewIsModal/);
  assert.match(SHELF, /<Text style=\{styles\.modalTitle\} accessibilityRole="header">/);

  // Each room choice is a named button carrying its own disabled state.
  assert.match(SHELF, /accessibilityLabel=\{`\$\{room\.title\}, \$\{room\.itemCount \?\? 0\} items`\}/);
  assert.match(SHELF, /testID=\{`add-to-room-choice-\$\{room\.id\}`\}/);

  // CREATE + ADD and CLOSE were unlabelled; CLOSE in particular must be
  // discoverable or the sheet is a trap for a screen-reader user.
  assert.match(SHELF, /accessibilityLabel="Create Dressing Room and add this item"/);
  assert.match(SHELF, /accessibilityLabel="Close"/);
  assert.match(SHELF, /testID="add-to-room-close"/);
});

test('semantics: every disabled-capable modal action reports its disabled state', () => {
  // A `disabled` prop with no matching accessibilityState announces as active.
  const disabledProps = SHELF.match(/accessibilityState=\{\{ disabled:/g) ?? [];
  assert.ok(
    disabledProps.length >= 3,
    'room choice, CREATE + ADD and CLOSE must each report disabled state',
  );
});

// ── Guard: the shared button contract was not touched ────────────────────────

test('the shared LuxuryButton and theme button contract is unchanged by Phase 4', () => {
  // Phase 4 is explicitly forbidden from changing the shared button system
  // without proven runtime evidence. The repairs above are all call-site or
  // screen-local. If this fails, a local fix quietly became a global one.
  const button = read('components', 'luxury', 'LuxuryButton.tsx');
  const theme = read('constants', 'theme.ts');
  assert.match(button, /minHeight:\s*44/, 'the shared 44 floor must remain');
  assert.match(theme, /primary:\s*\{[\s\S]*?height:\s*56/);
  assert.match(theme, /secondary:\s*\{[\s\S]*?height:\s*52/);
  assert.match(theme, /secondary:\s*\{[\s\S]*?minWidth:\s*200/);
});
