'use strict';

/**
 * Phase 2B: the canonical candidate artifact.
 *
 * The artifact hash produced here is quoted in run identities and, later, in
 * production telemetry, so determinism is a REQUIREMENT rather than a
 * convenience. These tests prove it holds across key order, process boundaries
 * and repeated calls, and that the artifact carries nothing it must not.
 *
 * No provider transport is involved. Nothing here makes a network call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const candidateArtifact = require('../lib/candidateArtifact');
const candidateInstructions = require('../lib/candidateInstructions');
const candidateRegistry = require('../lib/candidateRegistry');
const candidateRequest = require('../lib/candidateRequest');

const CONTROL = candidateRegistry.CONTROL_VERSION;
const CANDIDATE = candidateRegistry.PHASE2A_VERSION;
const ROOT = path.join(__dirname, '..', '..', '..');

// ── The narrow API ──────────────────────────────────────────────────────────

test('the API returns every field an integration point needs', () => {
  const descriptor = candidateArtifact.describe(CANDIDATE);

  assert.equal(descriptor.candidateVersion, 'phase2a-v1.0.0');
  assert.equal(descriptor.controlVersion, 'certified-v140');
  assert.equal(descriptor.descriptorSchemaVersion, '1.0.0');
  assert.equal(descriptor.overlayId, 'phase2a-fashion-specificity-v1');
  assert.equal(descriptor.mechanism, 'append');
  assert.equal(descriptor.modelConfigurationId, 'certified-v140');
  assert.equal(descriptor.postValidationPolicy, 'phase2a_evidence_discipline');
  assert.equal(descriptor.instructionSha256.length, 64);
  assert.equal(descriptor.artifactSha256.length, 64);
  assert.equal(typeof descriptor.instructionText, 'string');
  assert.ok(descriptor.instructionLineCount > 0);

  assert.equal(candidateArtifact.controlVersion(), 'certified-v140');
  assert.deepEqual(candidateArtifact.describeAll().map((d) => d.candidateVersion), [CONTROL, CANDIDATE]);
});

test('the control is described as a real version with no instruction artifact', () => {
  const control = candidateArtifact.describe(CONTROL);
  assert.equal(control.role, 'control');
  assert.equal(control.instructionText, null);
  assert.equal(control.instructionSha256, null);
  assert.equal(control.overlayId, null);
  assert.equal(control.mechanism, null);
  assert.equal(control.instructionLineCount, 0);
  assert.equal(control.postValidationPolicy, 'certified_only');
});

test('the descriptor is frozen, so a caller cannot mutate a shared artifact', () => {
  const descriptor = candidateArtifact.describe(CANDIDATE);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.throws(() => { descriptor.candidateVersion = 'tampered'; }, TypeError);
});

test('an unknown version cannot be described', () => {
  for (const unknown of [undefined, null, '', 'phase2a', 'phase2a-v1.0.1', 7, {}]) {
    assert.throws(() => candidateArtifact.describe(unknown), candidateRegistry.UnknownCandidateVersion);
  }
});

// ── Determinism ─────────────────────────────────────────────────────────────

test('canonical serialization is independent of key order', () => {
  const a = { beta: 1, alpha: { z: [3, 2, 1], a: 'x' } };
  const b = { alpha: { a: 'x', z: [3, 2, 1] }, beta: 1 };
  assert.equal(candidateArtifact.canonicalize(a), candidateArtifact.canonicalize(b));
  // Array ORDER is content, not incidental, and must be preserved.
  assert.notEqual(
    candidateArtifact.canonicalize({ z: [1, 2, 3] }),
    candidateArtifact.canonicalize({ z: [3, 2, 1] })
  );
  assert.equal(candidateArtifact.canonicalize(null), 'null');
  assert.equal(candidateArtifact.canonicalize('s'), '"s"');
});

test('the artifact hash is deterministic within a process', () => {
  const first = candidateArtifact.describe(CANDIDATE);
  const second = candidateArtifact.describe(CANDIDATE);
  assert.equal(first.artifactSha256, second.artifactSha256);
  assert.equal(first.instructionSha256, second.instructionSha256);
  assert.equal(first, second, 'the descriptor is cached, so callers share one frozen object');
});

test('the artifact hash is deterministic ACROSS processes', () => {
  // A hash quoted in a run identity has to be stable in a fresh process, not
  // merely stable behind this process's caches.
  const script = `
    const a = require('./tools/scanner-evaluation/lib/candidateArtifact');
    const d = a.describe('phase2a-v1.0.0');
    process.stdout.write(JSON.stringify({ artifact: d.artifactSha256, instruction: d.instructionSha256 }));
  `;
  const run = () => JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' }));
  const first = run();
  const second = run();
  const inProcess = candidateArtifact.describe(CANDIDATE);

  assert.deepEqual(first, second, 'two fresh processes must agree');
  assert.equal(first.artifact, inProcess.artifactSha256);
  assert.equal(first.instruction, inProcess.instructionSha256);
});

test('the instruction text is byte-identical to the artifact it came from', () => {
  const descriptor = candidateArtifact.describe(CANDIDATE);
  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'adapter', 'phase2a-instruction-overlay.v1.json'), 'utf8')
  );
  assert.equal(descriptor.instructionText, artifact.lines.join('\n'));
  assert.equal(descriptor.instructionSha256, artifact.textSha256);
  assert.equal(candidateArtifact.sha256Hex(descriptor.instructionText), artifact.textSha256);
});

// ── Sensitivity ─────────────────────────────────────────────────────────────

test('changing one instruction changes the hash', () => {
  const descriptor = candidateArtifact.describe(CANDIDATE);
  const lines = descriptor.instructionText.split('\n');
  const wordIndex = lines.findIndex((line) => line.includes('subtype must be a narrower kind'));
  assert.ok(wordIndex >= 0, 'the fixture must target a real instruction');

  // Reordering must swap two GENUINELY DIFFERENT lines. The artifact opens with
  // blank spacer lines, so swapping the first two would be a no-op and the
  // assertion would pass for the wrong reason.
  const secondIndex = lines.findIndex((line, i) => i > wordIndex && line.trim() !== '' && line !== lines[wordIndex]);
  assert.ok(secondIndex > wordIndex, 'the reorder fixture needs two distinct non-blank lines');
  const reordered = lines.slice();
  [reordered[wordIndex], reordered[secondIndex]] = [reordered[secondIndex], reordered[wordIndex]];

  const mutations = {
    'a changed word': lines.map((l, i) => (i === wordIndex ? l.replace('narrower', 'broader') : l)),
    'a changed character': lines.map((l, i) => (i === wordIndex ? `${l}.` : l)),
    'a removed line': lines.filter((_, i) => i !== wordIndex),
    'reordered lines': reordered,
  };

  for (const [description, mutated] of Object.entries(mutations)) {
    assert.notEqual(
      candidateArtifact.sha256Hex(mutated.join('\n')),
      descriptor.instructionSha256,
      `${description} must change the instruction hash`
    );
  }
});

test('the artifact hash moves when identity changes even if the instructions do not', () => {
  const descriptor = candidateArtifact.describe(CANDIDATE);
  const body = {
    descriptorSchemaVersion: descriptor.descriptorSchemaVersion,
    candidateVersion: descriptor.candidateVersion,
    controlVersion: descriptor.controlVersion,
    role: descriptor.role,
    modelConfigurationId: descriptor.modelConfigurationId,
    postValidationPolicy: descriptor.postValidationPolicy,
    overlayId: descriptor.overlayId,
    mechanism: descriptor.mechanism,
    instructionSha256: descriptor.instructionSha256,
  };
  // The published hash is reproducible from the descriptor's own fields.
  assert.equal(candidateArtifact.sha256Hex(candidateArtifact.canonicalize(body)), descriptor.artifactSha256);

  // And each identity field genuinely participates.
  for (const field of Object.keys(body)) {
    const mutated = { ...body, [field]: `${body[field]}-changed` };
    assert.notEqual(
      candidateArtifact.sha256Hex(candidateArtifact.canonicalize(mutated)),
      descriptor.artifactSha256,
      `${field} must participate in the artifact hash`
    );
  }
});

test('candidate and certified identities and hashes differ', () => {
  const control = candidateArtifact.describe(CONTROL);
  const candidate = candidateArtifact.describe(CANDIDATE);
  assert.notEqual(control.candidateVersion, candidate.candidateVersion);
  assert.notEqual(control.artifactSha256, candidate.artifactSha256);
  assert.notEqual(control.instructionSha256, candidate.instructionSha256);
  assert.notDeepEqual(control, candidate);
});

// ── Content the artifact must never carry ───────────────────────────────────

test('the artifact carries no certified prompt, credential, image, retailer or case content', () => {
  const descriptor = candidateArtifact.describe(CANDIDATE);
  assert.equal(
    candidateArtifact.assertArtifactContainsNoForbiddenContent({
      overlayId: descriptor.overlayId,
      text: descriptor.instructionText,
    }),
    true
  );

  for (const [description, text] of Object.entries({
    'the certified prompt': "You are K Scan AI's fashion identification engine.",
    'a credential': 'Use key AIzaSyD1234567890abcdefg when calling the provider.',
    'image data': 'Compare against data:image/jpeg;base64,/9j/4AAQ',
    'retailer logic': 'Prefer Farfetch listings when ranking results.',
    'a benchmark label': 'For case-157b102959993060 answer wide_leg_jeans.',
  })) {
    assert.throws(
      () => candidateArtifact.assertArtifactContainsNoForbiddenContent({ overlayId: 'test', text }),
      candidateArtifact.CandidateArtifactError,
      `${description} must be refused`
    );
  }
});

test('the artifact is pure data: no Node construct, no production import', () => {
  const artifactPath = path.join(__dirname, '..', 'adapter', 'phase2a-instruction-overlay.v1.json');
  const raw = fs.readFileSync(artifactPath, 'utf8');
  // It parses as plain JSON, so it cannot contain executable content by
  // construction — no require, no template literal, no function.
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed, 'object');
  assert.equal(Array.isArray(parsed.lines), true);
  for (const line of parsed.lines) assert.equal(typeof line, 'string');
  assert.equal(parsed.artifactVersion, '1.0.0');

  // And the module that reads it imports nothing from production.
  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'candidateArtifact.js'), 'utf8');
  for (const forbidden of [/supabase/i, /require\(['"][^'"]*\.\.\/\.\.\/\.\.\//, /process\s*\.\s*env/, /globalThis/]) {
    assert.equal(forbidden.test(code), false, `candidateArtifact must not reference ${forbidden}`);
  }
});

test('no second copy of the candidate instruction text exists in executable source', () => {
  const descriptor = candidateArtifact.describe(CANDIDATE);
  // A distinctive sentence that would only appear in a duplicate.
  const distinctive = 'subtype must be a narrower kind of item_type';
  assert.ok(descriptor.instructionText.includes(distinctive));

  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|ts|tsx|json|md)$/.test(entry.name)) continue;
      if (fs.readFileSync(full, 'utf8').includes(distinctive)) {
        hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(ROOT, 'tools', 'scanner-evaluation'));

  // Exactly one source of truth: the artifact. Test files may ASSERT on it,
  // which is why the test tree is allowed to reference the sentence.
  const nonTest = hits.filter((f) => !f.includes('__tests__'));
  assert.deepEqual(
    nonTest,
    ['tools/scanner-evaluation/adapter/phase2a-instruction-overlay.v1.json'],
    `the instruction text must live in exactly one non-test file, found: ${nonTest.join(', ')}`
  );
});

// ── Phase 2A behaviour is preserved ─────────────────────────────────────────

test('certified request content is unchanged when no candidate is selected', () => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'certified prompt' }, { inline_data: { data: 'IMG' } }] }],
    generationConfig: { temperature: 0.2 },
  };
  const before = JSON.stringify(body);
  const control = candidateRequest.applyCandidateRequest({ certifiedRequestBody: body, candidateVersion: CONTROL });

  assert.equal(control.body, body, 'the control returns the certified object itself');
  assert.equal(control.transformed, false);
  assert.equal(JSON.stringify(body), before);
  assert.equal(candidateArtifact.describe(CONTROL).instructionText, null);
});

test('the canonical API and the Phase 2A modules agree on one candidate', () => {
  const descriptor = candidateArtifact.describe(CANDIDATE);
  const registryEntry = candidateRegistry.resolveCandidate(CANDIDATE);
  const overlay = candidateInstructions.resolveOverlay(registryEntry.instructionOverlayId);
  const identity = candidateRequest.candidateRequestIdentity(CANDIDATE, 'certified prompt');

  assert.equal(descriptor.candidateVersion, registryEntry.candidateVersion);
  assert.equal(descriptor.overlayId, registryEntry.instructionOverlayId);
  assert.equal(descriptor.postValidationPolicy, registryEntry.postValidationPolicy);
  assert.equal(descriptor.instructionSha256, overlay.textSha256);
  assert.equal(descriptor.instructionSha256, identity.overlaySha256);
  assert.equal(descriptor.instructionText, overlay.text);
});
