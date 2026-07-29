#!/usr/bin/env node
'use strict';

/**
 * Build a governed Tier A dataset manifest from an acquisition report plus
 * explicit per-image curation decisions.
 *
 * WHY CURATION IS A SEPARATE, REQUIRED INPUT
 * Category-based retrieval is far more precise than free-text search, but it is
 * still not a substitute for looking at the image. Commons categories legitimately
 * contain drawings, museum artifacts, garment-factory interiors and detail crops
 * that are not usable identification cases. Every accepted case therefore needs a
 * recorded human/visual decision, and this tool REFUSES to emit a manifest entry
 * for any image that does not have one.
 *
 * An image with no curation decision is treated as NOT curated, never as
 * approved-by-default.
 *
 * Usage
 *   node tools/scanner-evaluation/build-tier-a-manifest.js \
 *     --report <acquisitionReport.json> \
 *     --curation <curation.json> \
 *     --out <manifest.json> [--holdout 15]
 */

const fs = require('fs');
const path = require('path');

const { validateCase } = require('./lib/datasetValidate');
const { splitDataset, validateSplit } = require('./lib/datasetSplit');

const DATASET_VERSION = '0.3.0';

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  return {
    report: get('--report'),
    curation: get('--curation'),
    out: get('--out'),
    holdout: Number(get('--holdout') || 15),
  };
}

/**
 * Turn one accepted acquisition record plus its curation decision into a
 * governed case. Labels come from curation, never from the search term.
 */
