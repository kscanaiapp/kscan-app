// P1-02 (Build 35 Patch 1) — the Scan Room live camera viewfinder must
// respect the available window HEIGHT, not just width.
//
// WHY THIS FILE EXISTS. Build 34 derived the viewfinder purely from window
// width: `Math.min(screenWidth - SPACING.xl * 2, 420)`, height always
// `width * 1.25`. On short-height windows -- iPad landscape chief among
// them, since Build 34 deliberately supports all four iPad orientations --
// that produces a viewfinder taller than the room actually left after the
// header, instruction card, capture button and secondary controls, pushing
// those lower controls off-screen with no way to reach them.
//
// services/scanRoomViewfinderLayout.js extracts the geometry into a pure,
// testable function so this is provable without a device: for each
// representative viewport class, this file demonstrates that Build 34's
// width-only formula would have overflowed the window, and that the
// height-aware repair does not.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that
// literal suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const {
  VIEWFINDER_ASPECT_RATIO,
  VIEWFINDER_HORIZONTAL_INSET,
  MIN_VIEWFINDER_WIDTH,
  SPACING_MIRROR,
  CAPTURE_BUTTON_TOUCH_SIZE_MIRROR,
  estimateReservedChromeHeight,
  computeScanRoomViewfinderSize,
} = require('../services/scanRoomViewfinderLayout.js');
const { MEDIA_MAX_WIDTH } = require('../services/responsiveLayout.js');

// Build 34's own formula, reproduced exactly, so we can prove the repair
// actually changes (and fixes) behavior rather than just adding an unused
// function.
function legacyWidthOnlySize(windowWidth) {
  const width = Math.min(windowWidth - VIEWFINDER_HORIZONTAL_INSET, MEDIA_MAX_WIDTH);
  return { width, height: width * 1.25 };
}

// Representative viewport classes from the Build 35 Patch 1 acceptance
// matrix. Insets are representative (status bar / home indicator / iPad
// rounded-corner allowances), not device-exact -- this is static proof of
// reasonable behavior, not a runtime measurement (the task explicitly does
// not claim pixel-perfect runtime validation from static tests).
const PHONE_PORTRAIT = [
  { name: 'iPhone SE 375x667', windowWidth: 375, windowHeight: 667, insetTop: 20, insetBottom: 0 },
  { name: 'iPhone 390x844', windowWidth: 390, windowHeight: 844, insetTop: 47, insetBottom: 34 },
  { name: 'iPhone Pro Max 430x932', windowWidth: 430, windowHeight: 932, insetTop: 59, insetBottom: 34 },
];
const IPAD_PORTRAIT = [
  { name: 'iPad 11in portrait 768x1024', windowWidth: 768, windowHeight: 1024, insetTop: 24, insetBottom: 20 },
  { name: 'iPad 10.9in portrait 834x1194', windowWidth: 834, windowHeight: 1194, insetTop: 24, insetBottom: 20 },
];
const IPAD_LANDSCAPE = [
  { name: 'iPad 11in landscape 1024x768', windowWidth: 1024, windowHeight: 768, insetTop: 24, insetBottom: 20 },
  { name: 'iPad 10.9in landscape 1194x834', windowWidth: 1194, windowHeight: 834, insetTop: 24, insetBottom: 20 },
  { name: 'iPad 12.9in landscape 1366x1024', windowWidth: 1366, windowHeight: 1024, insetTop: 24, insetBottom: 20 },
];
const ALL_VIEWPORTS = [...PHONE_PORTRAIT, ...IPAD_PORTRAIT, ...IPAD_LANDSCAPE];

// ──────────────────────────────────── 1. aspect ratio is always 4:5 ──────

test('P1-02: the viewfinder always keeps the 4:5 aspect ratio', () => {
  for (const v of ALL_VIEWPORTS) {
    const { width, height } = computeScanRoomViewfinderSize(v);
    assert.ok(
      Math.abs(height - width * VIEWFINDER_ASPECT_RATIO) < 1e-9,
      `${v.name}: height must equal width * ${VIEWFINDER_ASPECT_RATIO}`,
    );
  }
});

