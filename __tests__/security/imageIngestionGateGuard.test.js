#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  detectMissingRequiredFields,
  detectUnacceptableEnforcementStatus,
  detectUnclassifiedKnownRoutes,
  detectHeldFunctionDriftedLive,
  detectUndocumentedScanStatus,
  parseClamdSignatureDate,
  isSignatureStale,
  evaluateScannerHealth,
  evaluateEicarRejected,
  evaluateSyntheticImagePasses,
  evaluateMalformedImageFails,
} = require('../../security/scripts/image-ingestion-gate-guard');

const manifestPath = path.join(__dirname, '..', '..', 'security', 'perimeter', 'image-ingestion-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('the shipped image-ingestion-manifest.json has no surface with missing required fields', () => {
  assert.deepEqual(detectMissingRequiredFields(manifest.surfaces), []);
});

test('the shipped manifest has no surface with an unacceptable/unrecognized enforcementStatus', () => {
  assert.deepEqual(detectUnacceptableEnforcementStatus(manifest.surfaces), []);
});

test('the shipped manifest has no live render/edge-function surface with undocumented scan status', () => {
  assert.deepEqual(detectUndocumentedScanStatus(manifest.surfaces), []);
});

test('detectUnclassifiedKnownRoutes: flags a route the manifest never classified', () => {
  const surfaces = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(detectUnclassifiedKnownRoutes(['a', 'b', 'c'], surfaces), ['c']);
});

test('detectUnclassifiedKnownRoutes: every route in the real inventory is classified in the real manifest', () => {
  const knownRoutes = [
    'render-api-analyze',
    'style-library-images-add-scan',
    'style-library-images-inspiration-upload',
    'tryon-clothes-pro',
    'scan-identify',
    'dormant-expo-router-analyze-api',
  ];
  assert.deepEqual(detectUnclassifiedKnownRoutes(knownRoutes, manifest.surfaces), []);
});

test('detectMissingRequiredFields: flags a surface missing enforcementStatus', () => {
  const bad = [{ name: 'x', type: 't', route: 'r', caller: 'c' }];
  const result = detectMissingRequiredFields(bad);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].missingFields, ['enforcementStatus']);
});

test('detectUnacceptableEnforcementStatus: flags a made-up status', () => {
  const bad = [{ name: 'x', enforcementStatus: 'TOTALLY_FINE_TRUST_ME' }];
  assert.deepEqual(detectUnacceptableEnforcementStatus(bad), [{ name: 'x', enforcementStatus: 'TOTALLY_FINE_TRUST_ME' }]);
});

test('detectHeldFunctionDriftedLive: flags a held function that has silently become live', () => {
  const surfaces = [{ name: 'tryon-clothes-pro', heldFunction: true, liveInProduction: false }];
  assert.deepEqual(detectHeldFunctionDriftedLive(['tryon-clothes-pro'], surfaces), ['tryon-clothes-pro']);
});

test('detectHeldFunctionDriftedLive: does not flag a held function that is still not live', () => {
  const surfaces = [{ name: 'tryon-clothes-pro', heldFunction: true, liveInProduction: false }];
  assert.deepEqual(detectHeldFunctionDriftedLive([], surfaces), []);
});

test('detectUndocumentedScanStatus: flags a live render_endpoint missing malwareScanEnabled', () => {
  const surfaces = [{ name: 'x', type: 'render_endpoint', liveInProduction: true }];
  assert.deepEqual(detectUndocumentedScanStatus(surfaces), ['x']);
});

test('parseClamdSignatureDate: parses a real clamd VERSION string', () => {
  const date = parseClamdSignatureDate('ClamAV 1.3.0/27000/Sun Aug  3 12:00:00 2026');
  assert.ok(date instanceof Date);
  assert.equal(date.getUTCFullYear(), 2026);
});

test('parseClamdSignatureDate: returns null for a malformed string', () => {
  assert.equal(parseClamdSignatureDate('not a version string'), null);
  assert.equal(parseClamdSignatureDate(null), null);
});

test('isSignatureStale: fresh signature is not stale', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const version = 'ClamAV 1.3.0/27000/Mon Aug  3 10:00:00 2026';
  const result = isSignatureStale(version, now);
  assert.equal(result.stale, false);
});

test('isSignatureStale: an old signature date is flagged stale', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const version = 'ClamAV 1.3.0/27000/Mon Jul  1 00:00:00 2026';
  const result = isSignatureStale(version, now);
  assert.equal(result.stale, true);
});

test('isSignatureStale: an unparseable version string is treated as stale (fail closed)', () => {
  const result = isSignatureStale('garbage', Date.now());
  assert.equal(result.stale, true);
  assert.equal(result.reason, 'could_not_parse_signature_date');
});

test('evaluateScannerHealth: unhealthy ping fails regardless of anything else', () => {
  assert.equal(evaluateScannerHealth({ healthy: false }, Date.now()).pass, false);
  assert.equal(evaluateScannerHealth(null, Date.now()).pass, false);
});

test('evaluateScannerHealth: healthy + fresh signatures passes', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const result = evaluateScannerHealth({ healthy: true, versionString: 'ClamAV 1.3.0/27000/Mon Aug  3 10:00:00 2026' }, now);
  assert.equal(result.pass, true);
});

test('evaluateScannerHealth: healthy but stale signatures fails', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const result = evaluateScannerHealth({ healthy: true, versionString: 'ClamAV 1.3.0/27000/Mon Jan  1 00:00:00 2026' }, now);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'signatures_stale');
});

test('evaluateEicarRejected: true only for REJECTED_MALWARE', () => {
  assert.equal(evaluateEicarRejected({ verdict: 'REJECTED_MALWARE' }), true);
  assert.equal(evaluateEicarRejected({ verdict: 'CLEAN' }), false);
  assert.equal(evaluateEicarRejected(null), false);
});

test('evaluateSyntheticImagePasses / evaluateMalformedImageFails', () => {
  assert.equal(evaluateSyntheticImagePasses({ ok: true, verdict: 'CLEAN' }), true);
  assert.equal(evaluateSyntheticImagePasses({ ok: false, verdict: 'REJECTED_TYPE' }), false);
  assert.equal(evaluateMalformedImageFails({ ok: false, verdict: 'REJECTED_MALFORMED' }), true);
  assert.equal(evaluateMalformedImageFails({ ok: true, verdict: 'CLEAN' }), false);
});
