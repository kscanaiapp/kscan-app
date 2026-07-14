import assert from 'node:assert/strict';
import { buildSpeechText, MAX_SPEECH_CHARACTERS } from './speechText.ts';

Deno.test('speech text preserves normal visible copy and punctuation', () => {
  assert.equal(buildSpeechText('Try the navy blazer. It feels polished!'), 'Try the navy blazer. It feels polished!');
  assert.equal(buildSpeechText('Price: $1,250. Date: 07/14/2026.'), 'Price: $1,250. Date: 07/14/2026.');
  assert.equal(buildSpeechText('A bright scarf ✨ works here.'), 'A bright scarf ✨ works here.');
});

Deno.test('speech text normalizes whitespace and removes internal or markdown-only markup', () => {
  assert.equal(buildSpeechText('  Pair   the\nboots\twith denim.  '), 'Pair the boots with denim.');
  assert.equal(
    buildSpeechText('See [the edit](https://example.com/look). <actions>{"hidden":true}</actions> **Done.**'),
    'See the edit. Done.',
  );
  assert.equal(buildSpeechText('```json\n{"internal":true}\n```'), '');
});

Deno.test('speech text prefers the last complete sentence at the 700 character bound', () => {
  const first = `First look ${'works '.repeat(80)}.`;
  const second = ` Second thought ${'continues '.repeat(80)}.`;
  const result = buildSpeechText(first + second);
  assert.ok(result.length <= MAX_SPEECH_CHARACTERS);
  assert.ok(result.endsWith('.'));
  assert.equal(result, first.replace(/\s+\./g, '.').replace(/\s+/g, ' ').trim());
});

Deno.test('speech text safely bounds long copy with no sentence boundary and adds no ellipsis', () => {
  const result = buildSpeechText('word '.repeat(200).trim());
  assert.ok(result.length <= MAX_SPEECH_CHARACTERS);
  assert.ok(!result.endsWith('…'));
  assert.ok(!result.endsWith('...'));
});

Deno.test('speech text handles URLs, empty input, and empty normalized output', () => {
  assert.equal(buildSpeechText('Visit https://example.com/look for details.'), 'Visit https://example.com/look for details.');
  assert.equal(buildSpeechText('   '), '');
  assert.equal(buildSpeechText(null), '');
  assert.equal(buildSpeechText('<internal>secret</internal>'), '');
});
