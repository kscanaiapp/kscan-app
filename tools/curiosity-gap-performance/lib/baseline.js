'use strict';
/**
 * Baseline write + compare.
 *
 * A baseline is IMMUTABLE by policy (§30): writing over an existing baseline
 * file is refused. A performance baseline that can be silently overwritten is
 * not a baseline, it is a scratch file, and the first time someone "refreshes"
 * it the regression it was meant to catch disappears with it.
 *
 * Compare is deliberately conservative. It reports structural change and
 * modelled change SEPARATELY and never declares one artifact better than
 * another: a shorter modelled path proves nothing about production, and
 * quality effects belong to a different lane entirely.
 */

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_VERSION_FIELDS = [
  'source_sha',
  'source_binding_hash',
  'trace_schema_version',
  'ttfar_definition_version',
  'actionable_result_version',
  'scenario_version',
  'platform_profile_version',
  'model_version',
];

class BaselineError extends Error {
  constructor(message) { super(message); this.name = 'BaselineError'; }
}

function assertBaselineShape(artifact) {
  for (const field of REQUIRED_VERSION_FIELDS) {
    if (typeof artifact[field] !== 'string' || artifact[field].trim() === '') {
      throw new BaselineError(`baseline is missing required version field "${field}"`);
    }
  }
  if (!artifact.structural_findings) {
    throw new BaselineError('baseline must separate structural_findings from modeled_timing_findings');
  }
  if (!artifact.modeled_timing_findings) {
    throw new BaselineError('baseline must separate modeled_timing_findings from structural_findings');
  }
  if (typeof artifact.benchmark_status !== 'string' || !artifact.benchmark_status.includes('INTERNAL ENGINEERING ANALYSIS ONLY')) {
    throw new BaselineError('baseline must carry the mandatory internal-only benchmark disclaimer');
  }
  return true;
}

/** Refuses to overwrite. The caller must choose a new filename deliberately. */
function writeBaseline(filePath, artifact) {
  assertBaselineShape(artifact);
  if (fs.existsSync(filePath)) {
    throw new BaselineError(
      `refusing to overwrite an existing baseline: ${path.basename(filePath)}. ` +
        'Baselines are immutable — write a new versioned file instead.',
    );
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return filePath;
}

function readBaseline(filePath) {
  const artifact = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assertBaselineShape(artifact);
  return artifact;
}

/**
 * Compatibility is checked BEFORE any number is compared. Comparing timings
 * across different TTFAR definitions or different actionable-result schemas
 * produces a difference that means nothing, which is worse than refusing.
 */
function assertComparable(a, b) {
  const incompatible = [];
  for (const field of ['trace_schema_version', 'ttfar_definition_version', 'actionable_result_version', 'scenario_version', 'model_version']) {
    if (a[field] !== b[field]) incompatible.push({ field, a: a[field], b: b[field] });
  }
  if (incompatible.length > 0) {
    throw new BaselineError(
      `incompatible baselines: ${incompatible.map((i) => `${i.field} ${i.a} != ${i.b}`).join('; ')}`,
    );
  }
  return true;
}

function compareBaselines(a, b) {
  assertComparable(a, b);

  const structuralChange = [];
  const aStruct = a.structural_findings;
  const bStruct = b.structural_findings;
  for (const key of new Set([...Object.keys(aStruct), ...Object.keys(bStruct)])) {
    const av = JSON.stringify(aStruct[key]);
    const bv = JSON.stringify(bStruct[key]);
    if (av !== bv) structuralChange.push({ finding: key, from: aStruct[key], to: bStruct[key] });
  }

  const scenarioDelta = {};
  for (const sid of Object.keys(b.modeled_timing_findings.scenarios || {})) {
    const before = a.modeled_timing_findings.scenarios?.[sid];
    const after = b.modeled_timing_findings.scenarios?.[sid];
    if (!before || !after) continue;
    scenarioDelta[sid] = {
      first_result_critical_path_change: {
        from_chain: before.mid.first_result_chain,
        to_chain: after.mid.first_result_chain,
        chain_changed: JSON.stringify(before.mid.first_result_chain) !== JSON.stringify(after.mid.first_result_chain),
        modeled_ms_from: before.mid.first_result_ms,
        modeled_ms_to: after.mid.first_result_ms,
        evidence_class: 'MODELED',
      },
      complete_critical_path_change: {
        from_chain: before.mid.complete_response_chain,
        to_chain: after.mid.complete_response_chain,
        chain_changed: JSON.stringify(before.mid.complete_response_chain) !== JSON.stringify(after.mid.complete_response_chain),
        modeled_ms_from: before.mid.complete_response_ms,
        modeled_ms_to: after.mid.complete_response_ms,
        evidence_class: 'MODELED',
      },
    };
  }

  return {
    compared: { a: a.baseline_id, b: b.baseline_id },
    source_sha_change: a.source_sha === b.source_sha ? null : { from: a.source_sha, to: b.source_sha },
    source_binding_change: a.source_binding_hash === b.source_binding_hash
      ? null
      : { from: a.source_binding_hash, to: b.source_binding_hash,
          meaning: 'bound production source changed; every structural claim must be re-derived, not assumed to carry over' },
    structural_change: structuralChange,
    scenario_delta: scenarioDelta,
    timeout_exposure: {
      from: a.modeled_timing_findings.timeout_exposure,
      to: b.modeled_timing_findings.timeout_exposure,
    },
    retry_exposure: {
      from: a.modeled_timing_findings.retry_exposure,
      to: b.modeled_timing_findings.retry_exposure,
    },
    network_exposure: {
      from: a.modeled_timing_findings.network_exposure,
      to: b.modeled_timing_findings.network_exposure,
    },
    quality_effect: 'UNKNOWN',
    quality_effect_reason:
      'Match quality is owned by a different lane. This comparison establishes structure and modelled timing only, ' +
      'and never asserts that either artifact represents a better production system.',
    production_superiority_declared: false,
  };
}

module.exports = {
  REQUIRED_VERSION_FIELDS,
  BaselineError,
  assertBaselineShape,
  writeBaseline,
  readBaseline,
  assertComparable,
  compareBaselines,
};
