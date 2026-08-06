// PATTERN AS A STRUCTURED ATTRIBUTE (Build 25 Phase 2, BUG-11).
//
// Pattern was never a missing field. `item.pattern: string[]` has been a
// REQUIRED key of the canonical fashion contract all along, the scanner prompt
// already asks for it, and the shared normalizer already produces it. It was
// lost on the way to the user in two places:
//
//   1. services/library.js persisted a six-key legacy attribute block that had
//      no pattern, so a reopened scan could never show one — and every cloud
//      consumer reading analysis_result.metadata.pattern read null forever;
//   2. no surface rendered it. `grep -ri pattern components/` returned nothing.
//
// So this is plumbing over ONE canonical contract, not a second attribute
// model. Nothing here introduces a competing vocabulary.
//
// The honesty rule these encode: an absent pattern stays absent. "unknown" is
// the model declining to answer, and defaulting it to "solid" would be a claim
// about the fabric that the scan never made.
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

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function runModule(rel, requireShim = () => ({})) {
  const mod = { exports: {} };
  const js = ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
  vm.runInThisContext(`(function (exports, module, require) {\n${js}\n})`, { filename: rel })(
    mod.exports,
    mod,
    requireShim,
  );
  return mod.exports;
}

const display = runModule('services/scannerV2Display.ts');

// ── Pattern is already in the one canonical contract ─────────────────────────

test('pattern is a required key of the canonical contract, not a new field', () => {
  const contract = read('types/fashionIdentificationV2.ts');
  assert.match(contract, /pattern: string\[\]/, 'the contract must still declare pattern');

  const schema = JSON.parse(read('contracts/fashion-identification-v2.schema.json'));
  const item = schema.definitions?.result?.properties?.item;
  assert.ok(item, 'the schema must describe result.item');
  assert.ok(
    (item.required ?? []).includes('pattern'),
    'pattern must remain REQUIRED — this repair adds no field',
  );
  assert.equal(item.properties?.pattern?.type, 'array', 'pattern is a list in the contract');
});

test('the backend already asks the model for pattern', () => {
  // If this stops being true the plumbing below has nothing to carry.
  const index = read('supabase/functions/scan-identify/index.ts');
  assert.match(index, /pattern/, 'the scanner prompt/schema must still request pattern');
});

// ── Normalization: absent stays absent, never invented ───────────────────────

test('a real pattern is preserved verbatim', () => {
  for (const value of ['striped', 'Plaid', 'floral', 'animal print', 'geometric']) {
    assert.equal(display.normalizePatternLabel(value), value.trim());
  }
});

test('"unknown" is the model declining to answer, not a pattern', () => {
  for (const value of ['unknown', 'Unknown', 'UNKNOWN', ' unknown ']) {
    assert.equal(display.normalizePatternLabel(value), '');
  }
});

test('placeholder and null-ish values never reach a chip', () => {
  for (const value of ['none', 'n/a', 'N/A', 'null', 'undefined', 'not specified', 'other', '']) {
    assert.equal(display.normalizePatternLabel(value), '');
  }
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(display.normalizePatternLabel(value), '');
  }
});

test('an unknown pattern is NOT defaulted to solid', () => {
  // Inventing "solid" would assert the garment is unpatterned, which is a
  // different claim from "we could not tell".
  assert.notEqual(display.normalizePatternLabel('unknown'), 'solid');
  assert.equal(display.normalizePatternLabel(undefined), '');
});

test('a genuine "solid" reported by the model IS kept', () => {
  // The inverse of the rule above: solid is a real answer when the model gives
  // it, and dropping it would lose information the scan did establish.
  assert.equal(display.normalizePatternLabel('solid'), 'solid');
});

// ── Persistence: pattern survives a save ─────────────────────────────────────

test('the saved scan record persists pattern', () => {
  const source = read('services/library.js');
  const block = source.slice(source.indexOf('attributes: {'), source.indexOf('style_tags:'));
  assert.match(block, /pattern:/, 'the legacy attribute block dropped pattern — that is BUG-11');
  assert.match(
    source,
    /pattern:\s*analysis\.metadata\?\.pattern \?\? null/,
    'absent must persist as null, never as an invented value',
  );
});

test('the mapper strips a non-answer before it is ever persisted', () => {
  const source = read('services/scanIdentificationMapper.ts');
  assert.match(source, /normalizePatternLabel/, 'the mapper must normalize pattern');
  assert.match(
    source,
    /if \(patternLabel\) next\.pattern = patternLabel;/,
    'an empty label must leave the key absent rather than writing ""',
  );
});

// ── Surface parity ───────────────────────────────────────────────────────────

