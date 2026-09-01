// Pure geometry for the Scan Room live camera viewfinder.
//
// Build 34 derived the viewfinder size from window WIDTH alone (capped at
// MEDIA_MAX_WIDTH, held to a fixed 4:5 aspect ratio). On short-height
// windows -- iPad landscape chief among them, since Build 34 supports all
// four iPad orientations -- a width-only 420x525 viewfinder can be taller
// than the space actually left after the header, instruction card, capture
// button and secondary controls, pushing the lower controls off-screen.
//
// This module adds a height-aware second constraint using the same budget
// bookkeeping the surrounding layout already spends (SPACING tokens,
// CAPTURE_BUTTON size): a maximum viewfinder height derived from the window
// height minus that reserved chrome, converted to an equivalent width via
// the aspect ratio. The narrower of the two width candidates wins, so the
// aspect ratio is never broken -- height is always derived from the chosen
// width, never computed independently.
//
// These budgets are STATIC estimates, not runtime measurements: they do not
// account for Dynamic Type or unusual text wraps growing the instruction
// card or header beyond the two-line worst case assumed below. They are
// deliberately conservative (see INSTRUCTION_CARD_HEIGHT) so normal Dynamic
// Type sizes stay inside budget; an extreme Dynamic Type setting is outside
// what static analysis can prove and is a case for device QA, not this
// module. See §7 of the Build 35 Patch 1 change control: if device QA ever
// finds that guess insufficient, the fallback is a scrollable Scan Room
// surface, not a larger static budget here.
'use strict';

const { MEDIA_MAX_WIDTH } = require('./responsiveLayout');

// 4:5 (width:height), matching Build 34's viewfinderHeight = width * 1.25.
const VIEWFINDER_ASPECT_RATIO = 1.25;

// Mirrors constants/theme.ts SPACING. A plain-JS module cannot import that
// .ts file without a build step, so these literals are duplicated here.
// __tests__/scanRoomViewfinderLayout.test.js cross-checks them against the
// live theme module so they cannot silently drift.
const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
// Mirrors constants/theme.ts CAPTURE_BUTTON.touchSize.
const CAPTURE_BUTTON_TOUCH_SIZE = 84;

// Horizontal inset the viewfinder is centered within: screenWidth - xl*2,
// the same formula Build 34 used.
const VIEWFINDER_HORIZONTAL_INSET = SPACING.xl * 2;

// ScanRoomHeader content height below its own safe-area-aware top padding:
// the row (minHeight 44) + the header's own bottom padding (SPACING.lg) +
// the divider's top margin (SPACING.xs) + the "✧" divider line (~18pt at
// its 14pt font size).
const HEADER_CONTENT_HEIGHT = 44 + SPACING.lg + SPACING.xs + 18;

// Space between the header and the viewfinder: the wrap's own marginTop
// plus its 1.5pt border on the top and bottom edges.
const VIEWFINDER_TOP_MARGIN = SPACING.lg + 3;

// Instruction card: its marginTop + vertical padding on both edges + its
// 1pt border on both edges + a single title line (~17pt at 14pt font) + the
// body's own marginTop (SPACING.xs) + a worst-case two-line body at the
// card's explicit lineHeight of 20 (13pt font). Two lines is the observed
// wrap for the shipped copy on every phone width; wide iPads that wrap to
// one line simply end up with extra unused (safe) budget.
const INSTRUCTION_CARD_HEIGHT = SPACING.lg + SPACING.lg * 2 + 2 + 17 + SPACING.xs + 20 * 2;

// Controls block: its own marginTop + the capture button + the gap before
// the secondary row + one row of 44pt-tall pill controls + the block's own
// bottom padding (SPACING.xl).
const CONTROLS_HEIGHT = SPACING.lg + CAPTURE_BUTTON_TOUCH_SIZE + SPACING.md + 44 + SPACING.xl;

// Never collapse the viewfinder below a size that can still frame a
// garment. Only binds on multitasking splits far shorter than any device
// class this app supports; the horizontal-allowance clamp below still wins
// when even this floor would exceed the width available.
const MIN_VIEWFINDER_WIDTH = 160;

function estimateReservedChromeHeight(options) {
  const opts = options || {};
  const insetTop = Number(opts.insetTop) || 0;
  const insetBottom = Number(opts.insetBottom) || 0;
  const headerPaddingTop = Math.max(SPACING.lg, insetTop + SPACING.sm);
  return (
    headerPaddingTop +
    HEADER_CONTENT_HEIGHT +
    VIEWFINDER_TOP_MARGIN +
    INSTRUCTION_CARD_HEIGHT +
    CONTROLS_HEIGHT +
    insetBottom
  );
}

// widthLimitedSize = existing width-derived maximum
// heightBudget = windowHeight - header/control/instruction/spacing/safe-area budget
// heightLimitedWidth = heightBudget / VIEWFINDER_ASPECT_RATIO
// viewfinderWidth = min(widthLimitedSize, heightLimitedWidth)
// viewfinderHeight = viewfinderWidth * VIEWFINDER_ASPECT_RATIO
function computeScanRoomViewfinderSize(options) {
  const opts = options || {};
  const windowWidth = Number(opts.windowWidth) || 0;
  const windowHeight = Number(opts.windowHeight) || 0;

  const widthLimitedSize = Math.max(
    0,
    Math.min(windowWidth - VIEWFINDER_HORIZONTAL_INSET, MEDIA_MAX_WIDTH),
  );

  const reservedHeight = estimateReservedChromeHeight(opts);
  const heightBudget = windowHeight - reservedHeight;
  // Floor first, THEN clamp to the width allowance -- so an extreme
  // short-height window never produces a viewfinder wider than the screen
  // allows, even once the floor has kicked in.
  const heightLimitedWidth = Math.max(MIN_VIEWFINDER_WIDTH, heightBudget / VIEWFINDER_ASPECT_RATIO);

  const width = Math.min(widthLimitedSize, heightLimitedWidth);
  const height = width * VIEWFINDER_ASPECT_RATIO;

  return { width, height };
}

module.exports = {
  VIEWFINDER_ASPECT_RATIO,
  VIEWFINDER_HORIZONTAL_INSET,
  MIN_VIEWFINDER_WIDTH,
  SPACING_MIRROR: SPACING,
  CAPTURE_BUTTON_TOUCH_SIZE_MIRROR: CAPTURE_BUTTON_TOUCH_SIZE,
  estimateReservedChromeHeight,
  computeScanRoomViewfinderSize,
};
