import assert from "node:assert/strict";
import { createStylistSpeechHandler } from "./handler.ts";
import type { StylistSpeechDataAccess } from "./types.ts";
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = "11111111-1111-4111-8111-111111111111";
const message = "22222222-2222-4222-8222-222222222222";
const body = {
  sessionId: session,
  messageId: message,
  stylistId: "elise_default",
};
const base = (): StylistSpeechDataAccess => ({
  getAuthenticatedActor: async () => ({ id: actor }),
  getAccountStatus: async () => "active",
  hasActiveKPlus: async () => true,
  getSession: async () => ({ id: session, user_id: actor }),
  getMessage: async () => ({
    id: message,
    session_id: session,
    user_id: actor,
    sender: "assistant",
    content: "A short verified reply.",
    ui_blocks: null,
    provider: "stylechat",
  }),
  getStylistPreference: async () => ({ avatar_id: "elise_default" }),
  reserveSpeechRequest: async () => ({
    allowed: true,
    reservationId: "33333333-3333-4333-8333-333333333333",
  }),
  finishSpeechRequest: async () => {},
});
async function probe(
  overrides: Partial<StylistSpeechDataAccess>,
  input: unknown = body,
) {
  let calls = 0, reservations = 0;
  const data = { ...base(), ...overrides };
  const reserve = data.reserveSpeechRequest;
  data.reserveSpeechRequest = (...args) => {
    reservations++;
    return reserve(...args);
  };
  const handler = createStylistSpeechHandler({
    createDataAccess: () => data,
    env: { get: () => "fixture" },
    generateSpeech: async () => {
      calls++;
      return {
        audioBase64: "YQ==",
        alignment: null,
        alignmentDiagnostics: { source: "none", rawStatus: "absent" },
      };
    },
  });
  const response = await handler(
    new Request("https://fixture.invalid", {
      method: "POST",
      headers: { Authorization: "Bearer fixture" },
      body: JSON.stringify(input),
    }),
  );
  const payload = await response.json();
  return { status: response.status, code: payload.code, calls, reservations };
}
Deno.test("hostile matrix: every denied account state makes zero reservations and zero paid calls", async () => {
  for (
    const status of [
      "suspended",
      "deleted",
      "pending_deletion",
      "locked",
      "deactivated",
      null,
    ]
  ) {
    assert.deepEqual(await probe({ getAccountStatus: async () => status }), {
      status: 403,
      code: "ACCOUNT_UNAVAILABLE",
      calls: 0,
      reservations: 0,
    });
  }
});
Deno.test("hostile matrix: anonymous and missing actors make zero reservations and zero paid calls", async () => {
  for (const identity of [null, { id: actor, isAnonymous: true }]) {
    assert.deepEqual(
      await probe({ getAuthenticatedActor: async () => identity }),
      { status: 401, code: "NOT_AUTHENTICATED", calls: 0, reservations: 0 },
    );
  }
});
Deno.test("hostile matrix: cross-actor session and message make zero reservations and zero paid calls", async () => {
  const source = base();
  const ownedMessage = await source.getMessage(message, actor);
  assert.ok(ownedMessage);
  assert.deepEqual(
    await probe({ getSession: async () => ({ id: session, user_id: other }) }),
    { status: 404, code: "SESSION_NOT_FOUND", calls: 0, reservations: 0 },
  );
  assert.deepEqual(
    await probe({
      getMessage: async () => ({ ...ownedMessage, user_id: other }),
    }),
    { status: 404, code: "MESSAGE_NOT_FOUND", calls: 0, reservations: 0 },
  );
});
Deno.test("hostile matrix: arbitrary client speech material makes zero reservations and zero paid calls", async () => {
  for (
    const extra of [
      { text: "spoofed" },
      { voiceId: "spoofed" },
      { modelId: "spoofed" },
      { provider: "spoofed" },
      { userId: other },
    ]
  ) {
    assert.deepEqual(await probe({}, { ...body, ...extra }), {
      status: 400,
      code: "INVALID_REQUEST",
      calls: 0,
      reservations: 0,
    });
  }
});
Deno.test("hostile matrix: reservation-time revocation, disabled and exhausted budget make zero paid calls", async () => {
  for (
    const [reason, status, code] of [
      ["entitlement_required", 403, "KPLUS_REQUIRED"],
      ["disabled", 503, "SPEECH_DISABLED"],
      ["character_budget", 429, "SPEECH_COST_LIMIT"],
      ["concurrent_request", 429, "SPEECH_COST_LIMIT"],
    ] as const
  ) {
    assert.deepEqual(
      await probe({
        reserveSpeechRequest: async () => ({ allowed: false, reason }),
      }),
      { status, code, calls: 0, reservations: 1 },
    );
  }
});
