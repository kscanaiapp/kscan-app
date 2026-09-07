// Closet Intelligence V1 — the contract bridge (PR B, sections 19/20).
//
//     REAL CLOSET CONTRACT
//             |
//     MACHINE-READABLE SCHEMA        services/closet/closetContractSchema.json
//             |
//     ELISE / CONCIERGE FIXTURES     tools/elise-concierge-eval/fixtures/closets
//             |
//         VALID / FAIL
//
// Two jobs, and the first is the one that matters most:
//
//   1. THE SCHEMA MUST TRACK SOURCE. It is generated from real Closet truth, so
//      it is asserted against source — the taxonomy field list, the projection's
//      own fields, the bounds, and the intelligence contract's actual output.
//      A schema that drifts from the code is worse than no schema, because
//      everything downstream would then validate against a fiction.
//
//   2. DOWNSTREAM FIXTURES MUST CONFORM. The Elise/Concierge evaluation harness
//      carries Closet fixtures. This test proves whether they describe items a
//      real Closet can produce.
//
// This test validates the evaluation INSTRUMENT. It changes no Elise behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function runModule(rel, shim = () => ({})) {
  const source = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${source}\n})`, { filename: rel })(
    mod.exports,
    mod,
    shim,
  );
  return mod.exports;
}

const schema = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'services/closet/closetContractSchema.json'), 'utf8'),
);

const lens = runModule('services/closet/closetInventory.ts');
const review = runModule('services/closet/closetReview.ts');
const intelligence = runModule('services/closet/closetIntelligence.ts', (spec) => {
  if (spec === './closetInventory') return lens;
  if (spec === './closetReview') return review;
  return {};
});

// ── 1. The schema tracks source ───────────────────────────────────────────────

test('BRIDGE: the schema carries every committed taxonomy field, and no invented one', () => {
  // Read the field list out of the store itself rather than restating it.
  const store = fs.readFileSync(path.join(ROOT, 'services/closetLibrary.js'), 'utf8');
  const block = store.slice(
    store.indexOf('export const CLOSET_ITEM_TAXONOMY_FIELDS'),
    store.indexOf(']);', store.indexOf('export const CLOSET_ITEM_TAXONOMY_FIELDS')),
  );
  const taxonomyFields = [...block.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.equal(taxonomyFields.length, 8, `expected 8 taxonomy fields, found ${taxonomyFields.length}`);

  const schemaProps = Object.keys(schema.definitions.closetItem.properties);
  for (const field of taxonomyFields) {
    assert.ok(
      schemaProps.includes(field),
      `the schema is missing committed taxonomy field ${field} — it would let a fixture omit a real field`,
    );
  }
});

test('BRIDGE: every schema item property really exists on the read projection', () => {
  const projectionSource = fs.readFileSync(
    path.join(ROOT, 'services/closetItemProjection.ts'),
    'utf8',
  );
  const typeBlock = projectionSource.slice(
    projectionSource.indexOf('export type ClosetItemTaxonomy'),
    projectionSource.indexOf('function text('),
  );
  for (const prop of Object.keys(schema.definitions.closetItem.properties)) {
    assert.ok(
      new RegExp(`\\b${prop}\\b`).test(typeBlock),
      `the schema declares "${prop}" but the read projection does not expose it — the schema must never invent a future field`,
    );
  }
});

test('BRIDGE: the schema NEVER exposes internal provenance', () => {
  // The projection drops these by construction; the schema must not put them
  // back, or a downstream consumer would believe it may read them.
  const schemaProps = Object.keys(schema.definitions.closetItem.properties);
  for (const internal of [
    'sourceCandidateId',
    'sourceLineageId',
    'sourceSavedScanId',
    'sourceLocalScanId',
    'clientRequestId',
    'ownerId',
    'schemaVersion',
  ]) {
    assert.ok(!schemaProps.includes(internal), `the schema must not expose internal field ${internal}`);
  }
});

test('BRIDGE: the declared bounds match the store bounds exactly', () => {
  const store = fs.readFileSync(path.join(ROOT, 'services/closetLibrary.js'), 'utf8');
  const boundsBlock = store.slice(
    store.indexOf('const CLOSET_ITEM_TAXONOMY_BOUNDS'),
    store.indexOf('});', store.indexOf('const CLOSET_ITEM_TAXONOMY_BOUNDS')),
  );
  const bounds = Object.fromEntries(
    [...boundsBlock.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );

  const props = schema.definitions.closetItem.properties;
  for (const [field, max] of Object.entries(bounds)) {
    const declared =
      props[field].type === 'array' ? props[field].items.maxLength : props[field].maxLength;
    assert.equal(
      declared,
      max,
      `schema bound for ${field} is ${declared} but the store enforces ${max}`,
    );
  }
});

test('BRIDGE: the intelligence contract version in the schema matches the module', () => {
  assert.equal(
    schema.intelligenceContractVersion,
    intelligence.CLOSET_INTELLIGENCE_CONTRACT_VERSION,
    'a shape change that does not bump the version is how a fixture silently stops describing reality',
  );
  assert.equal(
    schema.definitions.closetIntelligence.properties.contractVersion.const,
    intelligence.CLOSET_INTELLIGENCE_CONTRACT_VERSION,
  );
});

test('BRIDGE: the real intelligence output validates against the declared schema', () => {
  const item = (over = {}) => ({
    id: 'closet_1',
    title: 'Navy Wool Coat',
    notes: null,
    origin: 'direct_intake',
    imageUri: null,
    thumbnailUri: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    category: 'Outerwear',
    clothingType: null,
    subtype: null,
    brand: 'Acme',
    primaryColor: 'navy',
    secondaryColors: [],
    material: ['wool'],
    size: 'M',
    displaySummary: null,
    taxonomyUnknown: false,
    ...over,
  });

  const out = intelligence.computeClosetIntelligence(
    [item(), item({ id: 'closet_2', category: null, taxonomyUnknown: true, brand: null })],
    {},
    Date.parse('2026-01-15T00:00:00.000Z'),
  );

  const declared = schema.definitions.closetIntelligence;
  // Every required key is present...
  for (const key of declared.required) {
    assert.ok(key in out, `intelligence output is missing required contract key ${key}`);
  }
  // ...and no key exists that the contract does not declare. This direction is
  // the one that catches a field added to the module and never written down.
  for (const key of Object.keys(out)) {
    assert.ok(
      key in declared.properties,
      `intelligence output has undeclared key "${key}" — bump the contract version and update the schema`,
    );
  }
  assert.equal(out.recentlyAddedWindowDays, declared.properties.recentlyAddedWindowDays.const);
  assert.ok(
    declared.properties.duplicateDetection.enum.includes(out.duplicateDetection),
    'duplicateDetection value is outside the declared enum',
  );
});

// ── 2. Downstream fixtures conform ────────────────────────────────────────────

const FIXTURE_PATH = 'tools/elise-concierge-eval/fixtures/closets/closets.json';

function loadFixtures() {
  const full = path.join(ROOT, FIXTURE_PATH);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

test('BRIDGE: the Elise/Concierge Closet fixtures exist and are readable', () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures, `${FIXTURE_PATH} must exist for the bridge to mean anything`);
  assert.ok(Array.isArray(fixtures.closets) && fixtures.closets.length > 0);
});

/**
 * The fields the evaluation fixtures use that the real Closet DOES NOT STORE.
 *
 * This is the section 20 drift finding, recorded as data rather than prose.
 *
 * The eval harness models a wardrobe item with `subcategory`, `colors`,
 * `colorFamilies`, `materials`, `formality`, `layeringRole` and `seasons`. A
 * committed Closet record has `subtype`, `primaryColor`/`secondaryColors`,
 * `material` (singular) — and stores NO formality, NO layering role and NO
 * seasons at all. `layeringRole` is DERIVED server-side by
 * eliseClosetCensus.inferLayeringRole(category, subtype); it is not a stored
 * fact and a Closet cannot supply it.
 *
 * This list is deliberately explicit and asserted below, so the drift cannot
 * grow silently: a NEW divergent field fails the test, while the known set is
 * documented with its real-Closet counterpart (or the absence of one).
 */
const KNOWN_FIXTURE_ONLY_FIELDS = Object.freeze({
  subcategory: 'renamed: the Closet stores `subtype`',
  colors: 'renamed/reshaped: the Closet stores `primaryColor` + `secondaryColors`',
  colorFamilies: 'NOT STORED by the Closet — an eval-only enrichment',
  materials: 'renamed: the Closet stores `material` (singular)',
  formality: 'NOT STORED by the Closet',
  layeringRole: 'NOT STORED — derived server-side by eliseClosetCensus.inferLayeringRole',
  seasons: 'NOT STORED by the Closet',
});

test('BRIDGE: fixture drift from the real Closet contract is bounded and declared', () => {
  const fixtures = loadFixtures();
  const seen = new Set();
  for (const closet of fixtures.closets) {
    for (const item of closet.items ?? []) {
      for (const key of Object.keys(item)) seen.add(key);
    }
  }

  const schemaProps = new Set(Object.keys(schema.definitions.closetItem.properties));
  const divergent = [...seen].filter((k) => !schemaProps.has(k)).sort();

  assert.deepEqual(
    divergent,
    Object.keys(KNOWN_FIXTURE_ONLY_FIELDS).sort(),
    'the Elise/Concierge Closet fixtures use a field the real Closet contract does not have, and it is not in the declared drift set. Either the Closet gained the field (update the schema) or the fixture invented one (fix the fixture) — a fixture that models facts a Closet cannot produce evaluates a wardrobe that does not exist.',
  );
});

test('BRIDGE: fixture fields that DO map to the Closet obey the real bounds', () => {
  const fixtures = loadFixtures();
  const props = schema.definitions.closetItem.properties;

  for (const closet of fixtures.closets) {
    for (const item of closet.items ?? []) {
      if (typeof item.title === 'string') {
        assert.ok(
          item.title.length <= props.title.maxLength,
          `fixture title exceeds the Closet bound: ${item.title}`,
        );
      }
      if (typeof item.category === 'string') {
        assert.ok(
          item.category.length <= props.category.maxLength,
          `fixture category exceeds the Closet bound: ${item.category}`,
        );
      }
      if (item.brand !== null && item.brand !== undefined) {
        assert.equal(typeof item.brand, 'string', 'fixture brand must be a string or null');
        assert.ok(item.brand.length <= props.brand.maxLength);
      }
      if (Array.isArray(item.materials)) {
        assert.ok(
          item.materials.length <= props.material.maxItems,
          'fixture material list exceeds the Closet 8-entry bound',
        );
      }
    }
  }
});

test('BRIDGE: every fixture item carries the fields the Closet guarantees', () => {
  const fixtures = loadFixtures();
  for (const closet of fixtures.closets) {
    for (const item of closet.items ?? []) {
      // `id` and `title` are structurally mandatory on a real Closet record —
      // `buildClosetRecord` always produces both. A fixture without them is
      // modelling an item the store cannot create.
      assert.equal(typeof item.id, 'string', `fixture item in ${closet.id} has no id`);
      assert.ok(item.id.length > 0);
      assert.equal(typeof item.title, 'string', `fixture item ${item.id} has no title`);
      assert.ok(item.title.length > 0);
    }
  }
});
