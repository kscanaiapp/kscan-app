import assert from 'node:assert/strict';

import { createStylistSpeechHandler } from './handler.ts';
import {
  SPEECH_CUES,
  isSpeechCue,
  requireSpeechCueText,
  speechCueText,
} from './speechCues.ts';
import { MAX_SPEECH_CHARACTERS } from './speechText.ts';
import { StylistSpeechError, type StylistSpeechDataAccess } from './types.ts';

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';

const APPROVED: Record<string, string> = {
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

// ── Pure allowlist ───────────────────────────────────────────────────────────

Deno.test('every approved cue resolves to its approved text verbatim', () => {
  for (const [cue, expected] of Object.entries(APPROVED)) {
    assert.equal(speechCueText(cue), expected);
    assert.equal(requireSpeechCueText(cue), expected);
  }
});

Deno.test('the cue vocabulary is exactly the six approved transitions', () => {
  assert.deepEqual([...SPEECH_CUES].sort(), Object.keys(APPROVED).sort());
});

Deno.test('an unapproved cue is rejected rather than spoken', () => {
  for (const value of ['', 'ENTRY', 'entry ', 'saving', 'arbitrary text', null, 7, {}, ['entry']]) {
    assert.equal(isSpeechCue(value), false);
    assert.equal(speechCueText(value), null);
    assert.throws(
      () => requireSpeechCueText(value),
      (error: unknown) =>
        error instanceof StylistSpeechError &&
        error.status === 400 &&
        error.code === 'INVALID_REQUEST',
    );
  }
});

Deno.test('cue text fits the spoken-text contract', () => {
  for (const cue of SPEECH_CUES) {
    const text = speechCueText(cue) ?? '';
    assert.ok(text.length > 0 && text.length <= MAX_SPEECH_CHARACTERS);
  }
});

// ── Handler cue mode ─────────────────────────────────────────────────────────

/**
 * Session and message readers throw. Cue mode must never consult them: it has no
 * row to own, and a lookup here would mean the mode had quietly grown a
 * dependency on chat state it is specifically designed not to need.
 */
function cueDataAccess(preferenceId: string | null = 'stylist_portrait_05'): StylistSpeechDataAccess {
  return {
    getAuthenticatedActor: () => Promise.resolve({ id: ACTOR_ID }),
    getAccountStatus: () => Promise.resolve('active'),
    getSession: () => {
      throw new Error('cue mode must not read sessions');
    },
    getMessage: () => {
      throw new Error('cue mode must not read messages');
    },
    getStylistPreference: () =>
      Promise.resolve(preferenceId ? { avatar_id: preferenceId } : null),
  };
}

/**
 * Captures what was actually handed to the provider. Asserting on this rather
 * than on encoded audio is deliberate: `btoa` cannot represent the typographic
 * apostrophes in the approved copy, and the property under test is "the approved
 * words reached the provider", not "the stub could encode them".
 */
const spoken: { text: string | null; voiceProfile: string | null } = {
  text: null,
  voiceProfile: null,
};

function cueHandler(preferenceId: string | null = 'stylist_portrait_05') {
  spoken.text = null;
  spoken.voiceProfile = null;
  return createStylistSpeechHandler({
    createDataAccess: () => cueDataAccess(preferenceId),
    env: { get: () => 'test' },
    generateSpeech: ({ text, voiceProfile }) => {
      spoken.text = text;
      spoken.voiceProfile = voiceProfile;
      return Promise.resolve({
        audioBase64: 'QUJDRA==',
        alignment: null,
        alignmentDiagnostics: { source: 'none', rawStatus: 'absent' },
      });
    },
  });
}

function cueRequest(body: unknown, authorization = 'Bearer valid-token') {
  return new Request('https://example.test/stylist-speech', {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

Deno.test('cue mode speaks the approved line without touching chat state', async () => {
  const response = await cueHandler()(
    cueRequest({ cue: 'dressing_room_ready', stylistId: 'stylist_portrait_05' }),
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(body.cue, 'dressing_room_ready');
  assert.equal(body.messageId, null);
  assert.equal(body.voiceProfile, 'feminine');
  assert.equal(spoken.text, APPROVED.dressing_room_ready);
  assert.equal(spoken.voiceProfile, 'feminine');
});

Deno.test('cue mode still requires authentication', async () => {
  const response = await cueHandler()(
    cueRequest({ cue: 'entry', stylistId: 'stylist_portrait_05' }, ''),
  );
  assert.equal(response.status, 401);
});

Deno.test('cue mode still enforces the persisted stylist preference', async () => {
  const response = await cueHandler('stylist_portrait_06')(
    cueRequest({ cue: 'entry', stylistId: 'stylist_portrait_05' }),
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 403);
  assert.equal(body.code, 'STYLIST_MISMATCH');
});

Deno.test('cue mode still refuses a silent stylist', async () => {
  const response = await cueHandler('elise_default')(
    cueRequest({ cue: 'entry', stylistId: 'elise_default' }),
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 422);
  assert.equal(body.code, 'STYLIST_SILENT');
});

Deno.test('an unapproved cue is refused by the handler', async () => {
  const response = await cueHandler()(
    cueRequest({ cue: 'say_whatever_i_want', stylistId: 'stylist_portrait_05' }),
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_REQUEST');
});

Deno.test('a body mixing both modes is refused instead of favouring one', async () => {
  const response = await cueHandler()(
    cueRequest({
      cue: 'entry',
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      stylistId: 'stylist_portrait_05',
    }),
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_REQUEST');
});

Deno.test('cue mode cannot be used to speak caller-supplied text', async () => {
  // The decisive property: there is no request field that carries words. A body
  // trying to smuggle text is rejected as an unsupported field, not spoken.
  const response = await cueHandler()(
    cueRequest({ cue: 'entry', text: 'read my arbitrary script', stylistId: 'stylist_portrait_05' }),
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_REQUEST');
});
