import assert from 'node:assert/strict';

import { parseGenderStylingContext, buildGenderStylingContextBlock } from './genderStylingContext.ts';

Deno.test('absent/malformed input parses to null (pre-Fix-#5 client behavior)', () => {
  assert.equal(parseGenderStylingContext(undefined), null);
  assert.equal(parseGenderStylingContext(null), null);
  assert.equal(parseGenderStylingContext(''), null);
  assert.equal(parseGenderStylingContext('MAN'), null);
  assert.equal(parseGenderStylingContext('Man'), null);
  assert.equal(parseGenderStylingContext('male'), null);
  assert.equal(parseGenderStylingContext('female'), null);
  assert.equal(parseGenderStylingContext(123), null);
  assert.equal(parseGenderStylingContext({ value: 'man' }), null);
  assert.equal(parseGenderStylingContext(['man']), null);
});

Deno.test('exactly the three canonical values parse through', () => {
  assert.equal(parseGenderStylingContext('man'), 'man');
  assert.equal(parseGenderStylingContext('woman'), 'woman');
  assert.equal(parseGenderStylingContext('prefer_not_to_say'), 'prefer_not_to_say');
});

Deno.test('MAN_CONTEXT_REACHES_STYLECHAT: man produces a menswear-leaning block', () => {
  const block = buildGenderStylingContextBlock('man');
  assert.match(block, /menswear/);
  assert.match(block, /selected "man"/);
  assert.match(block, /\[Optional Baseline Styling Context\]/);
});

Deno.test('WOMAN_CONTEXT_REACHES_STYLECHAT: woman produces a womenswear-leaning block', () => {
  const block = buildGenderStylingContextBlock('woman');
  assert.match(block, /womenswear/);
  assert.match(block, /selected "woman"/);
});

Deno.test('NEUTRAL_CONTEXT_REACHES_STYLECHAT: prefer_not_to_say reaches the prompt as an explicit neutral instruction, not silence', () => {
  const block = buildGenderStylingContextBlock('prefer_not_to_say');
  assert.match(block, /prefer not to say/);
  assert.match(block, /[Nn]eutral/);
  assert.doesNotMatch(block, /menswear/);
  assert.doesNotMatch(block, /womenswear/);
});

Deno.test('EXPLICIT_REQUEST_OVERRIDES_BASELINE: every block states the user message always wins', () => {
  for (const value of ['man', 'woman', 'prefer_not_to_say'] as const) {
    const block = buildGenderStylingContextBlock(value);
    assert.match(block, /explicit request in their message always takes priority/i);
  }
});

Deno.test('NO_GENDER_INFERENCE: every block forbids stating the preference back or inferring beyond it', () => {
  for (const value of ['man', 'woman', 'prefer_not_to_say'] as const) {
    const block = buildGenderStylingContextBlock(value);
    assert.match(block, /Do not state this preference back/);
    assert.match(block, /do not infer anything about the user beyond this one self-disclosed value/);
  }
});

Deno.test('block is a compact, bracketed, self-contained section (matches the Style DNA block convention)', () => {
  for (const value of ['man', 'woman', 'prefer_not_to_say'] as const) {
    const block = buildGenderStylingContextBlock(value);
    assert.ok(block.startsWith('[Optional Baseline Styling Context]'));
    assert.ok(block.endsWith('[/Optional Baseline Styling Context]'));
  }
});
