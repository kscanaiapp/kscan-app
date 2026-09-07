// Closet Experience V1 — the read-only inventory lens (PR A1).
//
// Runs the REAL services/closet/closetInventory.ts, transpiled in-process, the
// same way closetTypedLoad/closetTaxonomyPreservation run the real stores.
// Nothing here is mocked, because there is nothing to mock: the lens is pure.
//
// The negative controls are the point of this file. Section 76 requires that a
// Closet productization lane can PROVE, mechanically, that:
//   - an unclassified item is never hidden
//   - a summary describes the Closet, not the current query
//   - search is substring-only, never fuzzy
//   - ordering is deterministic across runs and input permutations
//   - nothing in the lens performs I/O

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function runModule(rel) {
  const source = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${source}\n})`, { filename: rel })(
    mod.exports,
    mod,
    () => {
      throw new Error(`closetInventory must not require anything at runtime (tried in ${rel})`);
    },
  );
  return mod.exports;
}

const lens = runModule('services/closet/closetInventory.ts');

let seq = 0;
function item(overrides = {}) {
  seq += 1;
  return {
    id: overrides.id ?? `closet_${String(seq).padStart(4, '0')}`,
    title: 'Closet item',
    notes: null,
    origin: 'direct_intake',
    imageUri: null,
    thumbnailUri: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    category: null,
    clothingType: null,
    subtype: null,
    brand: null,
    primaryColor: null,
    secondaryColors: [],
    material: [],
    size: null,
    displaySummary: null,
    taxonomyUnknown: true,
    ...overrides,
  };
}

// ── Summary ───────────────────────────────────────────────────────────────────

test('summary counts every item the actor owns, not the classified subset', () => {
  const summary = lens.summarizeCloset([
    item({ category: 'Tops' }),
    item({ category: 'Tops' }),
    item({ category: null }),
  ]);
  assert.equal(summary.totalItems, 3);
  assert.equal(summary.uncategorizedCount, 1);
  assert.equal(summary.distinctCategoryCount, 1, 'the absent bucket is not a category');
});

test('NEGATIVE CONTROL: an unclassified item is a selectable bucket, never hidden', () => {
  const items = [item({ category: 'Tops' }), item({ category: null })];
  const summary = lens.summarizeCloset(items);

  const bucket = summary.categories.find((c) => c.value === lens.UNCATEGORIZED_FILTER_VALUE);
  assert.ok(bucket, 'Uncategorized must appear as a real filter value');
  assert.equal(bucket.label, 'Uncategorized');
  assert.equal(bucket.count, 1);

  // And selecting it returns exactly that item.
  const view = lens.queryCloset(items, { category: lens.UNCATEGORIZED_FILTER_VALUE });
  assert.equal(view.visibleItems, 1);
  assert.equal(view.items[0].category, null);

  // And the default (no filter) still shows it.
  assert.equal(lens.queryCloset(items).visibleItems, 2);
});

test('Uncategorized always sorts last, even when it is the largest bucket', () => {
  const summary = lens.summarizeCloset([
    item({ category: null }),
    item({ category: null }),
    item({ category: null }),
    item({ category: 'Tops' }),
  ]);
  assert.equal(summary.categories.at(-1).value, lens.UNCATEGORIZED_FILTER_VALUE);
  assert.equal(summary.categories[0].value, 'Tops');
});

test('category ordering is count desc then label asc — never input order', () => {
  const forward = lens.summarizeCloset([
    item({ category: 'Shoes' }),
    item({ category: 'Bags' }),
    item({ category: 'Bags' }),
  ]);
  const reverse = lens.summarizeCloset([
    item({ category: 'Bags' }),
    item({ category: 'Bags' }),
    item({ category: 'Shoes' }),
  ]);
  assert.deepEqual(
    forward.categories.map((c) => c.value),
    reverse.categories.map((c) => c.value),
  );
  assert.deepEqual(forward.categories.map((c) => c.value), ['Bags', 'Shoes']);
});

test('the reserved bucket sentinel cannot collide with a real stored category', () => {
  // A garment category literally called "uncategorized" is a DIFFERENT bucket.
  const items = [item({ category: 'uncategorized' }), item({ category: null })];
  const summary = lens.summarizeCloset(items);
  assert.equal(summary.uncategorizedCount, 1, 'only the absent one is absent');
  assert.equal(summary.distinctCategoryCount, 1, 'the literal string is a real category');

  const absent = lens.queryCloset(items, { category: lens.UNCATEGORIZED_FILTER_VALUE });
  assert.equal(absent.visibleItems, 1);
  assert.equal(absent.items[0].category, null);

  const literal = lens.queryCloset(items, { category: 'uncategorized' });
  assert.equal(literal.visibleItems, 1);
  assert.equal(literal.items[0].category, 'uncategorized');
});

// ── Search ────────────────────────────────────────────────────────────────────

test('search is case-insensitive, trimmed, and whitespace-collapsed', () => {
  const items = [item({ title: 'Navy Wool Coat' }), item({ title: 'White Sneakers' })];
  for (const q of ['navy', '  NAVY  ', 'navy   wool', 'Navy Wool']) {
    const view = lens.queryCloset(items, { search: q });
    assert.equal(view.visibleItems, 1, `query ${JSON.stringify(q)} should match one item`);
    assert.equal(view.items[0].title, 'Navy Wool Coat');
  }
});

test('search reaches the taxonomy the item actually stores', () => {
  const items = [
    item({ title: 'Closet item', brand: 'Acme' }),
    item({ title: 'Closet item', primaryColor: 'crimson' }),
    item({ title: 'Closet item', material: ['merino', 'silk'] }),
    item({ title: 'Closet item', size: 'M' }),
    item({ title: 'Closet item', notes: 'wedding' }),
  ];
  assert.equal(lens.queryCloset(items, { search: 'acme' }).visibleItems, 1);
  assert.equal(lens.queryCloset(items, { search: 'crimson' }).visibleItems, 1);
  assert.equal(lens.queryCloset(items, { search: 'silk' }).visibleItems, 1);
  assert.equal(lens.queryCloset(items, { search: 'wedding' }).visibleItems, 1);
});

test('NEGATIVE CONTROL: search is substring-only — no fuzzy, stemming or synonyms', () => {
  const items = [item({ title: 'Navy Wool Coat' })];
  // A typo, a stem and a synonym must all MISS. If any of these ever matches,
  // someone has introduced fuzzy matching, which section 29 forbids because it
  // makes a result set unexplainable.
  for (const q of ['navi', 'coats', 'jacket', 'wooll', 'noavy']) {
    assert.equal(
      lens.queryCloset(items, { search: q }).visibleItems,
      0,
      `${JSON.stringify(q)} must not match — that would be fuzzy matching`,
    );
  }
  // The genuine prefix/substring still matches.
  assert.equal(lens.queryCloset(items, { search: 'coat' }).visibleItems, 1);
});

test('search never reads internal fields', () => {
  const items = [item({ id: 'closet_zzz9', origin: 'recent_scan', createdAt: '2026-03-04T00:00:00.000Z' })];
  assert.equal(lens.queryCloset(items, { search: 'closet_zzz9' }).visibleItems, 0, 'ids are not searchable');
  assert.equal(lens.queryCloset(items, { search: 'recent_scan' }).visibleItems, 0, 'origin enum is not searchable');
  assert.equal(lens.queryCloset(items, { search: '2026' }).visibleItems, 0, 'timestamps are not searchable');
});

// ── Filter / narrowing semantics ──────────────────────────────────────────────

test('origin filter uses the stored enum and defaults to all', () => {
  const items = [item({ origin: 'direct_intake' }), item({ origin: 'recent_scan' })];
  assert.equal(lens.queryCloset(items, { origin: 'all' }).visibleItems, 2);
  assert.equal(lens.queryCloset(items, { origin: 'recent_scan' }).visibleItems, 1);
  assert.equal(lens.queryCloset(items, { origin: 'nonsense' }).visibleItems, 2, 'unknown falls back to all');
});

test('filtered distinguishes "you own nothing" from "nothing matched"', () => {
  const items = [item({ title: 'Navy Wool Coat' })];
  assert.equal(lens.queryCloset(items).filtered, false);
  assert.equal(lens.queryCloset([]).filtered, false, 'an empty Closet with no query is not filtered');

  const missed = lens.queryCloset(items, { search: 'zzz' });
  assert.equal(missed.filtered, true);
  assert.equal(missed.visibleItems, 0);
  assert.equal(missed.totalItems, 1, 'totalItems still reports the whole Closet');
});

test('the summary is unaffected by the query — counts describe the Closet', () => {
  const items = [item({ category: 'Tops' }), item({ category: 'Shoes' })];
  const summary = lens.summarizeCloset(items);
  lens.queryCloset(items, { search: 'nothing matches this' });
  assert.deepEqual(lens.summarizeCloset(items), summary, 'querying must not mutate or re-derive the summary');
  assert.equal(summary.totalItems, 2);
});

// ── Determinism (the property PR B depends on) ────────────────────────────────

test('DETERMINISM: identical input yields byte-equivalent output across runs', () => {
  const items = [
    item({ id: 'a', title: 'Coat', category: 'Outerwear', createdAt: '2026-01-02T00:00:00.000Z' }),
    item({ id: 'b', title: 'Coat', category: 'Outerwear', createdAt: '2026-01-02T00:00:00.000Z' }),
    item({ id: 'c', title: 'Shoe', category: null, createdAt: '2026-01-01T00:00:00.000Z' }),
  ];
  for (const sort of lens.CLOSET_SORT_IDS) {
    const a = JSON.stringify(lens.queryCloset(items, { sort }));
    const b = JSON.stringify(lens.queryCloset(items, { sort }));
    assert.equal(a, b, `sort ${sort} must be byte-equivalent across runs`);
  }
  assert.equal(JSON.stringify(lens.summarizeCloset(items)), JSON.stringify(lens.summarizeCloset(items)));
});

test('DETERMINISM: ties break on id, so input order cannot change output order', () => {
  const mk = (id) =>
    item({ id, title: 'Same Title', category: 'Tops', createdAt: '2026-01-01T00:00:00.000Z' });
  const forward = [mk('a'), mk('b'), mk('c')];
  const shuffled = [mk('c'), mk('a'), mk('b')];
  for (const sort of lens.CLOSET_SORT_IDS) {
    assert.deepEqual(
      lens.queryCloset(forward, { sort }).items.map((i) => i.id),
      lens.queryCloset(shuffled, { sort }).items.map((i) => i.id),
      `sort ${sort} must not depend on input order`,
    );
  }
});

test('an item with no createdAt sorts last in BOTH time orders — unknown age, not oldest', () => {
  const withDate = item({ id: 'dated', createdAt: '2026-01-01T00:00:00.000Z' });
  const noDate = item({ id: 'undated', createdAt: null });
  const bad = item({ id: 'garbage', createdAt: 'not-a-date' });
  const items = [noDate, withDate, bad];

  assert.equal(lens.queryCloset(items, { sort: 'recently_added' }).items[0].id, 'dated');
  assert.equal(lens.queryCloset(items, { sort: 'oldest_added' }).items[0].id, 'dated');
  for (const sort of ['recently_added', 'oldest_added']) {
    const ids = lens.queryCloset(items, { sort }).items.map((i) => i.id);
    assert.deepEqual(ids.slice(1).sort(), ['garbage', 'undated'], `${sort}: undated items go last`);
  }
});

test('category sort puts uncategorized items last', () => {
  const items = [item({ id: 'x', category: null }), item({ id: 'y', category: 'Tops' })];
  assert.deepEqual(
    lens.queryCloset(items, { sort: 'category' }).items.map((i) => i.id),
    ['y', 'x'],
  );
});

test('queryCloset never mutates the array it is given', () => {
  const items = [item({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' }), item({ id: 'a', createdAt: '2026-02-01T00:00:00.000Z' })];
  const before = items.map((i) => i.id);
  lens.queryCloset(items, { sort: 'recently_added' });
  assert.deepEqual(items.map((i) => i.id), before, 'sort must operate on a copy');
});

// ── Language and claim boundary ───────────────────────────────────────────────

test('sort labels say ADDED, never purchased or bought', () => {
  const all = Object.values(lens.CLOSET_SORT_LABELS).join(' ').toLowerCase();
  for (const banned of ['purchase', 'bought', 'buy', 'owned since', 'acquired']) {
    assert.ok(!all.includes(banned), `sort labels must not imply purchase date (found ${banned})`);
  }
  assert.equal(lens.CLOSET_SORT_LABELS.recently_added, 'Recently added');
});

test('origin labels are customer language, never the stored enum', () => {
  const all = Object.values(lens.CLOSET_ORIGIN_LABELS).join(' ');
  assert.ok(!all.includes('direct_intake'));
  assert.ok(!all.includes('recent_scan'));
});

test('robustness: null, undefined and junk entries do not throw', () => {
  assert.equal(lens.summarizeCloset(null).totalItems, 0);
  assert.equal(lens.summarizeCloset(undefined).totalItems, 0);
  assert.equal(lens.queryCloset(null).visibleItems, 0);
  const withJunk = lens.queryCloset([null, undefined, item({ category: 'Tops' })]);
  assert.equal(withJunk.visibleItems, 1);
});

// ── Structural: no I/O in the lens ────────────────────────────────────────────

test('STRUCTURAL: the lens performs no I/O and reaches no store, network or actor', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closet/closetInventory.ts'), 'utf8');
  // The runModule require-shim above already throws on ANY runtime require, so
  // this asserts the same rule at the source level for imports the transpiler
  // may hoist or elide.
  for (const banned of [
    'supabase',
    'FileSystem',
    'expo-file-system',
    'fetch(',
    'AsyncStorage',
    'closetSyncStore',
    'closetLibrary',
    'actorContext',
  ]) {
    assert.ok(
      !source.includes(banned),
      `closetInventory.ts must stay pure — found a reference to ${banned}`,
    );
  }
});
