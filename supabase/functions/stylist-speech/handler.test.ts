import assert from 'node:assert/strict';

import { createStylistSpeechHandler } from './handler.ts';
import { StylistSpeechRateLimiter } from './rateLimit.ts';
import type {
  SpeechMessageRow,
  SpeechSessionRow,
  StylistPreferenceRow,
  StylistSpeechDataAccess,
} from './types.ts';

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ACTOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const DEFAULT_BODY = { sessionId: SESSION_ID, messageId: MESSAGE_ID, stylistId: 'stylist_portrait_05' };

interface DataOverrides {
  actor?: { id: string } | null;
  accountStatus?: string | null;
  session?: SpeechSessionRow | null;
  message?: SpeechMessageRow | null;
  preference?: StylistPreferenceRow | null;
}

function dataAccess(overrides: DataOverrides = {}): StylistSpeechDataAccess {
  const defaults = {
    actor: { id: ACTOR_ID },
    accountStatus: 'active',
    session: { id: SESSION_ID, user_id: ACTOR_ID },
    message: {
      id: MESSAGE_ID,
      session_id: SESSION_ID,
      user_id: ACTOR_ID,
      sender: 'assistant',
      content: '**Hello** from [K Scan](https://kscan.app).',
      ui_blocks: null,
      provider: 'stylechat',
    },
    preference: { avatar_id: 'stylist_portrait_05' },
  } satisfies Required<DataOverrides>;
  const values = { ...defaults, ...overrides };
  return {
    getAuthenticatedActor: () => Promise.resolve(values.actor),
    getAccountStatus: () => Promise.resolve(values.accountStatus),
    getSession: () => Promise.resolve(values.session),
    getMessage: () => Promise.resolve(values.message),
    getStylistPreference: () => Promise.resolve(values.preference),
  };
}

function handlerFor(overrides: DataOverrides = {}, dependencyOverrides: Record<string, unknown> = {}) {
  return createStylistSpeechHandler({
    createDataAccess: () => dataAccess(overrides),
    env: { get: () => 'test' },
    generateSpeech: ({ text, voiceProfile }) => Promise.resolve({
      audioBase64: btoa(`${voiceProfile}:${text}`),
      alignment: null,
      alignmentDiagnostics: { source: 'none', rawStatus: 'absent' },
    }),
    ...dependencyOverrides,
  });
}

/** Captures the exact voiceSecretName (and voiceProfile) resolved for the request without dispatching. */
function capturingHandler(overrides: DataOverrides, captured: { voiceSecretName?: string; voiceProfile?: string }) {
  return createStylistSpeechHandler({
    createDataAccess: () => dataAccess(overrides),
    env: { get: () => 'test' },
    generateSpeech: ({ text, voiceProfile, voiceSecretName }) => {
      captured.voiceSecretName = voiceSecretName;
      captured.voiceProfile = voiceProfile;
      return Promise.resolve({
        audioBase64: btoa(`${voiceProfile}:${text}`),
        alignment: null,
        alignmentDiagnostics: { source: 'none', rawStatus: 'absent' },
      });
    },
  });
}

