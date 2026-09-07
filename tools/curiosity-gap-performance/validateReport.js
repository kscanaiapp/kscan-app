#!/usr/bin/env node
'use strict';
/**
 * INDEPENDENT REPORT VALIDATOR (§37).
 *
 * Deliberately separate from runLab.js and deliberately NOT sharing its
 * helpers beyond the pure libs. A validator that imports the runner's own
 * conclusions validates nothing: it has to be able to fail an artifact the
 * runner happily produced.
 *
 * Exits non-zero on failure.
 *
 * Usage: node tools/curiosity-gap-performance/validateReport.js [baseline.json ...]
 *        (with no arguments it validates every baseline in baseline/)
 */

const fs = require('node:fs');
const path = require('node:path');

const { verifyBindings } = require('./lib/sourceBinding');
const { assertPrivacySafe } = require('./lib/privacy');
const { EVIDENCE_CLASSES } = require('./lib/evidence');
const { REQUIRED_VERSION_FIELDS } = require('./lib/baseline');
const { validateGraph } = require('./lib/graph');

const LAB_DIR = __dirname;
const REPO_ROOT = path.resolve(LAB_DIR, '..', '..');
const REQUIRED_DISCLAIMER = 'INTERNAL ENGINEERING ANALYSIS ONLY';

const FORBIDDEN_COMPARISONS = [
  'google lens', 'amazon', 'phia', 'daydream', 'style dna', 'syte', 'visenze',
];

function fail(failures, check, detail) { failures.push({ check, detail }); }

function validateArtifactFiles(failures) {
  const required = [
    'authority/ttfar-definition.json',
    'authority/actionable-result-schema.json',
    'authority/assumptions-register.json',
    'authority/source-bindings.json',
    'platformProfiles/ios.json',
    'platformProfiles/android.json',
    'scenarios/scan-funnel-on.json',
    'scenarios/scan-funnel-off.json',
  ];
  const loaded = {};
  for (const rel of required) {
    const abs = path.join(LAB_DIR, rel);
    if (!fs.existsSync(abs)) { fail(failures, 'artifact_present', rel); continue; }
    try { loaded[rel] = JSON.parse(fs.readFileSync(abs, 'utf8')); }
    catch (err) { fail(failures, 'artifact_parses', `${rel}: ${err.message}`); }
  }
  return loaded;
}

function validateSourceAuthority(failures, loaded) {
  const EXPECTED_SHA = '909df8646a690b55c5af6b7b8c80193df64a2ec8';
  for (const [rel, a] of Object.entries(loaded)) {
    if ('source_sha' in a && a.source_sha !== EXPECTED_SHA) {
      fail(failures, 'source_sha', `${rel} declares ${a.source_sha}, expected ${EXPECTED_SHA}`);
    }
  }
  const bindings = loaded['authority/source-bindings.json'];
  if (bindings) {
    const v = verifyBindings(REPO_ROOT, bindings);
    if (!v.ok) {
      fail(failures, 'source_binding_drift', { drifted: v.drifted.map((d) => d.file), missing: v.missing });
    }
    if (!v.binding_hash_consistent) fail(failures, 'binding_hash_consistency', 'binding_hash does not match its file map');
  }
}

function validateDefinitions(failures, loaded) {
  const ttfar = loaded['authority/ttfar-definition.json'];
  if (ttfar) {
    if (!ttfar.ttfar_start_version) fail(failures, 'ttfar_definition', 'missing ttfar_start_version');
    if (!ttfar.t_zero?.source_file || !ttfar.t_zero?.function) {
      fail(failures, 'ttfar_definition', 't=0 must name a source file and function');
    }
    if (ttfar.t_zero?.evidence_class !== 'PROVEN') {
      fail(failures, 'ttfar_definition', 't=0 must be PROVEN from source, not asserted');
    }
  }
  const act = loaded['authority/actionable-result-schema.json'];
  if (act) {
    if (!act.actionable_result_version) fail(failures, 'actionable_result', 'missing actionable_result_version');
    const req = act.minimum_renderable?.required_fields;
    if (!Array.isArray(req) || req.length === 0) {
      fail(failures, 'actionable_result', 'minimum_renderable.required_fields must be a non-empty array');
    } else {
      for (const f of req) {
        if (!f.enforced_at) fail(failures, 'actionable_result', `field ${f.field} has no enforcement locator`);
      }
    }
    if (!act.minimum_actionable?.validator) fail(failures, 'actionable_result', 'missing the actionability validator locator');
  }
}

function validateEvidenceClasses(failures, loaded) {
  const register = loaded['authority/assumptions-register.json'];
  if (!register) return;
  const seen = new Set();
  for (const p of register.parameters || []) {
    if (!EVIDENCE_CLASSES.includes(p.evidence)) {
      fail(failures, 'evidence_class', `parameter ${p.parameter} has invalid evidence "${p.evidence}"`);
    }
    if (p.evidence !== 'PROVEN' && (!p.source || p.source.trim() === '')) {
      fail(failures, 'modeled_assumption_provenance', `parameter ${p.parameter} is ${p.evidence} with no provenance`);
    }
    if (!('if_wrong_by_3x_does_conclusion_survive' in p)) {
      fail(failures, 'assumptions_register', `parameter ${p.parameter} is missing the 3x robustness field`);
    }
    if (seen.has(p.parameter)) fail(failures, 'assumptions_register', `duplicate parameter ${p.parameter}`);
    seen.add(p.parameter);
  }
}

