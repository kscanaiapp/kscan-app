/**
 * Phase 7 — `clothingType` middle taxonomy tier, end to end.
 *
 * Phase 6 measured a concrete `clothingType` in ZERO of 20 classifiable cases.
 * The Phase 7 investigation proved that was not a parser, evaluator, projection
 * or reporting defect: the production contract carried only two taxonomy levels,
 * so there was never a third value to lose. This suite covers the contract
 * expansion that adds the middle tier:
 *
 *     category  ->  clothingType  ->  subtype
 *     pants     ->  jeans         ->  wide_leg_jeans
 *
 * What is proved here:
 *   1. the provider schemas permit `clothing_type` (single-item requires it);
 *   2. all three prompts ask for three DISTINCT levels and never instruct the
 *      model to copy one tier into another;
 *   3. `identification.clothing_type` survives sanitization;
 *   4. it reaches `item.clothingType` through the one normalizer;
 *   5. category and subtype behaviour is unchanged;
 *   6. absent / uncertain values are never back-filled from a neighbour;
 *   7. the V1 legacy projection is contract-identical;
 *   8. the benchmark scoring projection reads the same path V2 writes;
 *   9. the evaluator scores the three tiers independently.
 *
 * Every fixture here is SYNTHETIC deterministic input. None of it is historical
 * provider evidence, and nothing in this file reads or rewrites a Phase 6
 * artifact. No network, no provider, no Supabase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    Set,
    Map,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    RegExp,
    require: (id) => {
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const V2 = loadTsModule('supabase/functions/_shared/fashionIdentificationV2.ts');
const MULTI = loadTsModule('supabase/functions/scan-identify/multiItemGarments.ts');

const scoringProjection = require('../tools/scanner-evaluation/lib/scoringProjection');
const normalizedResultValidation = require('../tools/scanner-evaluation/lib/normalizedResultValidation');
const scoreFields = require('../tools/scanner-evaluation/lib/scoreFields');

const INDEX_SOURCE = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/scan-identify/index.ts'),
  'utf8',
);

/**
 * The three tiers used throughout, deliberately DISTINCT so that any test which
 * passes by copying one level into another would fail.
 */
const TIERS = Object.freeze({ category: 'pants', clothingType: 'jeans', subtype: 'wide_leg_jeans' });

function providerIdentification(overrides = {}) {
  return {
    visual_observation: 'Dark blue wide-leg jeans laid flat.',
    item_type: TIERS.category,
    clothing_type: TIERS.clothingType,
    subtype: TIERS.subtype,
    primary_color: 'dark blue',
    material_estimate: 'denim',
    confidence_score: 0.84,
    non_fashion: false,
    ...overrides,
  };
}

function normalizeClassified(identification, extra = {}) {
  return V2.normalizeToV2({
    requestId: 'req_phase7',
    outcome: 'classified',
    evidenceIds: ['ev-00000001'],
    identification,
    attributes: {},
    ...extra,
  });
}

// ── 1. Provider response schemas ────────────────────────────────────────────

test('the single-item schema declares clothing_type and REQUIRES it beside its siblings', () => {
  const schema = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('const SELECTED_ITEM_RESPONSE_SCHEMA'),
    INDEX_SOURCE.indexOf('function buildSelectedItemPrompt'),
  );
  assert.ok(schema.length > 0, 'located the single-item schema');
  assert.match(schema, /clothing_type: \{ type: 'STRING' \}/);

  const required = schema.slice(schema.indexOf('required: ['), schema.indexOf('recommendedProducts'));
  for (const field of ['item_type', 'clothing_type', 'subtype']) {
    assert.ok(required.includes(`'${field}'`), `${field} is required in the single-item schema`);
  }
});

test('the multi-item schema permits clothing_type but does not require it', () => {
  const schema = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('const MULTI_ITEM_RESPONSE_SCHEMA'),
    INDEX_SOURCE.indexOf('const SELECTED_ITEM_RESPONSE_SCHEMA'),
  );
  assert.ok(schema.length > 0, 'located the multi-item schema');
  assert.match(schema, /clothing_type: \{ type: 'STRING' \}/);

  const required = schema.slice(schema.indexOf('required: ['));
  assert.ok(required.includes("'item_type'"), 'item_type stays required');
  assert.equal(
    required.includes("'clothing_type'"),
    false,
    'the compact detection pass must not force a third tier on every candidate',
  );
});

test('clothing_type is on the sanitizer allowlist, so the parser retains it', () => {
  const allowlist = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('const IDENTIFICATION_STRING_KEYS'),
    INDEX_SOURCE.indexOf('const IDENTIFICATION_ARRAY_KEYS'),
  );
  assert.match(allowlist, /'clothing_type'/);
});

