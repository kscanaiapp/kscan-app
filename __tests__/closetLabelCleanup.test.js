// REPEATED AND ORPHANED LABELS (Build 25 Phase 2, BUG-12).
//
// The classifier routinely returns the same word for more than one taxonomy
// field — a plain top comes back as category "top" AND subtype "top" — and every
// surface joined those fields blindly, so cards read "top · top · black". The
// Closet card had the same defect across two lines: a promoted item's title is
// built FROM its taxonomy, so an item with no brand and no subtype got its bare
// category as a title and the category again as the subtitle underneath.
//
// These drive the real projection and the real review builder, so they observe
// the string a card would actually render.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

function runModule(rel, requireShim = () => ({})) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

const projection = runModule('services/closetItemProjection.ts');

function item(taxonomy) {
  return {
    schemaVersion: 2,
    id: 'closet_1',
    ownerId: 'user-a',
    title: 'Item',
    imageUri: '/doc/kscan_closet/images/a.jpg',
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
    ...taxonomy,
  };
}

// ── The reported string ──────────────────────────────────────────────────────

test('a category that equals its subtype is not said twice', () => {
  const projected = projection.getClosetItemProjection(
    item({ category: 'top', subtype: 'top', primaryColor: 'black' }),
  );
  assert.equal(projected.displaySummary, 'top · black');
  assert.doesNotMatch(projected.displaySummary, /top · top/);
});

test('de-duplication ignores case and surrounding space', () => {
  const projected = projection.getClosetItemProjection(
    item({ category: 'Top', subtype: ' top ', primaryColor: 'Black' }),
  );
  assert.equal(projected.displaySummary, 'Top · Black');
});

test('a genuinely more specific subtype is KEPT', () => {
  // The repair must not flatten real taxonomy — only the repeat goes.
  const projected = projection.getClosetItemProjection(
    item({ category: 'Outerwear', subtype: 'Bomber', primaryColor: 'Black' }),
  );
  assert.equal(projected.displaySummary, 'Outerwear · Bomber · Black');
});

test('the broader value is the one kept when two fields agree', () => {
  // Parts arrive broadest-first, so the first occurrence wins and the ordering
  // a reader expects is preserved.
  const projected = projection.getClosetItemProjection(
    item({ category: 'Dress', clothingType: 'dress', subtype: 'Wrap', primaryColor: 'Navy' }),
  );
  assert.equal(projected.displaySummary, 'Dress · Wrap · Navy');
});

test('an all-identical taxonomy collapses to one label, not a chain', () => {
  const projected = projection.getClosetItemProjection(
    item({ category: 'top', clothingType: 'top', subtype: 'TOP' }),
  );
  assert.equal(projected.displaySummary, 'top');
});

test('an empty taxonomy still reports nothing rather than an empty string', () => {
  const projected = projection.getClosetItemProjection(item({}));
  assert.equal(projected.displaySummary, null);
});

// ── The same rule everywhere the string is built ─────────────────────────────

test('every surface that joins taxonomy de-duplicates it', () => {
  // Four independent implementations of the same join. If a new one appears
  // without de-duplication, "top · top" comes back on that surface only.
  // The iOS line has no MultiItemResultNavigator — the multi-item candidate
  // review surface is Android-only. Its absence is a real platform difference,
  // not a missing port, so it is not asserted here.
  const joiners = [
    'services/closetItemProjection.ts',
    'services/closetBatchReview.ts',
    'components/closet/ClosetCandidateStatusPanel.tsx',
  ];
  for (const rel of joiners) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(
      source,
      /new Set<string>\(\)|new Set\(\)/,
      `${rel} joins taxonomy without de-duplicating it`,
    );
    assert.match(source, /toLowerCase\(\)/, `${rel} must compare case-insensitively`);
  }
});

// ── The Closet card's two lines ──────────────────────────────────────────────

test('the Closet card drops a subtitle that only repeats its title', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
  const fn = source.match(/function closetCardSubtitle\(([\s\S]*?)\n}/);
  assert.ok(fn, 'the card subtitle must be derived, not inlined');

  const js = ts.transpileModule(fn[0], {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const closetCardSubtitle = Function(`${js}; return closetCardSubtitle;`)();
  assert.equal(closetCardSubtitle('Tops', 'Tops'), undefined, '"Tops" over "Tops" is the defect');
  assert.equal(closetCardSubtitle('Tops', 'tops'), undefined, 'case is not a difference');
  assert.equal(closetCardSubtitle('Acme Bomber', 'Outerwear'), 'Outerwear', 'a real category stays');
  assert.equal(closetCardSubtitle('Anything', null), 'Owned item', 'the fallback is unchanged');
});

test('the card is still labelled by its title for assistive tech', () => {
  // Dropping the visible subtitle must not drop the item's identity.
  const source = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
  assert.match(source, /accessibilityLabel=\{`\$\{a\.title\} Closet item`\}/);
});

// ── One body per empty state ─────────────────────────────────────────────────

test('the Closet declares no second, unrendered empty body', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
  const closetChrome = source.slice(source.indexOf('closet: {'), source.indexOf('} as const;'));
  assert.equal(
    /emptyBody:/.test(closetChrome),
    false,
    'a static Closet body is a second copy of a state that writes its own',
  );
  // Recent Scans still declares one, and it is still the one rendered.
  assert.match(source, /const recentEmptyBody =/);
});

test('scan-result empty states say something the title did not', () => {
  const v2 = fs.readFileSync(path.join(ROOT, 'components/scan-results/ScanResultV2.tsx'), 'utf8');
  assert.equal(
    v2.includes('Your scan data could not be loaded.'),
    false,
    'that body only restated "Scan result unavailable"',
  );

  const hero = fs.readFileSync(
    path.join(ROOT, 'components/scan-results/ScanResultHero.tsx'),
    'utf8',
  );
  assert.equal(
    hero.includes('Your scan analysis is ready.'),
    false,
    'that body contradicted the empty state it appeared in',
  );
});

// ── Negative controls ────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: the pre-repair join reproduces the reported string', () => {
  // Exactly what every surface did before: filter falsy, join.
  const preRepairJoin = (parts) => parts.filter(Boolean).join(' · ');
  assert.equal(
    preRepairJoin(['top', null, 'top', 'black']),
    'top · top · black',
    'the old join must still be shown to produce the defect',
  );

  // And the repaired projection does not.
  const projected = projection.getClosetItemProjection(
    item({ category: 'top', subtype: 'top', primaryColor: 'black' }),
  );
  assert.notEqual(projected.displaySummary, 'top · top · black');
});

test('NEGATIVE CONTROL: the pre-repair card subtitle repeated the title', () => {
  const preRepairSubtitle = (title, category) => category ?? 'Owned item';
  assert.equal(
    preRepairSubtitle('Tops', 'Tops'),
    'Tops',
    'the old expression must be shown to duplicate the title',
  );
});
