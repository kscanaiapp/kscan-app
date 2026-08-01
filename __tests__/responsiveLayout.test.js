const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REGULAR_WIDTH_BREAKPOINT,
  WIDE_WIDTH_BREAKPOINT,
  CONTENT_MAX_WIDTH,
  FORM_MAX_WIDTH,
  CONVERSATION_MAX_WIDTH,
  MODAL_MAX_WIDTH,
  getWidthClass,
  getGridColumns,
  getContentWidth,
  getResponsiveGridCellWidth,
} = require('../services/responsiveLayout');

// Window widths in points. Compact = every iPhone plus iPad narrow/half-width
// multitasking. Regular = iPad windows wide enough for a richer layout.
const IPHONE_WIDTHS = [320, 375, 390, 393, 414, 428, 430, 440];
const IPAD_NARROW_MULTITASKING_WIDTHS = [320, 375]; // Slide Over / narrow Split View
const IPAD_HALF_WIDTH_MULTITASKING = [507, 512, 639, 678]; // ~half of 11" / 13"
const IPAD_PORTRAIT_WIDTHS = [744, 768, 810, 820, 834]; // mini, 11", 13" portrait
const IPAD_LANDSCAPE_WIDTHS = [1024, 1080, 1133, 1180, 1194, 1210, 1366];

const H_PAD = 24; // SPACING.xl
const GAP = 12; // SPACING.md
const CHROME = 16; // SPACING.lg — LuxuryScreen horizontal padding

// The exact module-scope formula the accepted iPhone build shipped with.
function legacyPhoneCardWidth(screenWidth) {
  return Math.floor((screenWidth - H_PAD * 2 - GAP) / 2);
}

function responsiveCardWidth(windowWidth) {
  return getResponsiveGridCellWidth(windowWidth, {
    horizontalPadding: H_PAD,
    gap: GAP,
    chromePadding: CHROME,
  });
}

// ── Width classification ────────────────────────────────────────────────────

test('every iPhone width classifies as compact', () => {
  for (const width of IPHONE_WIDTHS) {
    assert.equal(getWidthClass(width), 'compact', `${width}pt must be compact`);
  }
});

test('iPad portrait and landscape widths classify as regular', () => {
  for (const width of [...IPAD_PORTRAIT_WIDTHS, ...IPAD_LANDSCAPE_WIDTHS]) {
    assert.equal(getWidthClass(width), 'regular', `${width}pt must be regular`);
  }
});

test('narrow and half-width multitasking fall back to the compact phone layout', () => {
  for (const width of [...IPAD_NARROW_MULTITASKING_WIDTHS, ...IPAD_HALF_WIDTH_MULTITASKING]) {
    assert.equal(getWidthClass(width), 'compact', `${width}pt multitasking must be compact`);
  }
});

test('the breakpoint is exact and monotonic — no width straddles both classes', () => {
  assert.equal(getWidthClass(REGULAR_WIDTH_BREAKPOINT - 1), 'compact');
  assert.equal(getWidthClass(REGULAR_WIDTH_BREAKPOINT), 'regular');
  let seenRegular = false;
  for (let width = 0; width <= 1600; width += 1) {
    const widthClass = getWidthClass(width);
    if (widthClass === 'regular') seenRegular = true;
    if (seenRegular) {
      assert.equal(widthClass, 'regular', `width class must not revert to compact at ${width}pt`);
    }
  }
});

test('degenerate widths never crash and resolve to the safe compact layout', () => {
  for (const width of [0, -1, NaN, undefined, null]) {
    assert.equal(getWidthClass(width), 'compact');
  }
});

// ── iPhone regression protection ────────────────────────────────────────────

test('compact grid cell width is bit-identical to the certified iPhone formula', () => {
  for (const width of IPHONE_WIDTHS) {
    assert.equal(
      responsiveCardWidth(width),
      legacyPhoneCardWidth(width),
      `iPhone layout must be unchanged at ${width}pt`,
    );
  }
});

test('compact layout always yields exactly two columns', () => {
  for (const width of [...IPHONE_WIDTHS, ...IPAD_HALF_WIDTH_MULTITASKING]) {
    assert.equal(getGridColumns(width), 2, `${width}pt must stay two-column`);
  }
});

test('compact content width is the full window — no phone-side max-width cap', () => {
  for (const width of IPHONE_WIDTHS) {
    assert.equal(getContentWidth(width), width);
  }
});

// ── Regular-width behavior ──────────────────────────────────────────────────

test('regular widths gain a third column and wide widths a fourth', () => {
  for (const width of IPAD_PORTRAIT_WIDTHS) {
    assert.equal(getGridColumns(width), 3, `${width}pt portrait iPad expects 3 columns`);
  }
  for (const width of IPAD_LANDSCAPE_WIDTHS) {
    assert.equal(getGridColumns(width), 4, `${width}pt landscape iPad expects 4 columns`);
  }
  assert.equal(getGridColumns(WIDE_WIDTH_BREAKPOINT - 1), 3);
  assert.equal(getGridColumns(WIDE_WIDTH_BREAKPOINT), 4);
});

