// Closet item → private Dressing Room slot classification (Phase 2, Stage 3).
//
// Table-driven against the keyword vocabulary the repository actually uses
// (services/free-tier/outfitGenerator.ts#bucketForCategory), because Closet
// taxonomy is free-form text from the backend classifier rather than a closed
// enum — there is no value list to enumerate exhaustively.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const moduleCache = new Map();

function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  vm.runInThisContext(`(function (exports, module, require) {\n${output}\n})`, { filename })(
    mod.exports,
    mod,
    localRequire,
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const slots = loadModule('services/privateDressingRoomSlots.ts');
const projection = loadModule('services/closetItemProjection.ts');

function project(fields) {
  return projection.getClosetItemProjection({ id: 'c1', title: 'Item', ...fields });
}

// ── Taxonomy → slot table ────────────────────────────────────────────────────
//
// Every value below is drawn from BUCKET_KEYWORDS in
// services/free-tier/outfitGenerator.ts, the repository's verified vocabulary.

const TABLE = [
  // [taxonomy value, expected slot]
  ['shirt', 'top'],
  ['blouse', 'top'],
  ['sweater', 'top'],
  ['knit', 'top'],
  ['t-shirt', 'top'],
  ['tee', 'top'],
  ['hoodie', 'top'],
  ['polo', 'top'],
  ['tank', 'top'],
  ['trousers', 'bottom'],
  ['pants', 'bottom'],
  ['jeans', 'bottom'],
  ['skirt', 'bottom'],
  ['shorts', 'bottom'],
  ['chinos', 'bottom'],
  ['leggings', 'bottom'],
  ['dress', 'dress'],
  ['gown', 'dress'],
  ['jumpsuit', 'dress'],
  ['romper', 'dress'],
  ['blazer', 'outerwear'],
  ['jacket', 'outerwear'],
  ['coat', 'outerwear'],
  ['parka', 'outerwear'],
  ['trench', 'outerwear'],
  ['cardigan', 'outerwear'],
  ['shoes', 'footwear'],
  ['sneakers', 'footwear'],
  ['boots', 'footwear'],
  ['heels', 'footwear'],
  ['loafers', 'footwear'],
  ['sandals', 'footwear'],
  ['trainers', 'footwear'],
  ['hat', 'accessory'],
  ['scarf', 'accessory'],
  ['belt', 'accessory'],
  ['watch', 'accessory'],
  ['sunglasses', 'accessory'],
  ['gloves', 'accessory'],
  ['tie', 'accessory'],
];

for (const [value, expected] of TABLE) {
  test(`subtype "${value}" classifies as ${expected}`, () => {
    const result = slots.classifyClosetItemSlot(project({ subtype: value }));
    assert.equal(result.primarySlot, expected);
    assert.equal(result.source, 'subtype');
    assert.equal(result.fallback, false);
    assert.equal(result.unsupportedReason, null);
  });
}

test('the repository category vocabulary maps as expected', () => {
  // Values seen on real records (analyze+api.js CATEGORY_CANONICAL,
  // free-tier/freeTierPreviewData.ts).
  const cases = [
    ['Tops', 'top'],
    ['Bottoms', 'bottom'],
    ['Outerwear', 'outerwear'],
    ['Footwear', 'footwear'],
    ['Dresses', 'dress'],
    ['Accessories', 'accessory'],
  ];
  for (const [category, expected] of cases) {
    const result = slots.classifyClosetItemSlot(project({ category }));
    assert.equal(result.primarySlot, expected, category);
    assert.equal(result.source, 'category');
  }
});

// ── Precedence ───────────────────────────────────────────────────────────────

test('subtype beats clothingType and category', () => {
  const result = slots.classifyClosetItemSlot(
    project({ subtype: 'jumpsuit', clothingType: 'shirt', category: 'Tops' }),
  );
  assert.equal(result.primarySlot, 'dress');
  assert.equal(result.source, 'subtype');
});

test('clothingType is used when subtype is absent or unrecognised', () => {
  const absent = slots.classifyClosetItemSlot(project({ clothingType: 'jeans', category: 'Tops' }));
  assert.equal(absent.primarySlot, 'bottom');
  assert.equal(absent.source, 'clothingType');

  const unrecognised = slots.classifyClosetItemSlot(
    project({ subtype: 'Zephyr', clothingType: 'jeans' }),
  );
  assert.equal(unrecognised.primarySlot, 'bottom');
  assert.equal(unrecognised.source, 'clothingType');
});

test('INHERITED LIMITATION: bucketForCategory matches substrings, not whole words', () => {
  // Documented rather than hidden. `bucketForCategory` tests with
  // `lower.includes(keyword)`, so 'capsule' contains the accessory keyword
  // 'cap'. Phase 2 reuses that engine deliberately — Closet taxonomy is
  // free-form text and a parallel vocabulary is exactly what the assignment
  // forbids — and the precedence order limits the blast radius, since a real
  // `subtype` is a garment word rather than prose. Changing the matcher would
  // alter free-tier outfit and pairing behaviour and is out of Phase 2 scope.
  const result = slots.classifyClosetItemSlot(project({ subtype: 'Spring capsule' }));
  assert.equal(result.primarySlot, 'accessory');
  assert.equal(result.source, 'subtype');
});

test('category is the last structured resort', () => {
  const result = slots.classifyClosetItemSlot(
    project({ subtype: 'Favourite', clothingType: 'Unknown', category: 'Footwear' }),
  );
  assert.equal(result.primarySlot, 'footwear');
  assert.equal(result.source, 'category');
});

test('title is used only when no structured field is recognised', () => {
  const result = slots.classifyClosetItemSlot(
    project({ title: 'Navy Blazer', subtype: null, clothingType: null, category: null }),
  );
  assert.equal(result.primarySlot, 'outerwear');
  assert.equal(result.source, 'title');
  assert.equal(result.fallback, true);
});

test('a recognised structured field is never overridden by the title', () => {
  const result = slots.classifyClosetItemSlot(
    project({ category: 'Footwear', title: 'Navy Blazer' }),
  );
  assert.equal(result.primarySlot, 'footwear', 'structured taxonomy wins');
  assert.equal(result.source, 'category');
});

test('a structured field recognised as a NON-outfit role blocks the title fallback', () => {
  // 'tote' buckets to `bag`, which this workspace does not compose around. The
  // taxonomy was present and understood, so the answer is "no outfit role" —
  // the title must not be re-read to manufacture one.
  const result = slots.classifyClosetItemSlot(
    project({ subtype: 'tote bag', title: 'Leather Blazer' }),
  );
  assert.equal(result.primarySlot, null);
  assert.equal(result.unsupportedReason, 'unsupported_role');
});

// ── Unsupported and ambiguous ────────────────────────────────────────────────

test('bag and other roles are unsupported, not silently re-slotted', () => {
  for (const value of ['tote', 'backpack', 'purse', 'clutch', 'crossbody']) {
    const result = slots.classifyClosetItemSlot(project({ subtype: value, title: 'Bag' }));
    assert.equal(result.primarySlot, null, value);
    assert.equal(result.unsupportedReason, 'unsupported_role');
  }
});

test('entirely unknown taxonomy is unclassified rather than guessed', () => {
  const result = slots.classifyClosetItemSlot(
    project({ subtype: 'Zephyr', clothingType: 'Quux', category: 'Miscellany', title: 'Thing' }),
  );
  assert.equal(result.primarySlot, null);
  assert.equal(result.unsupportedReason, 'unclassified');
  assert.deepEqual(result.secondarySlots, []);
});

test('a malformed or missing item fails safely', () => {
  for (const bad of [null, undefined, {}, { id: '' }, 'nope', 42, []]) {
    const result = slots.classifyClosetItemSlot(bad);
    assert.equal(result.primarySlot, null, JSON.stringify(bad));
    assert.ok(['invalid_item', 'unclassified'].includes(result.unsupportedReason));
  }
});

test('an empty-string taxonomy value is skipped, not treated as a match', () => {
  const result = slots.classifyClosetItemSlot(
    project({ subtype: '   ', clothingType: '', category: 'Tops' }),
  );
  assert.equal(result.primarySlot, 'top');
  assert.equal(result.source, 'category');
});

// ── Structural rules ─────────────────────────────────────────────────────────

test('a dress is a one-piece that can also serve as a top', () => {
  const result = slots.classifyClosetItemSlot(project({ subtype: 'dress' }));
  assert.equal(result.primarySlot, 'dress');
  assert.deepEqual(result.secondarySlots, ['top']);
  assert.deepEqual(slots.eligibleSlotsFor(result), ['dress', 'top']);
});

test('a blazer stays outerwear and may serve as a top layer', () => {
  const result = slots.classifyClosetItemSlot(project({ subtype: 'blazer' }));
  assert.equal(result.primarySlot, 'outerwear');
  assert.deepEqual(result.secondarySlots, ['top']);
});

test('footwear has no secondary role', () => {
  const result = slots.classifyClosetItemSlot(project({ subtype: 'loafers' }));
  assert.equal(result.primarySlot, 'footwear');
  assert.deepEqual(result.secondarySlots, []);
  assert.deepEqual(slots.eligibleSlotsFor(result), ['footwear']);
});

test('an accessory never replaces a core garment', () => {
  const result = slots.classifyClosetItemSlot(project({ subtype: 'scarf' }));
  assert.equal(result.primarySlot, 'accessory');
  assert.deepEqual(result.secondarySlots, []);
  for (const core of ['top', 'bottom', 'dress', 'footwear']) {
    assert.equal(slots.eligibleSlotsFor(result).includes(core), false);
  }
});

test('tops and bottoms have no secondary role', () => {
  assert.deepEqual(slots.classifyClosetItemSlot(project({ subtype: 'shirt' })).secondarySlots, []);
  assert.deepEqual(slots.classifyClosetItemSlot(project({ subtype: 'jeans' })).secondarySlots, []);
});

test('eligibleSlotsFor is empty for an unsupported item', () => {
  const result = slots.classifyClosetItemSlot(project({ subtype: 'tote' }));
  assert.deepEqual(slots.eligibleSlotsFor(result), []);
});

// ── List classification ──────────────────────────────────────────────────────

test('classifyClosetItems keeps only usable items and preserves order', () => {
  const items = [
    project({ subtype: 'shirt' }),
    project({ subtype: 'tote' }),
    project({ subtype: 'jeans' }),
    project({ subtype: 'Zephyr' }),
    project({ subtype: 'loafers' }),
  ];
  const classified = slots.classifyClosetItems(items);
  assert.equal(classified.length, 3);
  assert.deepEqual(
    classified.map((entry) => entry.classification.primarySlot),
    ['top', 'bottom', 'footwear'],
  );
});

test('classifyClosetItems handles a missing or malformed list', () => {
  assert.deepEqual(slots.classifyClosetItems(null), []);
  assert.deepEqual(slots.classifyClosetItems(undefined), []);
  assert.deepEqual(slots.classifyClosetItems('nope'), []);
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('classification never mutates the projection', () => {
  const item = project({ subtype: 'blazer', category: 'Outerwear' });
  const before = JSON.stringify(item);
  slots.classifyClosetItemSlot(item);
  slots.classifyClosetItems([item]);
  assert.equal(JSON.stringify(item), before);
});

test('the returned secondarySlots array is not shared between calls', () => {
  const a = slots.classifyClosetItemSlot(project({ subtype: 'dress' }));
  const b = slots.classifyClosetItemSlot(project({ subtype: 'dress' }));
  a.secondarySlots.push('footwear');
  assert.deepEqual(b.secondarySlots, ['top'], 'a caller cannot corrupt the shared table');
});

test('the classifier reads no trusted internal Closet field', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/privateDressingRoomSlots.ts'), 'utf8');
  // Field ACCESS, not file text: the header comment cites closetLibrary.js by
  // name to explain where taxonomy values come from.
  for (const internal of [
    'sourceCandidateId',
    'sourceLineageId',
    'contentHash',
    'ownerId',
    'clientRequestId',
  ]) {
    assert.equal(source.includes(`item.${internal}`), false, `must not read ${internal}`);
  }
  const imports = source.match(/^import .*$/gm) ?? [];
  for (const line of imports) {
    for (const forbidden of ['closetLibrary', 'expo-file-system', 'supabase']) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}`);
    }
  }
});

test('the classifier reuses the repository keyword engine rather than a new vocabulary', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/privateDressingRoomSlots.ts'), 'utf8');
  assert.match(source, /import \{ bucketForCategory \} from '\.\/free-tier\/outfitGenerator'/);
  // No second keyword list may be declared here.
  assert.equal(/\['(jacket|shirt|jean|sneaker)'/.test(source), false);
});
