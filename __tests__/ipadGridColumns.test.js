/**
 * Build 29 iPad pass — DEF-045 / DEF-068.
 *
 * The column COUNT was already responsive and the cell WIDTH was already
 * derived from it. What was missing was the row builder: every grid split its
 * collection with a hardcoded two-item pair reducer, so on a regular-width iPad
 * cells were sized for three columns (four when wide) while only two were ever
 * rendered — a third to a half of every row left empty.
 *
 * These tests are written against width CLASSES, never a device's exact pixel
 * dimensions, so they keep holding for future sizes, Split View, and rotation.
 * The invariant that matters is the agreement between the width the cells are
 * sized to and the number of cells placed in a row.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  chunkIntoRows,
  getGridColumns,
  getWidthClass,
  getResponsiveGridCellWidth,
  getContentWidth,
  CONTENT_MAX_WIDTH,
} = require('../services/responsiveLayout');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Same width vocabulary the existing responsive contract tests use.
const IPHONE_WIDTHS = [320, 375, 390, 393, 414, 428, 430, 440];
const IPAD_NARROW_MULTITASKING_WIDTHS = [320, 375];
const IPAD_HALF_WIDTH_MULTITASKING = [507, 512, 639, 678];
const IPAD_PORTRAIT_WIDTHS = [744, 768, 810, 820, 834];
const IPAD_LANDSCAPE_WIDTHS = [1024, 1080, 1133, 1180, 1194, 1210, 1366];
// Large/foldable-style surfaces, as an additional regression check.
const LARGE_SURFACE_WIDTHS = [1440, 1600, 1920];

const COMPACT = [...IPHONE_WIDTHS, ...IPAD_NARROW_MULTITASKING_WIDTHS, ...IPAD_HALF_WIDTH_MULTITASKING];
const REGULAR = [...IPAD_PORTRAIT_WIDTHS, ...IPAD_LANDSCAPE_WIDTHS, ...LARGE_SURFACE_WIDTHS];

const GRID_OPTIONS = { horizontalPadding: 24, gap: 16, chromePadding: 24 };

// ── chunkIntoRows: the primitive the grids were missing ──────────────────

test('chunkIntoRows fills every row to the column count except the last', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  for (const columns of [1, 2, 3, 4, 5]) {
    const rows = chunkIntoRows(items, columns);
    // Every row but the last is full...
    for (const row of rows.slice(0, -1)) {
      assert.equal(row.length, columns, `columns=${columns}`);
    }
    // ...the last is non-empty and never over-full...
    const last = rows[rows.length - 1];
    assert.ok(last.length > 0 && last.length <= columns, `columns=${columns}`);
    // ...and nothing is lost or duplicated.
    assert.deepEqual(rows.flat(), items, `columns=${columns}`);
  }
});

test('chunkIntoRows never pads a short row with placeholders', () => {
  const rows = chunkIntoRows([1, 2, 3, 4, 5], 3);
  assert.deepEqual(rows, [[1, 2, 3], [4, 5]]);
  // Grid rows are flex rows with a gap and fixed-width cells, so a short final
  // row left-aligns on its own. Padding would put phantom cells in the tree.
  assert.ok(rows.flat().every((value) => value != null));
});

test('chunkIntoRows degrades safely rather than looping forever', () => {
  assert.deepEqual(chunkIntoRows([], 3), []);
  assert.deepEqual(chunkIntoRows(null, 3), []);
  assert.deepEqual(chunkIntoRows(undefined, 2), []);
  // A nonsense column count must still terminate and keep every item.
  for (const columns of [0, -1, NaN, undefined, null, 1.5]) {
    const rows = chunkIntoRows([1, 2, 3], columns);
    assert.deepEqual(rows.flat(), [1, 2, 3], `columns=${String(columns)}`);
  }
});

// ── The invariant: rows agree with the width cells were sized to ─────────

test('a full row of cells fits inside the column they were sized against', () => {
  for (const width of [...COMPACT, ...REGULAR]) {
    const columns = getGridColumns(width);
    const cell = getResponsiveGridCellWidth(width, GRID_OPTIONS);

    // What a full row occupies, against the column the cells were sized in.
    const rowWidth = cell * columns + GRID_OPTIONS.gap * (columns - 1);
    const container =
      getWidthClass(width) === 'compact'
        ? width
        : getContentWidth(width) - GRID_OPTIONS.chromePadding * 2;
    const available = container - GRID_OPTIONS.horizontalPadding * 2;

    assert.ok(
      rowWidth <= available + 1,
      `width=${width}: row ${rowWidth} overflows available ${available}`,
    );
    // ...and leaves less than one cell of slack, which is what "no dead
    // horizontal space" means in practice. The old 2/row behaviour left a
    // full cell (or two) of slack at every regular width.
    assert.ok(
      available - rowWidth < cell,
      `width=${width}: ${available - rowWidth}pt of dead space, a whole cell fits`,
    );
  }
});

test('iPad widths genuinely gain columns over the phone layout', () => {
  for (const width of REGULAR) {
    assert.ok(getGridColumns(width) >= 3, `width=${width} should gain a column`);
  }
  // Landscape and large surfaces reach four.
  for (const width of [...IPAD_LANDSCAPE_WIDTHS, ...LARGE_SURFACE_WIDTHS]) {
    assert.equal(getGridColumns(width), 4, `width=${width}`);
  }
});

test('iPhone and narrow multitasking keep exactly the certified two columns', () => {
  for (const width of COMPACT) {
    assert.equal(getWidthClass(width), 'compact', `width=${width}`);
    assert.equal(getGridColumns(width), 2, `width=${width}`);
    // Two-per-row rows are what the pair reducer produced, so the iPhone
    // layout is unchanged by the switch to a generic row builder.
    const rows = chunkIntoRows([1, 2, 3, 4, 5], getGridColumns(width));
    assert.deepEqual(rows, [[1, 2], [3, 4], [5]], `width=${width}`);
  }
});

test('content stays in a centered column instead of stretching', () => {
  for (const width of REGULAR) {
    // Never wider than the cap, and never wider than the window itself: an
    // iPad portrait narrower than the cap uses its full width, while landscape
    // and large surfaces are capped and centered rather than stretched.
    const content = getContentWidth(width);
    assert.ok(content <= CONTENT_MAX_WIDTH, `width=${width} exceeds the cap`);
    assert.ok(content <= width, `width=${width} exceeds the window`);
    assert.equal(content, Math.min(width, CONTENT_MAX_WIDTH), `width=${width}`);
  }

  // Anything genuinely wide must actually be capped, or content would stretch.
  for (const width of [...IPAD_LANDSCAPE_WIDTHS, ...LARGE_SURFACE_WIDTHS]) {
    assert.equal(getContentWidth(width), CONTENT_MAX_WIDTH, `width=${width}`);
  }

  // Compact widths are untouched: the phone layout is edge to edge as certified.
  for (const width of COMPACT) {
    assert.equal(getContentWidth(width), width, `width=${width}`);
  }
});

test('rotation is a pure re-derivation: portrait and landscape both resolve', () => {
  // Same device, both orientations — each must produce a self-consistent grid.
  for (const [portrait, landscape] of [[820, 1180], [744, 1133], [834, 1194]]) {
    for (const width of [portrait, landscape]) {
      const columns = getGridColumns(width);
      const cell = getResponsiveGridCellWidth(width, GRID_OPTIONS);
      assert.ok(cell > 0, `width=${width}`);
      assert.ok(columns >= 3, `width=${width}`);
    }
    // Landscape must never render fewer columns than portrait.
    assert.ok(
      getGridColumns(landscape) >= getGridColumns(portrait),
      `${landscape} should not have fewer columns than ${portrait}`,
    );
  }
});

// ── The screens actually use it ──────────────────────────────────────────

test('DEF-045: the library grids build rows from the responsive column count', () => {
  const library = read('app/library.tsx');

  assert.ok(
    !/i % 2 === 0/.test(library),
    'the regression: hardcoded two-item pair reducers',
  );
  for (const rows of ['scanRows', 'closetRows', 'inspirationRows']) {
    assert.match(
      library,
      new RegExp(`const ${rows} = toGridRows\\(`),
      `${rows} must be built from the layout's own column count`,
    );
    assert.match(library, new RegExp(`\\{${rows}\\.map\\(`), `${rows} must be rendered`);
  }
  // The cell width and the row builder come from the SAME layout object, so
  // they cannot disagree about the column count — that disagreement was the
  // defect.
  assert.match(
    library,
    /const \{ gridColumns, gridCellWidth, toGridRows \} = useResponsiveLayout\(\)/,
  );
});

test('DEF-068: the Dressing Room inspiration grid is no longer pinned to two', () => {
  const room = read('app/dressing-rooms/[id].tsx');

  assert.ok(!/i % 2 === 0/.test(room), 'the pair reducer must be gone');
  assert.ok(
    !/columns: 2,/.test(room),
    'the card width must not pin itself to two columns',
  );
  assert.match(room, /toInspirationRows\(inspirations\)/);
  assert.match(room, /const \{ gridCellWidth, gridColumns, toGridRows \} = useResponsiveLayout\(\)/);
});

test('no shipping grid reintroduces a hardcoded pair reducer', () => {
  for (const file of [
    'app/library.tsx',
    'app/dressing-rooms/[id].tsx',
    'app/looks/index.tsx',
    'app/(public)/rooms/[token].tsx',
  ]) {
    assert.ok(!/i % 2 === 0/.test(read(file)), `${file} must not hardcode two columns`);
  }
});

test('the grids remain keyed per item, so reflow does not remount cells', () => {
  const library = read('app/library.tsx');
  // Rows are keyed by their first item's id and cells by their own id, so a
  // rotation that changes the column count re-keys rows without giving two
  // different items the same key.
  assert.match(library, /key=\{row\[0\]\.id\}/, 'rows keyed by a stable item id');
  assert.equal(
    (library.match(/key=\{(item|scan)\.id\}/g) || []).length,
    3,
    'each of the three grids must key its cells per item',
  );
});

// ── Appearance: the app is light-only ────────────────────────────────────

test('the app does not force dark system chrome onto its light canvas', () => {
  const appConfig = JSON.parse(read('app.json'));
  const style = appConfig.expo.userInterfaceStyle;

  // K Scan has a single light palette: there is no useColorScheme/Appearance
  // consumer anywhere, the default screen background is ivory, and screens
  // declare StatusBar style="dark" (dark glyphs on a light background).
  // Forcing "dark" gave dark keyboards, alerts and action sheets against that
  // canvas. "automatic" would be equally wrong — there is no dark theme to
  // switch to — so the honest declaration is "light".
  assert.equal(style, 'light');
});

test('the light-only premise still holds', () => {
  // If a dark theme is ever added, this test should fail and the appearance
  // decision above should be revisited rather than silently kept.
  for (const file of ['constants/theme.ts', 'app/_layout.tsx']) {
    assert.ok(
      !/useColorScheme|Appearance\.get/.test(read(file)),
      `${file} implements dark mode; revisit userInterfaceStyle`,
    );
  }
});
