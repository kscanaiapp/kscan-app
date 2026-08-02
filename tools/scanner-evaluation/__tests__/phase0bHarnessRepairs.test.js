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
  scoreExactProduct,
  aggregateScores,
  penaltyFor,
} = require('../lib/scoreFields');
const { validateCase } = require('../lib/datasetValidate');
const { splitDataset, validateSplit } = require('../lib/datasetSplit');
const runBaseline = require('../run-baseline');
const freezeDataset = require('../freeze-dataset');
const certifiedSource = require('../lib/certifiedSource');
const trackingGuard = require('../check-build4-tracking');

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

// Phase 0C reclassified MC-1. Scoring an exact-product expectation as
// under-identification attributed a contract limitation to the model, so the
// case is no longer scored on this axis at all — it is retained and tagged.
test('result state: expected exact match is NOT_MEASURED, not under-identification', () => {
  const scored = resultState.scoreResultState(
    { expectedResultType: 'likely_exact_match', category: 'footwear' },
    styleResult
  );
  assert.equal(scored.disposition, resultState.DISPOSITIONS.NOT_MEASURED);
  assert.equal(scored.futureExactProductEvaluation, true);
  assert.notEqual(scored.disposition, resultState.DISPOSITIONS.UNDER_IDENTIFICATION);
});

test('under-identification still fires where the contract CAN express the target', () => {
  // closest_matches -> insufficient_evidence is a real under-identification:
  // nothing in the contract prevented a style-level answer here.
  const scored = resultState.scoreResultState(
    { expectedResultType: 'identified_style', category: 'footwear' },
    { status: 'insufficient_visual_evidence', resolutionLevel: 'unknown', exactProduct: null }
  );
  assert.equal(scored.disposition, resultState.DISPOSITIONS.UNDER_IDENTIFICATION);
});

test('exact-product metrics report not_measured rather than a zero', () => {
  const label = {
    caseId: 'ep-1', datasetVersion: '0.1.0', category: 'footwear', clothingType: 'sneaker',
    subtype: 'unknown', primaryColor: 'red', secondaryColors: 'unknown', material: 'unknown',
    pattern: 'unknown', brand: 'not_visible', exactProduct: 'Nike Air Force 1',
    expectedResultType: 'likely_exact_match', expectedAbstention: false,
  };
  const metrics = aggregateScores([scoreCase(label, styleResult)]);
  assert.equal(metrics.exactProduct.exactProductPrecision, 'not_measured');
  assert.equal(metrics.exactProduct.incorrectExactMatchRate, 'not_measured');
  assert.notEqual(metrics.exactProduct.exactProductPrecision, 0);
  assert.equal(metrics.exactProduct.futureExactProductEvaluationCases, 1);
  assert.equal(metrics.underIdentification.count, 0, 'MC-1 cases must not inflate under-identification');
});

test('an exact-product claim in a prediction is surfaced as a runner-fidelity fault', () => {
  const scored = scoreExactProduct('Nike Air Force 1', 'Nike Air Force 1', 'likely_exact_match');
  assert.equal(scored.disposition, DISPOSITIONS.NOT_MEASURED);
  assert.equal(scored.unexpectedExactProductClaim, true);
  assert.match(scored.notes, /certified v140 path cannot emit/);
});