test('Scan Results renders Pattern alongside the other attributes', () => {
  const panel = read('components/scan-results/StyleMatchPanel.tsx');
  assert.match(panel, /label="Pattern"/, 'the Scan Results chips must include Pattern');
  assert.match(
    panel,
    /hasMetadata = category \|\| color \|\| silhouette \|\| material \|\| pattern/,
    'a scan whose ONLY attribute is pattern must still show the metadata row',
  );

  const screen = read('components/scan-results/ScanResultV2.tsx');
  assert.match(screen, /pattern=\{v2Data\.pattern\}/, 'the screen must pass pattern down');
});

test('the scan detail view renders Pattern', () => {
  const card = read('components/AnalysisCard.tsx');
  assert.match(card, /label="Pattern"/);
  assert.match(card, /\{pattern \? \(/, 'the chip must be conditional on having one');
  assert.equal(
    /const pattern\s+= sanitizeText/.test(card),
    false,
    'sanitizeText substitutes an em dash, which would render an empty Pattern chip',
  );
});

test('the contract carries pattern from the legacy shape to the V2 view model', () => {
  const types = read('components/scan-results/types.ts');
  assert.match(types, /pattern\?: string;/, 'both the view model and the legacy metadata');
  assert.match(types, /pattern: meta\.pattern \|\| undefined/, 'mapLegacyToV2 must copy it');
});

test('a reopened Recent Scan passes its persisted pattern to the detail view', () => {
  const library = read('app/library.tsx');
  assert.match(library, /pattern\?: string \| null;/, 'the scan attribute type must carry it');
  assert.match(
    library,
    /pattern: selectedScan\.attributes\.pattern \?\? null/,
    'reopening a scan must hand its pattern to the detail view',
  );
});

// ── Historical compatibility ─────────────────────────────────────────────────

test('a scan saved before pattern existed still opens', () => {
  // Optional on the type and null-coalesced at every read, so a pre-repair
  // record has no pattern rather than being unreadable.
  const library = read('app/library.tsx');
  assert.match(library, /pattern\?: string \| null;/, 'the field must be optional');

  const card = read('components/AnalysisCard.tsx');
  assert.match(card, /pattern\?: string \| null;/, 'the detail view must accept it missing');
  assert.match(
    card,
    /typeof meta\.pattern === 'string' \? meta\.pattern\.trim\(\) : ''/,
    'a missing pattern must read as absent, not throw',
  );
});

test('no second attribute model was introduced', () => {
  // The constraint that matters most here. Pattern is plumbed over the existing
  // contract; nothing declares a competing vocabulary or enum.
  for (const rel of [
    'services/scannerV2Display.ts',
    'services/scanIdentificationMapper.ts',
    'components/scan-results/StyleMatchPanel.tsx',
  ].filter(exists)) {
    const source = read(rel);
    assert.equal(
      /PATTERN_VOCABULARY|PatternEnum|PATTERN_TAXONOMY/.test(source),
      false,
      `${rel} declares a competing pattern taxonomy`,
    );
  }
});

// ── Negative controls ────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: the pre-repair persisted block had no pattern', () => {
  // The exact six keys library.js wrote before this repair.
  const preRepair = {
    category: 'Outerwear',
    silhouette: 'Bomber',
    color_palette: 'Navy',
    material_estimate: 'Wool',
    style_tags: [],
    confidence_score: 0.9,
  };
  assert.equal(
    Object.prototype.hasOwnProperty.call(preRepair, 'pattern'),
    false,
    'the old attribute block must be shown to drop pattern',
  );
  assert.equal(preRepair.pattern ?? null, null, 'which is why a reopened scan showed none');
});

test('NEGATIVE CONTROL: an un-normalized pattern would render "unknown"', () => {
  // What a surface would show without normalizePatternLabel.
  const raw = ['unknown'];
  assert.equal(raw.filter(Boolean).join(', '), 'unknown', 'the naive join surfaces the non-answer');

  // And the repaired path drops it.
  assert.equal(
    raw.map((entry) => display.normalizePatternLabel(entry)).filter(Boolean).join(', '),
    '',
  );
});

test('NEGATIVE CONTROL: a fabricated pattern is detectable', () => {
  // If anyone "helpfully" defaults an absent pattern, these are the shapes that
  // would appear — and the normalizer must not produce any of them.
  for (const absent of [undefined, null, '', 'unknown']) {
    const result = display.normalizePatternLabel(absent);
    assert.equal(result, '', `an absent pattern became "${result}"`);
    assert.notEqual(result, 'solid');
    assert.notEqual(result, 'none');
  }
});
