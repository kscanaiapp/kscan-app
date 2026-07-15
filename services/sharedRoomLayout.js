// Pure grid-cell width math for the shared-room item grid. Kept independent
// of transported item count: the number of items never controls column
// width, only how many rows the fixed-width cells wrap into.
function computeItemGridCellWidth(screenWidth, options = {}) {
  const width = Number(screenWidth) || 0;
  const horizontalPadding = Number(options.horizontalPadding) || 0;
  const gap = Number(options.gap) || 0;
  const columns = Number(options.columns) || 2;

  const available = width - horizontalPadding * 2 - gap * (columns - 1);
  return Math.max(0, Math.floor(available / columns));
}

module.exports = {
  computeItemGridCellWidth,
};
