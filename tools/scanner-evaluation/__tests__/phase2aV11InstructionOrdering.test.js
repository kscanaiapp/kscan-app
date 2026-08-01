'use strict';

/**
 * Phase 3 REVISE_CANDIDATE remediation — regression coverage.
 *
 * The measured defect: phase2a-v1.0.0 produced an unparseable response on
 * 42.4% of development cases versus the certified control's 18.2%. Root cause
 * recorded in docs/scanner-accuracy/build4-phase3-live-evaluation-2026-07-31.md:
 * the STRICT STRUCTURED OUTPUT rule sat LAST, after six increasingly demanding
 * specificity sections.
 *
 * These tests encode the correction as a property of the artifacts. The
 * "ordering" assertions below FAIL against v1.0.0 and PASS against v1.1.0 —
 * that is deliberate, and is the failing-test-before-the-fix requirement.
 *
 * They do NOT assert that the regression is fixed in behaviour. Only the
 * governed live evaluation establishes that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ADAPTER_DIR = path.join(__dirname, '..', 'adapter');
const V1 = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, 'phase2a-instruction-overlay.v1.json'), 'utf8'));
const V11 = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, 'phase2a-instruction-overlay.v1_1.json'), 'utf8'));

const strictIndex = (o) => o.lines.findIndex((l) => /STRICT STRUCTURED OUTPUT/.test(l));
const sectionHeaders = (o) => o.lines.filter((l) => /^[1-9]\. [A-Z]/.test(l));

test('V1.0.0 BASELINE: the defect is real — strict output is the LAST section', () => {
  const headers = sectionHeaders(V1);
  assert.equal(headers.length, 7);
  assert.match(headers[headers.length - 1], /STRICT STRUCTURED OUTPUT/);
});

test('CORRECTION: v1.1.0 places strict output FIRST', () => {
  const headers = sectionHeaders(V11);
  assert.equal(headers.length, 7, 'all seven sections must survive the reorder');
  assert.match(headers[0], /^1\. STRICT STRUCTURED OUTPUT$/);
});

test('CORRECTION: strict output immediately follows the preamble, nothing between', () => {
  const preambleEnd = V11.lines.indexOf('response shape.');
  assert.ok(preambleEnd > 0);
  const between = V11.lines.slice(preambleEnd + 1, strictIndex(V11)).filter((l) => l.trim() !== '');
  assert.deepEqual(between, [], 'no instruction may sit between the preamble and the output rule');
});

test('CORRECTION: the one authorized negative example is present, exactly once', () => {
  const hits = V11.lines.filter((l) => l === 'Do not begin your response with an explanation of your reasoning.');
  assert.equal(hits.length, 1);
});

test('MINIMALITY: the six specificity sections are byte-identical, only renumbered', () => {
  const norm = (o) => o.lines
    .filter((l) => l.trim() !== '')
    .filter((l) => !/^K SCAN AI PHASE 2A CANDIDATE INSTRUCTIONS/.test(l))
    .filter((l) => l !== 'Do not begin your response with an explanation of your reasoning.')
    .map((l) => l.replace(/^[1-7]\. /, '#. '))
    .sort();
  assert.deepEqual(norm(V11), norm(V1), 'the correction may reorder and renumber, never reword');
});

test('IMMUTABILITY: v1.0.0 is untouched — its recorded results stay attributable', () => {
  assert.equal(V1.candidateVersion, 'phase2a-v1.0.0');
  assert.equal(V1.textSha256, '93b67ad9de443dbb59b3d7aa502e4bb126fad7d8b8ed8e23560bb4802629e384');
  assert.equal(
    crypto.createHash('sha256').update(V1.lines.join('\n'), 'utf8').digest('hex'),
    V1.textSha256,
  );
});

test('INTEGRITY: v1.1.0 declares a distinct identity, a self-consistent hash, and the recorded hash', () => {
  assert.equal(V11.candidateVersion, 'phase2a-v1.1.0');
  assert.equal(V11.overlayId, 'phase2a-fashion-specificity-v1_1');
  assert.notEqual(V11.textSha256, V1.textSha256);
  assert.equal(
    crypto.createHash('sha256').update(V11.lines.join('\n'), 'utf8').digest('hex'),
    V11.textSha256,
  );
  // Reproduced independently in a fresh worktree from the same deterministic
  // derivation — this is the hash the owner asked to be verified byte-for-byte.
  assert.equal(V11.textSha256, '2f08bb4f498da71a8cb3600f8a5d4a3942306b65f01c5e51c2c70cae36fada47');
  assert.equal(V11.derivedFrom.textSha256, V1.textSha256, 'provenance must name the exact parent');
});

test('SCOPE: the correction changes no field name and no response shape', () => {
  assert.equal(V11.mechanism, V1.mechanism);
  assert.equal(V11.appliesTo, V1.appliesTo);
});

test('REGISTRY: control, rejected, and correction all resolve as distinct, correctly-classified identities', () => {
  const registry = require('../lib/candidateRegistry');
  assert.ok(registry.isKnown('phase2a-v1.0.0'));
  assert.ok(registry.isKnown('phase2a-v1.1.0'));
  assert.equal(registry.isRejected('phase2a-v1.0.0'), true);
  assert.equal(registry.isRejected('phase2a-v1.1.0'), false);
  assert.equal(registry.isEligibleForEvaluation('phase2a-v1.0.0'), false);
  assert.equal(registry.isEligibleForEvaluation('phase2a-v1.1.0'), true);

  const a = registry.resolveCandidate('phase2a-v1.0.0');
  const b = registry.resolveCandidate('phase2a-v1.1.0');
  assert.notEqual(a.runIdSegment, b.runIdSegment, 'results must not collide in one run directory');
  assert.notEqual(a.instructionOverlayId, b.instructionOverlayId);
  assert.equal(b.modelConfigurationId, a.modelConfigurationId, 'topology must stay certified');
  assert.equal(b.postValidationPolicy, a.postValidationPolicy);
});

test('OVERLAY LOADER: v1.1.0 loads and passes its own integrity and discipline checks', () => {
  const instructions = require('../lib/candidateInstructions');
  const resolved = instructions.resolveOverlay('phase2a-fashion-specificity-v1_1');
  assert.equal(resolved.candidateVersion, 'phase2a-v1.1.0');
  assert.equal(resolved.textSha256, V11.textSha256);
  assert.match(resolved.text, /1\. STRICT STRUCTURED OUTPUT/);
});

test('LAUNCH GATE: run-baseline.js refuses to launch the rejected candidate again', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'run-baseline.js'), 'utf8');
  assert.match(src, /isEligibleForEvaluation/, 'the CLI must consult the eligibility gate, not isKnown() alone');
});

test('NO PRODUCTION SELECTION: certifying v1.1.0 for evaluation does not touch the deployed default', () => {
  // scannerVersionResolver.ts's committed default must remain the certified
  // control regardless of what this harness registers as evaluation-eligible.
  const resolverSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'supabase', 'functions', '_shared', 'scannerVersionResolver.ts'),
    'utf8',
  );
  assert.match(resolverSrc, /SCANNER_VERSION_DEFAULT[\s\S]{0,40}=[\s\S]{0,10}CERTIFIED_CONTROL_VERSION/);
  const artifactSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'supabase', 'functions', '_shared', 'scannerCandidateArtifact.ts'),
    'utf8',
  );
  assert.equal(
    /phase2a-v1\.1\.0/.test(artifactSrc),
    false,
    'the deployed artifact must not reference an uncertified candidate before certification',
  );
});