// ──────────────────────── 2/3. width never exceeds either ceiling ────────

test('P1-02: width never exceeds the existing intended maximum (MEDIA_MAX_WIDTH)', () => {
  for (const v of ALL_VIEWPORTS) {
    const { width } = computeScanRoomViewfinderSize(v);
    assert.ok(width <= MEDIA_MAX_WIDTH + 1e-9, `${v.name}: width ${width} > ${MEDIA_MAX_WIDTH}`);
  }
});

test('P1-02: width never exceeds the horizontal viewport allowance', () => {
  for (const v of ALL_VIEWPORTS) {
    const { width } = computeScanRoomViewfinderSize(v);
    const allowance = v.windowWidth - VIEWFINDER_HORIZONTAL_INSET;
    assert.ok(width <= allowance + 1e-9, `${v.name}: width ${width} > allowance ${allowance}`);
  }
});

// ────────────────────── 4. height leaves a valid vertical budget ─────────

test('P1-02: camera height + reserved chrome fits inside the window for every supported viewport', () => {
  for (const v of ALL_VIEWPORTS) {
    const { height } = computeScanRoomViewfinderSize(v);
    const reserved = estimateReservedChromeHeight(v);
    assert.ok(
      height + reserved <= v.windowHeight + 1e-9,
      `${v.name}: viewfinder(${height}) + chrome(${reserved}) > window(${v.windowHeight})`,
    );
  }
});

// ───────────────── 5. iPad landscape shrinks vs. the old algorithm ───────

test('P1-02: iPad landscape gets a SMALLER viewfinder than Build 34\'s width-only algorithm, and the old one would have overflowed', () => {
  // Only the 11in/10.9in classes are height-constrained in landscape; the
  // 12.9in class has enough height to keep the full intended size even in
  // landscape (that "not unnecessarily tiny" case is asserted separately
  // below), so it is deliberately excluded from the "must shrink" claim.
  const constrainedLandscape = IPAD_LANDSCAPE.filter((v) => v.name !== 'iPad 12.9in landscape 1366x1024');
  assert.equal(constrainedLandscape.length, 2);
  for (const v of constrainedLandscape) {
    const repaired = computeScanRoomViewfinderSize(v);
    const legacy = legacyWidthOnlySize(v.windowWidth);
    const reserved = estimateReservedChromeHeight(v);

    assert.ok(repaired.height < legacy.height, `${v.name}: repaired height must be smaller than legacy`);
    assert.ok(
      legacy.height + reserved > v.windowHeight,
      `${v.name}: legacy Build 34 geometry must overflow the window (demonstrating the defect)`,
    );
    assert.ok(
      repaired.height + reserved <= v.windowHeight + 1e-9,
      `${v.name}: repaired geometry must fit the window (demonstrating the fix)`,
    );
  }
});

// ─────────────────────── 6. short-height iPhones remain usable ───────────

test('P1-02: short-height iPhones remain usable (bounded but not floored)', () => {
  for (const v of PHONE_PORTRAIT) {
    const { width } = computeScanRoomViewfinderSize(v);
    assert.ok(width > MIN_VIEWFINDER_WIDTH, `${v.name}: width ${width} should be well above the emergency floor`);
  }
});

// ───────────────────── 7. large iPads are not unnecessarily tiny ─────────

test('P1-02: large iPads (ample height) keep the full intended viewfinder size', () => {
  for (const v of [...IPAD_PORTRAIT, IPAD_LANDSCAPE[2]]) {
    const { width } = computeScanRoomViewfinderSize(v);
    assert.equal(width, MEDIA_MAX_WIDTH, `${v.name}: should not be shrunk when height is ample`);
  }
});

// ───────────────────────── 8. dimension changes recompute geometry ───────

test('P1-02: rotating the device (dimension change) recomputes different geometry', () => {
  // The 11in iPad rotation pair: portrait has ample height (stays at the
  // intended max), landscape is height-constrained -- a rotation where the
  // geometry must actually differ, not just get recomputed to the same value.
  const portrait = computeScanRoomViewfinderSize({ windowWidth: 768, windowHeight: 1024, insetTop: 24, insetBottom: 20 });
  const landscape = computeScanRoomViewfinderSize({ windowWidth: 1024, windowHeight: 768, insetTop: 24, insetBottom: 20 });
  assert.notEqual(portrait.width, landscape.width);
  assert.notEqual(portrait.height, landscape.height);
});

