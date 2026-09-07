'use strict';

/**
 * COVERAGE MATRIX — spec section 20.
 *
 * Coverage = DEFECT TYPE x TASK TYPE x CONTEXT STRATUM x DIFFICULTY.
 * Built from the ACTUAL generated corpus (metrics/corpusRunner.js), not a
 * blind Cartesian product: most cells of a 16 x 15 x 3 x 3 = 2160-cell grid
 * are legitimately empty given a bounded 20-scenario fixture set (spec
 * section 21), and an empty cell is reported as INSUFFICIENT_COVERAGE, never
 * silently treated as a passing or failing result. The matrix HASH
 * (COVERAGE_MATRIX_HASH) is a baseline field (baseline/baseline.js) so a
 * later corpus change that silently shifts coverage is detectable.
 */

const { canonicalStringify, sha256Hex } = require('../model/canonicalJson');

const CONTEXT_STRATA = Object.freeze({
  rich: ['closet_large', 'closet_balanced', 'closet_formal_heavy', 'closet_casual_heavy', 'closet_monochrome', 'closet_colorful'],
  sparse: ['closet_minimal', 'closet_missing_category', 'closet_seasonally_limited'],
  edge: ['closet_empty', 'closet_similar_item_ambiguity', 'closet_non_k_plus_actor'],
});

function contextStratumOf(closetId) {
  for (const [stratum, ids] of Object.entries(CONTEXT_STRATA)) {
    if (ids.includes(closetId)) return stratum;
  }
  return 'unclassified';
}

/**
 * @param {object[]} cases - corpusRunner.buildCorpus().cases (script !== CLEAN/AMBIGUITY only, matrix is defect-coverage specific)
 * @param {object[]} scenarios - fixtures.scenarios (for closetId/difficulty lookups)
 */
function buildCoverageMatrix(cases, scenariosById) {
  const cells = new Map(); // key "defect|task|stratum|difficulty" -> count

  for (const c of cases) {
    if (c.script === 'CLEAN' || c.script === 'AMBIGUITY') continue;
    const scenario = scenariosById[c.scenarioId];
    if (!scenario) continue;
    const stratum = contextStratumOf(scenario.closetId);
    const key = [c.script, c.taskId, stratum, scenario.difficulty].join('|');
    cells.set(key, (cells.get(key) || 0) + 1);
  }

  const rows = [...cells.entries()]
    .map(([key, count]) => {
      const [defectCode, taskId, contextStratum, difficulty] = key.split('|');
      return { defectCode, taskId, contextStratum, difficulty, count };
    })
    .sort((a, b) => (a.defectCode + a.taskId + a.contextStratum + a.difficulty).localeCompare(
      b.defectCode + b.taskId + b.contextStratum + b.difficulty,
    ));

  const covered = rows.length;
  const totalCasesCovered = rows.reduce((sum, r) => sum + r.count, 0);

  const matrix = {
    coverageMatrixVersion: 'COVERAGE_MATRIX_V1',
    dimensions: ['defectCode', 'taskId', 'contextStratum', 'difficulty'],
    coveredCellCount: covered,
    totalCasesCovered,
    note:
      'This is the OBSERVED coverage of the bounded corpus, not a Cartesian product target (spec section 20 explicitly warns against generating one). A defect/task/stratum/difficulty combination absent from `rows` is INSUFFICIENT_COVERAGE by omission -- it is not scored, in either direction.',
    rows,
  };

  const hash = sha256Hex(canonicalStringify(matrix));
  return { ...matrix, coverageMatrixHash: hash };
}

/** Per-defect-code coverage summary: which task/stratum/difficulty combinations exist at all. */
function summarizeDefectCoverage(matrix) {
  const byDefect = {};
  for (const row of matrix.rows) {
    if (!byDefect[row.defectCode]) byDefect[row.defectCode] = { taskIds: new Set(), strata: new Set(), difficulties: new Set(), cellCount: 0 };
    byDefect[row.defectCode].taskIds.add(row.taskId);
    byDefect[row.defectCode].strata.add(row.contextStratum);
    byDefect[row.defectCode].difficulties.add(row.difficulty);
    byDefect[row.defectCode].cellCount += 1;
  }
  const out = {};
  for (const [code, v] of Object.entries(byDefect)) {
    out[code] = {
      cellCount: v.cellCount,
      taskIds: [...v.taskIds].sort(),
      contextStrata: [...v.strata].sort(),
      difficulties: [...v.difficulties].sort(),
    };
  }
  return out;
}

module.exports = { buildCoverageMatrix, summarizeDefectCoverage, contextStratumOf, CONTEXT_STRATA };
