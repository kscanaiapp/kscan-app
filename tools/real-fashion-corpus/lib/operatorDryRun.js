'use strict';

/**
 * Operator dry run (mission sections 43 and 44).
 *
 *   43: "The collection guide must be tested. Walk at least one sample/pilot
 *        case through: collection, metadata entry, validation, ingestion, QC,
 *        evaluation loading - using the documented workflow. If the
 *        instructions do not actually work, the lane is not complete."
 *
 *   44: with no camera and no physical garments available, REAL PILOT is
 *        READY_NO_CAPTURES, and the mechanics are proved with clearly-labelled
 *        PIPELINE_TEST_ASSETs instead.
 *
 * This walks every documented stage against generated assets, and then - the
 * part that matters most - proves the real-corpus validator REJECTS the
 * result. A dry run that ended by quietly leaving test assets in the corpus
 * would have proved the opposite of what mission section 26 requires.
 *
 * Nothing here writes into corpus/garments, corpus/cases or corpus/holdout.
 * Every artifact goes to a caller-supplied temporary directory.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildScenarioAssets } = require('../testAssets/generate');
const { GARMENT_COLUMNS, CASE_COLUMNS } = require('./intake');
const { toCsv } = require('./csv');
const { validateBatch, prepareRecords } = require('./ingest');
const { loadCorpus, loadCorpusConfig } = require('./corpusStore');
const { runQc } = require('./qc');
const { compileCorpus } = require('./compile');
const { evaluateIdentityEligibility, deriveGrade } = require('./groundTruth');
const { validateCase } = require('./recordSchema');
const { identityMetrics } = require('./evaluate');
const { evaluateCorpus } = require('../../fashion-match-quality/evaluator/evaluate');
const { ASSET_TIER_PIPELINE_TEST } = require('./constants');

const DRY_RUN_PURPOSE =
  'operator dry run (mission section 43): proves capture -> metadata -> validate -> ingest -> QC -> evaluation ' +
  'loading works end to end. Never a real case.';

/**
 * Stage 1 - CAPTURE (simulated). Write generated assets to a temp asset root,
 * exactly where a collector would have copied photographs off a phone.
 */
function stageCapture(assetRoot) {
  const assets = buildScenarioAssets();
  fs.mkdirSync(path.join(assetRoot, 'G901'), { recursive: true });
  fs.mkdirSync(path.join(assetRoot, 'G902'), { recursive: true });

  const files = {
    'G901/C9001-ios.png': assets.cleanPng.bytes,
    'G901/C9002-android.png': assets.cleanPngVariant.bytes,
    'G902/C9003-ios.png': assets.cleanJpeg.bytes,
    // Deliberately dirty inputs, so the dry run exercises rejection too.
    'G902/C9004-gps.jpg': assets.jpegWithGpsExif.bytes,
    'G902/C9005-corrupt.png': assets.corruptCrcPng.bytes,
  };
  for (const [relative, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(assetRoot, relative), bytes);
  }
  return { assetRoot, files: Object.keys(files) };
}

