const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ELISE_SPEECH_MOMENT_COPY,
  listEliseSpeechMoments,
} = require('../services/style-chat/eliseSpeechMoments.ts');
const {
  SPEECH_CUES,
  speechCueText,
} = require('../supabase/functions/stylist-speech/speechCues.ts');

/**
 * The app and the Edge Function deploy separately, so the approved copy is
 * restated on each side rather than shared through an import — a shared import
 * would be a lie about how these two artifacts ship. This test is what makes the
 * duplication safe: if either side is edited alone, the pair has drifted and
 * Elise would say different words depending on which build a user is running.
 */
test('client moments and server cues cover exactly the same vocabulary', () => {
  assert.deepEqual([...listEliseSpeechMoments()].sort(), [...SPEECH_CUES].sort());
});

test('client and server hold byte-identical copy for every moment', () => {
  for (const moment of listEliseSpeechMoments()) {
    assert.equal(
      ELISE_SPEECH_MOMENT_COPY[moment],
      speechCueText(moment),
      `copy for "${moment}" has drifted between the app and stylist-speech`,
    );
  }
});
