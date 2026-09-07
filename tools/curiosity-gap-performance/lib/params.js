'use strict';
/**
 * Parameter resolution from the assumptions register.
 *
 * The register is the single source of truth for every number the model
 * consumes. Nothing may reach the model that is not declared there — that is
 * enforced by lib/model.js throwing on an unknown parameter rather than
 * defaulting, and by this module refusing to invent a band it cannot find.
 */

const fs = require('node:fs');
const path = require('node:path');

const REGISTER_PATH = path.join(__dirname, '..', 'authority', 'assumptions-register.json');

function loadRegister(registerPath = REGISTER_PATH) {
  return JSON.parse(fs.readFileSync(registerPath, 'utf8'));
}

/**
 * Build a parameter set at one band ('low' | 'mid' | 'high').
 *
 * Every value carries its declared evidence class, so a stage reading an
 * OBSERVED parameter produces an OBSERVED duration and one reading a MODELED
 * parameter produces a MODELED duration. That is what makes the critical-path
 * evidence class meaningful rather than decorative.
 */
function paramsAtBand(register, band, overrides = {}) {
  if (!['low', 'mid', 'high'].includes(band)) {
    throw new Error(`band must be low|mid|high, got "${band}"`);
  }
  const params = {};
  for (const entry of register.parameters) {
    const r = entry.value_or_range;
    let value;
    if (r && typeof r === 'object' && band in r) {
      value = r[band];
    } else if (r && typeof r.fixed === 'number') {
      value = r.fixed;
    } else if (r && Array.isArray(r.sweep)) {
      // A swept parameter has no single band value; pick a representative
      // midpoint so a non-sweep run is still evaluable, and say so.
      value = r.sweep[Math.floor(r.sweep.length / 2)];
    } else {
      continue; // derived parameters are supplied by the caller
    }
    params[entry.parameter] = { value, evidence_class: entry.evidence };
  }
  // retry_attempts_extra defaults to 0 (no retry) unless swept explicitly.
  params.retry_attempts_extra = 0;
  return { ...params, ...overrides };
}

function describeParams(params) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => typeof v === 'object' && v !== null && 'value' in v)
      .map(([k, v]) => [k, `${v.value} (${v.evidence_class})`]),
  );
}

module.exports = { REGISTER_PATH, loadRegister, paramsAtBand, describeParams };
