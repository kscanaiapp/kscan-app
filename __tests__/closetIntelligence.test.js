// Closet Intelligence V1 — deterministic wardrobe facts (PR B).
//
// The controls that decide whether this contract is trustworthy:
//   - byte-equivalent output for identical input (section 56)
//   - zero AI/network cost (section 14)
//   - duplicate detection is conservative to the point of returning nothing,
//     and says why, rather than reaching for similarity (sections 61/62)
//   - absence safety reuses the existing doctrine and refuses to license an
//     absence claim while any record is unclassified (section 65)
//   - completeness language always names K Scan AI Closet records (section 58)
//   - the K+ split leaves basic counts free (section 57)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function runModule(rel, shim = () => ({})) {
  const source = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${source}\n})`, { filename: rel })(
    mod.exports,
    mod,
    shim,
  );
  return mod.exports;
}

const lens = runModule('services/closet/closetInventory.ts');
const review = runModule('services/closet/closetReview.ts');
const intel = runModule('services/closet/closetIntelligence.ts', (spec) => {
  if (spec === './closetInventory') return lens;
  if (spec === './closetReview') return review;
  return {};
});

const NOW = Date.parse('2026-02-01T00:00:00.000Z');

/**
 * Strip comments before a forbidden-token sweep.
 *
 * These modules DOCUMENT their own prohibitions ("no LLM", "no Math.random",
 * and a citation of a path under supabase/functions/). Sweeping raw text would
 * flag the sentence that promises the invariant while missing nothing real, so
 * every structural sweep below runs on executable code only.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

let seq = 0;
function item(over = {}) {
  seq += 1;
  return {
    id: over.id ?? `closet_${String(seq).padStart(3, '0')}`,
    title: 'Navy Wool Coat',
    notes: null,
    origin: 'direct_intake',
    imageUri: null,
    thumbnailUri: null,
    createdAt: '2026-01-20T00:00:00.000Z',
    updatedAt: '2026-01-20T00:00:00.000Z',
    category: 'Outerwear',
    clothingType: null,
    subtype: null,
    brand: null,
    primaryColor: null,
    secondaryColors: [],
    material: [],
    size: null,
    displaySummary: null,
    taxonomyUnknown: false,
    ...over,
  };
}

// ── Determinism (section 56) ──────────────────────────────────────────────────

test('DETERMINISM: identical input yields BYTE-EQUIVALENT output', () => {
  const items = [
    item({ id: 'a', category: 'Tops', brand: 'Acme' }),
    item({ id: 'b', category: 'Tops' }),
    item({ id: 'c', category: null, taxonomyUnknown: true }),
  ];
  const first = JSON.stringify(intel.computeClosetIntelligence(items, {}, NOW));
  const second = JSON.stringify(intel.computeClosetIntelligence(items, {}, NOW));
  assert.equal(first, second);
});

test('DETERMINISM: input ORDER cannot change the output', () => {
  const mk = () => [
    item({ id: 'a', category: 'Tops', brand: 'Acme' }),
    item({ id: 'b', category: 'Shoes' }),
    item({ id: 'c', category: 'Tops' }),
  ];
  const forward = mk();
  const shuffled = [mk()[1], mk()[2], mk()[0]];
  assert.equal(
    JSON.stringify(intel.computeClosetIntelligence(forward, {}, NOW)),
    JSON.stringify(intel.computeClosetIntelligence(shuffled, {}, NOW)),
  );
});

test('DETERMINISM: percentages are integers, never floats', () => {
  // 1 of 3 = 33.333... A float would differ in its last digit across engines and
  // break byte-equivalence.
  const out = intel.computeClosetIntelligence(
    [item({ brand: 'Acme' }), item(), item()],
    {},
    NOW,
  );
  const brand = out.fieldCoverage.find((f) => f.field === 'brand');
  assert.equal(brand.percent, 33);
  assert.ok(Number.isInteger(brand.percent));
});

test('DETERMINISM: field coverage is emitted in a FIXED field order', () => {
  const a = intel.computeClosetIntelligence([item()], {}, NOW).fieldCoverage.map((f) => f.field);
  const b = intel.computeClosetIntelligence([item({ brand: 'X' })], {}, NOW).fieldCoverage.map((f) => f.field);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [
    'brand',
    'primaryColor',
    'clothingType',
    'subtype',
    'material',
    'secondaryColors',
    'size',
  ]);
});

// ── Zero cost (section 14) ────────────────────────────────────────────────────

test('COST: the intelligence module makes no AI, network or provider call', () => {
  // Comments are stripped first: this file's own documentation names the
  // things it must not do (and cites a path under supabase/functions), and a
  // raw substring sweep would flag the prose that promises the invariant.
  const source = stripComments(
    fs.readFileSync(path.join(ROOT, 'services/closet/closetIntelligence.ts'), 'utf8'),
  );
  for (const banned of [
    'fetch(',
    'supabase',
    'gemini',
    'Gemini',
    'openai',
    'llama',
    'embedding',
    'functions.invoke',
    'XMLHttpRequest',
    'WebSocket',
    'axios',
  ]) {
    assert.ok(!source.includes(banned), `Closet Intelligence must be deterministic and free — found ${banned}`);
  }
});

test('COST: there is no durable intelligence store', () => {
  const source = stripComments(
    fs.readFileSync(path.join(ROOT, 'services/closet/closetIntelligence.ts'), 'utf8'),
  );
  for (const banned of ['FileSystem', 'AsyncStorage', 'writeAsString', 'createTable', 'insert(']) {
    assert.ok(!source.includes(banned), `section 55 forbids a second durable store — found ${banned}`);
  }
});

test('COST: the only non-determinism is the injectable clock', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'services/closet/closetIntelligence.ts'), 'utf8');
  const source = stripComments(raw);
  assert.ok(!source.includes('Math.random'), 'no randomness in executable code');
  // Date.now appears exactly once, as the default value of the `now` parameter.
  const dateNowCount = (source.match(/Date\.now\(\)/g) ?? []).length;
  assert.equal(dateNowCount, 1, 'the clock must be reachable in exactly one place');
  assert.match(raw, /now: number = Date\.now\(\)/, 'and that place must be an injectable parameter');
});

// ── Duplicate policy (sections 61-63) ─────────────────────────────────────────

test('DUPLICATES: V1 returns none, and states why', () => {
  // Two records that are identical in every visible respect.
  const twins = [
    item({ id: 'a', title: 'White Tee', category: 'Tops', brand: 'Acme', primaryColor: 'white' }),
    item({ id: 'b', title: 'White Tee', category: 'Tops', brand: 'Acme', primaryColor: 'white' }),
  ];
  const out = intel.computeClosetIntelligence(twins, {}, NOW);
  assert.deepEqual(out.duplicateCandidates, []);
  assert.equal(
    out.duplicateDetection,
    'unavailable_no_stable_identifier',
    'a Closet record carries no product id, SKU or GTIN, so section 61 requires NO candidate rather than a guess',
  );
});

test('NEGATIVE CONTROL: no fuzzy, image, perceptual or colour similarity exists anywhere in the module', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closet/closetIntelligence.ts'), 'utf8');
  const code = source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
  for (const banned of [
    'levenshtein',
    'jaro',
    'similarity',
    'fuzzy',
    'phash',
    'perceptualHash',
    'hammingDistance',
    'cosine',
    'canonicalProductIdentity',
  ]) {
    assert.ok(
      !new RegExp(banned, 'i').test(code),
      `section 61 forbids ${banned} in duplicate detection`,
    );
  }
});

test('DUPLICATES: the language never tells a user to delete one', () => {
  const copy = intel.describeDuplicateCandidate().toLowerCase();
  for (const banned of ['delete', 'remove', 'duplicate —', 'merge']) {
    assert.ok(!copy.includes(banned), `duplicate copy must not instruct: ${copy}`);
  }
  assert.match(intel.describeDuplicateCandidate(), /may have added this item twice/i);
});

// ── Absence safety (section 65) ───────────────────────────────────────────────

test('ABSENCE: a fully classified Closet licenses absence claims', () => {
  const out = intel.computeClosetIntelligence([item({ category: 'Tops' })], {}, NOW);
  assert.equal(out.licensesAbsenceClaims, true);
});

test('ABSENCE: ONE unclassified record revokes the licence for the whole Closet', () => {
  const out = intel.computeClosetIntelligence(
    [item({ id: 'a', category: 'Tops' }), item({ id: 'b', category: null, taxonomyUnknown: true })],
    {},
    NOW,
  );
  assert.equal(out.unclassifiedItems, 1);
  assert.equal(
    out.licensesAbsenceClaims,
    false,
    'a record the taxonomy could not place might be the very thing being asked about — absence of classification is not classification of absence',
  );
});

test('ABSENCE: an empty Closet licenses nothing', () => {
  const out = intel.computeClosetIntelligence([], {}, NOW);
  assert.equal(out.totalItems, 0);
  assert.equal(
    out.licensesAbsenceClaims,
    false,
    'an empty local Closet is not proof the user owns nothing',
  );
});

test('ABSENCE: a missing categoryCounts key is not itself a claim', () => {
  const out = intel.computeClosetIntelligence(
    [item({ category: 'Tops' }), item({ category: null, taxonomyUnknown: true })],
    {},
    NOW,
  );
  assert.ok(!out.categoryCounts.some((c) => c.value === 'Shoes'));
  assert.equal(out.licensesAbsenceClaims, false, 'so "you own no Shoes" is NOT licensed here');
});

// ── Coverage and the filter floor ─────────────────────────────────────────────

test('coverage counts a populated list, and does not count an empty one', () => {
  const out = intel.computeClosetIntelligence(
    [item({ material: ['wool'] }), item({ material: [] })],
    {},
    NOW,
  );
  const material = out.fieldCoverage.find((f) => f.field === 'material');
  assert.equal(material.populated, 1);
  assert.equal(material.percent, 50);
});

test('the 70% filter floor is reported as a fact, not left to a surface', () => {
  const high = intel.computeClosetIntelligence(
    [item({ brand: 'A' }), item({ brand: 'B' }), item({ brand: 'C' }), item()],
    {},
    NOW,
  );
  assert.equal(high.fieldCoverage.find((f) => f.field === 'brand').meetsFilterFloor, true, '75% clears');

  const low = intel.computeClosetIntelligence([item({ brand: 'A' }), item(), item()], {}, NOW);
  assert.equal(low.fieldCoverage.find((f) => f.field === 'brand').meetsFilterFloor, false, '33% does not');
});

test('whitespace-only values do not count as populated', () => {
  const out = intel.computeClosetIntelligence([item({ brand: '   ' })], {}, NOW);
  assert.equal(out.fieldCoverage.find((f) => f.field === 'brand').populated, 0);
});

// ── Recently added ────────────────────────────────────────────────────────────

test('recently-added uses the declared window and excludes unknown-age records', () => {
  const out = intel.computeClosetIntelligence(
    [
      item({ id: 'recent', createdAt: '2026-01-20T00:00:00.000Z' }),
      item({ id: 'old', createdAt: '2025-01-01T00:00:00.000Z' }),
      item({ id: 'undated', createdAt: null }),
      item({ id: 'garbage', createdAt: 'not-a-date' }),
      item({ id: 'future', createdAt: '2027-01-01T00:00:00.000Z' }),
    ],
    {},
    NOW,
  );
  assert.equal(out.recentlyAddedWindowDays, 30);
  assert.equal(
    out.recentlyAddedCount,
    1,
    'unknown age is not newness, and a future timestamp is not "recently added" either',
  );
});

// ── Core vs K+ (section 57) ───────────────────────────────────────────────────

test('K+ BOUNDARY: basic counts are plain contract fields, never gated in the data', () => {
  // The contract itself carries the free facts. Gating happens at the SURFACE,
  // so a non-entitled actor still gets correct basic wardrobe management.
  const out = intel.computeClosetIntelligence([item(), item()], {}, NOW);
  assert.equal(out.totalItems, 2);
  assert.ok(Array.isArray(out.categoryCounts));
  assert.equal(typeof out.reviewRequiredCount, 'number');
});

test('K+ BOUNDARY: the panel leaves total, categories and review count outside the gate', () => {
  const panel = fs.readFileSync(
    path.join(ROOT, 'components/closet/ClosetIntelligencePanel.tsx'),
    'utf8',
  );
  const gateAt = panel.indexOf('<KPlusGate');
  assert.ok(gateAt > 0, 'the panel must use the shared gate');
  const free = panel.slice(0, gateAt);

  assert.ok(free.includes('closet-intelligence-total'), '"42 items" must not be a premium feature');
  assert.ok(free.includes('describeCategory'), 'a simple category count is basic wardrobe management');
  assert.ok(free.includes('closet-intelligence-review-count'), 'the review count is core');

  const gated = panel.slice(gateAt);
  assert.ok(gated.includes('closet-intelligence-classification-coverage'), 'coverage analysis is K+');
  assert.ok(gated.includes('closet-intelligence-recent'), 'inventory patterns are K+');
});

test('K+ BOUNDARY: RESOLVING renders a neutral state, never a pitch or a lock', () => {
  const panel = fs.readFileSync(
    path.join(ROOT, 'components/closet/ClosetIntelligencePanel.tsx'),
    'utf8',
  );
  const resolvingAt = panel.indexOf("state === 'loading'");
  assert.ok(resolvingAt > 0, 'the panel must branch on the resolving state');
  const inactiveAt = panel.indexOf('if (!isActive)');
  assert.ok(
    resolvingAt < inactiveAt,
    'RESOLVING must be handled BEFORE the inactive branch, or a loading actor gets the unavailable message',
  );
  const resolvingBranch = panel.slice(resolvingAt, inactiveAt);
  for (const banned of ['openUpgrade', "isn't currently available", 'Learn more']) {
    assert.ok(
      !resolvingBranch.includes(banned),
      `the resolving branch must not ${banned} — RESOLVING is not INACTIVE`,
    );
  }
});

test('K+ BOUNDARY: no commerce language anywhere on the surface (section 11)', () => {
  const panel = fs.readFileSync(
    path.join(ROOT, 'components/closet/ClosetIntelligencePanel.tsx'),
    'utf8',
  );
  const code = stripComments(panel);
  for (const banned of ['Subscribe', 'Upgrade to', 'Buy ', 'Purchase', 'Renew', 'per month']) {
    assert.ok(!code.includes(banned), `no purchase path exists, so the surface must not sell: ${banned}`);
  }
  // A price, not the template-literal dollar sign that `${...}` uses.
  assert.ok(!/\$\s?\d/.test(code), 'no price may appear on this surface');
  assert.match(code, /isn&apos;t currently available/, 'availability language, not commerce language');
});

test('K+ BOUNDARY: the panel consumes the canonical gate, never its own predicate', () => {
  const panel = fs.readFileSync(
    path.join(ROOT, 'components/closet/ClosetIntelligencePanel.tsx'),
    'utf8',
  );
  assert.ok(panel.includes('KPlusGate'), 'must use the one shared gate');
  assert.ok(panel.includes("source=\"closet_intelligence\""), 'must use the existing bounded source');
  for (const banned of ['kplus_has_active_entitlement', 'expiresAt', 'grantReason', 'user_entitlements']) {
    assert.ok(!panel.includes(banned), `section 13: consume the predicate, do not reimplement it (${banned})`);
  }
});

// ── Claim boundary language (sections 58, 59, 87) ─────────────────────────────

test('LANGUAGE: no completeness statement is ever about the user\'s wardrobe', () => {
  const strings = [];
  for (const total of [0, 1, 7, 100]) {
    const items = Array.from({ length: total }, (_, i) =>
      item({ id: `x${i}`, brand: i % 2 ? 'Acme' : null }),
    );
    const out = intel.computeClosetIntelligence(items, {}, NOW);
    strings.push(intel.describeCoverage(out.classificationCoverage, 'a category'));
    for (const f of out.fieldCoverage) strings.push(intel.describeCoverage(f, 'a brand'));
    for (const c of out.categoryCounts) strings.push(intel.describeCategory(c));
  }

  assert.ok(strings.length > 20, `the sweep must cover real output (got ${strings.length})`);
  for (const s of strings) {
    const lower = s.toLowerCase();
    assert.ok(
      !/your wardrobe is \d+% complete/.test(lower),
      `forbidden completeness claim: ${s}`,
    );
    // Every statement carrying a number must scope itself to K Scan AI.
    if (/\d/.test(s)) {
      assert.ok(
        lower.includes('k scan ai'),
        `a number must be scoped to K Scan AI Closet records: ${s}`,
      );
    }
  }
});

test('LANGUAGE: category statements are descriptive, never prescriptive (section 59)', () => {
  const out = intel.computeClosetIntelligence(
    [item({ category: 'Tops' }), item({ category: 'Tops' }), item({ category: null, taxonomyUnknown: true })],
    {},
    NOW,
  );
  for (const c of out.categoryCounts) {
    const s = intel.describeCategory(c);
    for (const banned of ['you need', 'you should', 'consider', 'buy', 'shop', 'missing']) {
      assert.ok(!s.toLowerCase().includes(banned), `category copy must not recommend: ${s}`);
    }
  }
  assert.equal(intel.describeCategory(out.categoryCounts[0]), 'You have 2 Tops items in K Scan AI.');
});

test('LANGUAGE: an empty Closet produces no misleading percentage', () => {
  const out = intel.computeClosetIntelligence([], {}, NOW);
  assert.equal(out.classificationCoverage.percent, 0);
  assert.equal(out.classificationCoverage.meetsFilterFloor, false);
  assert.match(
    intel.describeCoverage(out.classificationCoverage, 'a category'),
    /No items in your K Scan AI Closet yet/,
  );
});

test('the panel renders nothing at all for an empty Closet (section 24)', () => {
  const panel = fs.readFileSync(
    path.join(ROOT, 'components/closet/ClosetIntelligencePanel.tsx'),
    'utf8',
  );
  assert.match(
    panel,
    /if \(intelligence\.totalItems === 0\) return null;/,
    'no meaningless analytics over an empty Closet',
  );
});

test('robustness: junk input does not throw', () => {
  assert.equal(intel.computeClosetIntelligence(null).totalItems, 0);
  assert.equal(intel.computeClosetIntelligence(undefined, undefined).totalItems, 0);
  assert.equal(intel.computeClosetIntelligence([null, undefined, item()], {}, NOW).totalItems, 1);
});