function toCase(record, decision, siblings = []) {
  const licence = record.licence || {};
  const attributionText = licence.attributionRequired
    ? `${record.author} — ${licence.licenceId}${licence.licenceVersion ? ` ${licence.licenceVersion}` : ''}`
    : null;

  // A same-item set becomes ONE case carrying every view, not N unrelated cases.
  // Emitting the views separately would both erase the multi-image stratum and
  // silently over-weight that garment in every aggregate score.
  const views = [record, ...siblings];

  return {
    caseId: decision.sameItemSetId || record.caseId,
    datasetVersion: DATASET_VERSION,

    // ── Governed storage: reference and hashes only, never bytes in Git ──
    imageReferences: views.map((v) => ({
      refType: 'governed_object_storage', refValue: v.governedStorageRef,
    })),
    imageHashes: views.map((v) => `sha256:${v.sanitizedSha256}`),
    imageCount: views.length,
    sameItemAcrossImages: views.length > 1 ? true : 'not_applicable',
    sameItemSetId: decision.sameItemSetId || null,

    // ── Licence and provenance evidence ──
    provenance: {
      repository: record.repository,
      retrievalMethod: record.retrievalMethod,
      retrievalDate: record.retrievalDate,
      sourcePage: record.sourcePage,
      directImageUrl: record.directImageUrl,
      author: record.author,
      licenceId: licence.licenceId,
      licenceVersion: licence.licenceVersion,
      licenceUrl: record.licenceUrl,
      licenceObservedString: licence.observed,
      attributionRequired: Boolean(licence.attributionRequired),
      attributionText,
      shareAlikeRequired: Boolean(licence.shareAlikeRequired),
      originalSha256: record.originalSha256,
      sanitizedSha256: record.sanitizedSha256,
    },

    // ── Labels: from the curation decision only ──
    category: decision.category,
    clothingType: decision.clothingType || 'unknown',
    subtype: decision.subtype || 'unknown',
    primaryColor: decision.primaryColor || 'unknown',
    secondaryColors: decision.secondaryColors || 'unknown',
    material: decision.material || 'unknown',
    pattern: decision.pattern || 'unknown',
    brand: decision.brand || 'not_visible',
    exactProduct: 'unknown',
    expectedResultType: decision.expectedResultType,
    expectedAbstention: Boolean(decision.expectedAbstention),
    // The split validator recognises the non-fashion stratum by this flag, so it
    // must be emitted or non-fashion negatives are invisible to stratification.
    nonFashion: decision.category === 'non_fashion',
    sceneTags: decision.sceneTags || [],
    difficultyTags: decision.difficultyTags || [],
    brandVisible: decision.brandVisible === true,
    exactProductKnowable: false,
    futureExactProductEvaluation: false,

    // ── Review state ──
    reviewStatus: 'draft',
    reviewerCount: 1,
    labelConfidence: decision.labelConfidence || 'medium',
    curation: {
      status: 'curated_visually',
      decidedBy: 'build-lead visual review',
      subjectConfirmed: true,
      note: decision.note || null,
    },

    // ── Source and authorization ──
    sourceClass: 'licensed_apparel',
    authorizationStatus: 'approved_internal_eval',
    authorizationReference: `${record.sourcePage} (${licence.licenceId}${licence.licenceVersion ? ` ${licence.licenceVersion}` : ''})`,

    // ── Privacy ──
    privacyDisposition: 'hash_and_label_only',
    privacyReviewDate: record.retrievalDate,
    retentionPolicyRef: 'docs/scanner-accuracy/phase0b-privacy-retention.md#retention',
    exifRemoved: true,
    faceReviewState: decision.faceReviewState,
    plateReviewState: decision.plateReviewState || 'no_plate_present',
    derivativeStatus: 'masked_derivative',
    governedStorageRef: record.governedStorageRef,
    trademarkReviewState: decision.trademarkReviewState || 'no_trademark_visible',
    visiblePerson: decision.visiblePerson === true,

    notes: decision.note || 'Tier A licensed-web-image benchmark case.',
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.report || !args.curation || !args.out) {
    console.error('Usage: --report <r.json> --curation <c.json> --out <m.json> [--holdout N]');
    process.exitCode = 1;
    return;
  }

  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  const curation = JSON.parse(fs.readFileSync(args.curation, 'utf8'));
  const decisions = new Map(Object.entries(curation.decisions || {}));

  const cases = [];
  const skipped = [];

  // Pass 1: admit only images that carry an explicit keep decision.
  const admitted = [];
  for (const record of report.accepted || []) {
    const decision = decisions.get(record.caseId);
    if (!decision) {
      skipped.push({ caseId: record.caseId, reason: 'no curation decision recorded' });
      continue;
    }
    if (decision.keep !== true) {
      skipped.push({ caseId: record.caseId, reason: decision.reason || 'curated out' });
      continue;
    }
    admitted.push({ record, decision });
  }

  // Pass 2: collapse each same-item set into one multi-image case. The set's
  // PRIMARY member is the first admitted view that carries full labels; a
  // setMemberOnly view can contribute an image but must never define the labels.
  const setGroups = new Map();
  for (const a of admitted) {
    const sid = a.decision.sameItemSetId;
    if (!sid) continue;
    if (!setGroups.has(sid)) setGroups.set(sid, []);
    setGroups.get(sid).push(a);
  }

  const consumed = new Set();
  for (const [sid, members] of setGroups) {
    const primary = members.find((m) => m.decision.setMemberOnly !== true) || members[0];
    const others = members.filter((m) => m !== primary);
    cases.push(toCase(primary.record, primary.decision, others.map((m) => m.record)));
    for (const m of members) consumed.add(m.record.caseId);
    if (!curation.sameItemSets || !curation.sameItemSets[sid]) {
      skipped.push({ caseId: sid, reason: 'set referenced by a decision but not registered in sameItemSets' });
    }
  }

  for (const a of admitted) {
    if (consumed.has(a.record.caseId)) continue;
    cases.push(toCase(a.record, a.decision));
  }

  // Validate every case under the full contract, including exclusion registry.
  const invalid = [];
  for (const c of cases) {
    const result = validateCase(c, { requirePhase0bPrivacy: true });
    if (!result.ok) invalid.push({ caseId: c.caseId, errors: result.errors });
  }

  const split = splitDataset(cases, { holdoutCount: Math.min(args.holdout, Math.floor(cases.length / 5)) });
  const splitReport = validateSplit(cases, split);

  const manifest = {
    datasetVersion: DATASET_VERSION,
    tier: 'A',
    benchmarkKind: 'licensed_web_image_benchmark',
    notARealWorldSmartGlassesBenchmark: true,
    benchmarkLimitations: [
      'no smart-glasses point of view',
      'no wearer motion blur',
      'no partial framing inside the five-second curiosity window',
      'no repeated views of the same physical garment',
      'no authentic retail-floor lighting or distance',
    ],
    generatedAt: curation.curationDate,
    caseCount: cases.length,
    split,
    cases,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const summary = {
    ok: invalid.length === 0,
    out: args.out,
    caseCount: cases.length,
    skippedCount: skipped.length,
    invalidCount: invalid.length,
    invalid: invalid.slice(0, 5),
    development: split.development.length,
    holdout: split.holdout.length,
    splitOk: splitReport.ok,
    missingStrata: splitReport.missingStrata,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (invalid.length) process.exitCode = 1;
  return summary;
}

if (require.main === module) main();

module.exports = { main, toCase, DATASET_VERSION };