function speechRequest(body: unknown = DEFAULT_BODY, authorization = 'Bearer valid-token', method = 'POST') {
  return new Request('https://example.test/stylist-speech', {
    method,
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

async function responseBody(response: Response) {
  return await response.json() as Record<string, unknown>;
}

Deno.test('returns bound speech for an owned assistant message', async () => {
  const response = await handlerFor()(speechRequest());
  const body = await responseBody(response);
  assert.equal(response.status, 200);
  assert.equal(body.messageId, MESSAGE_ID);
  assert.equal(body.stylistId, 'stylist_portrait_05');
  assert.equal(body.voiceProfile, 'feminine');
  assert.equal(atob(String(body.audioBase64)), 'feminine:Hello from K Scan.');
  assert.equal(body.cue, null);
  assert.deepEqual(Object.keys(body).sort(), [
    'alignment',
    'alignmentDiagnostics',
    'audioBase64',
    'cue',
    'messageId',
    'mimeType',
    'stylistId',
    'voiceProfile',
  ]);
});

Deno.test('selects masculine voices from the fixed server allowlist', async () => {
  const response = await handlerFor(
    { preference: { avatar_id: 'stylist_portrait_02' } },
  )(speechRequest({ ...DEFAULT_BODY, stylistId: 'stylist_portrait_02' }));
  const body = await responseBody(response);
  assert.equal(response.status, 200);
  assert.equal(body.voiceProfile, 'masculine');
});

Deno.test('routes each configured stylist to its own server-side voice secret, never the client-supplied one', async () => {
  // Henry, Sarah, and Mark: proves provider selection uses the resolved
  // per-stylist voice SECRET NAME, not a shared profile-level voice, and
  // that no literal voice ID ever reaches the provider client from here.
  const cases = [
    ['stylist_portrait_02', 'ELEVENLABS_STYLIST_02_VOICE_ID', 'masculine'],
    ['stylist_portrait_05', 'ELEVENLABS_STYLIST_05_VOICE_ID', 'feminine'],
    ['stylist_portrait_08', 'ELEVENLABS_STYLIST_08_VOICE_ID', 'masculine'],
  ] as const;

  for (const [stylistId, expectedSecretName, expectedProfile] of cases) {
    const captured: { voiceSecretName?: string; voiceProfile?: string } = {};
    const handler = capturingHandler({ preference: { avatar_id: stylistId } }, captured);
    const response = await handler(speechRequest({ ...DEFAULT_BODY, stylistId }));
    assert.equal(response.status, 200);
    assert.equal(captured.voiceSecretName, expectedSecretName);
    assert.equal(captured.voiceProfile, expectedProfile);
  }
});

Deno.test('masculine stylists that share a profile still route to independently configured voice secrets', async () => {
  const henry: { voiceSecretName?: string } = {};
  const mark: { voiceSecretName?: string } = {};
  const david: { voiceSecretName?: string } = {};

  await capturingHandler({ preference: { avatar_id: 'stylist_portrait_02' } }, henry)(
    speechRequest({ ...DEFAULT_BODY, stylistId: 'stylist_portrait_02' }),
  );
  await capturingHandler({ preference: { avatar_id: 'stylist_portrait_08' } }, mark)(
    speechRequest({ ...DEFAULT_BODY, stylistId: 'stylist_portrait_08' }),
  );
  await capturingHandler({ preference: { avatar_id: 'stylist_portrait_09' } }, david)(
    speechRequest({ ...DEFAULT_BODY, stylistId: 'stylist_portrait_09' }),
  );

  assert.notEqual(henry.voiceSecretName, mark.voiceSecretName);
  assert.notEqual(henry.voiceSecretName, david.voiceSecretName);
  assert.notEqual(mark.voiceSecretName, david.voiceSecretName);
});

Deno.test('feminine stylists that share a profile still route to independently configured voice secrets', async () => {
  const elise: { voiceSecretName?: string } = {};
  const marie: { voiceSecretName?: string } = {};
  const kim: { voiceSecretName?: string } = {};

  await capturingHandler({ preference: { avatar_id: 'stylist_portrait_01' } }, elise)(
    speechRequest({ ...DEFAULT_BODY, stylistId: 'stylist_portrait_01' }),
  );
  await capturingHandler({ preference: { avatar_id: 'stylist_portrait_04' } }, marie)(
    speechRequest({ ...DEFAULT_BODY, stylistId: 'stylist_portrait_04' }),
  );
  await capturingHandler({ preference: { avatar_id: 'stylist_portrait_10' } }, kim)(
    speechRequest({ ...DEFAULT_BODY, stylistId: 'stylist_portrait_10' }),
  );

  assert.notEqual(elise.voiceSecretName, marie.voiceSecretName);
  assert.notEqual(elise.voiceSecretName, kim.voiceSecretName);
  assert.notEqual(marie.voiceSecretName, kim.voiceSecretName);
});

Deno.test('rejects missing and invalid authentication', async () => {
  for (const [authorization, overrides] of [
    ['', {}],
    ['Token invalid', {}],
    ['Bearer invalid', { actor: null }],
  ] as const) {
    const response = await handlerFor(overrides)(speechRequest(DEFAULT_BODY, authorization));
    assert.equal(response.status, 401);
    assert.equal((await responseBody(response)).code, 'NOT_AUTHENTICATED');
  }
});

Deno.test('rejects unavailable accounts', async () => {
  for (const accountStatus of ['pending_deletion', 'locked']) {
    const response = await handlerFor({ accountStatus })(speechRequest());
    assert.equal(response.status, 403);
    assert.equal((await responseBody(response)).code, 'ACCOUNT_UNAVAILABLE');
  }
});

Deno.test('rejects missing or cross-actor sessions', async () => {
  for (const session of [null, { id: SESSION_ID, user_id: OTHER_ACTOR_ID }]) {
    const response = await handlerFor({ session })(speechRequest());
    assert.equal(response.status, 404);
    assert.equal((await responseBody(response)).code, 'SESSION_NOT_FOUND');
  }
});

Deno.test('rejects missing, cross-actor, and cross-session messages', async () => {
  const baseMessage = dataAccess().getMessage(MESSAGE_ID, ACTOR_ID);
  const message = (await baseMessage)!;
  for (const candidate of [
    null,
    { ...message, user_id: OTHER_ACTOR_ID },
    { ...message, session_id: '33333333-3333-4333-8333-333333333333' },
  ]) {
    const response = await handlerFor({ message: candidate })(speechRequest());
    assert.equal(response.status, 404);
    assert.equal((await responseBody(response)).code, 'MESSAGE_NOT_FOUND');
  }
});

Deno.test('rejects user, empty, hidden, and system-provider messages', async () => {
  const message = (await dataAccess().getMessage(MESSAGE_ID, ACTOR_ID))!;
  for (const candidate of [
    { ...message, sender: 'user' },
    { ...message, content: '   ' },
    { ...message, ui_blocks: [{ type: 'hidden' }] },
    { ...message, provider: 'system' },
  ]) {
    const response = await handlerFor({ message: candidate })(speechRequest());
    assert.equal(response.status, 422);
    assert.equal((await responseBody(response)).code, 'MESSAGE_INELIGIBLE');
  }
});

Deno.test('rejects silent, unsupported, and preference-mismatched stylists', async () => {
  for (const [stylistId, preference, expectedCode, expectedStatus] of [
    ['elise_default', { avatar_id: 'elise_default' }, 'STYLIST_SILENT', 422],
    ['unknown_avatar', { avatar_id: 'unknown_avatar' }, 'STYLIST_UNSUPPORTED', 422],
    ['stylist_portrait_06', { avatar_id: 'stylist_portrait_05' }, 'STYLIST_MISMATCH', 403],
  ] as const) {
    const response = await handlerFor({ preference })(speechRequest({ ...DEFAULT_BODY, stylistId }));
    assert.equal(response.status, expectedStatus);
    assert.equal((await responseBody(response)).code, expectedCode);
  }
});

Deno.test('defaults a missing persisted preference to silent Elise', async () => {
  const response = await handlerFor({ preference: null })(speechRequest());
  assert.equal(response.status, 403);
  assert.equal((await responseBody(response)).code, 'STYLIST_MISMATCH');
});

Deno.test('rejects malformed references and all client-supplied speech material', async () => {
  for (const body of [
    { ...DEFAULT_BODY, sessionId: 'not-a-uuid' },
    { ...DEFAULT_BODY, text: 'Say this instead' },
    { ...DEFAULT_BODY, voiceId: 'client-controlled' },
    { ...DEFAULT_BODY, voiceProfile: 'masculine' },
  ]) {
    const response = await handlerFor()(speechRequest(body));
    assert.equal(response.status, 400);
    assert.equal((await responseBody(response)).code, 'INVALID_REQUEST');
  }
});

Deno.test('deduplicates the same actor, message, session, and stylist while in flight', async () => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const limiter = new StylistSpeechRateLimiter();
  const handler = handlerFor({}, {
    limiter,
    generateSpeech: async () => {
      await providerGate;
      return { audioBase64: btoa('audio'), alignment: null };
    },
  });

  const first = handler(speechRequest());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const duplicate = await handler(speechRequest());
  assert.equal(duplicate.status, 409);
  assert.equal((await responseBody(duplicate)).code, 'DUPLICATE_REQUEST');
  releaseProvider();
  assert.equal((await first).status, 200);
});

Deno.test('sanitizes unexpected provider errors and allows a later retry', async () => {
  let attempts = 0;
  const handler = handlerFor({}, {
    generateSpeech: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('provider response contains server-only-api-key');
      return Promise.resolve({ audioBase64: btoa('audio'), alignment: null });
    },
  });
  const failed = await handler(speechRequest());
  const failedBody = await responseBody(failed);
  assert.equal(failed.status, 500);
  assert.equal(failedBody.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(failedBody), /server-only-api-key/);
  assert.equal((await handler(speechRequest())).status, 200);
});

Deno.test('supports CORS preflight and rejects non-POST methods', async () => {
  const handler = handlerFor();
  assert.equal((await handler(speechRequest(undefined, '', 'OPTIONS'))).status, 200);
  assert.equal((await handler(speechRequest(undefined, '', 'GET'))).status, 405);
});
