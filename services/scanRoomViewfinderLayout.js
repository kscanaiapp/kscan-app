// Pure geometry for the Scan Room live camera viewfinder.
//
// Build 34 sized the viewfinder from window WIDTH alone
// (min(width - xl*2, 420), held to a fixed 4:5 aspect ratio) and ignored
// window HEIGHT entirely. Android rotation is unrestricted and this app also
// supports tablet/multi-window resizing, so on a short-height window (phone
// or tablet landscape, or a constrained split-screen pane) a width-derived
// viewfinder can be taller than the room actually left for the header,
// instruction card, capture button and secondary controls -- pushing the
// capture button off-screen. The live camera surface is deliberately never
// wrapped in a scroll container (a bounded capture surface, not a page), so
// this has to be solved by sizing, not by scrolling.
//
// This adds a second, height-aware candidate width using the same layout
// bookkeeping the surrounding screen already spends (SPACING tokens, the
// capture button's touch size), converted to an equivalent width through the
// fixed aspect ratio. The narrower of the two candidates wins, so height is
// always DERIVED from the chosen width -- the aspect ratio itself is never
// computed independently, and a portrait phone (never height-constrained in
// practice) keeps today's exact width-derived size.
//
// Priority when a window is height-constrained (highest first):
//   1. The capture button and secondary controls stay reachable.
//   2. The instruction card stays visible, when there is room for it.
//   3. The viewfinder keeps its 4:5 aspect ratio.
//   4. The viewfinder shrinks as far as needed to satisfy the above.
// So a window too short to fit the instruction card at a reasonable
// viewfinder size (see MIN_PREFERRED_VIEWFINDER_WIDTH) drops the card --
// secondary, informational UI -- rather than let the viewfinder push the
// capture button out of reach. Only a window shorter than the header +
// controls chrome ALONE (no viewfinder, no instructions -- unrealistic for
// any device class or split-screen pane this app targets) can still
// overflow; that is a case for device QA and further chrome collapse, not
// something this module can invent a number to solve.
//
// The reserved-chrome estimate is a static budget, not a runtime
// measurement: it assumes the shipped one-line header and a two-line
// instruction body (the observed wrap for the current copy on every device
// class this app ships to). An extreme font-scale/accessibility setting that
// grows those beyond the assumed budget is outside what static geometry can
// prove and is left to device QA (Patch 1 Section 20), not solved here by
// widening the estimate indefinitely.
'use strict';

const { MEDIA_MAX_WIDTH } = require('./responsiveLayout');

// Matches LiveScanCamera's existing viewfinderHeight = viewfinderWidth * 1.25
// (a 4:5 width:height crop).
const VIEWFINDER_ASPECT_RATIO = 1.25;

// A plain CommonJS module cannot `import` constants/theme.ts without a build
// step, so the handful of values this geometry depends on are mirrored here.
// __tests__/scanRoomViewfinderLayout.test.js cross-checks every one of them
// against the live theme/header/button source so this cannot silently drift.
const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
const CAPTURE_BUTTON_TOUCH_SIZE = 84;

// The viewfinder is centered within screenWidth - SPACING.xl on each side --
// the same horizontal allowance Build 34 used.
const VIEWFINDER_HORIZONTAL_INSET = SPACING.xl * 2;

// ScanRoomHeader: paddingTop (safe-area aware, floored at SPACING.lg) + the
// 44pt-tall title row + paddingBottom (SPACING.lg) + the divider's marginTop
// (SPACING.xs) + the "✧" divider glyph (~18pt at its 14pt font size). The
// safe-area top inset is folded in separately below, so this constant covers
// only the header's OWN content height.
const HEADER_ROW_AND_DIVIDER_HEIGHT = 44 + SPACING.lg + SPACING.xs + 18;

// Space between the header and the viewfinder wrap: its marginTop plus the
// 1.5pt border rendered on the wrap's top and bottom edges.
const VIEWFINDER_WRAP_MARGIN = SPACING.lg + 3;

// Instruction card: marginTop + vertical padding on both edges + its 1pt
// border on both edges + one title line (~17pt at its 14pt bold font) + the
// body's marginTop (SPACING.xs) + a worst-case two-line body at the card's
// explicit 20pt lineHeight. Two lines is the observed wrap for the shipped
// copy at default text size on every device class this app ships to.
const INSTRUCTION_CARD_HEIGHT = SPACING.lg + SPACING.lg * 2 + 2 + 17 + SPACING.xs + 20 * 2;

