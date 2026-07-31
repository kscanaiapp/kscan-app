#!/usr/bin/env node
'use strict';

/**
 * Generate the production-safe Deno scanner candidate artifact from the
 * canonical Build 4 evaluation artifact.
 *
 * WHY THIS IS GENERATED RATHER THAN HAND-WRITTEN
 *
 * The candidate instruction text has to exist in two places: the evaluation
 * artifact, which is what Build 4 measured and hashed, and a Deno module the
 * Edge Function can import without touching the filesystem at request time.
 *
 * Two hand-maintained copies of the same prose WILL drift — that is the whole
 * failure mode this file exists to remove. The production module is therefore
 * derived mechanically from the evaluation artifact, and a parity test asserts
 * the derivation still holds. If the two ever disagree, the test fails rather
 * than production quietly shipping different instructions than were measured.
 *
 * The generated module contains NO filesystem access, NO Node built-ins and NO
 * dynamic import, so it is safe inside the Edge Function dependency closure.
 *
 * Usage:
 *   node scripts/generate-scanner-candidate-artifact.js [--check]
 *
 *   --check  verify the committed module matches what would be generated,
 *            and exit non-zero if it does not. Used by CI and the parity test.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_ARTIFACT = path.join(
  REPO_ROOT,
  'tools/scanner-evaluation/adapter/phase2a-instruction-overlay.v1.json'
);
const TARGET_MODULE = path.join(
  REPO_ROOT,
  'supabase/functions/_shared/scannerCandidateArtifact.ts'
);

/** Mirrors candidateArtifact.canonicalize: keys sorted at every level. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function build() {
  const artifact = JSON.parse(fs.readFileSync(SOURCE_ARTIFACT, 'utf8'));

  if (artifact.mechanism !== 'append') {
    throw new Error(`unsupported overlay mechanism: ${artifact.mechanism}`);
  }
  if (!Array.isArray(artifact.lines) || artifact.lines.length === 0) {
    throw new Error('source artifact carries no instruction lines');
  }

  const instructionText = artifact.lines.join('\n');
  const instructionSha256 = sha256Hex(instructionText);
  if (instructionSha256 !== artifact.textSha256) {
    throw new Error(
      `source artifact text hashes to ${instructionSha256} but records ${artifact.textSha256}`
    );
  }

  // The descriptor body, byte-identical to the evaluation-side
  // candidateArtifact.describe() hashed body. Reproducing it here is what lets
  // production quote the same artifact hash Build 4 certified.
  const descriptorBody = {
    descriptorSchemaVersion: '1.0.0',
    candidateVersion: artifact.candidateVersion,
    controlVersion: 'certified-v140',
    role: 'candidate',
    modelConfigurationId: 'certified-v140',
    postValidationPolicy: 'phase2a_evidence_discipline',
    overlayId: artifact.overlayId,
    mechanism: artifact.mechanism,
    instructionSha256,
  };
  const artifactSha256 = sha256Hex(canonicalize(descriptorBody));

  const lines = artifact.lines.map((line) => `  ${JSON.stringify(line)},`).join('\n');

  const source = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source of truth:
//   tools/scanner-evaluation/adapter/phase2a-instruction-overlay.v1.json
// Regenerate with:
//   node scripts/generate-scanner-candidate-artifact.js
// Verify with:
//   node scripts/generate-scanner-candidate-artifact.js --check
//
// The Build 4 scanner accuracy candidate, in the form the Edge Function can
// consume. Instruction text is embedded as data because an Edge Function must
// not read the filesystem at request time; it is GENERATED from the evaluation
// artifact so the measured instructions and the shipped instructions cannot
// drift apart.
//
// This module is inert on its own. It describes a candidate; it does not select
// one. Selection is owned by scannerVersionResolver.ts, and the production
// default is the certified control.

/** The certified control. The production default, and the rollback target. */
export const CERTIFIED_CONTROL_VERSION = 'certified-v140' as const;

/** The Build 4 Phase 2A candidate. Dormant unless trusted configuration names it. */
export const PHASE2A_CANDIDATE_VERSION = '${artifact.candidateVersion}' as const;

export type ScannerVersion =
  | typeof CERTIFIED_CONTROL_VERSION
  | typeof PHASE2A_CANDIDATE_VERSION;