test('not_measured carries zero penalty in every profile', () => {
  for (const profile of ['neutral', 'trust_weighted']) {
    assert.equal(penaltyFor('exactProduct', DISPOSITIONS.NOT_MEASURED, profile), 0);
  }
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

// Phase 0H: the only manifest that exists is the Phase 0A seed, and every one of
// its cases now references excluded_pending_provenance imagery. The runner
// therefore fails closed at the MANIFEST gate, before planning anything. That is
// the exclusion registry reaching all the way through the runner.
test('dry run fails closed when every case references excluded imagery', () => {
  const dir = tmpDir('dryrun');
  const result = runBaseline.main(['--dry-run', '--output-dir', dir], {
    executor: () => {
      throw new Error('executor must never be called in a dry run');
    },
    now: '2026-07-29T00:00:00.000Z',
  });
  // main() sets process.exitCode on refusal; we assert via the return value, so
  // clear it or the deliberate refusal would fail the whole test file.
  process.exitCode = 0;
  assert.equal(result.ok, false, 'a manifest of excluded imagery must not validate');
  const excluded = (result.errors || []).filter((e) => /excluded from evaluation use/.test(e.message));
  assert.equal(excluded.length, 8, 'all eight seed cases must be rejected');
  // Nothing was planned, nothing executed, nothing written.
  assert.equal(result.mode, undefined, 'the run never reached the dry-run stage');
  assert.equal(fs.existsSync(path.join(dir, runnerState.CASES_DIR)), false, 'cases/ must not be created');
});

test('dry run validates hashes, authorization, privacy and expected result state', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json'), 'utf8')
  );
  // This test isolates the hash, authorization, privacy and result-state gates.
  // Capture preparation is a separate concern with its own coverage in
  // phase1CapturePreparation, so it is asserted per-check here rather than via
  // overall `ok` — otherwise every preparation change would break this test.
  const prepared = { capturePreparation: 'certified_client_equivalent' };
  const OWNED_CHECKS = ['hash_count', 'image_count', 'image_hash', 'authorization', 'privacy', 'review_status', 'exif', 'expected_result_state'];
  const ownedFindings = (result) => result.findings.filter((f) => OWNED_CHECKS.includes(f.check));

  const good = runBaseline.preflightCase(manifest.cases[0], prepared);
  assert.deepEqual(ownedFindings(good), [], 'a well-formed seed case must clear every gate this test owns');
  assert.equal(good.resolvedImages.length, 1);

  const tampered = { ...manifest.cases[0], imageHashes: [`sha256:${'0'.repeat(64)}`] };
  const bad = runBaseline.preflightCase(tampered, prepared);
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((f) => f.check === 'image_hash'));

  const unauthorized = { ...manifest.cases[0], authorizationStatus: 'pending_authorization' };
  assert.ok(ownedFindings(runBaseline.preflightCase(unauthorized, prepared))
    .some((f) => f.check === 'authorization'));

  const blockedPrivacy = { ...manifest.cases[0], privacyDisposition: 'blocked_private' };
  assert.ok(ownedFindings(runBaseline.preflightCase(blockedPrivacy, prepared))
    .some((f) => f.check === 'privacy'));

  const badState = { ...manifest.cases[0], expectedResultType: 'made_up_state' };
  assert.ok(ownedFindings(runBaseline.preflightCase(badState, prepared))
    .some((f) => f.check === 'expected_result_state'));
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
    imageReferences: [{ refType: 'governed_object_storage', refValue: 'storage://build4-scanner-evals/gov-1/front' }],
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

// ── Certified v140 source (Phase 0C Lane C) ──────────────────────────────────

test('certified v140 closure verifies byte-for-byte from the git object store', () => {
  const result = certifiedSource.verifyClosure(null);
  assert.equal(result.ok, true, JSON.stringify(result.mismatches.slice(0, 3)));
  assert.equal(result.bundleHash, '28737e0c96047fa014c526886b32b3e5191283a9ed7441641da4d3b0ce632589');
  assert.equal(result.bundleFileCount, 31);
  assert.equal(result.fileCount, 39);
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.missing.length, 0);
});

test('the research branch is NOT the certified v140 source', () => {
  // Phase 0B wrongly treated HEAD as the equivalence basis. It descends from the
  // certification commit but drifted forward by the identify_for_closet work.
  const comparison = certifiedSource.compareToCertified('HEAD');
  assert.equal(comparison.isCertifiedSource, false);
  assert.notEqual(comparison.candidateBundleHash, comparison.certifiedBundleHash);
  assert.ok(
    comparison.bundleDrift.includes('supabase/functions/_shared/fashionIdentificationV2.ts'),
    'the contract module must be reported as drifted'
  );
  assert.match(comparison.verdict, /NOT the certified/);
});

test('certified source boundary properties hold', () => {
  const result = certifiedSource.verifyCertifiedBoundaries(null);
  assert.equal(result.ok, true);
  const byName = Object.fromEntries(result.checks.map((c) => [c.check, c]));
  assert.equal(byName.commerce_gated_by_intent.ok, true);
  assert.equal(byName.exact_product_null.ok, true);
  assert.equal(byName.identify_for_closet_absent.ok, true);
  assert.deepEqual(byName.intents_are_v140.observed, ['identify_and_shop', 'identify_for_style']);
});

