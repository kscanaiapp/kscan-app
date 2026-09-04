/**
 * Certification artifact schema for the VTO E2E harness (repair spec §7).
 *
 * No JSON-schema library was added for nine required fields; this module IS
 * the strongly-defined interface, hand-checked and directly unit-tested
 * (repair spec §8's stale-artifact negative controls exercise
 * `validateReportArtifact` below with no file I/O and no live workflow).
 * scripts/vto-e2e/validate-report.mjs is the CLI entry point that wraps it.
 */
'use strict';

export const REQUIRED_REPORT_FIELDS = [
  'runId',
  'projectRef',
  'mode',
  'authoritySha',
  'controls',
  'providerSubmits',
  'paidRequests',
  'cleanupStatus',
  'verdict',
];

export const MIN_REPORT_BYTES = 1; // > 0 bytes
export const MAX_REPORT_BYTES = 10 * 1024 * 1024; // < 10 MB

const VALID_VERDICTS = new Set(['PASS', 'FAIL']);
const VALID_MODES = new Set(['contract', 'staging-dryrun', 'staging-full-certification', 'cleanup']);

/**
 * Validates a report's raw byte size (repair spec §6). Size alone is never
 * sufficient proof of validity — this gate is always used alongside the
 * structural/correlation checks below, never standalone.
 */
export function validateReportSize(byteLength) {
  const errors = [];
  if (!Number.isFinite(byteLength) || byteLength < MIN_REPORT_BYTES) {
    errors.push(`report is ${byteLength} bytes — must be > 0 (missing or empty artifact)`);
  } else if (byteLength >= MAX_REPORT_BYTES) {
    errors.push(`report is ${byteLength} bytes — must be < ${MAX_REPORT_BYTES} (10 MB ceiling for a structured certification artifact)`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validates a PARSED report object's shape and, when `expectations` names
 * any of runId/projectRef/mode/authoritySha, its correlation to the current
 * invocation. Returns `{ ok, errors, stale }` — never throws.
 *
 * `stale` distinguishes an artifact that is structurally well-formed but
 * carries a different run's identity (STALE) from one that is malformed or
 * incomplete outright — repair spec §8 requires the harness to tell those
 * apart rather than reject both the same way. An ABSENT artifact (the file
 * itself doesn't exist) is a distinct case entirely and is handled by
 * validate-report.mjs before this function is ever called.
 */
export function validateReportArtifact(report, expectations = {}) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, errors: ['report is not a JSON object'], stale: false };
  }

  const errors = [];

  for (const field of REQUIRED_REPORT_FIELDS) {
    if (!(field in report)) errors.push(`missing required field: ${field}`);
  }

  if ('runId' in report && typeof report.runId !== 'string') {
    errors.push('runId must be a string');
  }
  if ('projectRef' in report && typeof report.projectRef !== 'string') {
    errors.push('projectRef must be a string');
  }
  if ('mode' in report) {
    if (typeof report.mode !== 'string') {
      errors.push('mode must be a string');
    } else if (!VALID_MODES.has(report.mode)) {
      errors.push(`mode must be one of ${[...VALID_MODES].join(', ')}, got ${JSON.stringify(report.mode)}`);
    }
  }
  if ('authoritySha' in report) {
    if (typeof report.authoritySha !== 'string') {
      errors.push('authoritySha must be a string');
    } else if (!/^[0-9a-f]{40}$/i.test(report.authoritySha)) {
      errors.push('authoritySha must be an exact 40-hex commit SHA');
    }
  }
  if ('controls' in report) {
    if (report.controls === null || typeof report.controls !== 'object') {
      errors.push('controls must be an array or object of explicit control outcomes');
    } else {
      const count = Array.isArray(report.controls) ? report.controls.length : Object.keys(report.controls).length;
      if (count === 0) errors.push('controls must be non-empty — zero recorded control outcomes proves nothing');
    }
  }
  if ('providerSubmits' in report && typeof report.providerSubmits !== 'number') {
    errors.push('providerSubmits must be a number');
  }
  if ('paidRequests' in report && typeof report.paidRequests !== 'number') {
    errors.push('paidRequests must be a number');
  }
  if ('cleanupStatus' in report
    && (report.cleanupStatus === null || typeof report.cleanupStatus !== 'object' || Array.isArray(report.cleanupStatus))) {
    errors.push('cleanupStatus must be a structured object');
  }
  if ('verdict' in report) {
    if (typeof report.verdict !== 'string') {
      errors.push('verdict must be a string');
    } else if (!VALID_VERDICTS.has(report.verdict)) {
      errors.push(`verdict must be one of ${[...VALID_VERDICTS].join(', ')}, got ${JSON.stringify(report.verdict)}`);
    }
  }

  // Correlation is only meaningful once the shape itself is trustworthy —
  // an artifact failing structural checks is STRUCTURAL, not STALE, even if
  // it happens to also carry a mismatched identity.
  let stale = false;
  if (errors.length === 0) {
    const staleReasons = [];
    for (const key of ['runId', 'projectRef', 'mode', 'authoritySha']) {
      if (expectations[key] !== undefined && report[key] !== expectations[key]) {
        stale = true;
        staleReasons.push(`${key} ${JSON.stringify(report[key])} != expected ${JSON.stringify(expectations[key])}`);
      }
    }
    if (stale) errors.push(`STALE ARTIFACT (does not correlate to this invocation): ${staleReasons.join('; ')}`);
  }

  return { ok: errors.length === 0, errors, stale };
}