function validateScenarios(failures, loaded) {
  for (const rel of ['scenarios/scan-funnel-on.json', 'scenarios/scan-funnel-off.json']) {
    const s = loaded[rel];
    if (!s) continue;
    if (!s.scenario_version) fail(failures, 'scenario_version', `${rel} missing scenario_version`);
    if (!s.first_result_terminal || !s.completion_terminal) {
      fail(failures, 'critical_path_consistency', `${rel} must declare both terminals`);
    }
    try { validateGraph(s.stages); }
    catch (err) { fail(failures, 'dependency_graph', `${rel}: ${err.message}`); }
    const ids = new Set(s.stages.map((x) => x.id));
    if (!ids.has(s.first_result_terminal)) fail(failures, 'critical_path_consistency', `${rel} first_result_terminal is not a stage`);
    if (!ids.has(s.completion_terminal)) fail(failures, 'critical_path_consistency', `${rel} completion_terminal is not a stage`);
  }
}

function validatePlatformProfiles(failures, loaded) {
  for (const rel of ['platformProfiles/ios.json', 'platformProfiles/android.json']) {
    const p = loaded[rel];
    if (!p) continue;
    if (!p.platform_profile_version) fail(failures, 'platform_profile_version', `${rel} missing platform_profile_version`);
    if (!['SOURCE-MAPPED', 'DEVICE-MEASURED'].includes(p.evidence_level)) {
      fail(failures, 'platform_profile', `${rel} evidence_level must be SOURCE-MAPPED or DEVICE-MEASURED`);
    }
    if (p.evidence_level === 'DEVICE-MEASURED' && p.device_measured !== true) {
      fail(failures, 'platform_profile', `${rel} claims DEVICE-MEASURED but device_measured is not true`);
    }
  }
}

function validateDisclaimers(failures, loaded, baselines) {
  const all = [...Object.entries(loaded), ...baselines.map((b) => [b.__file, b.artifact_json])];
  for (const [name, a] of all) {
    if (!a) continue;
    const text = JSON.stringify(a).toLowerCase();
    for (const competitor of FORBIDDEN_COMPARISONS) {
      // Only flag a competitor name used in a comparative timing context.
      if (text.includes(`than ${competitor}`) || text.includes(`vs ${competitor}`) || text.includes(`versus ${competitor}`)) {
        fail(failures, 'competitor_comparison', `${name} compares against ${competitor}`);
      }
    }
  }
  for (const b of baselines) {
    if (!String(b.artifact_json.benchmark_status || '').includes(REQUIRED_DISCLAIMER)) {
      fail(failures, 'required_disclaimer', `${b.__file} missing the internal-only disclaimer`);
    }
  }
}

function validateBaseline(failures, file, artifact) {
  for (const f of REQUIRED_VERSION_FIELDS) {
    if (typeof artifact[f] !== 'string' || !artifact[f].trim()) {
      fail(failures, 'baseline_versions', `${file}: missing ${f}`);
    }
  }
  if (!artifact.structural_findings || !artifact.modeled_timing_findings) {
    fail(failures, 'baseline_separation', `${file}: structural and modeled findings must be separate blocks`);
  }
  if (artifact.network_calls_made !== 0 || artifact.provider_spend_usd !== 0) {
    fail(failures, 'offline_guarantee', `${file}: baseline claims network calls or spend`);
  }
  // Modelled numbers must not be presented as measurements.
  const modeled = artifact.modeled_timing_findings;
  if (modeled && !String(modeled.disclaimer || '').toLowerCase().includes('modeled')) {
    fail(failures, 'modeled_labelling', `${file}: modeled_timing_findings lacks its MODELED disclaimer`);
  }
  try { assertPrivacySafe(artifact, file); }
  catch (err) { fail(failures, 'privacy', `${file}: ${err.message}`); }
}

function main(argv) {
  const failures = [];
  const loaded = validateArtifactFiles(failures);
  validateSourceAuthority(failures, loaded);
  validateDefinitions(failures, loaded);
  validateEvidenceClasses(failures, loaded);
  validateScenarios(failures, loaded);
  validatePlatformProfiles(failures, loaded);

  let files = argv.slice(2);
  if (files.length === 0) {
    const dir = path.join(LAB_DIR, 'baseline');
    files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f))
      : [];
  }
  const baselines = [];
  for (const f of files) {
    try {
      const artifact = JSON.parse(fs.readFileSync(f, 'utf8'));
      validateBaseline(failures, path.basename(f), artifact);
      baselines.push({ __file: path.basename(f), artifact_json: artifact });
    } catch (err) {
      fail(failures, 'baseline_parses', `${f}: ${err.message}`);
    }
  }
  validateDisclaimers(failures, loaded, baselines);

  const result = {
    validator: 'curiosity-gap-performance',
    baselines_validated: baselines.map((b) => b.__file),
    failures,
    pass: failures.length === 0,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}

if (require.main === module) main(process.argv);

module.exports = { main };
