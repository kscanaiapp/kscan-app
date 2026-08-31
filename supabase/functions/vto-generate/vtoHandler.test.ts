/**
 * VTO authority tests.
 *
 * These call the real handler with injected boundaries rather than reading
 * its source. A source-text assertion cannot tell the difference between
 * "the guard is present" and "the guard runs", and the whole value of this
 * function is that its guards run in a particular order.
 *
 * Deterministic throughout: the mock provider is driven at zero latency and
 * with an explicit scenario, so nothing here can flake.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { handleVtoRequest, type VtoHandlerDeps } from './vtoHandler.ts';
import { createMockVtoProvider } from './providers/mockProvider.ts';
import { resolveVtoProvider } from './providers/index.ts';
import { MOCK_VTO_RESULT_BASE64 } from './providers/mockResultAsset.ts';
import type { VtoFeatureConfig } from './vtoFeatureControl.ts';

const USER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_USER_ID = '99999999-8888-4777-8666-555555555555';

const ENABLED_CONFIG: VtoFeatureConfig = {
  enabled: true,
  provider: 'mock',
  supportedCategories: ['top', 'outerwear', 'blazer', 'dress'],
  mockLatencyMs: 0,
  mockScenario: 'success',
};

// A small but valid JPEG-shaped payload. Only its data-URI shape matters to
// the handler; the provider never decodes it.
const PERSON_DATA_URI = `data:image/jpeg;base64,${'A'.repeat(2048)}`;

function garment(overrides: Record<string, unknown> = {}) {
  return {
    productRef: 'prod_123',
    imageUrl: 'https://cdn.example.com/coat.jpg',
    category: 'wool coat',
    brand: 'Example',
    commerceSource: 'example',
    ...overrides,
  };
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'vtoreq_1_abc',
    origin: 'commerce_product',
    person: { dataUri: PERSON_DATA_URI },
    garment: garment(),
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://edge.local/vto-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function deps(overrides: Partial<VtoHandlerDeps> = {}): Partial<VtoHandlerDeps> {
  return {
    requireUser: () => Promise.resolve({ id: USER_ID, accessToken: 'token', isAnonymous: false }),
    assertAccountActive: () => Promise.resolve(),
    readVtoFeatureConfig: () => Promise.resolve(ENABLED_CONFIG),
    resolveVtoEntitlement: () => Promise.resolve({ state: 'active' as const }),
    resolveVtoProvider: () => ({
      ok: true as const,
      provider: createMockVtoProvider({ scenario: 'success', latencyMs: 0 }),
    }),
    // SEC-KPLUS-004: the handler now reserves a paid generation before calling
    // the provider and settles it afterwards. Stubbed to the granting outcome
    // here so these tests keep exercising the authority chain they are about;
    // the reservation's own behaviour (duplicate / quota / fail-closed) is
    // covered in vtoPaidBoundary.test.ts.
    reserveVtoGeneration: () =>
      Promise.resolve({ outcome: 'reserved' as const, used: 1, dailyLimit: 10 }),
    completeVtoGeneration: () => Promise.resolve(),
    generationTimeoutMs: 1_000,
    devScenariosAllowed: () => false,
    ...overrides,
  };
}

async function failureCode(response: Response): Promise<string> {
  const body = await response.json();
  return body?.error?.code ?? '(none)';
}

// ── P0: the authority chain ───────────────────────────────────────────────────

Deno.test('P0: an authenticated, entitled, eligible request succeeds', async () => {
  const response = await handleVtoRequest(post(requestBody()), deps());
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.status, 'success');
  assertEquals(body.provider, 'mock');
  assertEquals(body.result.isAiVisualization, true);
  assert(body.result.dataUri.startsWith('data:image/png;base64,'));
  assert(body.result.dataUri.includes(MOCK_VTO_RESULT_BASE64.slice(0, 40)));
});

Deno.test('P0: an unauthenticated request never reaches a provider', async () => {
  let providerCalled = false;
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({
      requireUser: () => Promise.reject(new Response('no', { status: 401 })),
      resolveVtoProvider: () => {
        providerCalled = true;
        return { ok: true as const, provider: createMockVtoProvider({ latencyMs: 0 }) };
      },
    }),
  );
  assertEquals(response.status, 401);
  assertEquals(await failureCode(response), 'authorization_failed');
  assertEquals(providerCalled, false);
});

Deno.test('P0: identity comes from the session, never from the body', async () => {
  // The body forges every identity field it can think of. The only id that
  // reaches the entitlement check must be the one requireUser returned.
  const seen: string[] = [];
  const response = await handleVtoRequest(
    post(
      requestBody({
        user_id: OTHER_USER_ID,
        userId: OTHER_USER_ID,
        actorId: OTHER_USER_ID,
        sub: OTHER_USER_ID,
      }),
    ),
    deps({
      resolveVtoEntitlement: (userId: string) => {
        seen.push(userId);
        return Promise.resolve({ state: 'active' as const });
      },
    }),
  );
  assertEquals(response.status, 200);
  // INT-KPLUS-007 added a second, later entitlement read immediately before the
  // paid provider boundary, so there are now two. This test is about WHOSE id
  // reaches the check, not how many times: every call must carry the session's
  // id and never a body-supplied one.
  assertEquals(seen.length, 2, 'entitlement is checked once up front and again at the paid boundary');
  assertEquals([...new Set(seen)], [USER_ID]);
});

Deno.test('P0: a deactivated account is refused before any provider work', async () => {
  let providerCalled = false;
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({
      assertAccountActive: () => Promise.reject(new Response('no', { status: 403 })),
      resolveVtoProvider: () => {
        providerCalled = true;
        return { ok: true as const, provider: createMockVtoProvider({ latencyMs: 0 }) };
      },
    }),
  );
  assertEquals(await failureCode(response), 'authorization_failed');
  assertEquals(providerCalled, false);
});

Deno.test('P0: the kill switch stops generation outright', async () => {
  let providerCalled = false;
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({
      readVtoFeatureConfig: () =>
        Promise.resolve({ ...ENABLED_CONFIG, enabled: false }),
      resolveVtoProvider: () => {
        providerCalled = true;
        return { ok: true as const, provider: createMockVtoProvider({ latencyMs: 0 }) };
      },
    }),
  );
  assertEquals(response.status, 403);
  assertEquals(await failureCode(response), 'feature_disabled');
  assertEquals(providerCalled, false);
});

Deno.test('P0: feature control is checked before entitlement', async () => {
  // Order matters for honesty: a globally disabled feature must never be
  // reported to a free user as "buy K+ to unlock".
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({
      readVtoFeatureConfig: () => Promise.resolve({ ...ENABLED_CONFIG, enabled: false }),
      resolveVtoEntitlement: () => Promise.resolve({ state: 'denied' as const }),
    }),
  );
  assertEquals(await failureCode(response), 'feature_disabled');
});

// ── P1: entitlement, media, and provider failure mapping ─────────────────────

Deno.test('P1: K+ fails closed when the user has no active grant', async () => {
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({ resolveVtoEntitlement: () => Promise.resolve({ state: 'denied' as const }) }),
  );
  assertEquals(response.status, 403);
  assertEquals(await failureCode(response), 'entitlement_required');
});

Deno.test('P1: an unreadable entitlement denies WITHOUT claiming K+ is missing', async () => {
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({ resolveVtoEntitlement: () => Promise.resolve({ state: 'unknown' as const }) }),
  );
  assertEquals(await failureCode(response), 'authorization_failed');
});

Deno.test('P1: an unsupported category is refused by the server', async () => {
  const response = await handleVtoRequest(
    post(requestBody({ garment: garment({ category: 'sneakers' }) })),
    deps(),
  );
  assertEquals(response.status, 422);
  assertEquals(await failureCode(response), 'unsupported_category');
});

Deno.test('P1: the server does not defer to the client on eligibility', async () => {
  // The body asserts eligibility loudly. The server is looking at the garment.
  const response = await handleVtoRequest(
    post(
      requestBody({
        garment: garment({ category: 'handbag' }),
        eligible: true,
        eligibility: { eligible: true, slot: 'top' },
        slot: 'top',
      }),
    ),
    deps(),
  );
  assertEquals(await failureCode(response), 'unsupported_category');
});

Deno.test('P1: a non-https garment image is refused', async () => {
  for (const imageUrl of [
    'http://cdn.example.com/coat.jpg',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    '',
  ]) {
    const response = await handleVtoRequest(
      post(requestBody({ garment: garment({ imageUrl }) })),
      deps(),
    );
    assertEquals(await failureCode(response), 'invalid_garment_input', imageUrl);
  }
});

Deno.test('P1: a missing product reference is refused', async () => {
  const response = await handleVtoRequest(
    post(requestBody({ garment: garment({ productRef: '   ' }) })),
    deps(),
  );
  assertEquals(await failureCode(response), 'invalid_garment_input');
});

Deno.test('P1: an arbitrary remote person reference is not a person input', async () => {
  // The contract accepts an inline sanitized derivative only. A URL is not
  // one, so the server cannot be pointed at somebody else's media.
  for (const dataUri of [
    'https://cdn.example.com/someone-else.jpg',
    'file:///var/mobile/photo.jpg',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/gif;base64,R0lGOD',
  ]) {
    const response = await handleVtoRequest(
      post(requestBody({ person: { dataUri } })),
      deps(),
    );
    assertEquals(await failureCode(response), 'invalid_person_input', dataUri);
  }
});

Deno.test('P1: an oversized person payload is rejected', async () => {
  const response = await handleVtoRequest(
    post(requestBody({ person: { dataUri: `data:image/jpeg;base64,${'A'.repeat(2_100_000)}` } })),
    deps(),
  );
  assertEquals(await failureCode(response), 'invalid_person_input');
});

Deno.test('P1: a provider timeout is reported as provider_timeout', async () => {
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({
      generationTimeoutMs: 25,
      resolveVtoProvider: () => ({
        ok: true as const,
        provider: createMockVtoProvider({ scenario: 'timeout', latencyMs: 0 }),
      }),
    }),
  );
  assertEquals(response.status, 504);
  assertEquals(await failureCode(response), 'provider_timeout');
});

Deno.test('P1: every mock failure scenario maps into the K Scan taxonomy', async () => {
  const expected: Record<string, string> = {
    rejected_input: 'provider_rejected_input',
    provider_unavailable: 'provider_unavailable',
    moderation: 'provider_moderation',
    rate_limited: 'rate_limited',
    invalid_output: 'invalid_output',
  };
  for (const [scenario, code] of Object.entries(expected)) {
    const response = await handleVtoRequest(
      post(requestBody()),
      deps({
        resolveVtoProvider: () => ({
          ok: true as const,
          provider: createMockVtoProvider({
            scenario: scenario as never,
            latencyMs: 0,
          }),
        }),
      }),
    );
    assertEquals(await failureCode(response), code, scenario);
  }
});

Deno.test('P1: a corrupt provider output is not passed off as a result', async () => {
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({
      resolveVtoProvider: () => ({
        ok: true as const,
        provider: createMockVtoProvider({ scenario: 'invalid_output', latencyMs: 0 }),
      }),
    }),
  );
  assertEquals(await failureCode(response), 'invalid_output');
  const body = await handleVtoRequest(
    post(requestBody()),
    deps({
      resolveVtoProvider: () => ({
        ok: true as const,
        provider: createMockVtoProvider({ scenario: 'invalid_output', latencyMs: 0 }),
      }),
    }),
  ).then((r) => r.json());
  assertEquals(body.result, undefined);
});

Deno.test('P1: an unknown provider id fails visibly instead of falling back to the mock', async () => {
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({
      readVtoFeatureConfig: () =>
        Promise.resolve({ ...ENABLED_CONFIG, provider: 'some-real-vendor' }),
      // The REAL registry, so this asserts its refusal rather than a stub's.
      resolveVtoProvider,
    }),
  );
  assertEquals(response.status, 503);
  assertEquals(await failureCode(response), 'provider_unavailable');
});

// ── Security negative cases ───────────────────────────────────────────────────

Deno.test('security: the client cannot override the provider or its endpoint', async () => {
  const selections: string[] = [];
  const response = await handleVtoRequest(
    post(
      requestBody({
        provider: 'attacker-provider',
        providerId: 'attacker-provider',
        endpoint: 'https://attacker.example.com/generate',
        apiKey: 'sk-should-never-be-used',
        RAPIDAPI_KEY: 'nope',
      }),
    ),
    deps({
      resolveVtoProvider: (selection) => {
        selections.push(selection.providerId);
        return {
          ok: true as const,
          provider: createMockVtoProvider({ scenario: 'success', latencyMs: 0 }),
        };
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(selections, ['mock']);
});

Deno.test('security: a dev scenario in the body is ignored unless the deployment opted in', async () => {
  const scenarios: Array<string | undefined> = [];
  const capture = (selection: { scenario?: string }) => {
    scenarios.push(selection.scenario);
    return {
      ok: true as const,
      provider: createMockVtoProvider({ scenario: 'success', latencyMs: 0 }),
    };
  };

  await handleVtoRequest(
    post(requestBody({ devScenario: 'provider_unavailable' })),
    deps({ devScenariosAllowed: () => false, resolveVtoProvider: capture }),
  );
  assertEquals(scenarios[0], 'success', 'closed deployment must use the configured scenario');

  await handleVtoRequest(
    post(requestBody({ devScenario: 'provider_unavailable' })),
    deps({ devScenariosAllowed: () => true, resolveVtoProvider: capture }),
  );
  assertEquals(scenarios[1], 'provider_unavailable');
});

Deno.test('security: a provider detail never reaches the response body', async () => {
  const response = await handleVtoRequest(
    post(requestBody()),
    deps({
      resolveVtoProvider: () => ({
        ok: true as const,
        provider: {
          id: 'mock',
          generate: () =>
            Promise.resolve({
              ok: false as const,
              failure: 'generation_failed' as const,
              detail: 'UPSTREAM SAID: account sk-live-1234 quota exceeded',
            }),
        },
      }),
    }),
  );
  const text = await response.text();
  assert(!text.includes('sk-live-1234'));
  assert(!text.includes('UPSTREAM'));
  assertEquals(JSON.parse(text).error.code, 'generation_failed');
});

Deno.test('security: a malformed body cannot bypass the authority chain', async () => {
  const broken = new Request('https://edge.local/vto-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  const response = await handleVtoRequest(
    broken,
    deps({ requireUser: () => Promise.reject(new Response('no', { status: 401 })) }),
  );
  assertEquals(await failureCode(response), 'authorization_failed');
});

Deno.test('security: a non-POST request is refused and its body is still drained', async () => {
  // Responding without consuming a streamed body is what produced the 160s
  // hang / 503 in this project's other Edge Functions.
  const req = new Request('https://edge.local/vto-generate', {
    method: 'GET',
  });
  const response = await handleVtoRequest(req, deps());
  assertEquals(response.status, 405);
  assertEquals(req.bodyUsed || req.body === null, true);
});

Deno.test('security: every early-return path has already consumed the request body', async () => {
  const cases: Array<[string, Partial<VtoHandlerDeps>]> = [
    ['authenticate', { requireUser: () => Promise.reject(new Response('no', { status: 401 })) }],
    ['account_guard', { assertAccountActive: () => Promise.reject(new Response('no', { status: 403 })) }],
    ['feature', { readVtoFeatureConfig: () => Promise.resolve({ ...ENABLED_CONFIG, enabled: false }) }],
    ['entitlement', { resolveVtoEntitlement: () => Promise.resolve({ state: 'denied' as const }) }],
  ];
  for (const [label, overrides] of cases) {
    const req = post(requestBody());
    await handleVtoRequest(req, deps(overrides));
    assertEquals(req.bodyUsed, true, label);
  }
});

// ── Response hygiene ─────────────────────────────────────────────────────────

Deno.test('the success envelope carries no fit, size, or body claim', async () => {
  const response = await handleVtoRequest(post(requestBody()), deps());
  const text = await response.text();
  for (const forbidden of ['size', 'fit', 'measurement', 'bmi', 'bodyFat', 'weight']) {
    assert(
      !text.toLowerCase().includes(forbidden.toLowerCase()),
      `response must not mention ${forbidden}`,
    );
  }
});

Deno.test('the request id is echoed but is never trusted as an identifier', async () => {
  const response = await handleVtoRequest(
    post(requestBody({ requestId: 'a'.repeat(400) })),
    deps(),
  );
  const body = await response.json();
  // An over-long or malformed label is replaced, not echoed.
  assertEquals(body.requestId, 'unlabelled');
});
