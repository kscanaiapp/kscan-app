'use strict';

/**
 * Build the phase2a-v1.1.0 instruction overlay from the immutable v1.0.0
 * artifact, applying ONLY the correction the Phase 3 live evaluation proposed
 * for owner review (docs/scanner-accuracy/build4-phase3-live-evaluation-2026-07-31.md,
 * "Proposed instruction delta"):
 *
 *   (a) Move the STRICT STRUCTURED OUTPUT requirement from LAST to FIRST, so it
 *       is the first thing reinforced after "Everything above still applies"
 *       rather than the last thing read after six increasingly demanding
 *       specificity sections.
 *   (b) Add one explicit negative example against prefacing the JSON with
 *       reasoning.
 *
 * Nothing else changes. The instruction TEXT of the six specificity sections is
 * copied verbatim; only their ordinal labels shift 1-6 -> 2-7. That is what
 * preserves the measured subtype/material/pattern wins the evaluation recorded.
 *
 * This script is the transformation of record: it derives v1.1.0 from v1.0.0
 * rather than restating it, so the diff between the two artifacts cannot
 * silently contain an unreviewed instruction change.
 *
 * Run:  node tools/scanner-evaluation/build-phase2a-v11-overlay.js [--write]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ADAPTER_DIR = path.join(__dirname, 'adapter');
const SRC = path.join(ADAPTER_DIR, 'phase2a-instruction-overlay.v1.json');
const OUT = path.join(ADAPTER_DIR, 'phase2a-instruction-overlay.v1_1.json');

const NEW_VERSION = 'phase2a-v1.1.0';
const NEW_OVERLAY_ID = 'phase2a-fashion-specificity-v1_1';
const NEGATIVE_EXAMPLE = 'Do not begin your response with an explanation of your reasoning.';

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const lines = src.lines.slice();

const strictIdx = lines.findIndex((l) => /^7\. STRICT STRUCTURED OUTPUT$/.test(l));
if (strictIdx === -1) throw new Error('v1.0.0 section 7 header not found; refusing to guess');

const strictBody = lines
  .slice(strictIdx + 1)
  .filter((l, i, arr) => !(i === 0 && l === ''))
  .filter((l) => l !== '' || true);
while (strictBody.length && strictBody[strictBody.length - 1] === '') strictBody.pop();

const preambleEnd = lines.findIndex((l) => l === 'response shape.');
if (preambleEnd === -1) throw new Error('preamble terminator not found; refusing to guess');

const middle = lines.slice(preambleEnd + 1, strictIdx);
while (middle.length && middle[middle.length - 1] === '') middle.pop();
const renumbered = middle.map((l) => {
  const m = /^([1-6])\. (.+)$/.exec(l);
  return m ? `${Number(m[1]) + 1}. ${m[2]}` : l;
});
const headersMoved = renumbered.filter((l) => /^[2-7]\. /.test(l)).length;
if (headersMoved !== 6) throw new Error(`expected 6 renumbered headers, got ${headersMoved}`);

const out = [];
for (let i = 0; i <= preambleEnd; i += 1) {
  out.push(i === 2 ? `K SCAN AI PHASE 2A CANDIDATE INSTRUCTIONS (${NEW_VERSION})` : lines[i]);
}
out.push('');
out.push('1. STRICT STRUCTURED OUTPUT');
out.push('');
for (const l of strictBody) out.push(l);
out.push(NEGATIVE_EXAMPLE);
out.push('');
for (const l of renumbered) out.push(l);

const text = out.join('\n');
const textSha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const artifact = {
  artifact: 'phase2a-instruction-overlay',
  artifactVersion: '1.1.0',
  overlayId: NEW_OVERLAY_ID,
  candidateVersion: NEW_VERSION,
  appliesTo: src.appliesTo,
  mechanism: src.mechanism,
  note: src.note,
  derivedFrom: {
    overlayId: src.overlayId,
    candidateVersion: src.candidateVersion,
    textSha256: src.textSha256,
    correction:
      'Phase 3 REVISE_CANDIDATE remediation: STRICT STRUCTURED OUTPUT moved from section 7 (last) '
      + 'to section 1 (first); one negative example added; sections 1-6 renumbered 2-7 with their '
      + 'instruction text unchanged. No other edit.',
  },
  textSha256,
  lines: out,
};

const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, serialized);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

console.log(`v1.0.0 textSha256 : ${src.textSha256}`);
console.log(`v1.1.0 textSha256 : ${textSha256}`);