test('a tampered certified record is detected rather than believed', () => {
  // The record is cross-checked against re-derived hashes, so corrupting an
  // expected hash must surface as a mismatch, not pass silently.
  const record = certifiedSource.loadRecord();
  const original = record.files.find((f) => f.path.endsWith('index.ts') && f.bundle);
  assert.ok(original, 'index.ts must be in the bundle closure');
  assert.match(original.sha256, /^[a-f0-9]{64}$/);
  // Recomputing the aggregate with one altered entry must change the bundle hash.
  const entries = record.files.filter((f) => f.bundle).map((f) => ({ path: f.path, sha256: f.sha256 }));
  const tampered = entries.map((e) => (e.path === original.path ? { ...e, sha256: 'f'.repeat(64) } : e));
  assert.notEqual(certifiedSource.aggregateHash(tampered), record.bundleHash);
  assert.equal(certifiedSource.aggregateHash(entries), record.bundleHash);
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

// ── Build 4 tracking guard (Phase 0C Lane D) ─────────────────────────────────

test('tracking guard detects the tools/ exclude hazard', () => {
  const exclude = trackingGuard.readExcludeRules();
  const shadowed = trackingGuard.shadowedRoots(exclude.rules);
  // The bare `tools/` rule shadows the harness root. If this ever stops being
  // true the guard is still correct — but the hazard note in the handoff docs
  // would need revisiting, so the assertion is on the mechanism, not the rule.
  assert.ok(Array.isArray(shadowed));
  assert.ok(
    trackingGuard.shadowedRoots(['tools/']).includes('tools/scanner-evaluation'),
    'a bare tools/ rule must be reported as shadowing the harness root'
  );
  assert.deepEqual(trackingGuard.shadowedRoots(['unrelated/']), []);
});

test('tracking guard enumerates every authorized Build 4 root', () => {
  assert.deepEqual(trackingGuard.AUTHORIZED_ROOTS, [
    'evals/scanner-accuracy',
    'tools/scanner-evaluation',
    'experiments/scanner-accuracy-v2',
    'docs/scanner-accuracy',
    'docs/audits',
  ]);
});

test('every authorized Build 4 file on disk is tracked by git', () => {
  // This is the backstop for the exclude hazard: a clean `git status` is NOT
  // evidence that harness work was committed.
  const report = trackingGuard.main(['--base', '274d40bdf736d730233299793b50efb48bec47cb']);
  assert.deepEqual(report.tracking.untracked, [], 'untracked authorized files must be staged with git add -f');
  assert.deepEqual(report.boundary.outsideAuthorizedRoots, [], 'Build 4 must not change files outside its roots');
  assert.equal(report.ok, true);
});

test('the path-boundary exception list is exactly the two owner-authorized files', () => {
  // The boundary keeps its teeth only if the exception stays an exact-file
  // allowlist. Adding a prefix or a third file here is a boundary change and must
  // be a deliberate, reviewed act — not a side effect of some other work.
  assert.deepEqual(
    Object.keys(trackingGuard.AUTHORIZED_BOUNDARY_EXCEPTIONS).sort(),
    ['package-lock.json', 'package.json']
  );
  for (const [file, exception] of Object.entries(trackingGuard.AUTHORIZED_BOUNDARY_EXCEPTIONS)) {
    assert.ok(exception.reason, `${file} exception must state a reason`);
    assert.ok(exception.authority, `${file} exception must name the authorizing decision`);
    assert.ok(exception.record, `${file} exception must reference the authorization record`);
    assert.ok(exception.constraint, `${file} exception must state its constraint`);
    // No wildcard or directory prefix may masquerade as a file exception.
    assert.equal(/[*?]/.test(file), false, 'exceptions are exact files, never patterns');
    assert.equal(file.includes('/'), false, 'the authorized exceptions are repository-root manifests');
  }
});

test('the autonomous lane uses no root-manifest boundary exception', () => {
  const report = trackingGuard.main(['--base', '274d40bdf736d730233299793b50efb48bec47cb']);
  const used = report.boundary.authorizedExceptionsUsed.map((e) => e.file).sort();
  assert.deepEqual(used, [], 'the next-build experiment may not touch root package manifests');
});

test('sharp is evaluation-local and is not reachable from application code', () => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const evaluationPackage = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tools/scanner-evaluation/package.json'),
    'utf8',
  ));
  assert.equal(rootPackage.dependencies && rootPackage.dependencies.sharp, undefined);
  assert.equal(rootPackage.devDependencies && rootPackage.devDependencies.sharp, undefined);
  assert.equal(evaluationPackage.dependencies.sharp, '0.35.3',
    'sharp must be pinned inside the evaluation-only dependency graph');

  // Nothing shipped to a device or an Edge Function may import the codec.
  const roots = ['app', 'components', 'services', 'hooks', 'contexts', 'constants', 'utils', 'supabase'];
  const offenders = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/require\(['"]sharp['"]\)|from ['"]sharp['"]/.test(source)) {
        offenders.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  for (const root of roots) walk(path.join(ROOT, root));
  assert.deepEqual(offenders, [], 'the image codec must stay confined to the evaluation harness');
});

// ── Commerce and boundary ────────────────────────────────────────────────────

test('commerce metrics are marked not_measured', () => {
  const metrics = aggregateScores([]);
  assert.equal(metrics.commerce.commerceLinkValidity, 'not_measured');
  assert.equal(metrics.commerce.retailerRelevance, 'not_measured');
  assert.equal(metrics.commerce.duplicateRetailerRate, 'not_measured');
  assert.equal(metrics.commerce.commerceCostUsd, 0);
  // Explicitly NOT zero — a zero would read as a measured perfect result.
  for (const key of ['commerceLinkValidity', 'retailerRelevance', 'duplicateRetailerRate']) {
    assert.notEqual(metrics.commerce[key], 0);
  }
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
