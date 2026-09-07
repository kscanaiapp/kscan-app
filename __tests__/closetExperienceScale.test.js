// Closet Experience V1 — 50 / 250 / 1000 item scale smoke (sections 34, 68).
//
// THE GOAL IS NOT A BENCHMARK. Wall-clock on a CI box says nothing about a
// phone. What this file proves is the thing that actually survives the trip to a
// device:
//
//   - correctness does not collapse as the Closet grows
//   - work is BOUNDED — no quadratic explosion, no unbounded scan
//   - the screen cannot mount 1000 cards at once
//
// Timings are recorded for the report, never asserted on: a threshold that
// passes on this machine and fails on a slower runner is a flake, and section 68
// explicitly says measure rather than optimize.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function runModule(rel) {
  const source = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${source}\n})`, { filename: rel })(
    mod.exports,
    mod,
    () => ({}),
  );
  return mod.exports;
}

const lens = runModule('services/closet/closetInventory.ts');

const CATEGORIES = ['Tops', 'Bottoms', 'Outerwear', 'Shoes', 'Bags', 'Accessories'];
const BRANDS = ['Acme', 'Northwind', 'Contoso', null];
const COLORS = ['navy', 'black', 'crimson', 'ivory', null];

/**
 * A deterministic synthetic Closet.
 *
 * Fully seeded from the index — no Math.random — so a failure at n=1000
 * reproduces exactly. Every fifth item is deliberately unclassified and every
 * seventh has no image, so the large fixtures exercise the absent paths rather
 * than a uniformly perfect wardrobe.
 */
function buildCloset(n) {
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const unclassified = i % 5 === 0;
    const imageless = i % 7 === 0;
    items.push({
      id: `closet_scale_${String(i).padStart(5, '0')}`,
      title: unclassified ? 'Closet item' : `${CATEGORIES[i % CATEGORIES.length]} ${i}`,
      notes: null,
      origin: i % 3 === 0 ? 'recent_scan' : 'direct_intake',
      imageUri: imageless ? null : `file:///closet/img_${i}.jpg`,
      thumbnailUri: imageless ? null : `file:///closet/thumb_${i}.jpg`,
      // Strictly increasing, so time sorts have a total order to find.
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      category: unclassified ? null : CATEGORIES[i % CATEGORIES.length],
      clothingType: null,
      subtype: null,
      brand: BRANDS[i % BRANDS.length],
      primaryColor: COLORS[i % COLORS.length],
      secondaryColors: [],
      material: i % 4 === 0 ? ['wool'] : [],
      size: null,
      displaySummary: null,
      taxonomyUnknown: unclassified,
    });
  }
  return items;
}

function ms(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

const SIZES = [50, 250, 1000];
const report = [];

for (const n of SIZES) {
  test(`n=${n}: summary, search, filter and sort all stay correct`, () => {
    const items = buildCloset(n);

    const summary = ms(() => lens.summarizeCloset(items));
    assert.equal(summary.out.totalItems, n);
    // Every fifth item is unclassified: indices 0,5,10,... = ceil(n/5).
    assert.equal(summary.out.uncategorizedCount, Math.ceil(n / 5));
    assert.equal(
      summary.out.categories.reduce((t, c) => t + c.count, 0),
      n,
      'every item lands in exactly one bucket — none is dropped',
    );

    const search = ms(() => lens.queryCloset(items, { search: 'outerwear' }));
    assert.ok(search.out.visibleItems > 0);
    assert.equal(search.out.totalItems, n, 'a search never changes the reported total');

    const filter = ms(() => lens.queryCloset(items, { category: lens.UNCATEGORIZED_FILTER_VALUE }));
    assert.equal(filter.out.visibleItems, Math.ceil(n / 5), 'unclassified items stay reachable at scale');

    const sort = ms(() => lens.queryCloset(items, { sort: 'alphabetical' }));
    assert.equal(sort.out.visibleItems, n, 'sorting never drops an item');

    report.push({ n, summary: summary.ms, search: search.ms, filter: filter.ms, sort: sort.ms });
  });
}

test('BOUNDED WORK: cost grows sub-quadratically from 50 to 1000 items', () => {
  // A 20x input increase must not cost anywhere near 400x. This is a shape
  // check, not a timing threshold: it catches an accidental O(n^2) (a nested
  // scan, a per-item duplicate search) while tolerating an order of magnitude
  // of machine noise.
  const small = report.find((r) => r.n === 50);
  const large = report.find((r) => r.n === 1000);
  assert.ok(small && large, 'the scale tests must have run first');

  const floor = 0.05; // ignore sub-50us noise, where ratios are meaningless
  for (const op of ['summary', 'search', 'filter', 'sort']) {
    const s = Math.max(small[op], floor);
    const l = Math.max(large[op], floor);
    const ratio = l / s;
    assert.ok(
      ratio < 100,
      `${op}: 20x more items cost ${ratio.toFixed(1)}x — that shape suggests quadratic work`,
    );
  }
});

test('the screen caps how many cards it mounts, whatever the Closet size', () => {
  // The grid lives inside a ScrollView, so there is no virtualization to rely
  // on. The cap IS the guard, and it must be enforced in the screen source.
  const screen = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');

  const declared = screen.match(/const CLOSET_PAGE_SIZE = (\d+);/);
  assert.ok(declared, 'app/library.tsx must declare CLOSET_PAGE_SIZE');
  const pageSize = Number(declared[1]);
  assert.ok(pageSize > 0 && pageSize <= 100, `page size ${pageSize} is not a meaningful cap`);

  assert.match(
    screen,
    /closetVisible\.slice\(0,\s*closetVisibleCount\)/,
    'the grid must render a bounded slice, not the whole array',
  );
  assert.match(
    screen,
    /closetPairs = closetPage\.reduce/,
    'the 2-up pairing must be built from the capped page, not from every item',
  );
  assert.ok(
    !/closetPairs = closet\.items\.reduce/.test(screen),
    'REGRESSION: the grid is pairing over every item again — a 1000-item Closet would mount 1000 cards',
  );
});

test('the grid asks for thumbnails before full-resolution originals (section 27)', () => {
  const screen = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
  const closetCards = screen.match(/imageUrl=\{[ab]\.thumbnailUri \?\? [ab]\.imageUri\}/g) ?? [];
  assert.ok(
    closetCards.length >= 2,
    'both Closet grid cards must prefer the cached thumbnail over the original',
  );
});

test('SCALE REPORT (recorded, not asserted)', () => {
  assert.equal(report.length, SIZES.length);
  for (const r of report) {
    console.log(
      `  n=${String(r.n).padStart(4)}  summary ${r.summary.toFixed(2)}ms  search ${r.search.toFixed(2)}ms  filter ${r.filter.toFixed(2)}ms  sort ${r.sort.toFixed(2)}ms`,
    );
  }
});
