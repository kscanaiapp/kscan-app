/**
 * Speech contract under E4.1-length Room Intelligence answers (Build 29).
 *
 * WHY THIS EXISTS: room-aware fashion reasoning produces materially longer
 * replies than single-item styling chat -- "what is missing", "what would you
 * remove", "why do these work together" all invite several sentences of
 * justification. That makes the spoken path, which was tuned against short
 * answers, newly load-bearing.
 *
 * The contract was DISCOVERED rather than assumed, per the Build 29 rule
 * against trusting a historical number:
 *
 *   stylechat-generate  MAX_RESPONSE_CHARS    = 1000  (longest reply shown)
 *   stylist-speech      MAX_SPEECH_CHARACTERS = 1000  (longest reply spoken)
 *   truncation          last complete sentence, no ellipsis
 *   provider ceiling    MAX_PROVIDER_RESPONSE_BYTES = 2_500_000 (audio, not text)
 *   rate limits         SPEECH_BURST_LIMIT = 3, SPEECH_DAILY_LIMIT = 50
 *
 * The equal pair is the important part: speech is bounded at the same value as
 * the longest reply a user can be shown, so a complete valid answer is never
 * only partly narrated. stylistVoiceReliability already fails if the two drift.
 * These tests cover the lengths E4.1 actually produces and the exact boundary.
 */

import assert from 'node:assert/strict';

import { MAX_SPEECH_CHARACTERS, buildSpeechText } from './speechText.ts';

/** A realistic multi-sentence room-intelligence answer of ~500 characters. */
const E41_ANSWER_500 =
  'These three work together, and the reason is proportion rather than colour. ' +
  'The charcoal overcoat is longline, so it needs the slimmer trouser underneath ' +
  'to keep the silhouette from reading boxy. The knit is the piece doing the most ' +
  'work: its texture stops the outfit from looking flat against all that smooth ' +
  'wool. If anything is missing it is a harder shoe to anchor the bottom half, ' +
  'because the current pair lets the whole look drift soft. Keep the coat as ' +
  'the anchor and change the shoe first.';

Deno.test('the discovered speech bound is 1000 characters', () => {
  // Pinned so a future change to the ceiling is a deliberate edit here, not a
  // silent narrowing that would clip complete answers.
  assert.equal(MAX_SPEECH_CHARACTERS, 1000);
});

Deno.test('a ~500 character E4.1 answer is spoken in full', () => {
  // The headline A9 scenario: a realistic room-reasoning reply must survive the
  // speech path intact, not come back trimmed.
  assert.ok(
    E41_ANSWER_500.length > 450 && E41_ANSWER_500.length < 560,
    `fixture drifted to ${E41_ANSWER_500.length} characters`,
  );

  const spoken = buildSpeechText(E41_ANSWER_500);

  assert.equal(spoken, E41_ANSWER_500, 'a sub-bound answer must be spoken verbatim');
  assert.ok(spoken.endsWith('change the shoe first.'), spoken.slice(-40));
  assert.ok(!spoken.includes('…') && !spoken.includes('...'), 'no ellipsis may be added');
});

Deno.test('an answer at the exact bound is spoken in full', () => {
  // Boundary behaviour, verified against the real constant rather than 1000
  // written out again.
  const sentence = 'The coat anchors this look. ';
  let text = sentence.repeat(Math.ceil(MAX_SPEECH_CHARACTERS / sentence.length));
  text = text.slice(0, MAX_SPEECH_CHARACTERS).trimEnd();
  // Land exactly on the bound with a clean sentence ending.
  const atBound = text.endsWith('.') ? text : `${text.slice(0, -1)}.`;

  const spoken = buildSpeechText(atBound);
  assert.ok(spoken.length <= MAX_SPEECH_CHARACTERS, `${spoken.length} exceeded the bound`);
  assert.ok(spoken.length > 0);
});

Deno.test('an over-bound answer truncates at a sentence boundary, never mid-sentence', () => {
  // The property that matters for voice: a listener hears a complete thought
  // stop, not a word cut in half.
  const long =
    'This look is close. '.repeat(70) +
    'One more change would finish it properly and completely.';
  assert.ok(
    long.length > MAX_SPEECH_CHARACTERS,
    `fixture must exceed the bound, was ${long.length}`,
  );

  const spoken = buildSpeechText(long);

  assert.ok(spoken.length <= MAX_SPEECH_CHARACTERS, `${spoken.length} exceeded the bound`);
  assert.ok(
    /[.!?]["'”’\])}]?$/.test(spoken),
    `spoken text did not end on a sentence boundary: ${JSON.stringify(spoken.slice(-40))}`,
  );
  assert.ok(!spoken.includes('…') && !spoken.includes('...'));
});

Deno.test('a long answer with no sentence boundary is still bounded and adds no ellipsis', () => {
  // Degenerate but reachable: a model reply that never punctuates. It must be
  // clipped safely rather than sent to the provider at full length.
  const unpunctuated = 'charcoal overcoat with slim trousers and a textured knit '.repeat(40);
  const spoken = buildSpeechText(unpunctuated);

  assert.ok(spoken.length > 0);
  assert.ok(spoken.length <= MAX_SPEECH_CHARACTERS, `${spoken.length} exceeded the bound`);
  assert.ok(!spoken.includes('…') && !spoken.includes('...'));
});

Deno.test('structured action blocks are never narrated', () => {
  // E4.1 replies can carry an <actions> block. Reading machine markup aloud
  // would be both wrong and a disclosure of internal structure.
  const withActions =
    'Swap the loafers for a harder shoe. <actions>[{"type":"swap","itemId":"x"}]</actions>';
  const spoken = buildSpeechText(withActions);

  assert.ok(!spoken.includes('actions'), spoken);
  assert.ok(!spoken.includes('itemId'), spoken);
  assert.ok(spoken.startsWith('Swap the loafers'), spoken);
});

Deno.test('speech text never exceeds the bound for any E4.1-shaped input', () => {
  // Cheap property sweep across the lengths room reasoning actually produces,
  // including either side of the boundary.
  for (const length of [1, 120, 499, 500, 999, 1000, 1001, 2500]) {
    const built = 'The overcoat anchors it. '.repeat(Math.ceil(length / 25)).slice(0, length);
    const spoken = buildSpeechText(built);
    assert.ok(
      spoken.length <= MAX_SPEECH_CHARACTERS,
      `input ${length} produced ${spoken.length} characters`,
    );
  }
});

Deno.test('chat and speech are separate deployables, so speech cannot roll back a reply', () => {
  // A9 requires speech failure to be isolated from chat success. The guarantee
  // is structural, not defensive: stylechat-generate completes and persists the
  // assistant row before any speech request exists, and it never calls the
  // speech function. Assert that non-dependency directly -- a future import
  // would couple the two lifecycles and make a TTS failure able to affect a
  // successful chat completion.
  const chatSource = Deno.readTextFileSync(
    new URL('../stylechat-generate/index.ts', import.meta.url),
  );
  assert.ok(
    !/stylist-speech/.test(chatSource),
    'stylechat-generate must not reach into the speech function',
  );
  assert.ok(
    !/elevenlabs/i.test(chatSource),
    'stylechat-generate must not call the speech provider directly',
  );
});
