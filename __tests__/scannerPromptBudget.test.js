/**
 * Phase 7.2 §4 / §20 — scanner prompt budget regression gate (Node).
 *
 * The build is required to improve what the scanner NOTICES without making
 * every scan pay more for it. This pins that: the composed primary prompt must
 * not exceed what Phase 7.1 sent.
 *
 * Guards against the easy failure mode — appending a fashion guide to the
 * existing prompt and calling it an accuracy improvement while every scan
 * quietly costs more input tokens forever.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collect, measure, extractTemplateConst } = require('../scripts/scanner-prompt-budget.js');

/**
 * Measured on the Phase 7.1 head, 4625645, before any Phase 7.2 edit:
 *
 *   IDENTIFY_PROMPT               12667 chars
 *   QUALITY_TUNE_PROMPT_ADDENDUM   1073 chars
 *   COMPOSED PRIMARY              13740 chars
 *
 * Exact character counts, not token estimates — there is no offline Gemini
 * tokenizer here, so this pins the number that can be measured exactly.
 */
const PHASE_71_COMPOSED_PRIMARY_CHARS = 13740;
const PHASE_71_IDENTIFY_PROMPT_CHARS = 12667;

test('the composed primary prompt did not grow against Phase 7.1', () => {
  const { composedPrimaryChars } = collect();
  assert.ok(
    composedPrimaryChars <= PHASE_71_COMPOSED_PRIMARY_CHARS,
    `composed primary prompt grew: ${composedPrimaryChars} > ${PHASE_71_COMPOSED_PRIMARY_CHARS}`,
  );
});

test('the primary prompt is net SMALLER despite the added evidence guidance', () => {
  // Achieved by replacement, not addition: three redundant few-shot JSON blocks
  // were removed in favour of compact evidence direction. If a future edit
  // reverses that trade, this fails rather than silently re-inflating.
  const { prompts } = collect();
  assert.ok(
    prompts.IDENTIFY_PROMPT.chars < PHASE_71_IDENTIFY_PROMPT_CHARS,
    `IDENTIFY_PROMPT should be smaller than Phase 7.1, got ${prompts.IDENTIFY_PROMPT.chars}`,
  );
});

test('the shared quality addendum was not inflated', () => {
  const { prompts } = collect();
  assert.ok(
    prompts.QUALITY_TUNE_PROMPT_ADDENDUM.chars <= 1400,
    'the addendum rides on every quality-tuned scan and must stay small',
  );
});

test('the text prompt was not touched by an image-only build', () => {
  const { prompts } = collect();
  assert.equal(prompts.TEXT_IDENTIFY_PROMPT.chars, 4330);
  assert.equal(prompts.MULTI_ITEM_IDENTIFY_PROMPT.chars, 2073);
});

test('the measurement tool reports exact chars and a LABELLED approximation', () => {
  const m = measure('abcd'.repeat(10));
  assert.equal(m.chars, 40);
  assert.equal(m.approxTokens, 10);
  // The field is named `approxTokens`, never `tokens` — a provider token count
  // is not something this repository can produce offline, and naming it as one
  // would repeat the Phase 6 cost-accounting mistake.
  assert.ok(!('tokens' in m));
});

test('the extractor handles a template literal containing braces and JSON', () => {
  const source = 'const X = `line {\n  "a": [1,2],\n}\nend`;\nconst Y = 1;';
  assert.equal(extractTemplateConst(source, 'X'), 'line {\n  "a": [1,2],\n}\nend');
  assert.equal(extractTemplateConst(source, 'MISSING'), null);
});
