import assert from 'node:assert/strict';

import { MAX_SPEECH_CHARACTERS } from './speechText.ts';

/**
 * Cross-function contract parity guard.
 *
 * stylist-speech and stylechat-generate deploy separately and each restate
 * their own length bound rather than importing one from the other (see the
 * comment on MAX_SPEECH_CHARACTERS in speechText.ts). That means nothing
 * stops the two values from drifting apart silently — a reply
 * stylechat-generate is willing to show in full could come back partially
 * narrated with no error anywhere.
 *
 * This test reads stylechat-generate's actual source and asserts equality
 * against stylist-speech's actual constant, so it fails the moment either
 * side changes without the other — not just when both happen to differ from
 * a literal 1000 written here.
 */
Deno.test('stylist-speech MAX_SPEECH_CHARACTERS stays in lockstep with stylechat-generate MAX_RESPONSE_CHARS', () => {
  const chatGenerateSource = Deno.readTextFileSync(
    new URL('../stylechat-generate/index.ts', import.meta.url),
  );
  const match = chatGenerateSource.match(/const\s+MAX_RESPONSE_CHARS\s*=\s*(\d+)\s*;/);
  assert.ok(
    match,
    'stylechat-generate/index.ts must declare MAX_RESPONSE_CHARS as a literal number constant',
  );
  const chatMaxResponseChars = Number(match![1]);

  assert.equal(
    MAX_SPEECH_CHARACTERS,
    chatMaxResponseChars,
    `stylist-speech MAX_SPEECH_CHARACTERS (${MAX_SPEECH_CHARACTERS}) must equal ` +
      `stylechat-generate MAX_RESPONSE_CHARS (${chatMaxResponseChars}); a complete, ` +
      'valid reply must never come back only partly narrated.',
  );
});

Deno.test('the currently agreed speech/reply bound is 1000 characters on both sides', () => {
  // Pinned in addition to the cross-check above so a coordinated change to
  // both constants at once is still a deliberate edit to this test, not a
  // silent narrowing nobody notices.
  const chatGenerateSource = Deno.readTextFileSync(
    new URL('../stylechat-generate/index.ts', import.meta.url),
  );
  const match = chatGenerateSource.match(/const\s+MAX_RESPONSE_CHARS\s*=\s*(\d+)\s*;/);
  assert.ok(match);
  assert.equal(Number(match![1]), 1000);
  assert.equal(MAX_SPEECH_CHARACTERS, 1000);
});
