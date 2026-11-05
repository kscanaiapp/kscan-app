// Pure responsive-layout math shared by every screen. Width-class driven —
// never keyed to a device model name — so iPhone, iPad, split-view widths,
// and future large surfaces all resolve through the same rules.
//
// Contract protected by __tests__/responsiveLayout.test.js:
// - every compact (phone) width must produce the exact legacy two-column
//   layout the accepted iPhone build shipped with;
// - regular widths gain columns and centered max-width columns instead of
//   stretching phone layouts edge to edge.
const { computeItemGridCellWidth } = require('./sharedRoomLayout');

// Below 700pt the window is "compact" and must render the certified iPhone
// experience unchanged. 700 covers every iPhone (max 440pt) with margin and
// classifies iPad narrow multitasking (~320-360pt) and half-width Split View
// (~507pt on 11", ~678pt on 13") as compact so those fall back to the
// stacked phone layout.
const REGULAR_WIDTH_BREAKPOINT = 700;

// At and above 1000pt (13-inch full screen, 11-inch landscape) grids may use
// a fourth column.
const WIDE_WIDTH_BREAKPOINT = 1000;

// Centered content column caps so very wide layouts constrain reading and
// form widths rather than stretching content edge to edge.
const CONTENT_MAX_WIDTH = 840;
const FORM_MAX_WIDTH = 560;
const CONVERSATION_MAX_WIDTH = 640;
const MODAL_MAX_WIDTH = 560;

// Fashion imagery (camera preview, capture review, hero) caps here so a
// garment is inspected at a sane size instead of being stretched or
// aspect-cropped across a full iPad width.
const MEDIA_MAX_WIDTH = 420;

// Scan results workspace (regular widths only). The result sheet widens from
// the phone-style MODAL_MAX_WIDTH column to a two-pane workspace: the scanned
// garment on the left, fashion analysis and commerce actions on the right.
// Compact widths keep the certified single-column sheet unchanged.
const RESULTS_WORKSPACE_MAX_WIDTH = 820;
// Hero media width inside the workspace's left pane (4:5 crop -> 340x425).
const RESULTS_WORKSPACE_MEDIA_WIDTH = 340;
// Minimum window width for the two-pane workspace. Below this (iPad mini
// portrait at 744pt, two-thirds Split View, any compact window) both panes
// would be squeezed under a useful size, so the single-column sheet is kept.
// 820 admits 11-inch portrait (820/834pt) and every full-screen landscape.
const RESULTS_WORKSPACE_MIN_WINDOW_WIDTH = 820;

// Height class. Phone-landscape compaction (shorter composers, tighter list
// padding) must key on a genuinely SHORT window, not on width > height: an
// iPad in landscape is wider than tall yet still has 744-1024pt of height,
// and compacting it wasted the large canvas. 500pt is above every phone in
// landscape (max ~440pt) and below every iPad landscape height (min 744pt).
const COMPACT_HEIGHT_BREAKPOINT = 500;

function getWidthClass(windowWidth) {
  const width = Number(windowWidth) || 0;
  return width >= REGULAR_WIDTH_BREAKPOINT ? 'regular' : 'compact';
}

function getHeightClass(windowHeight) {
  const height = Number(windowHeight) || 0;
  return height > 0 && height < COMPACT_HEIGHT_BREAKPOINT ? 'compact' : 'regular';
}

// Whether the results workspace (two-pane) layout applies. Requires a regular
// width AND enough room for both panes at their minimum useful size, so a
// regular-but-narrow window still gets the single-column sheet.
function usesResultsWorkspace(windowWidth) {
  const width = Number(windowWidth) || 0;
  return getWidthClass(width) === 'regular' && width >= RESULTS_WORKSPACE_MIN_WINDOW_WIDTH;
}

// Horizontal inset that centers a stretch-aligned block at maxWidth on wide
// windows while keeping the certified minimum inset everywhere else. Used by
// surfaces whose cards are laid out with alignSelf 'stretch' + margins (the
// Scan Room), where a plain maxWidth would pin the card to the left edge.
// Phones: (width - maxWidth) / 2 is negative, so minInset is returned
// unchanged.
function getCenteredHorizontalInset(windowWidth, maxWidth = MODAL_MAX_WIDTH, minInset = 0) {
  const width = Number(windowWidth) || 0;
  const cap = Number(maxWidth) || MODAL_MAX_WIDTH;
  const floor = Number(minInset) || 0;
  return Math.max(floor, Math.floor((width - cap) / 2));
}

// Column count for fashion-imagery grids. Compact keeps the legacy two
// columns; regular gains a third; wide layouts a fourth.
function getGridColumns(windowWidth, options = {}) {
  const width = Number(windowWidth) || 0;
  const compact = Number(options.compactColumns) || 2;
  const regular = Number(options.regularColumns) || 3;
  const wide = Number(options.wideColumns) || 4;
  if (width >= WIDE_WIDTH_BREAKPOINT) return wide;
  if (width >= REGULAR_WIDTH_BREAKPOINT) return regular;
  return compact;
}

// Effective layout width for a centered content column: the window width on
// compact, capped at maxWidth on regular so grid cells never overflow the
// centered column they render inside.
function getContentWidth(windowWidth, maxWidth = CONTENT_MAX_WIDTH) {
  const width = Number(windowWidth) || 0;
  if (getWidthClass(width) === 'compact') return width;
  return Math.min(width, Number(maxWidth) || CONTENT_MAX_WIDTH);
}

// Grid cell width inside the effective content column. Delegates to the
// shared-room math so there is exactly one cell-width formula in the app.
function computeGridCellWidth(containerWidth, options = {}) {
  return computeItemGridCellWidth(containerWidth, options);
}

// Regression-safe grid cell width for the certified two-column phone grids.
//
// Compact widths reproduce the legacy module-scope formula bit-for-bit
// (floor((window - hPad*2 - gap) / 2)) so every accepted iPhone layout is
// unchanged. Regular widths gain columns and size cells from the centered
// content column, subtracting any wrapper chrome padding (e.g. LuxuryScreen's
// horizontal padding) so cells always fit without wrapping artifacts.
function getResponsiveGridCellWidth(windowWidth, options = {}) {
  const width = Number(windowWidth) || 0;
  const horizontalPadding = Number(options.horizontalPadding) || 0;
  const gap = Number(options.gap) || 0;
  if (getWidthClass(width) === 'compact') {
    return computeItemGridCellWidth(width, { horizontalPadding, gap, columns: 2 });
  }
  const chromePadding = Number(options.chromePadding) || 0;
  const columns = Number(options.columns) || getGridColumns(width, options);
  const container = getContentWidth(width) - chromePadding * 2;
  return computeItemGridCellWidth(container, { horizontalPadding, gap, columns });
}

module.exports = {
  REGULAR_WIDTH_BREAKPOINT,
  WIDE_WIDTH_BREAKPOINT,
  CONTENT_MAX_WIDTH,
  FORM_MAX_WIDTH,
  CONVERSATION_MAX_WIDTH,
  MODAL_MAX_WIDTH,
  MEDIA_MAX_WIDTH,
  RESULTS_WORKSPACE_MAX_WIDTH,
  RESULTS_WORKSPACE_MEDIA_WIDTH,
  RESULTS_WORKSPACE_MIN_WINDOW_WIDTH,
  COMPACT_HEIGHT_BREAKPOINT,
  getWidthClass,
  getHeightClass,
  usesResultsWorkspace,
  getCenteredHorizontalInset,
  getGridColumns,
  getContentWidth,
  computeGridCellWidth,
  getResponsiveGridCellWidth,
};
