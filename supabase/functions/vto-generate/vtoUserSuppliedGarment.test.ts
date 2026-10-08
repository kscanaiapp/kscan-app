/**
 * `user_supplied_garment` source -- resolver and orchestrator tests.
 *
 * Same posture as vtoHandler.test.ts: the real resolver and the real handler
 * are CALLED, with only the network/database boundaries injected. The claims
 * here are about what runs and in what order, which a source-text assertion
 * cannot establish.
 *
 * The fixture is a real byte string with a real SHA-256, not a stubbed "valid"
 * flag: the point of the source is that the server recomputes the hash, so a
 * test that faked the hash would prove nothing about it.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { handleVtoRequest, type VtoHandlerDeps } from './vtoHandler.ts';
import { createMockVtoProvider } from './providers/mockProvider.ts';
import {
  VTO_GARMENT_PAYLOAD_MAX_CHARS,
  VTO_INLINE_GARMENT_REQUEST_BODY_MAX_CHARS,
  VTO_REQUEST_BODY_MAX_CHARS,
  type VtoProviderInput,
} from './vtoContract.ts';
import { isUserSuppliedVtoGarmentSource, resolveUserSuppliedVtoGarment } from './vtoUserSuppliedGarment.ts';
import type { VtoFeatureConfig } from './vtoFeatureControl.ts';

const USER_ID = '11111111-2222-4333-8444-555555555555';

const ENABLED_CONFIG: VtoFeatureConfig = {
  enabled: true,
  provider: 'mock',
  supportedCategories: ['top', 'outerwear', 'blazer', 'dress'],
  mockLatencyMs: 0,
  mockScenario: 'success',
};

const PERSON_DATA_URI = `data:image/jpeg;base64,${'A'.repeat(2048)}`;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A deterministic JPEG-shaped byte string: real SOI marker, arbitrary body. */
function jpegBytes(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  for (let i = 4; i < length; i++) bytes[i] = (i * 31 + seed) % 251;
  return bytes;
}

async function suppliedGarment(
  overrides: Record<string, unknown> = {},
  options: { length?: number; seed?: number } = {},
) {
  const base64 = toBase64(jpegBytes(options.length ?? 3000, options.seed ?? 7));
  const contentHash = await sha256Hex(base64);
  return {
    source: { type: 'user_supplied_garment', contentHash, contentHashVersion: 'sha256-normalized-v1' },
    dataUri: `data:image/jpeg;base64,${base64}`,
    category: 'dress',
    ...overrides,
  };
}

