#!/usr/bin/env node
'use strict';

/**
 * Secure Upload Gate for CI (Phase 12). Pure functions only, mirroring the
 * existing perimeter-manifest-guard.js / rls-storage-guard.js conventions --
 * a CI step supplies structured input (the manifest, a live scanner health
 * probe, an EICAR scan result) and this module decides pass/fail.
 */

const REQUIRED_MANIFEST_FIELDS = ['name', 'type', 'route', 'caller', 'enforcementStatus'];

// A surface with an entry at all -- even one with a real, documented gap
// (PARTIALLY_ENFORCED, NOT_ENFORCED_PENDING_OWNER_DECISION) -- is fine for
// this gate; the invariant enforced here is "nothing is silently
// unclassified," not "every gap is already closed." NOT_PRESENT_ON_BRANCH
// and DEAD_CODE_NO_LIVE_CALLER are also acceptable: they document routes
// that don't exist yet or have no live caller.
const ACCEPTABLE_ENFORCEMENT_STATUSES = [
  'ENFORCED',
  'PARTIALLY_ENFORCED',
  'NOT_ENFORCED_PENDING_OWNER_DECISION',
  'NOT_PRESENT_ON_BRANCH',
  'DEAD_CODE_NO_LIVE_CALLER',
];

function detectMissingRequiredFields(surfaces) {
  const missing = [];
  for (const surface of surfaces) {
    const absent = REQUIRED_MANIFEST_FIELDS.filter((f) => !(f in surface) || surface[f] === undefined);
    if (absent.length > 0) missing.push({ name: surface.name || '(unnamed)', missingFields: absent });
  }
  return missing;
}

function detectUnacceptableEnforcementStatus(surfaces) {
  return surfaces
    .filter((s) => !ACCEPTABLE_ENFORCEMENT_STATUSES.includes(s.enforcementStatus))
    .map((s) => ({ name: s.name, enforcementStatus: s.enforcementStatus }));
}

// knownRouteNames: the exhaustive route-name list this CI run expects to see
// classified (kept in sync with docs/security/secure-image-ingestion-inventory.md).
// Flags a route that inventory tracing found but the manifest never classified.
function detectUnclassifiedKnownRoutes(knownRouteNames, surfaces) {
  const classified = new Set(surfaces.map((s) => s.name));
  return knownRouteNames.filter((name) => !classified.has(name));
}

// liveFunctionSlugs: Edge Function slugs confirmed deployed right now (e.g.
// from a live `list_edge_functions` snapshot). Flags a function the manifest
// says is `heldFunction: true` / `liveInProduction: false` that has actually
// gone live without being reclassified -- the single highest-severity
// regression this check exists for (a scanner-bypassing function shipping
// silently).
function detectHeldFunctionDriftedLive(liveFunctionSlugs, surfaces) {
  const liveSet = new Set(liveFunctionSlugs);
  return surfaces
    .filter((s) => s.heldFunction === true && s.liveInProduction === false && liveSet.has(s.name))
    .map((s) => s.name);
}

// Every live render_endpoint / supabase_edge_function surface must at least
// document whether malware scanning is enabled (even if the honest answer is
// "false, pending scanner deployment") -- an entry silently omitting the
// field entirely would mean nobody classified that dimension.
function detectUndocumentedScanStatus(surfaces) {
  return surfaces
    .filter((s) => s.liveInProduction === true && (s.type === 'render_endpoint' || s.type === 'supabase_edge_function'))
    .filter((s) => !('malwareScanEnabled' in s))
    .map((s) => s.name);
}

// ── Scanner health (Phase 12: "scanner health passes", "signature age is within policy") ──

const DEFAULT_MAX_SIGNATURE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// versionString like "ClamAV 1.3.0/27000/Wed Aug  3 00:00:00 2026" -- the
// third '/'-separated field is the signature database build timestamp.
function parseClamdSignatureDate(versionString) {
  if (typeof versionString !== 'string') return null;
  const parts = versionString.split('/');
  if (parts.length < 3) return null;
  const dateString = parts.slice(2).join('/').trim();
  const parsed = new Date(dateString);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isSignatureStale(versionString, nowMs, maxAgeMs = DEFAULT_MAX_SIGNATURE_AGE_MS) {
  const sigDate = parseClamdSignatureDate(versionString);
  if (!sigDate) return { stale: true, reason: 'could_not_parse_signature_date' };
  const ageMs = nowMs - sigDate.getTime();
  return { stale: ageMs > maxAgeMs, ageMs, sigDate: sigDate.toISOString() };
}

// pingResult: the shape returned by security/ingestion-gate/clamdClient.ping().
function evaluateScannerHealth(pingResult, nowMs, maxAgeMs = DEFAULT_MAX_SIGNATURE_AGE_MS) {
  if (!pingResult || pingResult.healthy !== true) {
    return { pass: false, reason: 'scanner_unreachable' };
  }
  const staleness = isSignatureStale(pingResult.versionString, nowMs, maxAgeMs);
  if (staleness.stale) {
    return { pass: false, reason: 'signatures_stale', ...staleness };
  }
  return { pass: true, ...staleness };
}

// ── EICAR gate check (Phase 12: "EICAR is rejected") ──

// scanResult: the shape returned by security/ingestion-gate/clamdClient.scanBuffer().
function evaluateEicarRejected(scanResult) {
  return Boolean(scanResult) && scanResult.verdict === 'REJECTED_MALWARE';
}

// gateResult: the shape returned by security/ingestion-gate/gate.js:runIngestionGate()
// for a valid synthetic image -- must be ok:true, verdict CLEAN.
function evaluateSyntheticImagePasses(gateResult) {
  return Boolean(gateResult) && gateResult.ok === true && gateResult.verdict === 'CLEAN';
}

// gateResult for a malformed/oversized fixture -- must be a rejection, and
// specifically NOT accidentally CLEAN.
function evaluateMalformedImageFails(gateResult) {
  return Boolean(gateResult) && gateResult.ok === false;
}

module.exports = {
  REQUIRED_MANIFEST_FIELDS,
  ACCEPTABLE_ENFORCEMENT_STATUSES,
  detectMissingRequiredFields,
  detectUnacceptableEnforcementStatus,
  detectUnclassifiedKnownRoutes,
  detectHeldFunctionDriftedLive,
  detectUndocumentedScanStatus,
  DEFAULT_MAX_SIGNATURE_AGE_MS,
  parseClamdSignatureDate,
  isSignatureStale,
  evaluateScannerHealth,
  evaluateEicarRejected,
  evaluateSyntheticImagePasses,
  evaluateMalformedImageFails,
};

if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  const manifestPath = path.join(__dirname, '..', 'perimeter', 'image-ingestion-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const missingFields = detectMissingRequiredFields(manifest.surfaces);
  const badStatuses = detectUnacceptableEnforcementStatus(manifest.surfaces);
  const undocumentedScan = detectUndocumentedScanStatus(manifest.surfaces);

  console.log(JSON.stringify({ missingFields, badStatuses, undocumentedScan }, null, 2));
  if (missingFields.length > 0 || badStatuses.length > 0 || undocumentedScan.length > 0) {
    process.exit(1);
  }
  console.log('image-ingestion-gate-guard: PASS');
}