// ── 2. Prompt contract ──────────────────────────────────────────────────────

/**
 * Targeted contract assertions rather than full-string snapshots: a snapshot
 * would break on any unrelated wording change and would not actually prove the
 * three levels are described as distinct.
 */
for (const [label, marker, end] of [
  ['IDENTIFY_PROMPT', 'const IDENTIFY_PROMPT', 'const MULTI_ITEM_IDENTIFY_PROMPT'],
  ['TEXT_IDENTIFY_PROMPT', 'const TEXT_IDENTIFY_PROMPT', '// ── Helpers'],
]) {
  test(`${label} asks for all three taxonomy levels`, () => {
    const prompt = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf(marker), INDEX_SOURCE.indexOf(end));
    assert.ok(prompt.length > 0, `located ${label}`);

    for (const field of ['item_type', 'clothing_type', 'subtype']) {
      assert.ok(prompt.includes(`- ${field}`), `${label} lists ${field}`);
    }
    assert.match(prompt, /item_type: the broad product category/);
    assert.match(prompt, /clothing_type: the recognizable garment or footwear family/);
    assert.match(prompt, /subtype: the most specific/);
    assert.match(prompt, /must not repeat each other/);
    assert.match(prompt, /rather than repeating another level/);
  });
}

test('the prompts never instruct the model to copy one tier into another', () => {
  for (const forbidden of [
    /copy .{0,20}item_type .{0,20}clothing_type/i,
    /clothing_type .{0,30}same as .{0,20}(item_type|subtype)/i,
    /repeat .{0,20}(item_type|category) .{0,20}(as|into) .{0,20}clothing_type/i,
  ]) {
    assert.equal(forbidden.test(INDEX_SOURCE), false, `prompt must not say: ${forbidden}`);
  }
});

test('the worked examples keep the three levels distinct, never triplicated', () => {
  const identifyPrompt = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('const IDENTIFY_PROMPT'),
    INDEX_SOURCE.indexOf('const MULTI_ITEM_IDENTIFY_PROMPT'),
  );
  // The footwear example is the one that must not read footwear/footwear/footwear.
  assert.match(identifyPrompt, /"item_type": "footwear",\s*\n\s*"clothing_type": "sneaker",/);

  // No example may set all three levels to the same value.
  const triples = [...identifyPrompt.matchAll(
    /"item_type": "([^"]+)",\s*\n\s*"clothing_type": "([^"]+)",\s*\n\s*"subtype": "([^"]+)"/g,
  )];
  assert.ok(triples.length >= 3, 'the worked examples carry all three tiers');
  for (const [, category, clothingType, subtype] of triples) {
    assert.equal(
      category === clothingType && clothingType === subtype,
      false,
      `example triplicates one value: ${category}/${clothingType}/${subtype}`,
    );
  }
});

// ── 3. Normalization into the V2 contract ───────────────────────────────────

test('identification.clothing_type reaches item.clothingType', () => {
  const result = normalizeClassified(providerIdentification());

  assert.equal(result.item.clothingType, TIERS.clothingType);
  assert.equal(result.item.category, TIERS.category);
  assert.equal(result.item.subtype, TIERS.subtype);

  // Three tiers, three distinct values.
  assert.equal(new Set([result.item.category, result.item.clothingType, result.item.subtype]).size, 3);
});

test('category and subtype behaviour is unchanged by the new tier', () => {
  const withTier = normalizeClassified(providerIdentification());
  const withoutTier = normalizeClassified(providerIdentification({ clothing_type: undefined }));

  assert.equal(withTier.category, withoutTier.category);
  assert.equal(withTier.item.category, withoutTier.item.category);
  assert.equal(withTier.item.subtype, withoutTier.item.subtype);
  assert.equal(withTier.status, withoutTier.status);
  assert.equal(withTier.resolutionLevel, withoutTier.resolutionLevel);
  assert.equal(withTier.confidence.category, withoutTier.confidence.category);
});

test('an absent middle tier is null and is NEVER back-filled from a neighbour', () => {
  for (const absent of [undefined, null, '', '   ']) {
    const result = normalizeClassified(providerIdentification({ clothing_type: absent }));
    assert.equal(result.item.clothingType, null, `clothing_type=${JSON.stringify(absent)} projects to null`);
    assert.equal(result.item.category, TIERS.category, 'category still populated');
    assert.equal(result.item.subtype, TIERS.subtype, 'subtype still populated');
  }
});

test('an uncertainty token passes through unrewritten, exactly like its siblings', () => {
  const result = normalizeClassified(providerIdentification({ clothing_type: 'unknown' }));
  assert.equal(result.item.clothingType, 'unknown');
});

