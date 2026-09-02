// Build 34 Android Patch 1, Defect 2 — Scan Room viewfinder ignores window
// height.
//
// WHY THIS FILE EXISTS. LiveScanCamera derived the viewfinder purely from
// window WIDTH: `Math.min(screenWidth - SPACING.xl * 2, 420)`, height always
// `width * 1.25`. Android rotation is unrestricted and this screen is never
// wrapped in a scroll container, so on a short-height window (phone or
// tablet landscape, or a constrained split-screen pane) that formula can
// size a viewfinder taller than the room actually left for the header,
// instruction card, capture button and secondary controls -- pushing the
// capture button off-screen with no way to reach it.
//
// services/scanRoomViewfinderLayout.js extracts the geometry into a pure,
// testable function so this is provable without a device: for representative
// viewport classes, this file demonstrates that Build 34's width-only
// formula would have overflowed the window, and that the height-aware repair
// does not -- and that the repair recalculates from its inputs every call
// rather than freezing geometry at whatever orientation the screen first
// mounted in.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that
// literal suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const {
  VIEWFINDER_ASPECT_RATIO,
  VIEWFINDER_HORIZONTAL_INSET,
  MIN_PREFERRED_VIEWFINDER_WIDTH,
  MIN_RENDER_WIDTH,
  SPACING_MIRROR,
  CAPTURE_BUTTON_TOUCH_SIZE_MIRROR,
  estimateReservedChromeHeight,
  computeScanRoomViewfinderSize,
} = require('../services/scanRoomViewfinderLayout.js');
const { MEDIA_MAX_WIDTH } = require('../services/responsiveLayout.js');

const THEME = read('constants', 'theme.ts');
const HEADER = read('components', 'scan-room', 'ScanRoomHeader.tsx');
const CAMERA = stripComments(read('components', 'scan-room', 'LiveScanCamera.tsx'));

// ─────────────────────── the mirrored constants must not drift ───────────

test('the mirrored SPACING values match constants/theme.ts', () => {
  for (const [key, value] of Object.entries(SPACING_MIRROR)) {
    assert.match(
      THEME,
      new RegExp(`${key}:\\s*${value}\\b`),
      `SPACING.${key} in theme.ts must still be ${value}`,
    );
  }
});

test('the mirrored capture button touch size matches CAPTURE_BUTTON.touchSize', () => {
  assert.match(THEME, new RegExp(`touchSize:\\s*${CAPTURE_BUTTON_TOUCH_SIZE_MIRROR}\\b`));
});

test('MEDIA_MAX_WIDTH (the pre-existing width cap) is unchanged and still what Build 34 hardcoded', () => {
  assert.equal(MEDIA_MAX_WIDTH, 420);
});

// The budget's header figure assumes ScanRoomHeader's exact layout; if that
// component's own chrome ever changes, this must fail loudly instead of
// silently under- or over-estimating the reserved height.
test('the header budget assumptions match the live ScanRoomHeader source', () => {
  assert.match(HEADER, /paddingTop:\s*Math\.max\(SPACING\.lg,\s*insets\.top\s*\+\s*SPACING\.sm\)/);
  assert.match(HEADER, /minHeight:\s*44/);
  assert.match(HEADER, /paddingBottom:\s*SPACING\.lg/);
  assert.match(HEADER, /marginTop:\s*SPACING\.xs/); // the divider's own marginTop
});

// The instruction-card and controls budget figures assume LiveScanCamera's
// own literal style values.
test('the instruction-card budget assumptions match the live LiveScanCamera source', () => {
  const block = CAMERA.slice(CAMERA.indexOf('instructionCard: {'), CAMERA.indexOf('instructionTitle: {'));
  assert.match(block, /borderWidth:\s*1\b/);
  assert.match(block, /padding:\s*SPACING\.lg/);
  assert.match(block, /marginTop:\s*SPACING\.lg/);
  const bodyBlock = CAMERA.slice(CAMERA.indexOf('instructionBody: {'), CAMERA.indexOf('controls: {'));
  assert.match(bodyBlock, /lineHeight:\s*20\b/);
});

