'use strict';

/**
 * Phase 0B harness repair tests (contract section 15).
 * Deterministic, offline, zero paid calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ontology = require('../lib/ontology');
const resultState = require('../lib/resultState');
const multiImage = require('../lib/multiImage');
const fallbackTracking = require('../lib/fallbackTracking');
const runnerState = require('../lib/runnerState');
const {
  DISPOSITIONS,
  scoreField,
  scoreCase,
  scoreCaseAllProfiles,
  aggregateScores,
  penaltyFor,
} = require('../lib/scoreFields');
const { validateCase } = require('../lib/datasetValidate');
const { splitDataset, validateSplit } = require('../lib/datasetSplit');
const runBaseline = require('../run-baseline');
const freezeDataset = require('../freeze-dataset');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const O = ontology.OUTCOMES;

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kscan-eval-${name}-`));
}

// ── 4.1 Ontology ─────────────────────────────────────────────────────────────

test('ontology: exact match', () => {
  assert.equal(ontology.compareTaxonomy('chore_jacket', 'chore_jacket').outcome, O.EXACT);
  assert.equal(ontology.compareTaxonomy('low_top_sneaker', 'low_top_sneaker').outcome, O.EXACT);
});

test('ontology: valid one-level-broader match', () => {
  assert.equal(ontology.compareTaxonomy('chore_jacket', 'jacket').outcome, O.BROADER);
  assert.equal(ontology.compareTaxonomy('low_top_sneaker', 'sneaker').outcome, O.BROADER);
  assert.equal(ontology.compareTaxonomy('shoulder_bag', 'handbag').outcome, O.BROADER);
  assert.equal(ontology.compareTaxonomy('sneaker', 'footwear').outcome, O.BROADER);
  assert.equal(ontology.compareTaxonomy('handbag', 'bag').outcome, O.BROADER);
});

test('ontology: two levels broader is NOT acceptably broad', () => {
  const r = ontology.compareTaxonomy('chore_jacket', 'outerwear');
  assert.equal(r.outcome, O.UNRELATED);
  assert.equal(r.twoLevelsBroader, true);
});

test('ontology: invalid cross-category match is never credited', () => {
  // The Phase 0A substring matcher credited this as acceptably broad because
  // "bootcut_jeans".includes("boot"). A footwear prediction on a bottoms label
  // must be cross-category.
  const r = ontology.compareTaxonomy('bootcut_jeans', 'boot');
  assert.equal(r.outcome, O.UNRELATED);
  assert.equal(r.crossCategory, true);
});

test('ontology: disputed blazer/outerwear follows production sibling semantics', () => {
  const r = ontology.compareTaxonomy('blazer', 'outerwear');
  assert.equal(r.outcome, O.UNRELATED);
  assert.equal(r.disputed, true);
});

test('ontology: evaluation aliases resolve plural label vocabulary', () => {
  assert.equal(ontology.compareTaxonomy('tops', 'top').outcome, O.EXACT);
  assert.equal(ontology.compareTaxonomy('bottoms', 'pants').outcome, O.EXACT);
  // An alias never upgrades an unrelated value into a match.
  assert.equal(ontology.compareTaxonomy('tops', 'footwear').outcome, O.UNRELATED);
});

test('ontology: out-of-ontology prediction is scoreable, not excused', () => {
  const r = ontology.compareTaxonomy('sneaker', 'spaceship');
  assert.equal(r.outcome, O.UNRELATED);
  assert.equal(r.unmappedPrediction, true);
});

// ── 4.2 Color ────────────────────────────────────────────────────────────────

test('color-family comparison', () => {
  assert.equal(ontology.compareColor('navy', 'navy').outcome, O.EXACT);
  assert.equal(ontology.compareColor('navy', 'blue').outcome, O.BROADER);
  assert.equal(ontology.compareColor('burgundy', 'red').outcome, O.BROADER);
  assert.equal(ontology.compareColor('off_white', 'white').outcome, O.BROADER);
});

test('color: narrower assertion is not acceptably broad', () => {
  const r = ontology.compareColor('blue', 'navy');
  assert.equal(r.outcome, O.UNRELATED);
  assert.equal(r.narrower, true);
});

test('color: same-family peers are unrelated, not broad', () => {
  const r = ontology.compareColor('navy', 'cobalt');
  assert.equal(r.outcome, O.UNRELATED);
  assert.equal(r.peer, true);
});

test('color: teal has a documented terminal rule and is never folded into blue', () => {
  assert.equal(ontology.compareColor('teal', 'blue').outcome, O.UNRELATED);
  const disputed = ontology.COLORS.disputedMappings.find((d) => d.value === 'teal');
  assert.ok(disputed, 'teal must be documented as disputed');
  assert.match(disputed.status, /UNRESOLVED/);
});

// ── 4.3 Material ─────────────────────────────────────────────────────────────

test('material-family comparison', () => {
  assert.equal(ontology.compareMaterial('cotton', 'cotton').outcome, O.EXACT);
  // Production collapses cashmere -> wool in normalizeMaterial.
  assert.equal(ontology.compareMaterial('cashmere', 'wool').outcome, O.BROADER);
});

test('material: faux leather and leather are never equated, in either direction', () => {
  const a = ontology.compareMaterial('faux leather', 'leather');
  const b = ontology.compareMaterial('leather', 'faux leather');
  assert.equal(a.outcome, O.UNRELATED);
  assert.equal(a.forbiddenPair, true);
  assert.equal(b.outcome, O.UNRELATED);
  assert.equal(b.forbiddenPair, true);
});

test('material: denim is terminal and never folded into cotton', () => {
  assert.equal(ontology.compareMaterial('denim', 'cotton').outcome, O.UNRELATED);
});

// ── 4.4 Brand ────────────────────────────────────────────────────────────────

test('brand normalization handles formatting only', () => {
  assert.equal(ontology.normalizeBrand('  GUCCI  '), 'gucci');
  assert.equal(ontology.normalizeBrand('Levi’s'), 'levis');
  assert.equal(ontology.normalizeBrand('Nike®'), 'nike');
  assert.equal(ontology.normalizeBrand('Acme Inc.'), 'acme');
  assert.equal(ontology.compareBrand('Gucci', 'GUCCI').outcome, O.EXACT);
});

test('brand normalization never merges similar but distinct brands', () => {
  const pairs = [
    ['Ralph Lauren', 'Polo Ralph Lauren'],
    ['Armani', 'Emporio Armani'],
    ['The North Face', 'North Face'],
    ['New Balance', 'Balance'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(ontology.compareBrand(a, b).outcome, O.UNRELATED, `${a} must stay distinct from ${b}`);
  }
  assert.deepEqual(ontology.BRANDS.aliasTable.entries, [], 'alias table must ship empty');
});

// ── 4.5 Result state ─────────────────────────────────────────────────────────

const styleResult = {
  status: 'completed',
  resolutionLevel: 'brand_and_subtype',
  exactProduct: null,
  item: { category: 'footwear', subtype: 'low_top_sneaker' },
};

test('result state: mapping is derived from real production fields only', () => {
  // The four evaluation states are eval-only. Guard the production vocabularies.
  assert.deepEqual([...resultState.PRODUCTION_STATUSES], [
    'completed', 'partial', 'insufficient_visual_evidence',
    'non_fashion', 'multiple_items_need_selection', 'technical_failure',
  ]);
  assert.equal(resultState.deriveObservedResultState(styleResult).state, 'identified_style');
  assert.equal(
    resultState.deriveObservedResultState({ status: 'insufficient_visual_evidence', resolutionLevel: 'unknown' }).state,
    'insufficient_evidence'
  );
});

test('result state: expected insufficient evidence, actual exact claim -> unsupported_certainty', () => {
  const scored = resultState.scoreResultState(
    { expectedResultType: 'insufficient_evidence', category: 'footwear' },
    { status: 'completed', resolutionLevel: 'exact_product', exactProduct: { sku: 'ABC', model: 'X' } }
  );
  assert.equal(scored.disposition, resultState.DISPOSITIONS.UNSUPPORTED_CERTAINTY);
});

test('result state: expected identified style, actual broad style identity -> correct', () => {
  const scored = resultState.scoreResultState(
    { expectedResultType: 'identified_style', category: 'footwear' },
    styleResult
  );
  assert.equal(scored.disposition, resultState.DISPOSITIONS.CORRECT);
});

test('result state: expected closest matches, actual incorrect exact claim -> unsupported_certainty', () => {
  const scored = resultState.scoreResultState(
    { expectedResultType: 'closest_matches', category: 'footwear' },
    { status: 'completed', resolutionLevel: 'exact_product', exactProduct: { sku: 'WRONG', model: null } }
  );
  assert.equal(scored.disposition, resultState.DISPOSITIONS.UNSUPPORTED_CERTAINTY);
});

test('result state: expected exact match, actual reliable style identity -> under-identification', () => {
  const scored = resultState.scoreResultState(
    { expectedResultType: 'likely_exact_match', category: 'footwear' },
    styleResult
  );
  assert.equal(scored.disposition, resultState.DISPOSITIONS.UNDER_IDENTIFICATION);
  // MC-1: forced by the contract, not chosen by the model.
  assert.equal(scored.contractCeilingAttributable, true);
});

test('result state: expected non-fashion, actual fashion identity -> unsupported_certainty', () => {
  const scored = resultState.scoreResultState(
    { expectedResultType: 'insufficient_evidence', category: 'not_applicable' },
    styleResult
  );
  assert.equal(scored.disposition, resultState.DISPOSITIONS.UNSUPPORTED_CERTAINTY);
  assert.equal(scored.nonFashionFalsePositive, true);
});

test('measurement ceiling MC-1 is asserted, so a contract change cannot pass silently', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/_shared/fashionIdentificationV2.ts'),
    'utf8'
  );
  // normalizeToV2 must still pass exactProduct: null into deriveResolutionLevel
  // and must still emit exactProduct: null. If either changes, exact_product
  // becomes reachable and the baseline's attribution must be revisited.
  assert.match(source, /exactProduct: null,\n\s*\}\)\n\s*: 'unknown';/);
  assert.match(source, /\n    exactProduct: null,\n/);
  assert.ok(
    !resultState.REACHABLE_RESOLUTION_LEVELS.includes('exact_product'),
    'exact_product must not be listed as reachable'
  );
});

// ── 4.6 Uncertainty ──────────────────────────────────────────────────────────

test('uncertainty: ground truth unknown', () => {
  assert.equal(scoreField('material', 'unknown', null).disposition, DISPOSITIONS.CORRECT_ABSTENTION);
  assert.equal(scoreField('material', 'unknown', 'unknown').disposition, DISPOSITIONS.CORRECT_ABSTENTION);
  assert.equal(scoreField('material', 'unknown', 'cashmere').disposition, DISPOSITIONS.UNSUPPORTED_CERTAINTY);
});

test('uncertainty: ground truth not_visible', () => {
  assert.equal(scoreField('brand', 'not_visible', null).disposition, DISPOSITIONS.CORRECT);
  assert.equal(scoreField('brand', 'not_visible', 'unknown').disposition, DISPOSITIONS.CORRECT);
  const asserted = scoreField('brand', 'not_visible', 'Gucci');
  assert.equal(asserted.disposition, DISPOSITIONS.UNSUPPORTED_CERTAINTY);
  assert.equal(asserted.evidenceStrictViolation, true);
});

test('uncertainty: ground truth not_applicable', () => {
  assert.equal(scoreField('material', 'not_applicable', null).disposition, DISPOSITIONS.CORRECT);
  assert.equal(scoreField('material', 'not_applicable', 'cotton').disposition, DISPOSITIONS.INCORRECT);
});

test('uncertainty: ground truth known', () => {
  assert.equal(scoreField('subtype', 'chore_jacket', 'chore_jacket').disposition, DISPOSITIONS.CORRECT);
  assert.equal(scoreField('subtype', 'chore_jacket', 'jacket').disposition, DISPOSITIONS.ACCEPTABLY_BROAD);
  assert.equal(scoreField('subtype', 'chore_jacket', null).disposition, DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS);
  assert.equal(scoreField('subtype', 'chore_jacket', 'loafer').disposition, DISPOSITIONS.INCORRECT);
});

test('brand and exact product prefer null over an unsupported guess', () => {
  const abstained = scoreField('brand', 'gucci', null);
  const guessed = scoreField('brand', 'gucci', 'prada');
  assert.equal(abstained.disposition, DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS);
  assert.equal(guessed.disposition, DISPOSITIONS.UNSUPPORTED_CERTAINTY);
  assert.ok(guessed.penalty > abstained.penalty, 'a wrong brand must cost more than an honest unknown');
});

// ── 4.7 Field-specific trust weights ─────────────────────────────────────────

test('field-specific weighting: brand/exact-product overconfidence outweighs colour and material', () => {
  const brand = penaltyFor('brand', DISPOSITIONS.UNSUPPORTED_CERTAINTY, 'trust_weighted');
  const exact = penaltyFor('exactProduct', DISPOSITIONS.UNSUPPORTED_CERTAINTY, 'trust_weighted');
  const color = penaltyFor('primaryColor', DISPOSITIONS.UNSUPPORTED_CERTAINTY, 'trust_weighted');
  const material = penaltyFor('material', DISPOSITIONS.UNSUPPORTED_CERTAINTY, 'trust_weighted');
  assert.ok(brand > color && brand > material);
  assert.ok(exact > brand);
});

test('neutral profile weights every field equally', () => {
  const brand = penaltyFor('brand', DISPOSITIONS.INCORRECT, 'neutral');
  const color = penaltyFor('primaryColor', DISPOSITIONS.INCORRECT, 'neutral');
  assert.equal(brand, color);
});

test('both profiles are produced for every case', () => {
  const label = {
    caseId: 'x-1', datasetVersion: '0.1.0', category: 'footwear', clothingType: 'sneaker',
    subtype: 'unknown', primaryColor: 'red', secondaryColors: 'unknown', material: 'unknown',
    pattern: 'unknown', brand: 'not_visible', exactProduct: 'unknown',
    expectedResultType: 'identified_style', expectedAbstention: false,
  };
  const profiles = scoreCaseAllProfiles(label, styleResult);
  assert.ok(profiles.neutral && profiles.trust_weighted);
  assert.equal(profiles.neutral.profile, 'neutral');
  assert.equal(profiles.trust_weighted.profile, 'trust_weighted');
});

// ── 4.8 Non-fashion false positives ──────────────────────────────────────────

test('non-fashion false positive metric', () => {
  const nonFashionLabel = { category: 'not_applicable', expectedResultType: 'insufficient_evidence' };
  const correct = resultState.scoreNonFashion(nonFashionLabel, { status: 'non_fashion', resolutionLevel: 'unknown' });
  assert.equal(correct.disposition, resultState.DISPOSITIONS.CORRECT);

  const falsePositive = resultState.scoreNonFashion(nonFashionLabel, styleResult);
  assert.equal(falsePositive.disposition, resultState.DISPOSITIONS.UNSUPPORTED_CERTAINTY);
  assert.equal(falsePositive.nonFashionFalsePositive, true);

  const wrongAbstention = resultState.scoreNonFashion(
    { category: 'footwear', expectedResultType: 'identified_style' },
    { status: 'non_fashion', resolutionLevel: 'unknown' }
  );
  assert.equal(wrongAbstention.disposition, resultState.DISPOSITIONS.INCORRECT);
  assert.equal(wrongAbstention.incorrectAbstention, true);
});

test('nonFashionFalsePositiveRate is aggregated', () => {
  const label = {
    caseId: 'nf-1', datasetVersion: '0.1.0', category: 'not_applicable', clothingType: 'not_applicable',
    subtype: 'not_applicable', primaryColor: 'not_applicable', secondaryColors: 'not_applicable',
    material: 'not_applicable', pattern: 'not_applicable', brand: 'not_applicable',
    exactProduct: 'not_applicable', expectedResultType: 'insufficient_evidence', expectedAbstention: true,
  };
  const metrics = aggregateScores([scoreCase(label, styleResult)]);
  assert.equal(metrics.nonFashion.cases, 1);
  assert.equal(metrics.nonFashionFalsePositiveRate, 1);
});

// ── 4.9 Fallback ─────────────────────────────────────────────────────────────

test('fallback tracking records reason, model and route', () => {
  const event = fallbackTracking.recordFallbackEvent({
    caseId: 'c1', fallbackInvoked: true, fallbackReason: 'primary_model_timeout',
    model: 'gemini-3.5-flash-lite', route: 'v2_fallback_model',
  });
  assert.equal(event.reason, 'primary_model_timeout');
  assert.equal(event.model, 'gemini-3.5-flash-lite');
  assert.equal(event.route, 'v2_fallback_model');
});

test('fallback: system-level and primary-path metrics are both produced', () => {
  const cases = [
    { caseId: 'a', totalPenalty: 0, profile: 'neutral', fields: [], dispositionCounts: {}, flags: { fallbackInvoked: false } },
    { caseId: 'b', totalPenalty: 4, profile: 'neutral', fields: [], dispositionCounts: {}, flags: { fallbackInvoked: true } },
  ];
  const events = [fallbackTracking.recordFallbackEvent({ caseId: 'b', fallbackInvoked: true, fallbackReason: 'primary_model_error', route: 'v2_fallback_model' })];
  const report = fallbackTracking.buildDualPathReport(cases, events, aggregateScores);
  assert.equal(report.fallback.fallbackCount, 1);
  assert.equal(report.fallback.fallbackInvocationRate, 0.5);
  assert.equal(report.systemLevelMetrics.caseCount, 2);
  assert.equal(report.primaryPathMetrics.caseCount, 1);
  assert.deepEqual(report.excludedFromPrimaryPath, ['b']);
});

// ── 4.10 Multi-image ─────────────────────────────────────────────────────────

function img(evidenceId, angleHint, item) {
  return { evidenceId, angleHint, result: { status: 'completed', resolutionLevel: 'subtype', item } };
}

test('multi-image: independent per-image consistency is measured', () => {
  const label = { caseId: 'set-1', sameItemAcrossImages: true };
  const analysis = multiImage.analyzeImageSet(label, [
    img('e1', 'front', { category: 'footwear', subtype: 'low_top_sneaker', brand: { value: null, provenance: 'unknown' }, colors: { primary: 'red' }, material: [] }),
    img('e2', 'side', { category: 'footwear', subtype: 'low_top_sneaker', brand: { value: null, provenance: 'unknown' }, colors: { primary: 'red' }, material: [] }),
  ]);
  assert.equal(analysis.scorable, true);
  assert.equal(analysis.fields.category.agreementRate, 1);
  assert.equal(analysis.fields.category.consensus, 'footwear');
  assert.equal(analysis.disagreementFieldCount, 0);
});

test('multi-image: direct label/logo evidence outranks inferred resemblance', () => {
  const label = { caseId: 'set-2', sameItemAcrossImages: true };
  const analysis = multiImage.analyzeImageSet(label, [
    img('e1', 'front', { category: 'footwear', subtype: 'sneaker', brand: { value: 'adidas', provenance: 'visual' }, colors: { primary: 'red' }, material: [] }),
    img('e2', 'front', { category: 'footwear', subtype: 'sneaker', brand: { value: 'adidas', provenance: 'visual' }, colors: { primary: 'red' }, material: [] }),
    img('e3', 'logo', { category: 'footwear', subtype: 'sneaker', brand: { value: 'nike', provenance: 'logo_shape' }, colors: { primary: 'red' }, material: [] }),
  ]);
  // Two inferences said adidas; one logo image said nike. Direct evidence wins.
  assert.equal(analysis.fields.brand.consensus, 'nike');
  assert.equal(analysis.fields.brand.resolvedBy, 'direct_evidence_precedence');
  assert.equal(analysis.fields.brand.directEvidenceChangedConclusion, true);
  assert.equal(analysis.directEvidenceChangedConclusion, true);
});

test('multi-image: unresolved conflict is marked conflicting_evidence and not scored', () => {
  const label = { caseId: 'set-3', sameItemAcrossImages: true };
  const analysis = multiImage.analyzeImageSet(label, [
    img('e1', 'front', { category: 'footwear', subtype: 'sneaker', brand: { value: 'nike', provenance: 'visual' }, colors: { primary: 'red' }, material: [] }),
    img('e2', 'side', { category: 'footwear', subtype: 'sneaker', brand: { value: 'adidas', provenance: 'visual' }, colors: { primary: 'red' }, material: [] }),
  ]);
  assert.equal(analysis.fields.brand.consensus, multiImage.CONFLICT);
  assert.equal(analysis.fields.brand.conflict, true);
  assert.ok(analysis.unscorableFields.includes('brand'));
  const consolidated = multiImage.consolidateSetPrediction(analysis);
  assert.equal(consolidated.brand, undefined, 'a conflicting field must not be guessed');
});

test('multi-image: a set without reviewer same-item confirmation is not scorable', () => {
  const analysis = multiImage.analyzeImageSet(
    { caseId: 'set-4', sameItemAcrossImages: 'unknown' },
    [img('e1', 'front', { category: 'footwear' }), img('e2', 'front', { category: 'bag' })]
  );
  assert.equal(analysis.scorable, false);
  assert.match(analysis.reason, /same item/);
});

// ── 4.11 Dry run and resume ──────────────────────────────────────────────────

test('dry run makes zero model calls and writes zero case results', () => {
  const dir = tmpDir('dryrun');
  const result = runBaseline.main(['--dry-run', '--output-dir', dir], {
    executor: () => { throw new Error('executor must never be called in a dry run'); },
    now: '2026-07-29T00:00:00.000Z',
  });
  assert.equal(result.mode, 'dry_run');
  assert.equal(result.executedCallCount, 0);
  assert.equal(result.budget.executed, 0);
  assert.ok(result.plannedCallCount > 0, 'a dry run must still plan the call graph');
  assert.equal(fs.existsSync(path.join(dir, runnerState.CASES_DIR)), false, 'cases/ must not be created');
  assert.equal(result.planDocument.guarantees.modelCallsExecuted, 0);
  assert.equal(result.planDocument.guarantees.networkCallsExecuted, 0);
  assert.equal(result.planDocument.guarantees.persistenceWritesExecuted, 0);
  assert.equal(result.planDocument.guarantees.commerceEnabled, false);
});

test('dry run validates hashes, authorization, privacy and expected result state', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json'), 'utf8')
  );
  const good = runBaseline.preflightCase(manifest.cases[0]);
  assert.equal(good.ok, true);
  assert.equal(good.resolvedImages.length, 1);

  const tampered = { ...manifest.cases[0], imageHashes: [`sha256:${'0'.repeat(64)}`] };
  const bad = runBaseline.preflightCase(tampered);
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((f) => f.check === 'image_hash'));

  const unauthorized = { ...manifest.cases[0], authorizationStatus: 'pending_authorization' };
  assert.equal(runBaseline.preflightCase(unauthorized).ok, false);

  const blockedPrivacy = { ...manifest.cases[0], privacyDisposition: 'blocked_private' };
  assert.equal(runBaseline.preflightCase(blockedPrivacy).ok, false);

  const badState = { ...manifest.cases[0], expectedResultType: 'made_up_state' };
  assert.equal(runBaseline.preflightCase(badState).ok, false);
});

test('the runner ships no executor, so --execute cannot make a paid call by accident', () => {
  assert.throws(() => runBaseline.unauthorizedExecutor(), /No execution adapter is installed/);
});

test('resume does not re-call a completed case', () => {
  const dir = tmpDir('resume');
  const cases = [{ caseId: 'a' }, { caseId: 'b' }, { caseId: 'c' }];
  runnerState.writeCaseResult(dir, 'a', { caseId: 'a', datasetVersion: '0.1.0' });

  const selection = runnerState.selectCases(cases, { outputDir: dir, resume: true });
  assert.deepEqual(selection.toProcess.map((c) => c.caseId), ['b', 'c']);
  assert.deepEqual(selection.skipped, ['a']);
});

test('duplicate output is detected when not resuming', () => {
  const dir = tmpDir('dupe');
  runnerState.writeCaseResult(dir, 'a', { caseId: 'a', datasetVersion: '0.1.0' });
  assert.throws(
    () => runnerState.selectCases([{ caseId: 'a' }], { outputDir: dir, resume: false }),
    runnerState.DuplicateOutput
  );
  assert.throws(
    () => runnerState.writeCaseResult(dir, 'a', { caseId: 'a' }),
    runnerState.DuplicateOutput
  );
});

test('hard call ceiling stops the run', () => {
  const budget = new runnerState.CallBudget(2);
  budget.consume(1);
  budget.consume(1);
  assert.equal(budget.remaining(), 0);
  assert.throws(() => budget.consume(1), runnerState.CallCeilingExceeded);
});

test('--start-case and --case-id narrow the selection', () => {
  const dir = tmpDir('select');
  const cases = [{ caseId: 'a' }, { caseId: 'b' }, { caseId: 'c' }];
  assert.deepEqual(
    runnerState.selectCases(cases, { outputDir: dir, resume: false, startCase: 'b' }).toProcess.map((c) => c.caseId),
    ['b', 'c']
  );
  assert.deepEqual(
    runnerState.selectCases(cases, { outputDir: dir, resume: false, caseId: 'c' }).toProcess.map((c) => c.caseId),
    ['c']
  );
  assert.throws(() => runnerState.selectCases(cases, { outputDir: dir, resume: false, caseId: 'zzz' }), /matched no governed case/);
});

test('failures are preserved and do not count as completed', () => {
  const dir = tmpDir('failures');
  runnerState.writeFailure(dir, 'b', { caseId: 'b', error: 'boom' });
  assert.deepEqual([...runnerState.failedCaseIds(dir)], ['b']);
  assert.deepEqual([...runnerState.completedCaseIds(dir)], []);
  const selection = runnerState.selectCases([{ caseId: 'b' }], { outputDir: dir, resume: true });
  assert.deepEqual(selection.toProcess.map((c) => c.caseId), ['b'], 'a failed case must be retried on resume');
});

test('the runner never combines results from different dataset versions', () => {
  const dir = tmpDir('versions');
  runnerState.writeCaseResult(dir, 'a', { caseId: 'a', datasetVersion: '0.1.0' });
  runnerState.writeCaseResult(dir, 'b', { caseId: 'b', datasetVersion: '0.2.0' });
  assert.throws(() => runnerState.loadAllResults(dir, '0.1.0'), /mixes dataset versions/);
});

// ── Dataset split ────────────────────────────────────────────────────────────

test('development/holdout split validation', () => {
  const cases = [];
  for (let i = 0; i < 20; i += 1) {
    cases.push({
      caseId: `c-${i}`,
      category: i % 4 === 0 ? 'footwear' : 'top',
      brandVisible: i % 2 === 0,
      exactProductKnowable: i % 5 === 0,
      expectedResultType: i % 7 === 0 ? 'insufficient_evidence' : 'identified_style',
      sourceClass: i === 19 ? 'synthetic_image' : 'kscan_qa_fixture',
      imageCount: i % 6 === 0 ? 2 : 1,
    });
  }
  const split = splitDataset(cases, { holdoutCount: 5 });
  assert.equal(split.holdout.length + split.development.length, cases.length);
  const overlap = split.holdout.filter((id) => split.development.includes(id));
  assert.deepEqual(overlap, [], 'holdout and development must be disjoint');
  assert.ok(!split.holdout.includes('c-19'), 'synthetic cases must never enter the holdout');
});

test('split validation rejects a synthetic case in the holdout', () => {
  const cases = [
    { caseId: 'a', sourceClass: 'synthetic_image', category: 'top' },
    { caseId: 'b', sourceClass: 'kscan_qa_fixture', category: 'top' },
  ];
  const report = validateSplit(cases, { development: ['b'], holdout: ['a'] });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /synthetic/i.test(e.message)));
});

test('split validation rejects overlapping membership', () => {
  const cases = [{ caseId: 'a', sourceClass: 'kscan_qa_fixture', category: 'top' }];
  const report = validateSplit(cases, { development: ['a'], holdout: ['a'] });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /both/i.test(e.message)));
});

// ── Reviewer, adjudication, privacy and retention schema ─────────────────────

function governedCase(overrides = {}) {
  return {
    caseId: 'gov-1',
    datasetVersion: '0.2.0',
    imageReferences: [{ refType: 'governed_qa_fixture', refValue: 'assets/qa_fixtures/top.jpg' }],
    imageHashes: [`sha256:${'a'.repeat(64)}`],
    imageCount: 1,
    sameItemAcrossImages: 'not_applicable',
    category: 'top',
    clothingType: 'unknown',
    subtype: 'unknown',
    primaryColor: 'unknown',
    secondaryColors: 'unknown',
    material: 'unknown',
    pattern: 'unknown',
    brand: 'unknown',
    exactProduct: 'unknown',
    expectedResultType: 'identified_style',
    expectedAbstention: false,
    reviewStatus: 'approved',
    reviewerCount: 2,
    labelConfidence: 'medium',
    sourceClass: 'kscan_qa_fixture',
    authorizationStatus: 'approved_qa_fixture',
    privacyDisposition: 'governed_fixture_reference',
    privacyReviewDate: '2026-07-29',
    retentionPolicyRef: 'docs/scanner-accuracy/phase0b-privacy-retention.md#retention',
    exifRemoved: true,
    faceReviewState: 'no_face_present',
    plateReviewState: 'no_plate_present',
    derivativeStatus: 'original_approved',
    governedStorageRef: 'repo:assets/qa_fixtures',
    reviewerLabels: [
      { reviewerRole: 'primary', labels: { category: 'top' }, confidence: 'medium' },
      { reviewerRole: 'secondary', labels: { category: 'top' }, confidence: 'high' },
    ],
    adjudication: { required: false, fields: [], notes: '' },
    notes: 'test case',
    ...overrides,
  };
}

test('privacyReviewDate is required', () => {
  const result = validateCase(governedCase({ privacyReviewDate: undefined }), { requirePhase0bPrivacy: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'privacyReviewDate'));
});

test('retention fields are required', () => {
  const result = validateCase(governedCase({ retentionPolicyRef: undefined }), { requirePhase0bPrivacy: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'retentionPolicyRef'));
});

test('EXIF state is required and false blocks the case', () => {
  const missing = validateCase(governedCase({ exifRemoved: undefined }), { requirePhase0bPrivacy: true });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.path === 'exifRemoved'));

  const notRemoved = validateCase(governedCase({ exifRemoved: false }), { requirePhase0bPrivacy: true });
  assert.equal(notRemoved.ok, false);
});

test('reviewer labels are stored for both reviewers', () => {
  const ok = validateCase(governedCase(), { requirePhase0bPrivacy: true, requireTwoReviewers: true });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));

  const single = validateCase(
    governedCase({ reviewerLabels: [{ reviewerRole: 'primary', labels: { category: 'top' }, confidence: 'medium' }], reviewerCount: 1 }),
    { requirePhase0bPrivacy: true, requireTwoReviewers: true }
  );
  assert.equal(single.ok, false);
  assert.ok(single.errors.some((e) => /two independent/i.test(e.message)));
});

test('adjudication is required when reviewers disagree', () => {
  const disagreeing = governedCase({
    reviewerLabels: [
      { reviewerRole: 'primary', labels: { category: 'top' }, confidence: 'medium' },
      { reviewerRole: 'secondary', labels: { category: 'outerwear' }, confidence: 'medium' },
    ],
    adjudication: { required: false, fields: [], notes: '' },
  });
  const result = validateCase(disagreeing, { requirePhase0bPrivacy: true, requireTwoReviewers: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /adjudication/i.test(e.message)));
});

test('reviewer identities are not stored in the case record', () => {
  const withName = governedCase({
    reviewerLabels: [
      { reviewerRole: 'primary', reviewerEmail: 'someone@example.com', labels: { category: 'top' }, confidence: 'medium' },
      { reviewerRole: 'secondary', labels: { category: 'top' }, confidence: 'high' },
    ],
  });
  const result = validateCase(withName, { requirePhase0bPrivacy: true });
  assert.equal(result.ok, false);
});

test('synthetic cases may not carry brand or exact-product ground truth', () => {
  const bad = governedCase({ sourceClass: 'synthetic_image', brand: 'gucci', syntheticMeta: { generationMethod: 'x', reason: 'y', realismReview: 'approved' } });
  const result = validateCase(bad, { requirePhase0bPrivacy: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /synthetic/i.test(e.message)));
});

// ── Dataset freeze ───────────────────────────────────────────────────────────

test('freeze gate refuses the current dataset and names every failing precondition', () => {
  const evaluation = freezeDataset.evaluateFreeze(
    path.join(ROOT, 'evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json')
  );
  assert.equal(evaluation.ok, false, 'an 8-case unreviewed dataset must not be freezable');
  for (const expected of ['case_count', 'authorization_verified', 'two_reviewer_labeling', 'split_present']) {
    assert.ok(evaluation.failedGates.includes(expected), `expected failing gate: ${expected}`);
  }
  // The count gate must state the shortfall rather than merely failing.
  const countGate = evaluation.gates.find((g) => g.gate === 'case_count');
  assert.equal(countGate.detail.required, freezeDataset.TARGET_CASE_COUNT);
  assert.equal(countGate.detail.shortfall, freezeDataset.TARGET_CASE_COUNT - evaluation.caseCount);
});

test('freeze gate detects a dataset-version mismatch between manifest and cases', () => {
  const dir = tmpDir('freeze-mismatch');
  const manifestPath = path.join(dir, 'mismatch.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      datasetVersion: '0.2.0',
      cases: [{ ...governedCase(), datasetVersion: '0.1.0' }],
    }),
    'utf8'
  );
  const evaluation = freezeDataset.evaluateFreeze(manifestPath);
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failedGates.includes('structural_validation'));
});

test('freeze gate records a manifest hash so a frozen dataset is tamper-evident', () => {
  const evaluation = freezeDataset.evaluateFreeze(
    path.join(ROOT, 'evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json')
  );
  assert.match(evaluation.manifestSha256, /^[a-f0-9]{64}$/);
});

// ── Commerce and boundary ────────────────────────────────────────────────────

test('commerce metrics are marked not_measured', () => {
  const metrics = aggregateScores([]);
  assert.equal(metrics.commerce.commerceLinkValidity, 'not_measured');
  assert.equal(metrics.commerce.retailerRelevance, 'not_measured');
  assert.equal(metrics.commerce.duplicateSellerListings, 'not_measured');
  assert.equal(metrics.commerce.commerceCostUsd, 0);
});

test('evaluation code imports nothing from production runtime modules', () => {
  const dir = path.join(ROOT, 'tools/scanner-evaluation');
  const offenders = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.js$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      // A require() reaching into production source would couple the harness to
      // runtime code. Documented string references in provenance are fine.
      const requires = text.match(/require\(['"][^'"]+['"]\)/g) || [];
      for (const req of requires) {
        if (/(supabase\/functions|\.\.\/\.\.\/services|\.\.\/\.\.\/app|\.\.\/\.\.\/hooks|\.\.\/\.\.\/constants)/.test(req)) {
          offenders.push({ file: path.relative(ROOT, full), req });
        }
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, []);
});