// ─────────────── extreme short window: floor engages, never negative ─────

test('P1-02: an extreme short-height multitasking window is floored, never collapses to zero or negative', () => {
  const { width, height } = computeScanRoomViewfinderSize({
    windowWidth: 320,
    windowHeight: 400,
    insetTop: 0,
    insetBottom: 0,
  });
  assert.equal(width, MIN_VIEWFINDER_WIDTH);
  assert.ok(height > 0);
  // Even the floor must never claim more width than the screen allows.
  assert.ok(width <= 320 - VIEWFINDER_HORIZONTAL_INSET + 1e-9);
});

// ── budget constants mirrored from constants/theme.ts must not drift ──────

function loadTheme() {
  const source = read('constants/theme.ts');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier === 'react-native') return { Platform: { OS: 'ios', select: (o) => o.ios } };
      throw new Error(`Unexpected import in constants/theme.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: 'theme.ts' }).runInContext(sandbox);
  return mod.exports;
}

test('P1-02: the mirrored SPACING/CAPTURE_BUTTON constants match the live theme tokens', () => {
  const theme = loadTheme();
  for (const key of Object.keys(SPACING_MIRROR)) {
    assert.equal(SPACING_MIRROR[key], theme.SPACING[key], `SPACING.${key} mirror is out of date`);
  }
  assert.equal(CAPTURE_BUTTON_TOUCH_SIZE_MIRROR, theme.CAPTURE_BUTTON.touchSize);
});

// ──────────────── 9/10. permission + capture state machine untouched ─────

const CAMERA_SOURCE = 'components/scan-room/LiveScanCamera.tsx';

test('P1-02: camera permission handling is unchanged', () => {
  const source = stripComments(read(CAMERA_SOURCE));
  assert.match(source, /const \[permission, requestPermission\] = useCameraPermissions\(\);/);
  assert.match(source, /if \(!permission\?\.granted\) \{/);
  assert.match(source, /permission\?\.canAskAgain \? 'Allow Camera' : 'Open Settings'/);
  assert.match(source, /permission\?\.canAskAgain \? requestPermission : \(\) => \{ void Linking\.openSettings\(\); \}/);
});

test('P1-02: the capture/analyze state machine is unchanged', () => {
  const source = stripComments(read(CAMERA_SOURCE));
  assert.match(source, /disabled=\{!isCameraReady \|\| isCapturing \|\| isAnalyzing\}/);
  assert.match(source, /testID="scan-room-capture-button"/);
  assert.match(source, /\{\(isCapturing \|\| isAnalyzing\) && \(/);
  assert.match(source, /\{isAnalyzing \? 'Analyzing your look…' : 'Capturing…'\}/);
});

test('P1-02: the CameraView wiring (ref, facing, onCameraReady) is unchanged', () => {
  const source = stripComments(read(CAMERA_SOURCE));
  assert.match(source, /<CameraView\s+style=\{styles\.camera\}\s+ref=\{cameraRef\}\s+facing="back"\s+onCameraReady=\{onCameraReady\}\s*\/>/);
});

// ──────────────────── the geometry is actually wired into the component ──

test('P1-02: LiveScanCamera derives its viewfinder from computeScanRoomViewfinderSize, not a width-only formula', () => {
  const source = stripComments(read(CAMERA_SOURCE));
  assert.match(
    source,
    /import \{ computeScanRoomViewfinderSize \} from '\.\.\/\.\.\/services\/scanRoomViewfinderLayout';/,
  );
  assert.doesNotMatch(
    source,
    /Math\.min\(screenWidth - SPACING\.xl \* 2, 420\)/,
    'the width-only Build 34 formula must not still be the source of viewfinder size',
  );
  assert.match(source, /windowHeight: screenHeight/, 'window height must be passed into the geometry function');
});
