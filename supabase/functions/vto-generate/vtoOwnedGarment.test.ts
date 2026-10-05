import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveOwnedVtoGarment } from './vtoOwnedGarment.ts';
import { handleVtoRequest, type VtoHandlerDeps } from './vtoHandler.ts';
import { createMockVtoProvider } from './providers/mockProvider.ts';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const path = `${A}/closet/${ITEM}-primary.jpg`;
function row(overrides: Record<string, unknown> = {}) {
  return { id: ITEM, user_id: A, category: 'tops', clothing_type: 'shirt', subtype: 'blouse',
    storage_bucket: 'style-library-images', storage_path: path, media_status: 'ready', deleted_at: null, ...overrides };
}

for (const [name, value] of [
  ['foreign actor', row({ user_id: B })], ['foreign item', row({ id: B })],
  ['deleted', row({ deleted_at: '2026-10-05' })], ['missing media', row({ media_status: null })],
  ['pending media', row({ media_status: 'pending' })], ['arbitrary bucket', row({ storage_bucket: 'avatars' })],
  ['arbitrary path', row({ storage_path: `${A}/arbitrary.jpg` })], ['foreign primary path', row({ storage_path: `${B}/closet/${ITEM}-primary.jpg` })],
]) {
  Deno.test(`owned resolver denies ${name} before signing`, async () => {
    let signs = 0;
    const result = await resolveOwnedVtoGarment(A, ITEM, {
      rest: async query => { assert(query.includes(`user_id=eq.${A}`)); assert(query.includes('deleted_at=is.null')); return new Response(JSON.stringify([value])); },
      sign: async () => { signs++; return 'https://storage.example.com/garment.jpg'; },
    });
    assertEquals(result, { ok: false, code: 'invalid_garment_input' }); assertEquals(signs, 0);
  });
}
Deno.test('owned resolver handles absent row, invalid ID and unavailable storage safely', async () => {
  assertEquals(await resolveOwnedVtoGarment(A, 'not-a-uuid'), { ok: false, code: 'invalid_garment_input' });
  assertEquals(await resolveOwnedVtoGarment(A, ITEM, { rest: async () => new Response('[]') }), { ok: false, code: 'invalid_garment_input' });
  assertEquals(await resolveOwnedVtoGarment(A, ITEM, { rest: async () => new Response('private diagnostic', { status: 503 }) }), { ok: false, code: 'provider_unavailable' });
  assertEquals(await resolveOwnedVtoGarment(A, ITEM, { rest: async () => new Response(JSON.stringify([row()])), sign: async () => null }), { ok: false, code: 'invalid_garment_input' });
});

Deno.test('real owned signer scopes a short-lived URL to the derived private primary; refuses a foreign signed path', async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get('SUPABASE_URL');
  const originalKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  Deno.env.set('SUPABASE_URL', 'https://storage.example.com');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key');
  const encoded = `style-library-images/${path}`; let foreign = false;
  try {
    globalThis.fetch = async (input, init) => {
      assertEquals(input, `https://storage.example.com/storage/v1/object/sign/${encoded}`);
      assertEquals(init?.method, 'POST'); assertEquals(JSON.parse(String(init?.body)), { expiresIn: 120 });
      return new Response(JSON.stringify({ signedURL: foreign ? '/object/sign/foreign.jpg?token=fake' : `/object/sign/${encoded}?token=fixture` }));
    };
    const deps = { rest: async () => new Response(JSON.stringify([row()])) };
    const resolved = await resolveOwnedVtoGarment(A, ITEM, deps);
    assert(resolved.ok);
    assertEquals(resolved.garment.imageUrl, `https://storage.example.com/storage/v1/object/sign/${encoded}?token=fixture`);
    foreign = true;
    assertEquals(await resolveOwnedVtoGarment(A, ITEM, deps), { ok: false, code: 'invalid_garment_input' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete('SUPABASE_URL'); else Deno.env.set('SUPABASE_URL', originalBase);
    if (originalKey === undefined) Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY'); else Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', originalKey);
  }
});

