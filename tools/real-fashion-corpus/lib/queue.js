'use strict';

/**
 * Collection queue and the procurement/gap list (mission sections 24, 25, 11).
 *
 * Section 24 wants a live state report across PLANNED / CAPTURED /
 * GROUND_TRUTH_PENDING / QC_PENDING / VALID / REJECTED / HOLDOUT.
 * Section 25 wants the missing evidence stated in HUMAN-READABLE form
 * ("need 4 more dark outerwear cases"), prioritised by claim value.
 * Section 11 wants corpus bias reported prominently and honestly.
 *
 * Everything here is DERIVED from the records on disk. Nothing is
 * hand-maintained, so the queue cannot drift from the corpus it describes.
 */

const { loadCorpus, buildCorpusManifest, realCasesOnly } = require('./corpusStore');
const { runQc } = require('./qc');
const { holdoutCaseCount } = require('./holdout');
const { deriveGrade, evaluateIdentityEligibility } = require('./groundTruth');
const { classifyClaims, THRESHOLDS } = require('./power');
const { validatePairs } = require('./assetStore');
const { CASE_STATUSES, CATEGORIES, DIFFICULTY_STRATA, COLLECTION_SOURCES } = require('./constants');

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    for (const key of [].concat(keyFn(item))) {
      if (key === undefined || key === null) continue;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

/**
 * The live queue.
 *
 * `requireAssets: false` by default, because the queue must be readable on a
 * checkout with no asset mount - which is the state most readers are in.
 */
function buildQueue(options = {}) {
  const corpus = loadCorpus({ validate: false });
  const manifest = buildCorpusManifest(corpus);
  const qc = runQc(corpus, { requireAssets: false, ...options });

  const realCases = realCasesOnly(corpus.cases);
  const validIds = new Set(qc.validCaseIds);

  const byStatus = {};
  for (const status of CASE_STATUSES) byStatus[status] = 0;
  byStatus.HOLDOUT = holdoutCaseCount();

  for (const record of corpus.cases) {
    // The stored status is the collector's claim; QC decides the real one.
    // A case QC rejected is REJECTED regardless of what its record says.
    const effective = validIds.has(record.caseId) ? 'VALID' : qc.rejectedCaseIds.includes(record.caseId) ? 'REJECTED' : record.status;
    byStatus[effective] = (byStatus[effective] || 0) + 1;
  }

  const gradeByGarment = {};
  for (const garment of corpus.garments) {
    const grade = deriveGrade(garment.groundTruth).grade || 'INVALID';
    gradeByGarment[grade] = (gradeByGarment[grade] || 0) + 1;
  }

  const identityEligibleGarments = corpus.garments.filter((g) => evaluateIdentityEligibility(g).eligible);
  const eligibleGarmentIds = new Set(identityEligibleGarments.map((g) => g.garmentId));
  const identityEligibleCases = realCases.filter((c) => eligibleGarmentIds.has(c.garmentId));

  const pairs = validatePairs(realCases);
  const iosCases = realCases.filter((c) => c.capture?.device?.platform === 'ios');
  const androidCases = realCases.filter((c) => c.capture?.device?.platform === 'android');

  const categoryCounts = countBy(realCases, (record) => corpus.garmentsById.get(record.garmentId)?.category);
  const difficultyCounts = countBy(realCases, (record) => record.difficultyStrata || []);

  const claims = classifyClaims({
    totalCases: realCases.length,
    identityEligibleCases: identityEligibleCases.length,
    pairedCases: pairs.valid.length * 2,
    categoryCounts,
    difficultyCounts,
  });

  return {
    corpusVersion: corpus.config.corpusVersion,
    corpusHash: manifest.corpusHash,
    generatedAt: new Date().toISOString(),

    queue: byStatus,

    counts: {
      garments: corpus.garments.length,
      rawCases: corpus.cases.length,
      realCases: realCases.length,
      pipelineTestAssetsInCorpus: corpus.cases.length - realCases.length,
      validRealCases: validIds.size,
      rejectedCases: qc.rejectedCaseIds.length,
      holdoutCases: byStatus.HOLDOUT,
      identityEligibleGarments: identityEligibleGarments.length,
      identityEligibleCases: identityEligibleCases.length,
      iosCases: iosCases.length,
      androidCases: androidCases.length,
      pairedGarments: new Set(pairs.valid.map((p) => p.garmentId)).size,
      validPairs: pairs.valid.length,
      invalidPairs: pairs.invalid.length,
    },

    groundTruthGrades: gradeByGarment,

    collection: {
      collectors: [...new Set(corpus.garments.map((g) => g.collection?.collectorId).filter(Boolean))],
      collectorCount: new Set(corpus.garments.map((g) => g.collection?.collectorId).filter(Boolean)).size,
      sourceDistribution: countBy(corpus.garments, (g) => g.collection?.source),
    },

    coverage: {
      categoryCounts,
      uncoveredCategories: CATEGORIES.filter((category) => !categoryCounts[category]),
      difficultyCounts,
      uncoveredDifficultyStrata: DIFFICULTY_STRATA.filter((stratum) => !difficultyCounts[stratum]),
    },

    assetStorage: {
      status: qc.assets.storageStatus,
      root: qc.assets.root,
      mountSource: qc.assets.mountSource,
      verified: qc.assets.summary.ok,
      hashMismatches: qc.assets.summary.hashMismatch,
      missing: qc.assets.summary.missing,
    },

    qc: {
      passed: qc.passed,
      rejectionCount: qc.rejections.length,
      blockerCount: qc.blockers.length,
      findings: qc.findings,
    },

    claimDiscipline: claims,
  };
}

/* ------------------------------------------------------------------ *
 * Gap list (mission section 25)
 * ------------------------------------------------------------------ */

/**
 * Turn the shortfalls into sentences a person can act on, ordered by the value
 * of the claim they unblock. A gap list that reads like a JSON dump is a gap
 * list nobody uses.
 */
function buildGapList(queue) {
  const gaps = [];
  const { counts, coverage, collection, claimDiscipline } = queue;

  // 1. Claim-driven gaps, highest claim value first.
  //
  // The next tier is always exactly one step up from where the claim sits now.
  // Naming the tier a shortfall actually reaches matters: telling a collector
  // that three more cases reach DECISION_GRADE when they reach DESCRIPTIVE_ONLY
  // is how a corpus ends up over-claiming.
  const NEXT_TIER = {
    INSUFFICIENT_N: { name: 'DESCRIPTIVE_ONLY', field: 'shortfallToDescriptive', priority: 1 },
    DESCRIPTIVE_ONLY: { name: 'DIRECTIONAL', field: 'shortfallToDirectional', priority: 2 },
    DIRECTIONAL: { name: 'DECISION_GRADE', field: 'shortfallToDecisionGrade', priority: 3 },
  };

  const claimsByShortfall = [...claimDiscipline.claims].sort(
    (a, b) => a.shortfallToDirectional - b.shortfallToDirectional,
  );

  for (const claim of claimsByShortfall) {
    const step = NEXT_TIER[claim.classification];
    if (!step) continue; // already DECISION_GRADE - nothing to ask for
    const shortfall = claim[step.field];
    if (shortfall <= 0) continue;

    gaps.push({
      priority: step.priority,
      claimId: claim.claimId,
      currentN: claim.n,
      shortfall,
      text:
        `Need ${shortfall} more case(s) toward "${claim.question}" ` +
        `(now n=${claim.n}, ${claim.classification}; ${shortfall} more reaches ${step.name}). ` +
        `Denominator: ${claim.denominator}.`,
    });
  }

  // 2. Structural coverage gaps.
  for (const category of coverage.uncoveredCategories) {
    gaps.push({
      priority: 2,
      claimId: `CATEGORY_COVERAGE__${category.toUpperCase()}`,
      currentN: 0,
      shortfall: THRESHOLDS.unpaired.descriptive,
      text: `No ${category} cases at all. Collect at least ${THRESHOLDS.unpaired.descriptive} to say anything about the ${category} category.`,
    });
  }

  const importantStrata = [
    'DARK_GARMENT',
    'LIGHT_GARMENT',
    'NO_VISIBLE_LOGO',
    'VISIBLE_LOGO',
    'PATTERNED',
    'SOLID_COLOR',
    'COLORWAY_SIBLING',
    'SAME_BRAND_ADJACENT_STYLE',
    'VISUALLY_SIMILAR_DISTINCT_PRODUCT',
  ];
  for (const stratum of importantStrata) {
    const current = coverage.difficultyCounts[stratum] || 0;
    if (current >= THRESHOLDS.unpaired.descriptive) continue;
    gaps.push({
      priority: current === 0 ? 2 : 3,
      claimId: `DIFFICULTY_COVERAGE__${stratum}`,
      currentN: current,
      shortfall: THRESHOLDS.unpaired.descriptive - current,
      text: `Need ${THRESHOLDS.unpaired.descriptive - current} more ${stratum.toLowerCase().replace(/_/g, ' ')} case(s) (now ${current}). Without them the corpus is an easy-product benchmark.`,
    });
  }

  // 3. Paired-device gaps, per garment (mission section 15).
  if (counts.iosCases === 0 || counts.androidCases === 0) {
    const missing = [];
    if (counts.iosCases === 0) missing.push('iOS');
    if (counts.androidCases === 0) missing.push('Android');
    const subject =
      missing.length === 2 ? 'Neither iOS nor Android captures exist' : `No ${missing[0]} captures exist`;
    gaps.push({
      priority: 1,
      claimId: 'PAIRED_DEVICE_COVERAGE',
      currentN: counts.pairedGarments,
      shortfall: THRESHOLDS.paired.descriptive,
      text:
        `${subject}, so no device pair can be formed. PAIRED PLATFORM COLLECTION: PENDING_DEVICE. ` +
        "Do not fabricate parity by re-filing one platform's photograph as the other.",
    });
  }

  // 4. Collector diversity (mission section 35).
  if (collection.collectorCount <= 1) {
    gaps.push({
      priority: 2,
      claimId: 'COLLECTOR_DIVERSITY',
      currentN: collection.collectorCount,
      shortfall: 1,
      text:
        `Only ${collection.collectorCount} collector(s). A single-collector corpus inherits one wardrobe, one home ` +
        'lighting setup, one taste and one capture style. Add a second collector before scaling past the pilot.',
    });
  }

  // 5. Collection-source diversity (mission section 10).
  const sourcesUsed = Object.keys(collection.sourceDistribution || {});
  for (const source of COLLECTION_SOURCES) {
    if (sourcesUsed.includes(source)) continue;
    gaps.push({
      priority: 3,
      claimId: `COLLECTION_SOURCE__${source}`,
      currentN: 0,
      shortfall: 1,
      text: `No cases from ${source}. The corpus should not depend entirely on one person's wardrobe (mission section 10).`,
    });
  }

  gaps.sort((a, b) => a.priority - b.priority || a.shortfall - b.shortfall);
  return gaps;
}

function formatQueue(queue, gaps) {
  const lines = [];
  const push = (line = '') => lines.push(line);

  push('REAL FASHION MATCH CORPUS - COLLECTION QUEUE');
  push('='.repeat(60));
  push(`corpus version : ${queue.corpusVersion}`);
  push(`corpus hash    : ${queue.corpusHash.slice(0, 16)}...`);
  push(`asset storage  : ${queue.assetStorage.status} (${queue.assetStorage.root})`);
  push();
  push('QUEUE STATE');
  for (const [state, count] of Object.entries(queue.queue)) push(`  ${state.padEnd(22)} ${count}`);
  push();
  push('COUNTS');
  for (const [key, value] of Object.entries(queue.counts)) push(`  ${key.padEnd(28)} ${value}`);
  push();
  push('GROUND-TRUTH GRADES (by garment)');
  const totalGarments = queue.counts.garments || 0;
  for (const [grade, count] of Object.entries(queue.groundTruthGrades)) {
    const pct = totalGarments > 0 ? ` (${((count / totalGarments) * 100).toFixed(0)}%)` : '';
    push(`  ${grade.padEnd(22)} ${count}${pct}`);
  }
  if (totalGarments === 0) push('  (no garments collected yet)');
  push();
  push('COLLECTION');
  push(`  collectors            ${queue.collection.collectorCount} ${queue.collection.collectors.join(', ')}`);
  push(`  source distribution   ${JSON.stringify(queue.collection.sourceDistribution)}`);
  push();
  push('CLAIM DISCIPLINE');
  for (const [classification, count] of Object.entries(queue.claimDiscipline.summary)) {
    push(`  ${classification.padEnd(22)} ${count}`);
  }
  push();
  push(`QC: ${queue.qc.passed ? 'PASS' : 'FAIL'} (${queue.qc.rejectionCount} rejection(s), ${queue.qc.blockerCount} blocker(s))`);
  for (const finding of queue.qc.findings.slice(0, 20)) {
    push(`  [${finding.severity}] ${finding.code} ${finding.caseId || finding.garmentId || (finding.caseIds || []).join('+')}: ${finding.message}`);
  }
  push();
  push('PROCUREMENT / COLLECTION GAP LIST');
  push('-'.repeat(60));
  if (gaps.length === 0) {
    push('  No gaps: every designed claim is at least DESCRIPTIVE_ONLY.');
  } else {
    for (const gap of gaps) push(`  P${gap.priority}  ${gap.text}`);
  }
  return lines.join('\n');
}

module.exports = { buildQueue, buildGapList, formatQueue };