/** Every version this build can serve. */
export const SUPPORTED_SCANNER_VERSIONS: readonly ScannerVersion[] = Object.freeze([
  CERTIFIED_CONTROL_VERSION,
  PHASE2A_CANDIDATE_VERSION,
]);

/**
 * The candidate instruction lines, verbatim from the canonical artifact.
 * Joined with a single newline — the same join the evaluation harness uses.
 */
const PHASE2A_INSTRUCTION_LINES: readonly string[] = Object.freeze([
${lines}
]);

/** The deterministic candidate instruction text. */
export const PHASE2A_INSTRUCTION_TEXT: string = PHASE2A_INSTRUCTION_LINES.join('\\n');

/** SHA-256 of PHASE2A_INSTRUCTION_TEXT, certified by Build 4 Phase 2B. */
export const PHASE2A_INSTRUCTION_SHA256 = '${instructionSha256}' as const;

/** SHA-256 of the canonical candidate descriptor, certified by Build 4 Phase 2B. */
export const PHASE2A_ARTIFACT_SHA256 = '${artifactSha256}' as const;

export const PHASE2A_OVERLAY_ID = '${artifact.overlayId}' as const;

/**
 * Apply the candidate instructions to a certified prompt.
 *
 * APPEND ONLY. The certified prompt reaches the provider first, verbatim, in its
 * certified order; the candidate delta is exactly the text appended after it.
 * The certified prompt is never rewritten, reordered or truncated.
 *
 * Returns the input UNCHANGED for the certified control, so the control path is
 * not merely equivalent to today's behaviour — it is the same string.
 */
export function applyScannerCandidateInstructions(
  certifiedPrompt: string,
  version: ScannerVersion,
): string {
  if (version !== PHASE2A_CANDIDATE_VERSION) return certifiedPrompt;
  return \`\${certifiedPrompt}\${PHASE2A_INSTRUCTION_TEXT}\`;
}

/**
 * Sanitized artifact identity for telemetry.
 *
 * Ids and digests only. The instruction TEXT is deliberately absent: a digest is
 * enough to prove which artifact ran, and emitting the prose would turn every
 * log line into a second copy of it.
 */
export function scannerArtifactIdentity(version: ScannerVersion): {
  scannerVersion: ScannerVersion;
  scannerArtifactSha256: string | null;
  scannerInstructionSha256: string | null;
} {
  const isCandidate = version === PHASE2A_CANDIDATE_VERSION;
  return {
    scannerVersion: version,
    scannerArtifactSha256: isCandidate ? PHASE2A_ARTIFACT_SHA256 : null,
    scannerInstructionSha256: isCandidate ? PHASE2A_INSTRUCTION_SHA256 : null,
  };
}
`;

  return { source, instructionSha256, artifactSha256, lineCount: artifact.lines.length };
}

function main(argv) {
  const check = argv.includes('--check');
  const built = build();

  if (check) {
    if (!fs.existsSync(TARGET_MODULE)) {
      console.error(`MISSING: ${path.relative(REPO_ROOT, TARGET_MODULE)}`);
      process.exit(1);
    }
    const actual = fs.readFileSync(TARGET_MODULE, 'utf8').replace(/\r\n/g, '\n');
    if (actual !== built.source) {
      console.error('DRIFT: the committed candidate module does not match the canonical artifact.');
      console.error('Run: node scripts/generate-scanner-candidate-artifact.js');
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          module: path.relative(REPO_ROOT, TARGET_MODULE).split(path.sep).join('/'),
          instructionSha256: built.instructionSha256,
          artifactSha256: built.artifactSha256,
          lineCount: built.lineCount,
        },
        null,
        2
      )
    );
    return;
  }

  fs.mkdirSync(path.dirname(TARGET_MODULE), { recursive: true });
  fs.writeFileSync(TARGET_MODULE, built.source, 'utf8');
  console.log(`Wrote ${path.relative(REPO_ROOT, TARGET_MODULE).split(path.sep).join('/')}`);
  console.log(`  instructionSha256 ${built.instructionSha256}`);
  console.log(`  artifactSha256    ${built.artifactSha256}`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { build, canonicalize, sha256Hex, SOURCE_ARTIFACT, TARGET_MODULE };