// Controls block: marginTop + the capture button + the gap above the
// secondary row + one row of 44pt-tall pill controls + the block's own
// bottom padding. This is the one piece of chrome that is never dropped --
// it IS the primary capture control this whole module exists to protect.
const CONTROLS_BLOCK_HEIGHT =
  SPACING.lg + CAPTURE_BUTTON_TOUCH_SIZE + SPACING.md + 44 + SPACING.xl;

// Below this, a viewfinder can no longer usefully frame a garment -- so a
// window that can fit at least this much AND the instruction card keeps the
// card. This is a PREFERENCE threshold (governs whether the card is shown),
// not a hard floor on the final size: see MIN_RENDER_WIDTH below for what
// still bounds the result once the card has already been dropped.
const MIN_PREFERRED_VIEWFINDER_WIDTH = 160;

// The absolute rendering floor once every optional element (the instruction
// card) is already gone: never smaller than the app's own minimum touch
// target size (44pt, used throughout constants/theme.ts), rounded up for a
// visible margin. Below this a viewfinder is not "small", it is invisible --
// and a window that cannot fit even this alongside the header and controls
// cannot fit the screen's fixed chrome at all, which is a device-class
// problem no viewfinder size can solve (see module header).
const MIN_RENDER_WIDTH = 48;

function reservedChromeHeight(options, includeInstructions) {
  const opts = options || {};
  const insetTop = Number(opts.insetTop) || 0;
  const insetBottom = Number(opts.insetBottom) || 0;
  // Mirrors ScanRoomHeader's own paddingTop formula exactly.
  const headerPaddingTop = Math.max(SPACING.lg, insetTop + SPACING.sm);
  return (
    headerPaddingTop +
    HEADER_ROW_AND_DIVIDER_HEIGHT +
    VIEWFINDER_WRAP_MARGIN +
    (includeInstructions ? INSTRUCTION_CARD_HEIGHT : 0) +
    CONTROLS_BLOCK_HEIGHT +
    insetBottom
  );
}

// Reserved chrome height assuming the instruction card is shown -- the
// normal, preferred layout. Exported so tests (and any future caller that
// wants to reason about the full-chrome case) share this module's one
// definition rather than re-deriving it.
function estimateReservedChromeHeight(options) {
  return reservedChromeHeight(options, true);
}

// widthLimitedWidth = the existing width-only candidate (screen width minus
//                      horizontal inset, capped at MEDIA_MAX_WIDTH)
// Tries the full layout (instruction card shown) first; if the height
// budget there cannot fit a reasonably-sized viewfinder, drops the card and
// retries with the smaller reserved-chrome figure. Either way, the final
// width is never larger than heightBudget / VIEWFINDER_ASPECT_RATIO, so the
// invariant `height + reservedChromeHeight(matching mode) <= windowHeight`
// holds by construction whenever the window is at least as tall as that
// mode's reserved chrome.
function computeScanRoomViewfinderSize(input) {
  const opts = input || {};
  const windowWidth = Number(opts.windowWidth) || 0;
  const windowHeight = Number(opts.windowHeight) || 0;

  const widthLimitedWidth = Math.max(
    0,
    Math.min(windowWidth - VIEWFINDER_HORIZONTAL_INSET, MEDIA_MAX_WIDTH),
  );

  const fullBudget = windowHeight - reservedChromeHeight(opts, true);
  const fullHeightLimitedWidth = fullBudget / VIEWFINDER_ASPECT_RATIO;

  if (fullHeightLimitedWidth >= MIN_PREFERRED_VIEWFINDER_WIDTH) {
    const width = Math.min(widthLimitedWidth, fullHeightLimitedWidth);
    const height = width * VIEWFINDER_ASPECT_RATIO;
    return { width, height, showInstructions: true };
  }

  // Not enough vertical room to keep the instruction card at a reasonable
  // viewfinder size: drop the card (secondary, informational UI) so the
  // capture button and secondary controls stay reachable instead.
  const compactBudget = windowHeight - reservedChromeHeight(opts, false);
  const compactHeightLimitedWidth = Math.max(MIN_RENDER_WIDTH, compactBudget / VIEWFINDER_ASPECT_RATIO);
  const width = Math.min(widthLimitedWidth, compactHeightLimitedWidth);
  const height = width * VIEWFINDER_ASPECT_RATIO;
  return { width, height, showInstructions: false };
}

module.exports = {
  VIEWFINDER_ASPECT_RATIO,
  VIEWFINDER_HORIZONTAL_INSET,
  MIN_PREFERRED_VIEWFINDER_WIDTH,
  MIN_RENDER_WIDTH,
  SPACING_MIRROR: SPACING,
  CAPTURE_BUTTON_TOUCH_SIZE_MIRROR: CAPTURE_BUTTON_TOUCH_SIZE,
  estimateReservedChromeHeight,
  computeScanRoomViewfinderSize,
};