test('a non-identity outcome carries no middle tier', () => {
  for (const outcome of ['non_fashion', 'technical_failure', 'insufficient_visual_evidence']) {
    const result = V2.normalizeToV2({
      requestId: 'req_phase7',
      outcome,
      evidenceIds: ['ev-00000001'],
      identification: providerIdentification(),
      attributes: {},
    });
    assert.equal(result.item.clothingType, null, `${outcome} must not carry an identity`);
    assert.equal(result.item.category, null);
    assert.equal(result.item.subtype, null);
  }
});

test('the multi-item sanitizer keeps a distinct clothingType per candidate', () => {
  const garments = MULTI.sanitizeDetectedGarments([
    {
      label: 'dark blue jeans',
      category: 'pants',
      clothing_type: 'jeans',
      subtype: 'wide_leg_jeans',
      confidenceScore: 0.8,
      visual_observation: 'Wide-leg jeans.',
      item_type: 'pants',
      primary_color: 'dark blue',
    },
    {
      label: 'black blazer',
      category: 'blazer',
      clothing_type: 'blazer',
      subtype: 'double-breasted blazer',
      confidenceScore: 0.9,
      visual_observation: 'A black blazer.',
      item_type: 'blazer',
      primary_color: 'black',
    },
    {
      label: 'brown boot',
      category: 'footwear',
      subtype: 'chelsea_boot',
      confidenceScore: 0.7,
      visual_observation: 'A brown boot.',
      item_type: 'footwear',
      primary_color: 'brown',
    },
  ]);

  assert.equal(garments.length, 3);
  assert.equal(garments[0].clothingType, 'jeans');
  assert.equal(garments[1].clothingType, 'blazer');
  assert.equal(
    garments[2].clothingType,
    undefined,
    'a candidate with no supplied tier stays absent rather than inheriting its category',
  );

  // The compact detection pass must not smuggle the tier into the legacy
  // passthrough object.
  assert.equal('clothing_type' in garments[0].identification, false);
});

test('multi-item candidates carry the tier into the V2 result', () => {
  const result = V2.normalizeToV2({
    requestId: 'req_phase7',
    outcome: 'multiple_items_need_selection',
    evidenceIds: ['ev-00000001'],
    identification: providerIdentification(),
    attributes: {},
    candidates: [
      { candidateId: 'c1', evidenceId: 'ev-00000001', category: 'pants', clothingType: 'jeans', subtype: 'wide_leg_jeans' },
      { candidateId: 'c2', evidenceId: 'ev-00000001', category: 'footwear', subtype: 'chelsea_boot' },
    ],
  });

  assert.equal(result.candidates[0].clothingType, 'jeans');
  assert.equal(result.candidates[1].clothingType, undefined);
});

// ── 4. Legacy / V1 protection ───────────────────────────────────────────────

test('the V1 legacy projection is contract-identical — same keys, same values', () => {
  const withTier = V2.projectV2ToLegacy(normalizeClassified(providerIdentification()));
  const withoutTier = V2.projectV2ToLegacy(
    normalizeClassified(providerIdentification({ clothing_type: undefined })),
  );

  // Exactly the documented V1 field set, and nothing more.
  assert.deepEqual(Object.keys(withTier).sort(), [
    'brand_guess',
    'confidence_score',
    'item_type',
    'primary_color',
    'status',
    'subtype',
  ]);
  assert.equal('clothingType' in withTier, false, 'V1 must not gain the new field');
  assert.equal('clothing_type' in withTier, false, 'V1 must not gain the new field');

  // Presence of the tier changes nothing a V1 consumer can observe.
  assert.deepEqual(withTier, withoutTier);
});

test('the legacy identification passthrough is stripped of the V2-only tier', () => {
  // The handler holds `clothing_type` out of the object legacy clients receive
  // and re-attaches it for V2 normalization only.
  const isolation = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('V2-only taxonomy tier isolation'),
    INDEX_SOURCE.indexOf('const completedNormalizedId'),
  );
  assert.ok(isolation.length > 0, 'located the isolation block');
  assert.match(isolation, /clothing_type: _omitted/);
  assert.match(isolation, /normalized\('completed', userMessage, attributes, legacyIdentification\)/);

  const v2Reattach = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('const v2Result: FashionIdentificationResultV2'),
    INDEX_SOURCE.indexOf('Hard commerce decision'),
  );
  assert.match(v2Reattach, /clothing_type: v2ClothingType/);
});

// ── 5. Benchmark projection and evaluator integration ───────────────────────

