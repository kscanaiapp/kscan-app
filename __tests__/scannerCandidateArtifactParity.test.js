'use strict';

/**
 * Cross-boundary parity: the evaluation artifact and the production module must
 * describe ONE candidate.
 *
 * The candidate instruction text necessarily exists twice — once in the Build 4
 * evaluation artifact that was measured and hashed, and once in a Deno module
 * the Edge Function can import without touching the filesystem at request time.
 * Two hand-maintained copies of the same prose always drift eventually, and the
 * consequence here is specific and bad: production would ship instructions that
 * were never the ones evaluated.
 *
 * These tests close that gap. The production module is GENERATED from the
 * evaluation artifact, and the assertions below prove the derivation still
 * holds, that both certified digests are unchanged, and that the generated
 * module is safe to sit inside an Edge Function dependency closure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_ARTIFACT = path.join(
  REPO_ROOT,
  'tools/scanner-evaluation/adapter/phase2a-instruction-overlay.v1.json'
);
const PRODUCTION_MODULE = path.join(
  REPO_ROOT,
  'supabase/functions/_shared/scannerCandidateArtifact.ts'
);

/** Certified by Build 4 Phase 2B. These are contract values, not observations. */
const CERTIFIED_INSTRUCTION_SHA256 =
  '93b67ad9de443dbb59b3d7aa502e4bb126fad7d8b8ed8e23560bb4802629e384';
const CERTIFIED_ARTIFACT_SHA256 =
  '6cc51fbaecaca28b270f4df853dd8004b7360b7d67044f8f74f667ebd8de3a33';
const CANDIDATE_VERSION = 'phase2a-v1.0.0';
const CONTROL_VERSION = 'certified-v140';

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const readArtifact = () => JSON.parse(fs.readFileSync(SOURCE_ARTIFACT, 'utf8'));
const readModule = () => fs.readFileSync(PRODUCTION_MODULE, 'utf8').replace(/\r\n/g, '\n');

/**
 * Recover the embedded instruction lines from the generated module.
 *
 * Each line is emitted as a JSON string literal, so the array can be recovered
 * exactly without executing the module — which matters, because the module is
 * Deno TypeScript and must never need a Node runtime to be verified.
 */
function embeddedLines(source) {
  const block = source.match(
    /const PHASE2A_INSTRUCTION_LINES: readonly string\[\] = Object\.freeze\(\[\n([\s\S]*?)\n\]\);/
  );
  assert.ok(block, 'the generated module must embed an instruction line array');
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line.replace(/,$/, '')));
}

// ── The two sides describe one candidate ────────────────────────────────────

test('the production module embeds the evaluation artifact verbatim', () => {
  const artifact = readArtifact();
  const embedded = embeddedLines(readModule());

  assert.deepEqual(embedded, artifact.lines, 'every instruction line must match, in order');
  assert.equal(embedded.length, artifact.lines.length);
  assert.equal(embedded.join('\n'), artifact.lines.join('\n'));
});

test('both sides hash to the digests Build 4 certified', () => {
  const artifact = readArtifact();
  const text = artifact.lines.join('\n');

  // The evaluation artifact still hashes to its own recorded value.
  assert.equal(sha256Hex(text), artifact.textSha256);
  // And that value is the one Phase 2B certified.
  assert.equal(artifact.textSha256, CERTIFIED_INSTRUCTION_SHA256);
  // The production module derives the same text.
  assert.equal(sha256Hex(embeddedLines(readModule()).join('\n')), CERTIFIED_INSTRUCTION_SHA256);
});

test('the production module pins the certified digests', () => {
  const source = readModule();
  assert.match(source, new RegExp(`PHASE2A_INSTRUCTION_SHA256 = '${CERTIFIED_INSTRUCTION_SHA256}'`));
  assert.match(source, new RegExp(`PHASE2A_ARTIFACT_SHA256 = '${CERTIFIED_ARTIFACT_SHA256}'`));
  assert.match(source, new RegExp(`PHASE2A_CANDIDATE_VERSION = '${CANDIDATE_VERSION}'`));
  assert.match(source, new RegExp(`CERTIFIED_CONTROL_VERSION = '${CONTROL_VERSION}'`));
});

test('the pinned artifact digest reproduces from the canonical descriptor', () => {
  // Recomputed here rather than trusted, so an edited constant is caught.
  const canonicalize = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  };
  const body = {
    descriptorSchemaVersion: '1.0.0',
    candidateVersion: CANDIDATE_VERSION,
    controlVersion: CONTROL_VERSION,
    role: 'candidate',
    modelConfigurationId: CONTROL_VERSION,
    postValidationPolicy: 'phase2a_evidence_discipline',
    overlayId: 'phase2a-fashion-specificity-v1',
    mechanism: 'append',
    instructionSha256: CERTIFIED_INSTRUCTION_SHA256,
  };
  assert.equal(sha256Hex(canonicalize(body)), CERTIFIED_ARTIFACT_SHA256);
});

// ── Drift detection ─────────────────────────────────────────────────────────

