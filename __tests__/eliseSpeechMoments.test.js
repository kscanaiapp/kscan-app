const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ELISE_SPEECH_MOMENT_COPY,
  isEliseSpeechMoment,
  listEliseSpeechMoments,
  resolveEliseSpeechMomentCopy,
} = require('../services/style-chat/eliseSpeechMoments.ts');

// The spoken-text bound enforced by stylist-speech `speechText.ts`. Restated
// here rather than imported because the Edge Function deploys separately; if the
// pair ever drifts, this test is one of the places that notices.
const MAX_SPEECH_CHARACTERS = 1000;

const APPROVED = {
  entry:
    'Hey, I\u2019m Elise. Show me what you\u2019re working with, and we\u2019ll figure it out together.',
  image_understood:
    'Got it. I can see what you\u2019re working with. Ask me anything about this piece.',
  closet_saved: 'Saved. Now we can build around it whenever you want.',
  style_item: 'Let\u2019s build a look around it.',
  dressing_room_ready:
    'Here\u2019s a starting point. We can change anything you don\u2019t love.',
  change_something: 'Absolutely. Tell me what you want to change.',
};

test('every approved moment resolves to its exact approved line', () => {
  for (const [moment, expected] of Object.entries(APPROVED)) {
    assert.equal(
      resolveEliseSpeechMomentCopy(moment),
      expected,
      `${moment} must resolve to the approved line verbatim`,
    );
  }
});

test('the moment vocabulary is exactly the six approved transitions', () => {
  assert.deepEqual([...listEliseSpeechMoments()].sort(), Object.keys(APPROVED).sort());
});

test('an unknown state does not fabricate speech', () => {
  const notMoments = [
    'saving',
    'identifying',
    'entry ',
    'ENTRY',
    'image_understood_v2',
    '',
    null,
    undefined,
    0,
    {},
    [],
    ['entry'],
  ];
  for (const value of notMoments) {
    assert.equal(
      resolveEliseSpeechMomentCopy(value),
      null,
      `${JSON.stringify(value)} must resolve to null, not invented speech`,
    );
    assert.equal(isEliseSpeechMoment(value), false);
  }
});

test('all approved copy stays inside the spoken-text contract', () => {
  for (const [moment, line] of Object.entries(APPROVED)) {
    assert.ok(line.length > 0, `${moment} must not be empty`);
    assert.ok(
      line.length <= MAX_SPEECH_CHARACTERS,
      `${moment} must fit the ${MAX_SPEECH_CHARACTERS}-character spoken contract`,
    );
  }
});

test('copy avoids system language and stays in Elise voice', () => {
  // The tone rule is testable at its edges: these are the phrasings the product
  // copy explicitly rejects, and a future edit that reintroduces them is a
  // regression in Elise's character, not a harmless reword.
  const BANNED = [
    'analyzed',
    'processed successfully',
    'persisted',
    'visual data',
    'request has been completed',
    'error',
  ];
  for (const [moment, line] of Object.entries(APPROVED)) {
    const lowered = line.toLowerCase();
    for (const banned of BANNED) {
      assert.ok(
        !lowered.includes(banned),
        `${moment} must not use system language ("${banned}")`,
      );
    }
  }
});

test('the exported copy table is frozen against accidental mutation', () => {
  // Sloppy-mode CommonJS swallows writes to a frozen object instead of throwing,
  // so assert the property that actually matters: the line is unchanged either way.
  assert.equal(Object.isFrozen(ELISE_SPEECH_MOMENT_COPY), true);
  try {
    ELISE_SPEECH_MOMENT_COPY.entry = 'something else';
  } catch {
    // Strict-mode callers get a TypeError; both outcomes are acceptable.
  }
  assert.equal(ELISE_SPEECH_MOMENT_COPY.entry, APPROVED.entry);
});
