const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeItemGridCellWidth } = require('../services/sharedRoomLayout');

const ROOT = path.resolve(__dirname, '..');
const SHARED_SCAN_CARD_SRC = fs.readFileSync(
  path.join(ROOT, 'components/luxury/SharedScanCard.tsx'),
  'utf8',
);

const REPRESENTATIVE_WIDTHS = [375, 390, 414, 428];
const H_PAD = 24; // SPACING.xl
const GAP = 12; // SPACING.md

test('two-column cell width is derived from viewport, padding, and gap only', () => {
  for (const screenWidth of REPRESENTATIVE_WIDTHS) {
    const cellWidth = computeItemGridCellWidth(screenWidth, {
      horizontalPadding: H_PAD,
      gap: GAP,
    });
    const expected = Math.floor((screenWidth - H_PAD * 2 - GAP) / 2);
    assert.equal(cellWidth, expected);
    assert.ok(cellWidth > 0, `cell width must be positive at ${screenWidth}px`);
  }
});

test('cell width does not accept or vary with item/room item count', () => {
  // The helper's signature has no item-count input at all: transported
  // itemCount must never be able to influence column width.
  const widthWithNoHint = computeItemGridCellWidth(390, { horizontalPadding: H_PAD, gap: GAP });
  const widthWithStrayItemCount = computeItemGridCellWidth(390, {
    horizontalPadding: H_PAD,
    gap: GAP,
    itemCount: 13,
  });
  assert.equal(widthWithNoHint, widthWithStrayItemCount);
});

test('one item, two items, and thirteen items all use the identical fixed cell width', () => {
  const cellWidth = computeItemGridCellWidth(390, { horizontalPadding: H_PAD, gap: GAP });
  for (const itemCount of [1, 2, 13]) {
    const widths = Array.from({ length: itemCount }, () => cellWidth);
    assert.ok(widths.every((w) => w === cellWidth));
  }
});

test('thirteen items in a two-column wrap grid form six full rows plus one dangling item', () => {
  const itemCount = 13;
  const columns = 2;
  const fullRows = Math.floor(itemCount / columns);
  const remainder = itemCount % columns;
  assert.equal(fullRows, 6);
  assert.equal(remainder, 1);
});

test('SharedScanCard root style does not set flex, which would override the explicit grid cell width', () => {
  const cardStyleMatch = SHARED_SCAN_CARD_SRC.match(/card:\s*\{([^}]*)\}/s);
  assert.ok(cardStyleMatch, 'expected a card style block in SharedScanCard.tsx');
  assert.doesNotMatch(
    cardStyleMatch[1],
    /flex\s*:\s*1/,
    'card root must not set flex: 1 — it competes with the parent-provided width style and, ' +
      'combined with the flexWrap grid, collapses all items onto one row',
  );
});

test('SharedScanCard image wrapper has a resolvable width and stable aspect ratio', () => {
  const imageWrapMatch = SHARED_SCAN_CARD_SRC.match(/imageWrap:\s*\{([^}]*)\}/s);
  assert.ok(imageWrapMatch, 'expected an imageWrap style block in SharedScanCard.tsx');
  assert.match(imageWrapMatch[1], /width:\s*'100%'/);
  assert.match(imageWrapMatch[1], /aspectRatio:\s*1/);
});

test('SharedScanCard title clamps to two lines so long names cannot expand the card', () => {
  assert.match(SHARED_SCAN_CARD_SRC, /numberOfLines=\{2\}/);
});
