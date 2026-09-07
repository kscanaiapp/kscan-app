'use strict';
/**
 * Source bindings — the mechanism that stops this lab quietly going stale.
 *
 * Every modelled stage claims a fact about production source ("Gemini is
 * awaited before commerce starts", "the fast fan-out deadline is 1900 ms").
 * Those claims are only true at a particular revision of a particular file. If
 * someone changes `commerceFunnelConfig.ts` next month, every conclusion drawn
 * from it silently becomes fiction — and a stale model that still runs green is
 * worse than no model, because it is trusted.
 *
 * So each binding records a sha256 of the bound file. `verifyBindings` re-hashes
 * and reports drift. The runner treats drift as FAIL, not as a warning.
 *
 * A whole-file hash is deliberately chosen over a line-range hash: line ranges
 * drift under unrelated edits and produce false confidence when a constant
 * moves. A whole-file hash over-reports (a comment change trips it), and
 * over-reporting is the correct failure direction for an authority artifact.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256OfFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256OfString(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Build the binding record for a set of repo-relative paths.
 * `repoRoot` is explicit so the lab never depends on process.cwd().
 */
function buildBindings(repoRoot, relPaths) {
  const files = {};
  for (const rel of [...relPaths].sort()) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`source binding target does not exist: ${rel}`);
    }
    files[rel] = sha256OfFile(abs);
  }
  return {
    files,
    // One hash over the whole binding set, so a baseline can carry a single
    // comparable fingerprint instead of a map.
    binding_hash: sha256OfString(
      Object.entries(files).map(([k, v]) => `${k}:${v}`).join('\n'),
    ),
  };
}

/**
 * Re-hash and compare. Returns { ok, drifted: [...], missing: [...] }.
 * Never throws on drift — the caller decides the severity, and the report
 * validator and the runner want different exit behaviour.
 */
function verifyBindings(repoRoot, bindings) {
  const drifted = [];
  const missing = [];
  for (const [rel, expected] of Object.entries(bindings.files || {})) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const actual = sha256OfFile(abs);
    if (actual !== expected) drifted.push({ file: rel, expected, actual });
  }
  const recomputed = Object.entries(bindings.files || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join('\n');
  return {
    ok: drifted.length === 0 && missing.length === 0,
    drifted,
    missing,
    binding_hash_consistent: sha256OfString(recomputed) === bindings.binding_hash,
  };
}

/**
 * A model stage's binding ledger entry (§16). Every field is required: an
 * entry without a control-flow fact is a decorative citation, not a binding.
 */
function bindingEntry({
  modelStage,
  sourceFile,
  sourceFunction,
  controlFlowFact,
  extractedConstants = {},
  assumedValues = {},
  evidenceClass,
}) {
  for (const [k, v] of Object.entries({ modelStage, sourceFile, sourceFunction, controlFlowFact, evidenceClass })) {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new TypeError(`binding entry field "${k}" must be a non-empty string`);
    }
  }
  return {
    model_stage: modelStage,
    source_file: sourceFile,
    source_function: sourceFunction,
    control_flow_fact: controlFlowFact,
    extracted_constants: extractedConstants,
    assumed_values: assumedValues,
    evidence_class: evidenceClass,
  };
}

module.exports = { sha256OfFile, sha256OfString, buildBindings, verifyBindings, bindingEntry };
