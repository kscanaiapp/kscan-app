'use strict';

/**
 * Phase 6 Candidate A — registry, overlay and boundary tests.
 *
 * Candidate A's whole claim is that Phase 2A's accuracy instruction can be kept
 * while its length is not. That makes overlay LENGTH a measured property of this
 * candidate, so it is asserted here rather than left to review: an overlay that
 * silently grew back toward Phase 2A's size would be testing the confound the
 * candidate exists to remove.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const registry = require('../lib/candidateRegistry');
const instructions = require('../lib/candidateInstructions');

const CANDIDATE = 'phase6-scanner-v1.0-a';
const OVERLAY_ID = 'phase6-decisive-specificity-v1';
const CONTROL = 'certified-v140';

test('Candidate A is registered as a candidate on certified topology', () => {
  const entry = registry.resolveCandidate(CANDIDATE);
  assert.equal(entry.role, 'candidate');
  assert.equal(entry.instructionOverlayId, OVERLAY_ID);
  assert.equal(entry.runIdSegment, CANDIDATE);
  // The provider topology is the certified one. A candidate that needed a
  // different model would be a different phase, not a registry row.
  assert.equal(entry.modelConfigurationId, 'certified-v140');
  assert.notEqual(entry.postValidationPolicy, 'certified_only');
});

test('Candidate A cannot collide with the control result identity', () => {
  const control = registry.resolveCandidate(CONTROL);
  const candidate = registry.resolveCandidate(CANDIDATE);
  assert.notEqual(control.runIdSegment, candidate.runIdSegment);
  assert.doesNotThrow(() => registry.assertDistinctResultIdentity(CONTROL, CANDIDATE));
});

test('selecting Candidate A requires naming it; nothing defaults onto it', () => {
  // Resolving with no selection must not land on a candidate.
  const resolved = registry.resolveCandidate(undefined);
  assert.equal(resolved.role, 'control');
  assert.equal(resolved.candidateVersion, CONTROL);
});

test('the overlay artifact loads and its declared hash matches its bytes', () => {
  const overlay = instructions.resolveOverlay(OVERLAY_ID);
  assert.equal(overlay.candidateVersion, CANDIDATE);
  assert.equal(overlay.mechanism, 'append');
  assert.equal(
    overlay.textSha256,
    'b470706f3788912ee9d447a68bc9716a13c3f247a13fac0e5348b5be682e4764',
  );
});

test('the overlay passes candidate discipline', () => {
  const overlay = instructions.resolveOverlay(OVERLAY_ID);
  assert.equal(instructions.assertOverlayDiscipline(overlay), true);
});

test('the overlay stays far below the rejected Phase 2A overlay length', () => {
  const a = instructions.resolveOverlay(OVERLAY_ID).text;
  const phase2a = instructions.resolveOverlay('phase2a-fashion-specificity-v1').text;

  // The confound this candidate exists to remove. Phase 2A added ~1,000 prompt
  // tokens and invalid output went 18.2% -> 42.4%, with every failure landing
  // within ~20 tokens of the 2,048 shared output/reasoning ceiling.
  assert.ok(
    a.length < phase2a.length / 3,
    `Candidate A overlay must stay under a third of Phase 2A's length; `
    + `got ${a.length} vs ${phase2a.length}`,
  );

  // An absolute ceiling too, so shrinking Phase 2A later could not quietly
  // license a larger Candidate A.
  assert.ok(a.length <= 1000, `Candidate A overlay must stay <= 1000 chars; got ${a.length}`);
});

test('the overlay adds no field and changes no response shape', () => {
  const overlay = instructions.resolveOverlay(OVERLAY_ID);
  // assertOverlayDiscipline already rejects any snake_case token absent from the
  // certified provider contract. This pins the complementary property: the
  // overlay makes no structural claim of its own.
  for (const forbidden of [/\badd (?:a |an )?field/i, /\brename\b/i, /\bnew field\b/i, /\bschema\b/i]) {
    assert.ok(
      !forbidden.test(overlay.text),
      `overlay must not describe a structural change: ${forbidden}`,
    );
  }
});

test('the overlay instructs decisiveness, which is the reliability half of the hypothesis', () => {
  const { text } = instructions.resolveOverlay(OVERLAY_ID);
  assert.match(text, /do not deliberate/i);
  assert.match(text, /answer at once|answer directly/i);
});

test('the overlay instructs specificity, which is the accuracy half of the hypothesis', () => {
  const { text } = instructions.resolveOverlay(OVERLAY_ID);
  assert.match(text, /specific fashion term/i);
});

test('a hypothesis record exists and predates any recorded result', () => {
  const doc = path.join(__dirname, '..', '..', '..', 'docs', 'scanner-accuracy', 'phase6', 'candidate-a-hypothesis.md');
  assert.ok(fs.existsSync(doc), 'Candidate A must not exist without a written hypothesis');
  const text = fs.readFileSync(doc, 'utf8');
  for (const field of [
    'CANDIDATE ID:', 'EXPECTED PRIMARY METRIC:', 'EXPECTED DIRECTION:',
    'EXPECTED EFFECT RANGE:', 'EXPECTED SUPPRESSION EFFECT:', 'CANONICAL RENDERED PROMPT:',
  ]) {
    assert.ok(text.includes(field), `hypothesis record must state ${field}`);
  }
  assert.match(text, /HYPOTHESIS SUPPORTED:\s*not yet evaluated/);
});

test('no Phase 6 candidate result exists yet, so no hypothesis can have been fitted to one', () => {
  const overlayDir = path.join(__dirname, '..', 'adapter');
  const stray = fs.readdirSync(overlayDir).filter((f) => /phase6.*result|phase6.*report/i.test(f));
  assert.deepEqual(stray, [], 'Phase 6 candidate results must not be authored alongside the candidate');
});

test('exactly one Phase 6 candidate is registered; the family cap is three', () => {
  const phase6 = registry.versions().filter((v) => v.startsWith('phase6-scanner-v1.0'));
  assert.ok(phase6.length >= 1, 'Candidate A must be registered');
  assert.ok(phase6.length <= 3, `the family allows at most three candidates; found ${phase6.length}`);
  assert.deepEqual(phase6, [CANDIDATE], 'only Candidate A is authorized until it has been measured');
});