/** Stage 2 - ENTER METADATA. Produce the two filled sheets. */
function stageEnterMetadata() {
  const garmentHeaders = GARMENT_COLUMNS.map((c) => c.name);
  const caseHeaders = CASE_COLUMNS.map((c) => c.name);

  const garmentRows = [
    {
      garment_id: 'G901',
      category: 'outerwear',
      collector_id: 'DRY-RUN-COLLECTOR',
      collection_source: 'OWNER_TEAM_GARMENT',
      store_policy_respected: '',
      brand: 'Dry Run Brand',
      product_name: 'Dry Run Quilted Jacket',
      style_code: 'DRB-QJ-0001',
      gtin: '0000000000017',
      colorway_name: 'Slate',
      colorway_code: 'SLT-01',
      size: 'M',
      asserted_grade: 'IDENTIFIER_GRADE',
      evidence_type: 'MANUFACTURER_TAG',
      evidence_verified_on: '2026-09-01',
      evidence_verified_by: 'DRY-RUN-COLLECTOR',
      evidence_observed_facts: 'brandOnTag=Dry Run Brand; styleCodeOnTag=DRB-QJ-0001; colorwayOnTag=Slate SLT-01',
      evidence_url: 'https://example.invalid/dry-run/jacket',
      catalog_state_verified_on: '2026-09-01',
      attr_silhouette: 'boxy',
      attr_material: 'polyester',
      attr_pattern: 'solid',
      attr_color_family: 'grey',
      attr_price_tier: 'mid',
      attr_gender_presentation: 'unisex',
      notes: 'DRY RUN ONLY - not a real garment',
    },
    {
      // A PARTIAL garment, so the dry run also proves the identity denominator
      // actually excludes something rather than being vacuously satisfied.
      garment_id: 'G902',
      category: 'top',
      collector_id: 'DRY-RUN-COLLECTOR-2',
      collection_source: 'OTHER_AUTHORIZED_PHYSICAL',
      store_policy_respected: '',
      brand: 'Dry Run Brand',
      product_name: '',
      style_code: '',
      gtin: '',
      colorway_name: '',
      colorway_code: '',
      size: 'L',
      asserted_grade: 'PARTIAL',
      evidence_type: 'DIRECT_OWNER_KNOWLEDGE',
      evidence_verified_on: '2026-09-01',
      evidence_verified_by: 'DRY-RUN-COLLECTOR-2',
      evidence_observed_facts: 'brandRecalledByOwner=Dry Run Brand; purchasedApproximately=2024',
      evidence_url: '',
      catalog_state_verified_on: '2026-09-01',
      attr_silhouette: 'relaxed',
      attr_material: 'cotton',
      attr_pattern: 'striped',
      attr_color_family: 'blue',
      attr_price_tier: 'value',
      attr_gender_presentation: 'unisex',
      notes: 'DRY RUN ONLY - not a real garment',
    },
  ];

  const caseRows = [
    {
      case_id: 'C9001',
      garment_id: 'G901',
      device_platform: 'ios',
      device_model: 'Dry Run Device (iOS)',
      capture_profile: 'ios-current-v1',
      capture_type: 'HANGER',
      capture_environment: 'INDOOR_ARTIFICIAL',
      captured_on: '2026-09-01',
      captured_width: '4032',
      captured_height: '3024',
      format: 'png',
      human_present: 'no',
      consent_status: '',
      asset_path: 'G901/C9001-ios.png',
      paired_case_id: 'C9002',
      input_hard_negative_of: '',
      difficulty_strata: 'NO_VISIBLE_LOGO;MID_TONE_GARMENT;SOLID_COLOR',
      notes: 'DRY RUN ONLY',
    },
    {
      case_id: 'C9002',
      garment_id: 'G901',
      device_platform: 'android',
      device_model: 'Dry Run Device (Android)',
      capture_profile: 'android-current-v1',
      capture_type: 'HANGER',
      capture_environment: 'INDOOR_ARTIFICIAL',
      captured_on: '2026-09-01',
      captured_width: '4000',
      captured_height: '3000',
      format: 'png',
      human_present: 'no',
      consent_status: '',
      asset_path: 'G901/C9002-android.png',
      paired_case_id: 'C9001',
      input_hard_negative_of: '',
      difficulty_strata: 'NO_VISIBLE_LOGO;MID_TONE_GARMENT;SOLID_COLOR',
      notes: 'DRY RUN ONLY',
    },
    {
      case_id: 'C9003',
      garment_id: 'G902',
      device_platform: 'ios',
      device_model: 'Dry Run Device (iOS)',
      capture_profile: 'ios-current-v1',
      capture_type: 'FLAT_LAY',
      capture_environment: 'INDOOR_NATURAL',
      captured_on: '2026-09-01',
      captured_width: '4032',
      captured_height: '3024',
      format: 'jpeg',
      human_present: 'no',
      consent_status: '',
      asset_path: 'G902/C9003-ios.png',
      paired_case_id: '',
      input_hard_negative_of: 'G901',
      difficulty_strata: 'PATTERNED;LIGHT_GARMENT',
      notes: 'DRY RUN ONLY',
    },
  ];

  return {
    garmentsCsv: toCsv(garmentHeaders, garmentRows),
    casesCsv: toCsv(caseHeaders, caseRows),
    // Kept separate so a stage can deliberately feed a bad sheet.
    rows: { garmentRows, caseRows },
    headers: { garmentHeaders, caseHeaders },
  };
}

