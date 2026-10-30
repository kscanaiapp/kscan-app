import assert from 'node:assert/strict';
import { handleVtoRequest } from '../vtoHandler.ts';
import { createAiLabToolsProvider } from './aiLabToolsProvider.ts';
import { MOCK_VTO_RESULT_BASE64 } from './mockResultAsset.ts';

Deno.test('VTO-REMOTE-HANDLER: invalid garment must not submit or consume a synthetic attempt', async () => {
  let submits = 0, completes = 0, releases = 0;
  const provider = createAiLabToolsProvider({ apiKey: 'OFFLINE-NONSECRET', fetchImpl: async (url, init) => {
    if (url === 'https://cdn.example.com/garment.png') return new Response('<html>not an image</html>', { headers: { 'content-type': 'image/jpeg' } });
    assert.equal(init.method, 'POST');
    assert.equal(url, 'https://try-on-clothes-pro.p.rapidapi.com/portrait/editing/try-on-clothes-pro');
    submits++;
    return new Response(JSON.stringify({ message: 'OFFLINE invalid image rejection' }), { status: 400 });
  } });
  const response = await handleVtoRequest(new Request('https://edge.local/vto-generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'audit_media_1', origin: 'commerce_product', person: { dataUri: `data:image/png;base64,${MOCK_VTO_RESULT_BASE64}` }, garment: { productRef: 'synthetic:garment', imageUrl: 'https://cdn.example.com/garment.png', category: 'outerwear' } }),
  }), {
    requireUser: async () => ({ id: '11111111-2222-4333-8444-555555555555', accessToken: 'OFFLINE', isAnonymous: false }),
    assertAccountActive: async () => {},
    readVtoFeatureConfig: async () => ({ enabled: true, provider: 'ailabtools_tryon_clothes_pro', supportedCategories: ['outerwear'], mockLatencyMs: 0, mockScenario: 'success' }),
    resolveVtoEntitlement: async () => ({ state: 'active' as const }),
    resolveVtoProvider: () => ({ ok: true as const, provider }),
    reserveVtoGeneration: async () => ({ outcome: 'reserved' as const, used: 1, dailyLimit: 10, attemptId: '33333333-4444-4555-8666-777777777777' }),
    completeVtoGeneration: async () => { completes++; return true; },
    releaseVtoGeneration: async () => { releases++; return true; },
    generationTimeoutMs: 1000,
    devScenariosAllowed: () => false,
  });
  const body = await response.json();
  console.log(JSON.stringify({ boundary: 'actual handler/adapter with injected external effects', status: response.status, body, submits, completes, releases, limitation: 'real handler and adapter; mocked provider and quota stores; no live billing or database' }));
  assert.equal(submits, 0, 'Malformed remote image must be denied before provider dispatch');
  assert.equal(completes, 0, 'No paid attempt should be retained for locally rejectable bytes');
  assert.equal(releases, 1);
  assert.equal(body.error.code, 'invalid_garment_input');
});