test('the generator check passes against the committed module', () => {
  const output = execFileSync(
    process.execPath,
    ['scripts/generate-scanner-candidate-artifact.js', '--check'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(result.instructionSha256, CERTIFIED_INSTRUCTION_SHA256);
  assert.equal(result.artifactSha256, CERTIFIED_ARTIFACT_SHA256);
});

test('drift on EITHER side is detected, not just one', () => {
  const source = readModule();
  const artifact = readArtifact();

  // Production side: a single changed character in an embedded line.
  const lines = embeddedLines(source);
  const index = lines.findIndex((line) => line.includes('subtype must be a narrower kind'));
  assert.ok(index >= 0, 'the fixture must target a real instruction');
  const mutatedProduction = lines.slice();
  mutatedProduction[index] = mutatedProduction[index].replace('narrower', 'broader');
  assert.notEqual(sha256Hex(mutatedProduction.join('\n')), CERTIFIED_INSTRUCTION_SHA256);
  assert.notDeepEqual(mutatedProduction, artifact.lines);

  // Evaluation side: a removed line.
  const mutatedEvaluation = artifact.lines.filter((_, i) => i !== index);
  assert.notEqual(sha256Hex(mutatedEvaluation.join('\n')), CERTIFIED_INSTRUCTION_SHA256);
  assert.notDeepEqual(mutatedEvaluation, lines);

  // A reordering that is NOT a no-op (the artifact opens with blank spacers).
  const second = lines.findIndex((l, i) => i > index && l.trim() !== '' && l !== lines[index]);
  assert.ok(second > index);
  const reordered = lines.slice();
  [reordered[index], reordered[second]] = [reordered[second], reordered[index]];
  assert.notEqual(sha256Hex(reordered.join('\n')), CERTIFIED_INSTRUCTION_SHA256);
});

// ── Safe for the Edge Function closure ──────────────────────────────────────

test('the generated module is Deno-safe and request-time pure', () => {
  const source = readModule();
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const [description, pattern] of Object.entries({
    'a Node require': /\brequire\s*\(/,
    'a Node built-in import': /from\s+['"]node:/,
    'a filesystem read': /readFileSync|Deno\s*\.\s*readFile|Deno\s*\.\s*open/,
    'a dynamic import': /\bimport\s*\(/,
    'a remote import': /from\s+['"]https?:\/\//,
    'process access': /\bprocess\s*\./,
    'a network call': /\bfetch\s*\(/,
    'an environment read': /Deno\s*\.\s*env/,
  })) {
    assert.equal(pattern.test(code), false, `the module must not contain ${description}`);
  }
});

test('the artifact carries no credential, image, label or commerce content', () => {
  const text = readArtifact().lines.join('\n');
  for (const [description, pattern] of Object.entries({
    'a credential': /AIza[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z]{16,}|Bearer\s+[0-9A-Za-z._-]{16,}/,
    'image data': /data:image\/[a-z]+;base64,/i,
    'retailer or commerce logic': /\b(?:farfetch|kickscrew|shopify|affiliate|retailer_id)\b/i,
    'a benchmark label or case id': /\bcase-[0-9a-f]{8,}|\btiera-[a-z_]+-[0-9a-f]{6,}/i,
    'the certified prompt': /You are K Scan AI's fashion identification engine/i,
  })) {
    assert.equal(pattern.test(text), false, `the artifact must not contain ${description}`);
  }
});

test('no third copy of the instruction text exists in production source', () => {
  const distinctive = 'subtype must be a narrower kind of item_type';
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|json)$/.test(entry.name)) continue;
      if (fs.readFileSync(full, 'utf8').includes(distinctive)) {
        hits.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(REPO_ROOT, 'supabase'));

  assert.deepEqual(
    hits,
    ['supabase/functions/_shared/scannerCandidateArtifact.ts'],
    `exactly one production file may carry the instruction text, found: ${hits.join(', ')}`
  );
});

// ── The control path is untouched ───────────────────────────────────────────

test('the control returns the certified prompt unchanged, by identity', () => {
  const source = readModule();
  // The control path returns the INPUT, not a rebuilt copy of it. That is what
  // makes "no change when the candidate is not selected" a structural property
  // rather than a promise about string equality.
  assert.match(
    source,
    /if \(version !== PHASE2A_CANDIDATE_VERSION\) return certifiedPrompt;/,
    'the control must return the certified prompt itself'
  );
  // And the candidate appends — the certified text stays first.
  assert.match(source, /return `\$\{certifiedPrompt\}\$\{PHASE2A_INSTRUCTION_TEXT\}`/);
});

test('telemetry identity exposes digests only, never the instruction text', () => {
  const source = readModule();
  const fn = source.slice(source.indexOf('export function scannerArtifactIdentity'));
  assert.equal(
    /PHASE2A_INSTRUCTION_TEXT/.test(fn),
    false,
    'the telemetry identity must not carry the instruction prose'
  );
  assert.match(fn, /scannerArtifactSha256/);
  assert.match(fn, /scannerInstructionSha256/);
});