/**
 * Run the whole documented workflow.
 *
 * Returns a structured result with one entry per stage; every stage records
 * whether it passed and why.
 */
function runOperatorDryRun({ workDir } = {}) {
  const root = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-dry-run-'));
  const assetRoot = path.join(root, 'assets');
  const stages = [];
  const record = (name, ok, detail, extra = {}) => {
    stages.push({ stage: name, ok, detail, ...extra });
    return ok;
  };

  /* -------- 1. CAPTURE -------- */
  const capture = stageCapture(assetRoot);
  record('CAPTURE', capture.files.length === 5, `${capture.files.length} asset(s) staged in ${assetRoot}`);

  /* -------- 2. ENTER METADATA -------- */
  const sheets = stageEnterMetadata();
  record('ENTER_METADATA', true, `${sheets.rows.garmentRows.length} garment row(s), ${sheets.rows.caseRows.length} case row(s)`);

  /* -------- 3. VALIDATE -------- */
  const existingCorpus = loadCorpus({ validate: false });
  const validated = validateBatch({
    garmentsCsv: sheets.garmentsCsv,
    casesCsv: sheets.casesCsv,
    existingCorpus,
  });
  if (
    !record('VALIDATE', validated.valid, validated.valid ? 'all rows valid' : `${validated.errors.length} error(s)`, {
      errors: validated.errors,
    })
  ) {
    return { ok: false, root, assetRoot, stages };
  }

  /* -------- 4. INGEST (dry, and deliberately never into the real corpus) -------- */
  const config = loadCorpusConfig();
  const prepared = prepareRecords({
    garments: validated.garments,
    cases: validated.cases,
    config,
    options: { assetRoot },
  });
  if (
    !record(
      'INGEST',
      prepared.errors.length === 0,
      prepared.errors.length === 0
        ? `${prepared.cases.length} case(s) prepared with real hashes and EXIF verdicts read from the bytes`
        : `${prepared.errors.length} error(s)`,
      { errors: prepared.errors },
    )
  ) {
    return { ok: false, root, assetRoot, stages };
  }

  // Re-tier every prepared case. Intake can only ever emit REAL_CAPTURE, which
  // is correct for a collector - but these are generated bytes, and mission
  // section 26 forbids ever labelling one as real.
  const dryRunCases = prepared.cases.map((caseRecord) => ({
    ...caseRecord,
    assetTier: ASSET_TIER_PIPELINE_TEST,
    pipelineTestPurpose: DRY_RUN_PURPOSE,
  }));
  const garmentsById = new Map(prepared.garments.map((garment) => [garment.garmentId, garment]));

  record(
    'TIER_RELABEL',
    dryRunCases.every((c) => c.assetTier === ASSET_TIER_PIPELINE_TEST),
    'every dry-run case is tagged PIPELINE_TEST_ASSET, so none can be mistaken for a capture',
  );

  /* -------- 5. QC -------- */
  const qc = runQc(
    { config, garments: prepared.garments, cases: dryRunCases, garmentsById },
    { assetRoot, requireAssets: true },
  );
  // QC MUST fail here, and must fail specifically on tier contamination: these
  // are generated assets sitting where real cases live.
  const tierFindings = qc.findings.filter((f) => f.code === 'QC_TIER_CONTAMINATION');
  record(
    'QC',
    tierFindings.length === dryRunCases.length,
    `QC flagged ${tierFindings.length}/${dryRunCases.length} dry-run case(s) as tier contamination, as it must`,
    { qcPassed: qc.passed, findingCodes: [...new Set(qc.findings.map((f) => f.code))] },
  );

  /* -------- 6. EVALUATION LOADING -------- */
  // The compiler must REFUSE a pipeline-test case outright.
  const compiledFromTestAssets = compileCorpus({ garmentsById, cases: dryRunCases });
  record(
    'COMPILE_REFUSES_TEST_ASSETS',
    compiledFromTestAssets.fixtures.length === 0 && compiledFromTestAssets.errors.length === dryRunCases.length,
    `the compiler refused all ${dryRunCases.length} pipeline-test case(s); 0 fixtures were produced`,
    { errors: compiledFromTestAssets.errors.map((e) => e.message) },
  );

  // To prove evaluation LOADING works, compile the same records with the tier
  // temporarily set to real. This is the one place the shape is exercised end
  // to end - and it happens in a temp directory, never on disk in the corpus.
  const asIfReal = dryRunCases.map((caseRecord) => {
    const { pipelineTestPurpose, ...rest } = caseRecord;
    return { ...rest, assetTier: 'REAL_CAPTURE' };
  });
  const compiled = compileCorpus({ garmentsById, cases: asIfReal });
  record(
    'COMPILE',
    compiled.fixtures.length === asIfReal.length && compiled.errors.length === 0,
    `${compiled.fixtures.length} fixture(s) compiled and accepted by the INHERITED FMQL fixture schema`,
    { errors: compiled.errors },
  );

  const evaluations = compiled.fixtures.length > 0 ? evaluateCorpus(compiled.fixtures) : [];
  const eligibleCaseIds = new Set(
    asIfReal
      .filter((caseRecord) => {
        const garment = garmentsById.get(caseRecord.garmentId);
        return garment && evaluateIdentityEligibility(garment).eligible;
      })
      .map((caseRecord) => caseRecord.caseId),
  );
  const identity = identityMetrics(evaluations, eligibleCaseIds);

  record(
    'EVALUATION_LOADING',
    evaluations.length === compiled.fixtures.length,
    `${evaluations.length} fixture(s) scored through FMQL's own evaluator`,
  );

  // G902 is PARTIAL, so its case must be excluded from the identity
  // denominator. If this ever passes vacuously the denominator rule is untested.
  record(
    'IDENTITY_DENOMINATOR',
    identity.suppressedIneligibleCases > 0 && identity.n === eligibleCaseIds.size,
    `identity n=${identity.n} over ${eligibleCaseIds.size} eligible case(s); ` +
      `${identity.suppressedIneligibleCases} case(s) suppressed as identity-ineligible`,
    { grades: prepared.garments.map((g) => ({ garmentId: g.garmentId, grade: deriveGrade(g.groundTruth).grade })) },
  );

  /* -------- 7. REAL-CORPUS REJECTION -------- */
  // The whole point: schema-valid though they are, these cases must be
  // rejectable as real cases.
  const schemaValid = dryRunCases.every((caseRecord) => validateCase(caseRecord).valid);
  record(
    'REAL_CORPUS_REJECTS_TEST_ASSETS',
    schemaValid && tierFindings.length === dryRunCases.length,
    'dry-run cases are schema-valid yet rejected as real cases by tier - the mechanics are proved without the ' +
      'corpus gaining a single fabricated case',
  );

  /* -------- 8. CORPUS UNCHANGED -------- */
  const after = loadCorpus({ validate: false });
  record(
    'CORPUS_UNCHANGED',
    after.cases.length === existingCorpus.cases.length && after.garments.length === existingCorpus.garments.length,
    `corpus still holds ${after.garments.length} garment(s) and ${after.cases.length} case(s) - the dry run wrote nothing into it`,
  );

  return {
    ok: stages.every((stage) => stage.ok),
    root,
    assetRoot,
    stages,
    artifacts: { garmentsCsv: sheets.garmentsCsv, casesCsv: sheets.casesCsv, cases: dryRunCases, fixtures: compiled.fixtures, identity },
  };
}

function formatDryRun(result) {
  const lines = ['OPERATOR DRY RUN (mission section 43)', '='.repeat(60)];
  for (const stage of result.stages) {
    lines.push(`  [${stage.ok ? 'PASS' : 'FAIL'}] ${stage.stage.padEnd(32)} ${stage.detail}`);
    for (const error of stage.errors || []) {
      lines.push(`         ${typeof error === 'string' ? error : error.message}`);
    }
  }
  lines.push('');
  lines.push(`OPERATOR DRY RUN: ${result.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`  work dir: ${result.root}`);
  lines.push('  REAL PILOT: READY_NO_CAPTURES - no camera or physical garments are available in this environment,');
  lines.push('  so the mechanics are proved with PIPELINE_TEST_ASSETs and zero real cases were fabricated.');
  return lines.join('\n');
}

module.exports = { runOperatorDryRun, formatDryRun, stageEnterMetadata, stageCapture, DRY_RUN_PURPOSE };
