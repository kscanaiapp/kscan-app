'use strict';

/**
 * HUMAN REVIEW PACKAGE — spec sections 46/47.
 * Plain Markdown only. Max 50 cases. Never pre-scored -- Phase 2 may later
 * import human scores against the case ids this module assigns.
 */

const { RUBRIC_VERSION, RUBRIC_DIMENSIONS } = require('./rubric');
const { EVIDENCE_FRAMING_BANNER, CLAIM_CLAUSE } = require('../reports/evidenceFraming');

const MAX_CASES = 50;

/**
 * Deterministically select a bounded, representative sample from the full
 * corpus: every defect code once, CLEAN and AMBIGUITY represented, capped at
 * MAX_CASES. Order is stable (sorted by scenarioId/script) so re-running
 * produces the same packet (spec section 52 determinism).
 */
function selectHumanReviewSample(cases) {
  const withText = cases.filter((c) => typeof c.text === 'string');
  const seenScript = new Set();
  const sample = [];
  const sorted = [...withText].sort((a, b) => (a.script + a.scenarioId + a.systemProfile).localeCompare(b.script + b.scenarioId + b.systemProfile));
  for (const c of sorted) {
    const key = `${c.script}`;
    if (!seenScript.has(key)) {
      seenScript.add(key);
      sample.push(c);
    }
    if (sample.length >= MAX_CASES) break;
  }
  // Fill remaining slots (if any) with more CLEAN/AMBIGUITY variety, still capped.
  for (const c of sorted) {
    if (sample.length >= MAX_CASES) break;
    if (!sample.includes(c) && (c.script === 'CLEAN' || c.script === 'AMBIGUITY')) sample.push(c);
  }
  return sample.slice(0, MAX_CASES);
}

function renderCase(c, fixtures, index) {
  const scenario = fixtures.scenariosById[c.scenarioId];
  const closet = fixtures.closetsById[c.groundTruth.closetId];
  const style = fixtures.signatureStylesById[c.groundTruth.signatureStyleId];
  const lines = [];
  lines.push(`## Case ${index + 1}: ${c.scenarioId} / ${c.systemProfile} / ${c.script}`);
  lines.push('');
  lines.push(`**REQUEST**: ${scenario.message}`);
  lines.push('');
  lines.push(`**CLOSET** (${closet.id}, kind=${closet.kind}, kPlusActive=${closet.kPlusActive}):`);
  lines.push(closet.items.length ? closet.items.map((i) => `- ${i.title} (${i.id})`).join('\n') : '- (empty)');
  lines.push('');
  lines.push(`**SIGNATURE STYLE** (${style.id}, confidence=${style.confidence}):`);
  lines.push(style.empty ? '- (no Signature Style evidence)' : `- preferences: ${(style.preferences || []).join(', ') || '(none)'}\n- dislikes: ${(style.dislikes || []).join(', ') || '(none)'}`);
  lines.push('');
  lines.push(`**CONSTRAINTS**: hard=[${(scenario.hardConstraints || []).join(', ')}] soft=[${(scenario.softConstraints || []).join(', ')}]`);
  lines.push('');
  lines.push('**RESPONSE** (synthetic -- see evidence framing at top of document):');
  lines.push('> ' + c.text.replace(/\n/g, '\n> '));
  lines.push('');
  lines.push(`**DETERMINISTIC FINDINGS**: expected=\`${c.expectedVerdict}\` actual=\`${c.actualVerdict}\` match=${c.expectedVerdict === c.actualVerdict}`);
  if (c.findings && c.findings.length) {
    lines.push(c.findings.map((f) => `- ${f.code}`).join('\n'));
  }
  lines.push('');
  lines.push('**HUMAN QUESTIONS** (rubric — do not pre-score; leave blank for reviewer):');
  for (const dim of RUBRIC_DIMENSIONS) {
    lines.push(`- ${dim.id} (1-5): ____   -- ${dim.prompt}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function buildHumanReviewPacket(cases, fixtures) {
  const sample = selectHumanReviewSample(cases);
  const header = [
    EVIDENCE_FRAMING_BANNER,
    '',
    '# Human Review Packet',
    '',
    `Rubric version: ${RUBRIC_VERSION}. Case count: ${sample.length} (max ${MAX_CASES}).`,
    '',
    CLAIM_CLAUSE,
    '',
    'Rubric anchors:',
    '',
    ...RUBRIC_DIMENSIONS.map((d) => `- **${d.id}**: ${Object.entries(d.anchors).map(([k, v]) => `${k}=${v}`).join(' | ')}`),
    '',
    '---',
    '',
  ].join('\n');

  const body = sample.map((c, i) => renderCase(c, fixtures, i)).join('\n');
  return `${header}\n${body}`;
}

module.exports = { buildHumanReviewPacket, selectHumanReviewSample, MAX_CASES };