test('regular layouts constrain content rather than stretching edge to edge', () => {
  for (const width of [...IPAD_PORTRAIT_WIDTHS, ...IPAD_LANDSCAPE_WIDTHS]) {
    const contentWidth = getContentWidth(width);
    assert.ok(
      contentWidth <= CONTENT_MAX_WIDTH,
      `${width}pt content column must be capped at ${CONTENT_MAX_WIDTH}pt, got ${contentWidth}`,
    );
    if (width > CONTENT_MAX_WIDTH) {
      assert.equal(
        contentWidth,
        CONTENT_MAX_WIDTH,
        `${width}pt exceeds the cap and must not use the full window width`,
      );
    }
  }
});

test('every iPad landscape width is actively constrained, never full-bleed', () => {
  for (const width of IPAD_LANDSCAPE_WIDTHS) {
    assert.ok(
      getContentWidth(width) < width,
      `${width}pt landscape must render a narrower centered column than the window`,
    );
  }
});

test('regular grid cells stay positive and fit inside the content column', () => {
  for (const width of [...IPAD_PORTRAIT_WIDTHS, ...IPAD_LANDSCAPE_WIDTHS]) {
    const columns = getGridColumns(width);
    const cellWidth = responsiveCardWidth(width);
    assert.ok(cellWidth > 0, `cell width must be positive at ${width}pt`);
    const rowWidth = cellWidth * columns + GAP * (columns - 1);
    const available = getContentWidth(width) - CHROME * 2 - H_PAD * 2;
    assert.ok(
      rowWidth <= available,
      `${columns} cells (${rowWidth}pt) must fit the ${available}pt content row at ${width}pt`,
    );
  }
});

test('regular-width layout is genuinely different, not a stretched phone layout', () => {
  // A stretched phone layout would keep two columns and simply widen each
  // cell. Regular width must add columns instead.
  for (const width of [...IPAD_PORTRAIT_WIDTHS, ...IPAD_LANDSCAPE_WIDTHS]) {
    assert.ok(getGridColumns(width) > 2, `${width}pt must not remain a two-column phone grid`);
    assert.notEqual(
      responsiveCardWidth(width),
      legacyPhoneCardWidth(width),
      `${width}pt must not reuse the phone cell width`,
    );
  }
});

// ── Readable-width caps ─────────────────────────────────────────────────────

test('reading, form, conversation, and modal caps are ordered and phone-inert', () => {
  const widestPhone = Math.max(...IPHONE_WIDTHS);
  for (const [name, cap] of [
    ['form', FORM_MAX_WIDTH],
    ['conversation', CONVERSATION_MAX_WIDTH],
    ['modal', MODAL_MAX_WIDTH],
    ['content', CONTENT_MAX_WIDTH],
  ]) {
    assert.ok(cap > widestPhone, `${name} cap (${cap}) must exceed the widest phone (${widestPhone})`);
  }
  assert.ok(FORM_MAX_WIDTH <= CONVERSATION_MAX_WIDTH);
  assert.ok(CONVERSATION_MAX_WIDTH <= CONTENT_MAX_WIDTH);
  assert.ok(MODAL_MAX_WIDTH < Math.min(...IPAD_PORTRAIT_WIDTHS));
});

// ── Transition safety ───────────────────────────────────────────────────────

test('layout is a pure function of width — repeated calls never drift', () => {
  const sequence = [390, 1024, 390, 834, 507, 1366, 390];
  const byWidth = new Map();
  for (const width of sequence) {
    const snapshot = JSON.stringify({
      widthClass: getWidthClass(width),
      columns: getGridColumns(width),
      contentWidth: getContentWidth(width),
      cellWidth: responsiveCardWidth(width),
    });
    if (byWidth.has(width)) {
      assert.equal(snapshot, byWidth.get(width), `layout at ${width}pt must be deterministic`);
    }
    byWidth.set(width, snapshot);
  }
});

test('rotating an iPad both ways returns to the original layout', () => {
  const portrait = 834;
  const landscape = 1194;
  const before = responsiveCardWidth(portrait);
  responsiveCardWidth(landscape);
  assert.equal(responsiveCardWidth(portrait), before);
});

test('resizing across the breakpoint in both directions is symmetric', () => {
  const compact = 507;
  const regular = 1024;
  const compactFirst = [responsiveCardWidth(compact), responsiveCardWidth(regular)];
  const regularFirst = [responsiveCardWidth(regular), responsiveCardWidth(compact)];
  assert.equal(compactFirst[0], regularFirst[1]);
  assert.equal(compactFirst[1], regularFirst[0]);
});

test('layout math takes no domain input — data can never influence the grid', () => {
  const baseline = responsiveCardWidth(1024);
  const withStrayDomainState = getResponsiveGridCellWidth(1024, {
    horizontalPadding: H_PAD,
    gap: GAP,
    chromePadding: CHROME,
    itemCount: 137,
    actorId: 'actor-b',
    scanId: 'local:abc',
  });
  assert.equal(baseline, withStrayDomainState);
});