/** The exact path V2 writes, projected into the exact path the scorer reads. */
function projectNormalized(identification) {
  const result = normalizeClassified(identification);
  const validation = normalizedResultValidation.validateNormalizedResult(
    JSON.parse(JSON.stringify(result)),
  );
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  return scoringProjection.projectV2ForScoring(validation.value);
}

test('the evaluator reads the same path the V2 projection writes', () => {
  assert.ok(scoringProjection.SCORER_INPUT_KEYS.includes('clothingType'));

  const projected = projectNormalized(providerIdentification());
  assert.equal(projected.clothingType, TIERS.clothingType);
  assert.equal(projected.category, TIERS.category);
  assert.equal(projected.subtype, TIERS.subtype);
});

test('a correct middle-tier value is credited', () => {
  const projected = projectNormalized(providerIdentification());
  const scored = scoreFields.scoreField('clothingType', TIERS.clothingType, projected.clothingType);
  assert.equal(scored.disposition, scoreFields.DISPOSITIONS.CORRECT);
});

test('an incorrect middle-tier value is not credited', () => {
  const projected = projectNormalized(providerIdentification({ clothing_type: 'boot' }));
  const scored = scoreFields.scoreField('clothingType', TIERS.clothingType, projected.clothingType);
  assert.notEqual(scored.disposition, scoreFields.DISPOSITIONS.CORRECT);
  assert.notEqual(scored.disposition, scoreFields.DISPOSITIONS.ACCEPTABLY_BROAD);
});

test('an absent middle tier remains uncredited rather than fabricated', () => {
  const projected = projectNormalized(providerIdentification({ clothing_type: undefined }));
  assert.equal(projected.clothingType, null);

  const scored = scoreFields.scoreField('clothingType', TIERS.clothingType, projected.clothingType);
  assert.equal(scored.disposition, scoreFields.DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS);
  assert.notEqual(scored.disposition, scoreFields.DISPOSITIONS.CORRECT);
  assert.notEqual(scored.disposition, scoreFields.DISPOSITIONS.NOT_MEASURED);
});

test('an uncertainty token is an abstention, not a concrete answer', () => {
  const projected = projectNormalized(providerIdentification({ clothing_type: 'unknown' }));
  const scored = scoreFields.scoreField('clothingType', TIERS.clothingType, projected.clothingType);
  assert.equal(scored.disposition, scoreFields.DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS);
});

test('the three tiers are scored INDEPENDENTLY — one prediction is never counted twice', () => {
  // The model gets the middle tier right and the subtype wrong. If any layer
  // copied one tier into another, these two could not disagree.
  const projected = projectNormalized(providerIdentification({ subtype: 'skinny_jeans' }));

  const category = scoreFields.scoreField('category', TIERS.category, projected.category);
  const clothingType = scoreFields.scoreField('clothingType', TIERS.clothingType, projected.clothingType);
  const subtype = scoreFields.scoreField('subtype', TIERS.subtype, projected.subtype);

  assert.equal(category.disposition, scoreFields.DISPOSITIONS.CORRECT);
  assert.equal(clothingType.disposition, scoreFields.DISPOSITIONS.CORRECT);
  assert.notEqual(subtype.disposition, scoreFields.DISPOSITIONS.CORRECT);
});

test('the middle tier is a real provider value, not a copy of a neighbour', () => {
  // The provider supplies ONLY category and subtype. A back-filling
  // implementation would produce a concrete clothingType here.
  const projected = projectNormalized({
    visual_observation: 'Dark blue wide-leg jeans laid flat.',
    item_type: TIERS.category,
    subtype: TIERS.subtype,
    primary_color: 'dark blue',
    confidence_score: 0.84,
    non_fashion: false,
  });

  assert.equal(projected.clothingType, null);
  assert.notEqual(projected.clothingType, projected.category);
  assert.notEqual(projected.clothingType, projected.subtype);
});

// ── 6. Phase 6 evidence is untouched ────────────────────────────────────────

test('the locked Phase 6 control baseline still reports its historical zero', () => {
  const locked = JSON.parse(fs.readFileSync(
    path.join(
      ROOT,
      'docs/scanner-accuracy/phase6/control-baselines',
      'baseline-v0.3.1-v140-20260803-0531-e4ac29c-development-exec',
      'control-baseline.json',
    ),
    'utf8',
  ));

  assert.equal(locked.immutable, true);
  assert.equal(locked.suppressionMetrics.byField.clothingType.answeredN, 0);
  assert.equal(locked.accuracyMetrics.neutral.identification.clothingType.correct, 0);
  assert.equal(locked.accuracyMetrics.neutral.identification.clothingType.gradeableN, 18);
});