function post(body: unknown): Request {
  return new Request('https://edge.local/vto-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

interface Spy {
  providerInputs: VtoProviderInput[];
  reservationKeys: string[];
  resolverCalls: number;
}

function harness(overrides: Partial<VtoHandlerDeps> = {}): { deps: Partial<VtoHandlerDeps>; spy: Spy } {
  const spy: Spy = { providerInputs: [], reservationKeys: [], resolverCalls: 0 };
  const inner = createMockVtoProvider({ scenario: 'success', latencyMs: 0 });
  const deps: Partial<VtoHandlerDeps> = {
    requireUser: () => Promise.resolve({ id: USER_ID, accessToken: 'token', isAnonymous: false }),
    assertAccountActive: () => Promise.resolve(),
    readVtoFeatureConfig: () => Promise.resolve(ENABLED_CONFIG),
    resolveVtoEntitlement: () => Promise.resolve({ state: 'active' as const }),
    resolveUserSuppliedVtoGarment: (garment) => {
      spy.resolverCalls += 1;
      return resolveUserSuppliedVtoGarment(garment);
    },
    resolveVtoProvider: () => ({
      ok: true as const,
      provider: {
        id: inner.id,
        generate(input, options) {
          spy.providerInputs.push(input);
          return inner.generate(input, options);
        },
      },
    }),
    reserveVtoGeneration: (_userId, key) => {
      spy.reservationKeys.push(key);
      return Promise.resolve({ outcome: 'reserved' as const, used: 1, dailyLimit: 10 });
    },
    completeVtoGeneration: () => Promise.resolve(),
    releaseVtoGeneration: () => Promise.resolve(),
    generationTimeoutMs: 1_000,
    devScenariosAllowed: () => false,
    ...overrides,
  };
  return { deps, spy };
}

async function suppliedBody(
  overrides: Record<string, unknown> = {},
  // deno-lint-ignore no-explicit-any
): Promise<Record<string, any>> {
  return {
    requestId: 'vtoreq_1_abc',
    origin: 'elise',
    person: { dataUri: PERSON_DATA_URI },
    garment: await suppliedGarment(),
    requestGeneration: '1',
    ...overrides,
  };
}

async function failureCode(response: Response): Promise<string> {
  const body = await response.json();
  return body?.error?.code ?? '(none)';
}

// ── The resolver ─────────────────────────────────────────────────────────────

Deno.test('resolver: a garment whose recomputed hash matches its fingerprint is accepted', async () => {
  const garment = await suppliedGarment();
  const resolved = await resolveUserSuppliedVtoGarment(garment);
  assert(resolved.ok);
  assertEquals(resolved.garment.productRef, `user_supplied_garment:${garment.source.contentHash}`);
  assertEquals(
    resolved.garment.mediaIdentity,
    `user_supplied_garment/sha256-normalized-v1/${garment.source.contentHash}`,
  );
  assertEquals(resolved.garment.source, garment.source);
  assertEquals(resolved.garment.garmentDataUri, garment.dataUri);
  assertEquals(resolved.garment.category, 'dress');
});

Deno.test('resolver: a fingerprint that does not match the bytes is refused', async () => {
  const garment = await suppliedGarment();
  const other = await suppliedGarment({}, { seed: 99 });
  const resolved = await resolveUserSuppliedVtoGarment({ ...garment, source: other.source });
  assert(!resolved.ok);
  assertEquals(resolved.detail, 'garment_hash_mismatch');
});

Deno.test('resolver: an unknown hash version or a malformed hash is refused', async () => {
  const garment = await suppliedGarment();
  const wrongVersion = await resolveUserSuppliedVtoGarment({
    ...garment,
    source: { ...garment.source, contentHashVersion: 'sha256-raw-v9' },
  });
  assert(!wrongVersion.ok);
  assertEquals(wrongVersion.detail, 'garment_hash_version');

  for (const contentHash of ['', 'abc', garment.source.contentHash.toUpperCase(), 42, null]) {
    const resolved = await resolveUserSuppliedVtoGarment({
      ...garment,
      source: { ...garment.source, contentHash },
    });
    assert(!resolved.ok);
    assertEquals(resolved.detail, 'garment_hash_shape');
  }
});

Deno.test('resolver: only the approved inline media type is accepted', async () => {
  const garment = await suppliedGarment();
  for (const mediaType of ['image/png', 'image/webp', 'image/gif', 'text/html', 'image/svg+xml']) {
    const resolved = await resolveUserSuppliedVtoGarment({
      ...garment,
      dataUri: garment.dataUri.replace('image/jpeg', mediaType),
    });
    assert(!resolved.ok);
    assertEquals(resolved.detail, 'garment_media_type');
  }
});

Deno.test('resolver: a URL, a file reference or a missing payload is never a garment', async () => {
  const garment = await suppliedGarment();
  for (const dataUri of [
    'https://cdn.example.com/dress.jpg',
    'file:///data/user/0/kscan/candidate.jpg',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    const resolved = await resolveUserSuppliedVtoGarment({ ...garment, dataUri });
    assert(!resolved.ok);
    assertEquals(resolved.detail, 'garment_media_type');
  }
  for (const dataUri of [undefined, null, '', 12]) {
    const resolved = await resolveUserSuppliedVtoGarment({ ...garment, dataUri });
    assert(!resolved.ok);
    assertEquals(resolved.detail, 'garment_media_missing');
  }
});

Deno.test('resolver: bytes that are not a JPEG are refused even with a correct hash', async () => {
  const bytes = new Uint8Array(3000).fill(0x41);
  const base64 = toBase64(bytes);
  const resolved = await resolveUserSuppliedVtoGarment({
    source: {
      type: 'user_supplied_garment',
      contentHash: await sha256Hex(base64),
      contentHashVersion: 'sha256-normalized-v1',
    },
    dataUri: `data:image/jpeg;base64,${base64}`,
    category: 'dress',
  });
  assert(!resolved.ok);
  assertEquals(resolved.detail, 'garment_media_not_jpeg');
});

Deno.test('resolver: the garment payload bound is enforced before any decode', async () => {
  const garment = await suppliedGarment();
  const oversized = `data:image/jpeg;base64,${'A'.repeat(VTO_GARMENT_PAYLOAD_MAX_CHARS)}`;
  assert(oversized.length > VTO_GARMENT_PAYLOAD_MAX_CHARS);
  const resolved = await resolveUserSuppliedVtoGarment({ ...garment, dataUri: oversized });
  assert(!resolved.ok);
  assertEquals(resolved.detail, 'garment_media_too_large');
});

Deno.test('resolver: a truncated or malformed encoding is refused', async () => {
  const garment = await suppliedGarment();
  const tiny = toBase64(jpegBytes(64));
  const tinyResolved = await resolveUserSuppliedVtoGarment({
    source: {
      type: 'user_supplied_garment',
      contentHash: await sha256Hex(tiny),
      contentHashVersion: 'sha256-normalized-v1',
    },
    dataUri: `data:image/jpeg;base64,${tiny}`,
    category: 'dress',
  });
  assert(!tinyResolved.ok);
  assertEquals(tinyResolved.detail, 'garment_media_too_small');

  for (const suffix of ['!', ' ', '\n', '=A']) {
    const resolved = await resolveUserSuppliedVtoGarment({
      ...garment,
      dataUri: `${garment.dataUri}${suffix}`,
    });
    assert(!resolved.ok);
    assertEquals(resolved.detail, 'garment_media_encoding');
  }
});

Deno.test('resolver: a non-canonical encoding of the same bytes has no second identity', async () => {
  // 3001 bytes leaves one trailing byte, so the final sextet carries four
  // unused bits. Flipping one of them decodes to the SAME bytes from a
  // DIFFERENT string -- which is exactly the second request body the
  // fingerprint must not be satisfiable by.
  const canonical = toBase64(jpegBytes(3001));
  assert(canonical.endsWith('=='));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = canonical[canonical.length - 3];
  const twisted = `${canonical.slice(0, -3)}${alphabet[alphabet.indexOf(last) + 1]}==`;
  assert(twisted !== canonical);
  assertEquals(atob(twisted), atob(canonical));

  for (const hashOf of [canonical, twisted]) {
    const resolved = await resolveUserSuppliedVtoGarment({
      source: {
        type: 'user_supplied_garment',
        contentHash: await sha256Hex(hashOf),
        contentHashVersion: 'sha256-normalized-v1',
      },
      dataUri: `data:image/jpeg;base64,${twisted}`,
      category: 'dress',
    });
    assert(!resolved.ok);
    assertEquals(resolved.detail, 'garment_media_noncanonical');
  }
});

Deno.test('resolver: caller-supplied identity fields are never consumed', async () => {
  const garment = await suppliedGarment({
    productRef: 'closet_item:99999999-8888-4777-8666-555555555555',
    imageUrl: 'https://attacker.example/steal.jpg',
    candidateId: 'cand_local_123',
    userId: '99999999-8888-4777-8666-555555555555',
    provider: 'mock',
    mediaIdentity: 'style-library-images/someone/else.jpg',
  });
  const resolved = await resolveUserSuppliedVtoGarment(garment);
  assert(resolved.ok);
  assertEquals(resolved.garment.productRef, `user_supplied_garment:${garment.source.contentHash}`);
  assertEquals(Object.keys(resolved.garment).sort(), [
    'category', 'garmentDataUri', 'mediaIdentity', 'productRef', 'source',
  ]);
  assertEquals(Object.keys(resolved.garment.source).sort(), [
    'contentHash', 'contentHashVersion', 'type',
  ]);
});

Deno.test('resolver: only the exact source type selects this branch', () => {
  assert(isUserSuppliedVtoGarmentSource({ type: 'user_supplied_garment' }));
  for (const value of [
    null, undefined, 'user_supplied_garment', [], { type: 'closet_item' }, { type: 'closet_candidate' },
    { type: 'USER_SUPPLIED_GARMENT' }, [{ type: 'user_supplied_garment' }],
  ]) {
    assert(!isUserSuppliedVtoGarmentSource(value));
  }
});

// ── The orchestrator ─────────────────────────────────────────────────────────

Deno.test('P0: a user-supplied garment generates through the existing pipeline, inline', async () => {
  const { deps, spy } = harness();
  const body = await suppliedBody();
  const response = await handleVtoRequest(post(body), deps);
  assertEquals(response.status, 200);
  const json = await response.json();
  assertEquals(json.status, 'success');
  assertEquals(json.result.isAiVisualization, true);
  // The source is echoed so the client can bind the result to what it asked for.
  assertEquals(json.garmentSource, body.garment.source);

  assertEquals(spy.providerInputs.length, 1);
  const input = spy.providerInputs[0];
  assertEquals(input.garmentDataUri, body.garment.dataUri);
  // No URL exists for an inline garment, so nothing is fetchable.
  assertEquals(input.garmentImageUrl, '');
  assertEquals(input.canonicalCategory, 'dress');
  assertEquals(input.slot, 'full_body');
  assertEquals(spy.reservationKeys.length, 1);
});

const EVERY_ORIGIN = [
  'elise', 'commerce_product', 'closet_item', 'scan_result', 'dressing_room', 'dev_harness', 'nonsense', undefined,
];

Deno.test('P0: origin is bounded metadata -- it does not refuse a user-supplied garment', async () => {
  for (const origin of EVERY_ORIGIN) {
    const { deps, spy } = harness();
    const body = await suppliedBody({ origin });
    const response = await handleVtoRequest(post(body), deps);
    assertEquals(response.status, 200, `origin ${origin}`);
    const json = await response.json();
    assertEquals(json.garmentSource, body.garment.source, `origin ${origin}`);
    // Validated exactly the same way, whatever label the client chose.
    assertEquals(spy.resolverCalls, 1, `origin ${origin}`);
    assertEquals(spy.providerInputs.length, 1, `origin ${origin}`);
    assertEquals(spy.providerInputs[0].garmentDataUri, body.garment.dataUri, `origin ${origin}`);
    assertEquals(spy.providerInputs[0].garmentImageUrl, '', `origin ${origin}`);
  }
});

Deno.test('P0: origin grants nothing -- no label gets past K+, the kill switch, the hash or the bound', async () => {
  for (const origin of EVERY_ORIGIN) {
    const noKPlus = harness({ resolveVtoEntitlement: () => Promise.resolve({ state: 'denied' as const }) });
    const denied = await handleVtoRequest(post(await suppliedBody({ origin })), noKPlus.deps);
    assertEquals(denied.status, 403, `origin ${origin}`);
    assertEquals(await failureCode(denied), 'entitlement_required', `origin ${origin}`);
    assertEquals(noKPlus.spy.providerInputs.length, 0, `origin ${origin}`);

    const disabled = harness({
      readVtoFeatureConfig: () => Promise.resolve({ ...ENABLED_CONFIG, enabled: false }),
    });
    const off = await handleVtoRequest(post(await suppliedBody({ origin })), disabled.deps);
    assertEquals(await failureCode(off), 'feature_disabled', `origin ${origin}`);
    assertEquals(disabled.spy.providerInputs.length, 0, `origin ${origin}`);

    const mismatch = harness();
    const body = await suppliedBody({ origin });
    body.garment = { ...body.garment, source: (await suppliedGarment({}, { seed: 21 })).source };
    const refused = await handleVtoRequest(post(body), mismatch.deps);
    assertEquals(refused.status, 422, `origin ${origin}`);
    assertEquals(await failureCode(refused), 'invalid_garment_input', `origin ${origin}`);
    assertEquals(mismatch.spy.reservationKeys.length, 0, `origin ${origin}`);
    assertEquals(mismatch.spy.providerInputs.length, 0, `origin ${origin}`);

    const unsupported = harness();
    const shoes = await suppliedBody({ origin });
    shoes.garment = { ...shoes.garment, category: 'sneakers' };
    assertEquals(
      await failureCode(await handleVtoRequest(post(shoes), unsupported.deps)),
      'unsupported_category',
      `origin ${origin}`,
    );
    assertEquals(unsupported.spy.providerInputs.length, 0, `origin ${origin}`);
  }
});

Deno.test('P0: a fingerprint mismatch reaches no reservation and no provider', async () => {
  const { deps, spy } = harness();
  const other = await suppliedGarment({}, { seed: 3 });
  const body = await suppliedBody();
  body.garment = { ...body.garment, source: other.source };
  const response = await handleVtoRequest(post(body), deps);
  assertEquals(response.status, 422);
  assertEquals(await failureCode(response), 'invalid_garment_input');
  assertEquals(spy.reservationKeys.length, 0);
  assertEquals(spy.providerInputs.length, 0);
});

Deno.test('P0: authentication, account, kill switch and K+ all run before the garment is examined', async () => {
  const denials: Array<[string, Partial<VtoHandlerDeps>, number, string]> = [
    ['unauthenticated', { requireUser: () => Promise.reject(new Response('no', { status: 401 })) }, 401, 'authorization_failed'],
    ['inactive account', { assertAccountActive: () => Promise.reject(new Error('locked')) }, 401, 'authorization_failed'],
    ['feature disabled', { readVtoFeatureConfig: () => Promise.resolve({ ...ENABLED_CONFIG, enabled: false }) }, 403, 'feature_disabled'],
    ['no K+', { resolveVtoEntitlement: () => Promise.resolve({ state: 'denied' as const }) }, 403, 'entitlement_required'],
    ['K+ unreadable', { resolveVtoEntitlement: () => Promise.resolve({ state: 'unknown' as const }) }, 401, 'authorization_failed'],
  ];
  for (const [label, override, status, code] of denials) {
    const { deps, spy } = harness(override);
    const response = await handleVtoRequest(post(await suppliedBody()), deps);
    assertEquals(response.status, status, label);
    assertEquals(await failureCode(response), code, label);
    assertEquals(spy.resolverCalls, 0, `${label}: the garment must not be decoded`);
    assertEquals(spy.reservationKeys.length, 0, label);
    assertEquals(spy.providerInputs.length, 0, label);
  }
});

Deno.test('P0: the existing category authority and allowlist decide an Elise upload too', async () => {
  const cases: Array<[string, number, string]> = [
    ['dress', 200, '(none)'],
    ['Wool Coat', 200, '(none)'],
    ['blazer', 200, '(none)'],
    // Recognised garments the allowlist has not enabled.
    ['jeans', 422, 'unsupported_category'],
    // Not garments VTO can visualize at all.
    ['sneakers', 422, 'unsupported_category'],
    ['handbag', 422, 'unsupported_category'],
    ['', 422, 'unsupported_category'],
  ];
  for (const [category, status, code] of cases) {
    const { deps, spy } = harness();
    const body = await suppliedBody();
    body.garment = { ...body.garment, category };
    const response = await handleVtoRequest(post(body), deps);
    assertEquals(response.status, status, category);
    assertEquals(await failureCode(response), code, category);
    assertEquals(spy.providerInputs.length, status === 200 ? 1 : 0, category);
  }

  // A narrowed remote allowlist is honoured exactly as for a product.
  const { deps, spy } = harness({
    readVtoFeatureConfig: () => Promise.resolve({ ...ENABLED_CONFIG, supportedCategories: ['top'] }),
  });
  const response = await handleVtoRequest(post(await suppliedBody()), deps);
  assertEquals(await failureCode(response), 'unsupported_category');
  assertEquals(spy.providerInputs.length, 0);
});

Deno.test('P0: K+ is re-read at the paid boundary for an Elise upload', async () => {
  let reads = 0;
  const { deps, spy } = harness({
    resolveVtoEntitlement: () => {
      reads += 1;
      return Promise.resolve(reads === 1 ? { state: 'active' as const } : { state: 'denied' as const });
    },
  });
  const response = await handleVtoRequest(post(await suppliedBody()), deps);
  assertEquals(response.status, 403);
  assertEquals(await failureCode(response), 'entitlement_required');
  assertEquals(reads, 2);
  assertEquals(spy.reservationKeys.length, 0);
  assertEquals(spy.providerInputs.length, 0);
});

Deno.test('P0: the reservation identity is the CONTENT, not a device id or the bytes', async () => {
  const { deps, spy } = harness();
  const first = await suppliedBody();
  const sameContentOtherCandidate = await suppliedBody();
  sameContentOtherCandidate.garment = { ...sameContentOtherCandidate.garment, candidateId: 'cand_other' };
  const otherContent = await suppliedBody();
  otherContent.garment = await suppliedGarment({}, { seed: 11 });
  const explicitRetry = await suppliedBody({ requestGeneration: '2' });

  for (const body of [first, sameContentOtherCandidate, otherContent, explicitRetry]) {
    const response = await handleVtoRequest(post(body), deps);
    assertEquals(response.status, 200);
  }
  const [a, b, c, d] = spy.reservationKeys;
  assertEquals(a, b, 'two taps of one intent collapse to one paid job');
  assert(a !== c, 'a different garment is a different job');
  assert(a !== d, 'an explicit Retry is a new, separately counted intent');
  for (const key of spy.reservationKeys) {
    assert(/^[0-9a-f]{64}$/.test(key));
  }
});

Deno.test('P0: quota, duplicate and unavailable reservations stop an Elise upload unchanged', async () => {
  const outcomes: Array<[Record<string, unknown>, number, string]> = [
    [{ outcome: 'quota_exceeded', used: 10, dailyLimit: 10 }, 429, 'quota_exhausted'],
    [{ outcome: 'duplicate', used: 1, dailyLimit: 10, priorStatus: 'reserved' }, 429, 'request_in_flight'],
    [{ outcome: 'unavailable' }, 401, 'authorization_failed'],
  ];
  for (const [outcome, status, code] of outcomes) {
    const { deps, spy } = harness({
      // deno-lint-ignore no-explicit-any
      reserveVtoGeneration: () => Promise.resolve(outcome as any),
    });
    const response = await handleVtoRequest(post(await suppliedBody()), deps);
    assertEquals(response.status, status);
    assertEquals(await failureCode(response), code);
    assertEquals(spy.providerInputs.length, 0);
  }
});

Deno.test('P0: an inline garment cannot be smuggled onto another source', async () => {
  // A commerce garment that ALSO carries a dataUri: the URL rules still apply
  // and the inline payload is never read.
  const elise = await suppliedGarment();
  const { deps, spy } = harness();
  const response = await handleVtoRequest(
    post({
      requestId: 'vtoreq_1_abc',
      origin: 'elise',
      person: { dataUri: PERSON_DATA_URI },
      garment: {
        productRef: 'prod_1',
        imageUrl: 'https://cdn.example.com/coat.jpg',
        category: 'wool coat',
        dataUri: elise.dataUri,
      },
    }),
    deps,
  );
  assertEquals(response.status, 200);
  assertEquals(spy.resolverCalls, 0);
  assertEquals(spy.providerInputs[0].garmentDataUri, undefined);
  assertEquals(spy.providerInputs[0].garmentImageUrl, 'https://cdn.example.com/coat.jpg');

  // And the device-local candidate is not a server-resolvable source.
  const candidate = harness();
  const refused = await handleVtoRequest(
    post({
      requestId: 'vtoreq_1_abc',
      origin: 'elise',
      person: { dataUri: PERSON_DATA_URI },
      garment: { source: { type: 'closet_candidate', candidateId: 'cand_local_123' }, dataUri: elise.dataUri },
    }),
    candidate.deps,
  );
  assertEquals(refused.status, 422);
  assertEquals(await failureCode(refused), 'invalid_garment_input');
  assertEquals(candidate.spy.providerInputs.length, 0);
});

Deno.test('body size: the larger ceiling belongs to the inline source alone', async () => {
  // Over the pre-existing ceiling, under the absolute one, and NOT an Elise
  // upload: refused exactly as it always was.
  const padding = 'x'.repeat(VTO_REQUEST_BODY_MAX_CHARS);
  const legacy = harness();
  const legacyResponse = await handleVtoRequest(
    post({
      requestId: 'vtoreq_1_abc',
      origin: 'commerce_product',
      person: { dataUri: PERSON_DATA_URI },
      garment: { productRef: 'prod_1', imageUrl: 'https://cdn.example.com/coat.jpg', category: 'coat' },
      padding,
    }),
    legacy.deps,
  );
  assertEquals(legacyResponse.status, 422);
  assertEquals(await failureCode(legacyResponse), 'invalid_person_input');
  assertEquals(legacy.spy.providerInputs.length, 0);

  // The same body size IS admitted past the size gate when it names the inline
  // source -- and is then judged on its garment, which here is over ITS bound.
  const elise = harness();
  const body = await suppliedBody();
  body.garment = {
    ...body.garment,
    dataUri: `data:image/jpeg;base64,${'A'.repeat(VTO_GARMENT_PAYLOAD_MAX_CHARS)}`,
  };
  const eliseResponse = await handleVtoRequest(post(body), elise.deps);
  assertEquals(eliseResponse.status, 422);
  assertEquals(await failureCode(eliseResponse), 'invalid_garment_input');
  assertEquals(elise.spy.resolverCalls, 1);
  assertEquals(elise.spy.providerInputs.length, 0);

  // Nothing at all gets past the absolute ceiling, whatever it names.
  const absolute = harness();
  const huge = await suppliedBody({ padding: 'x'.repeat(VTO_INLINE_GARMENT_REQUEST_BODY_MAX_CHARS) });
  const absoluteResponse = await handleVtoRequest(post(huge), absolute.deps);
  assertEquals(absoluteResponse.status, 422);
  assertEquals(await failureCode(absoluteResponse), 'invalid_person_input');
  assertEquals(absolute.spy.resolverCalls, 0);
});

Deno.test('privacy: neither the garment bytes nor its hash are ever logged', async () => {
  const lines: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  let body;
  try {
    body = await suppliedBody();
    const ok = harness();
    assertEquals((await handleVtoRequest(post(body), ok.deps)).status, 200);

    const mismatch = await suppliedBody();
    mismatch.garment = { ...mismatch.garment, source: (await suppliedGarment({}, { seed: 5 })).source };
    assertEquals((await handleVtoRequest(post(mismatch), harness().deps)).status, 422);
  } finally {
    Object.assign(console, original);
  }
  const logged = lines.join('\n');
  assert(lines.length > 0, 'the handler does log; the assertion below is not vacuous');
  const payload = body!.garment.dataUri.slice('data:image/jpeg;base64,'.length);
  assert(!logged.includes(payload.slice(0, 64)), 'garment bytes must not be logged');
  assert(!logged.includes(body!.garment.source.contentHash), 'the content hash must not be logged');
  assert(!logged.includes('data:image/'), 'no data URI of any kind is logged');
  assert(logged.includes('garment_hash_mismatch'), 'the refusal is observable by its reason code');
});