test('the controls-block budget assumptions match the live LiveScanCamera source', () => {
  const block = CAMERA.slice(CAMERA.indexOf('controls: {'), CAMERA.indexOf('secondaryControls: {'));
  assert.match(block, /marginTop:\s*SPACING\.lg/);
  assert.match(block, /gap:\s*SPACING\.md/);
  assert.match(block, /paddingBottom:\s*SPACING\.xl/);
  assert.match(CAMERA, /controlPill:\s*\{[\s\S]*?minHeight:\s*44/);
});

test('the viewfinder-wrap margin assumptions match the live LiveScanCamera source', () => {
  const block = CAMERA.slice(CAMERA.indexOf('viewfinderWrap: {'), CAMERA.indexOf('cameraContainer: {'));
  assert.match(block, /marginTop:\s*SPACING\.lg/);
  assert.match(block, /borderWidth:\s*1\.5\b/);
});

// ──────────────────── representative Android viewport classes ────────────
//
// Points/dp, not raw pixels. Insets are representative (status bar / gesture
// nav / tablet chrome), not device-exact -- this is static proof of
// reasonable behavior, matching the caveat already documented in
// services/scanRoomViewfinderLayout.js, not a runtime measurement.

const PHONE_PORTRAIT = [
  { name: 'compact phone portrait 360x800', windowWidth: 360, windowHeight: 800, insetTop: 24, insetBottom: 16 },
  { name: 'phone portrait 412x915', windowWidth: 412, windowHeight: 915, insetTop: 24, insetBottom: 24 },
  { name: 'large phone portrait 430x932', windowWidth: 430, windowHeight: 932, insetTop: 28, insetBottom: 24 },
];
// Android rotation is unrestricted (unlike a portrait-locked phone), so this
// class is load-bearing for THIS authority even though a phone is never
// height-constrained in portrait.
const PHONE_LANDSCAPE = [
  { name: 'compact phone landscape 800x360', windowWidth: 800, windowHeight: 360, insetTop: 0, insetBottom: 0 },
  { name: 'phone landscape 915x412', windowWidth: 915, windowHeight: 412, insetTop: 0, insetBottom: 0 },
  { name: 'large phone landscape 932x430', windowWidth: 932, windowHeight: 430, insetTop: 0, insetBottom: 0 },
];
const TABLET_PORTRAIT = [
  { name: 'tablet portrait 800x1280', windowWidth: 800, windowHeight: 1280, insetTop: 24, insetBottom: 16 },
  { name: 'large tablet portrait 900x1600', windowWidth: 900, windowHeight: 1600, insetTop: 24, insetBottom: 16 },
];
const TABLET_LANDSCAPE = [
  { name: 'tablet landscape 1280x800', windowWidth: 1280, windowHeight: 800, insetTop: 24, insetBottom: 16 },
  { name: 'large tablet landscape 1600x900', windowWidth: 1600, windowHeight: 900, insetTop: 24, insetBottom: 16 },
];
// Android split-screen / multi-window: a short pane, at or above the
// platform's ~440dp minimum multi-window height guideline.
const CONSTRAINED_SPLIT_TABLET = [
  { name: 'split-screen tablet pane 1280x480', windowWidth: 1280, windowHeight: 480, insetTop: 0, insetBottom: 0 },
  { name: 'split-screen tablet pane 800x440', windowWidth: 800, windowHeight: 440, insetTop: 0, insetBottom: 0 },
];
const ALL_VIEWPORTS = [
  ...PHONE_PORTRAIT,
  ...PHONE_LANDSCAPE,
  ...TABLET_PORTRAIT,
  ...TABLET_LANDSCAPE,
  ...CONSTRAINED_SPLIT_TABLET,
];

// The module intentionally exports only the full-chrome estimator (the
// normal, preferred layout); re-deriving the compact delta independently
// here -- from the SAME live source values already cross-checked above,
// not by importing the module's private constant -- keeps this an
// independent check rather than the test re-stating the implementation.
const INSTRUCTION_CARD_DELTA =
  SPACING_MIRROR.lg + SPACING_MIRROR.lg * 2 + 2 + 17 + SPACING_MIRROR.xs + 20 * 2;

// ────────────────────────── 1. aspect ratio is always 4:5 ────────────────

test('the viewfinder always keeps the 4:5 aspect ratio', () => {
  for (const v of ALL_VIEWPORTS) {
    const { width, height } = computeScanRoomViewfinderSize(v);
    assert.ok(
      Math.abs(height - width * VIEWFINDER_ASPECT_RATIO) < 1e-9,
      `${v.name}: height must equal width * ${VIEWFINDER_ASPECT_RATIO}`,
    );
  }
});

// ───────────────────── 2/3. width never exceeds either ceiling ───────────

test('width never exceeds the existing intended maximum (MEDIA_MAX_WIDTH)', () => {
  for (const v of ALL_VIEWPORTS) {
    const { width } = computeScanRoomViewfinderSize(v);
    assert.ok(width <= MEDIA_MAX_WIDTH + 1e-9, `${v.name}: width ${width} > ${MEDIA_MAX_WIDTH}`);
  }
});

test('width never exceeds the horizontal viewport allowance', () => {
  for (const v of ALL_VIEWPORTS) {
    const { width } = computeScanRoomViewfinderSize(v);
    const allowance = v.windowWidth - VIEWFINDER_HORIZONTAL_INSET;
    assert.ok(width <= allowance + 1e-9, `${v.name}: width ${width} > allowance ${allowance}`);
  }
});

// ───────────── 4. THE invariant: primary controls stay in-viewport ───────

test('INVARIANT: viewfinder height + reserved chrome fits inside the window for every supported viewport class', () => {
  for (const v of ALL_VIEWPORTS) {
    const result = computeScanRoomViewfinderSize(v);
    const reserved = result.showInstructions
      ? estimateReservedChromeHeight(v)
      : estimateReservedChromeHeight(v) - INSTRUCTION_CARD_DELTA;
    assert.ok(
      result.height + reserved <= v.windowHeight + 1e-9,
      `${v.name}: viewfinder(${result.height}) + chrome(${reserved}) > window(${v.windowHeight}) -- ` +
        'the capture button would be pushed out of reach',
    );
  }
});

// ───────── 5. landscape/split classes shrink vs. the old algorithm, ──────
// ───────── and the old algorithm demonstrably overflows there ───────────

// Build 34's own formula, reproduced exactly (not imported from the module
// under test), so this proves the repair actually changes behavior for the
// hostile classes rather than merely adding an unused function.
function legacyWidthOnlySize(windowWidth) {
  const width = Math.min(windowWidth - VIEWFINDER_HORIZONTAL_INSET, MEDIA_MAX_WIDTH);
  return { width, height: width * 1.25 };
}

test('DEFECT EVIDENCE: Build 34\'s width-only formula overflows the window on every height-constrained class', () => {
  const hostileClasses = [...PHONE_LANDSCAPE, ...TABLET_LANDSCAPE, ...CONSTRAINED_SPLIT_TABLET];
  for (const v of hostileClasses) {
    const legacy = legacyWidthOnlySize(v.windowWidth);
    const reserved = estimateReservedChromeHeight(v); // Build 34 always showed the instruction card
    assert.ok(
      legacy.height + reserved > v.windowHeight,
      `${v.name}: expected the UNREPAIRED formula to overflow (it is the defect this file proves), ` +
        `but ${legacy.height} + ${reserved} <= ${v.windowHeight}`,
    );
  }
});

test('the repair produces a smaller (or equal) viewfinder than the old formula on every height-constrained class', () => {
  const hostileClasses = [...PHONE_LANDSCAPE, ...TABLET_LANDSCAPE, ...CONSTRAINED_SPLIT_TABLET];
  for (const v of hostileClasses) {
    const legacy = legacyWidthOnlySize(v.windowWidth);
    const repaired = computeScanRoomViewfinderSize(v);
    assert.ok(
      repaired.width <= legacy.width,
      `${v.name}: repaired width ${repaired.width} must not exceed the legacy width ${legacy.width}`,
    );
  }
});

// A spacious viewport must NOT be unnecessarily shrunk -- the repair should
// match Build 34's own width-derived size exactly when there is no height
// pressure at all.
test('a spacious viewport (large tablet portrait) keeps the full width-derived size, unchanged from Build 34', () => {
  const v = TABLET_PORTRAIT.find((p) => p.name === 'large tablet portrait 900x1600');
  const legacy = legacyWidthOnlySize(v.windowWidth);
  const repaired = computeScanRoomViewfinderSize(v);
  assert.ok(Math.abs(repaired.width - legacy.width) < 1e-9, 'no height pressure: sizes must match exactly');
  assert.equal(repaired.showInstructions, true);
});

// ──────────────── 6. secondary UI degrades before capture reachability ───

test('the instruction card is shown on every non-constrained viewport class', () => {
  for (const v of [...PHONE_PORTRAIT, ...TABLET_PORTRAIT, ...TABLET_LANDSCAPE]) {
    const { showInstructions } = computeScanRoomViewfinderSize(v);
    assert.equal(showInstructions, true, `${v.name}: expected the instruction card to stay visible`);
  }
});

test('the instruction card is dropped -- not the capture controls -- on the height-constrained classes', () => {
  for (const v of [...PHONE_LANDSCAPE, ...CONSTRAINED_SPLIT_TABLET]) {
    const { showInstructions } = computeScanRoomViewfinderSize(v);
    assert.equal(showInstructions, false, `${v.name}: expected the instruction card to be dropped`);
  }
});

// ───────────────── 7. geometry recalculates, it does not freeze ──────────

test('geometry recalculates from its inputs -- rotating the SAME device produces a DIFFERENT result', () => {
  const portrait = computeScanRoomViewfinderSize({ windowWidth: 412, windowHeight: 915, insetTop: 24, insetBottom: 24 });
  const landscape = computeScanRoomViewfinderSize({ windowWidth: 915, windowHeight: 412, insetTop: 0, insetBottom: 0 });
  assert.notEqual(portrait.width, landscape.width);
  assert.notEqual(portrait.height, landscape.height);
});

test('geometry recalculates on every call -- it is a pure function of its arguments, not memoized state', () => {
  const input = { windowWidth: 412, windowHeight: 915, insetTop: 24, insetBottom: 24 };
  const first = computeScanRoomViewfinderSize(input);
  const second = computeScanRoomViewfinderSize({ ...input, windowHeight: 700 });
  const third = computeScanRoomViewfinderSize(input);
  assert.notEqual(first.height, second.height, 'a smaller window must change the result');
  assert.deepEqual(first, third, 'the same input must reproduce the same result (no hidden state)');
});

// ───────────────────────── extreme minimum floor ──────────────────────────

test('MIN_RENDER_WIDTH is never below the app\'s own minimum touch target (44pt, used throughout ScanRoomHeader/controlPill)', () => {
  assert.ok(MIN_RENDER_WIDTH >= 44);
});

test('MIN_PREFERRED_VIEWFINDER_WIDTH is only a preference threshold, not a hard floor: a genuinely tiny window still returns a smaller, still-positive size', () => {
  const { width, height } = computeScanRoomViewfinderSize({
    windowWidth: 700,
    windowHeight: 330,
    insetTop: 0,
    insetBottom: 0,
  });
  assert.ok(width > 0 && height > 0);
  assert.ok(width < MIN_PREFERRED_VIEWFINDER_WIDTH);
});

// ────────────────── 8. the geometry does not depend on the camera ────────

test('the geometry hook runs BEFORE the permission check, so it never requires camera access', () => {
  const geometryCallIdx = CAMERA.indexOf('computeScanRoomViewfinderSize(');
  const permissionReturnIdx = CAMERA.indexOf('if (!permission?.granted)');
  assert.ok(geometryCallIdx > 0 && permissionReturnIdx > 0);
  assert.ok(
    geometryCallIdx < permissionReturnIdx,
    'viewfinder geometry must be computed unconditionally, before the permission-denied early return',
  );
});

test('the permission-denied branch renders its own bounded layout and never reads viewfinderWidth/Height', () => {
  const start = CAMERA.indexOf('if (!permission?.granted)');
  const end = CAMERA.indexOf('return (', CAMERA.indexOf('return (', start) + 1);
  const block = CAMERA.slice(start, end);
  assert.doesNotMatch(block, /viewfinderWidth|viewfinderHeight/, 'the permission-denied UI must not size itself off camera-only geometry');
  assert.match(block, /<EmptyStateCard/);
});