function request(extra: Record<string, unknown> = {}): Request {
  return new Request('https://edge.local/vto-generate', { method: 'POST', body: JSON.stringify({
    requestId: 'owned_1', requestGeneration: 'intent_1', origin: 'closet_item',
    person: { dataUri: `data:image/jpeg;base64,${'A'.repeat(2048)}` },
    garment: { source: { type: 'closet_item', closetItemId: ITEM },
      imageUrl: 'https://attacker.example.com/forged.jpg', category: 'dress', user_id: B }, ...extra,
  }) });
}
function harness(options: { actor?: string; row?: Record<string, unknown>; entitlement?: 'active' | 'denied' } = {}) {
  const keys = new Set<string>(); const providerInputs: unknown[] = []; let signCount = 0; let reservations = 0;
  const mock = createMockVtoProvider({ latencyMs: 0 });
  const deps: Partial<VtoHandlerDeps> = {
    requireUser: async () => ({ id: options.actor ?? A, accessToken: 'fixture', isAnonymous: false }),
    assertAccountActive: async () => {},
    readVtoFeatureConfig: async () => ({ enabled: true, provider: 'mock', supportedCategories: ['top','outerwear','blazer','dress'], mockLatencyMs: 0, mockScenario: 'success' }),
    resolveVtoEntitlement: async () => ({ state: options.entitlement ?? 'active' }),
    resolveOwnedVtoGarment: (actor, item) => resolveOwnedVtoGarment(actor, item, {
      rest: async () => new Response(JSON.stringify([options.row ?? row()])),
      sign: async (bucket, mediaPath) => {
        assertEquals(bucket, 'style-library-images'); assertEquals(mediaPath, path);
        return `https://storage.example.com/primary.jpg?token=rotating_${++signCount}`;
      },
    }),
    resolveVtoProvider: () => ({ ok: true, provider: { id: mock.id, generate: (input, opts) => { providerInputs.push(input); return mock.generate(input, opts); } } }),
    reserveVtoGeneration: async (_actor, key) => {
      reservations++;
      if (keys.has(key)) return { outcome: 'duplicate', used: keys.size, dailyLimit: 10, priorStatus: 'succeeded' };
      keys.add(key); return { outcome: 'reserved', used: keys.size, dailyLimit: 10 };
    },
    completeVtoGeneration: async () => {}, releaseVtoGeneration: async () => {}, devScenariosAllowed: () => false,
  };
  return { deps, keys, providerInputs, get reservations() { return reservations; }, get signs() { return signCount; } };
}

Deno.test('owned Closet→handler→provider uses canonical media/category and echoes exact source', async () => {
  const h = harness(); const response = await handleVtoRequest(request(), h.deps);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.requestId, 'owned_1'); assertEquals(body.garmentSource, { type: 'closet_item', closetItemId: ITEM });
  const input = h.providerInputs[0] as { garmentImageUrl: string; canonicalCategory: string };
  assert(input.garmentImageUrl.includes('storage.example.com')); assert(!input.garmentImageUrl.includes('attacker'));
  assertEquals(input.canonicalCategory, 'top');
  assert(!JSON.stringify(body).includes('rotating_')); assert(!JSON.stringify(body).includes(path));
});
Deno.test('owned duplicate suppresses second paid job even when signed URL rotates; explicit retry is new intent', async () => {
  const h = harness();
  assertEquals((await handleVtoRequest(request(), h.deps)).status, 200);
  const duplicate = await handleVtoRequest(request({ requestId: 'owned_2' }), h.deps);
  assertEquals(duplicate.status, 429); assertEquals((await duplicate.json()).error.code, 'request_in_flight');
  assertEquals(h.providerInputs.length, 1); assertEquals(h.keys.size, 1);
  assertEquals((await handleVtoRequest(request({ requestGeneration: 'intent_2' }), h.deps)).status, 200);
  assertEquals(h.providerInputs.length, 2); assertEquals(h.keys.size, 2);
});
for (const [name, options, code] of [
  ['cross-actor', { actor: B }, 'invalid_garment_input'],
  ['unsupported category', { row: row({ category: 'footwear', clothing_type: 'shoes', subtype: 'sneakers' }) }, 'unsupported_category'],
  ['missing media', { row: row({ media_status: 'pending' }) }, 'invalid_garment_input'],
  ['canonical K+ absent', { entitlement: 'denied' as const }, 'entitlement_required'],
] as const) {
  Deno.test(`owned ${name} denied without provider spend or quota`, async () => {
    const h = harness(options); const response = await handleVtoRequest(request(), h.deps);
    assertEquals((await response.json()).error.code, code);
    assertEquals(h.providerInputs.length, 0); assertEquals(h.reservations, 0);
  });
}
Deno.test('owned source cannot fall back to commerce or choose a storage path', async () => {
  const h = harness();
  for (const garment of [ {}, { source: { type: 'unknown' } }, { source: { type: 'closet_item', closetItemId: 'bad-id', path } } ]) {
    const response = await handleVtoRequest(request({ garment }), h.deps);
    assertEquals(response.status, 422);
  }
  assertEquals(h.providerInputs.length, 0);
});
