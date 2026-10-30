import assert from 'node:assert/strict';
import { createAiLabToolsProvider } from './aiLabToolsProvider.ts';
import { MOCK_VTO_RESULT_BASE64 } from './mockResultAsset.ts';
import { hasRemoteGarmentImageContainer } from './remoteGarmentIntegrity.ts';

// Offline only. Every network call is replaced; no credentials or paid requests.
const validPng = Uint8Array.from(atob(MOCK_VTO_RESULT_BASE64), c => c.charCodeAt(0));
const garmentUrl = 'https://cdn.example.com/garment.png';
const cases = [
  { id: 'VTO-REMOTE-ZERO', bytes: new Uint8Array(), type: 'image/png', expectedSubmit: false },
  { id: 'VTO-REMOTE-TRUNCATED', bytes: validPng.slice(0, 12), type: 'image/png', expectedSubmit: false },
  { id: 'VTO-REMOTE-MIME-LIE', bytes: new TextEncoder().encode('<html>not an image</html>'), type: 'image/jpeg', expectedSubmit: false },
  { id: 'VTO-REMOTE-CORRUPT', bytes: new Uint8Array([1, 2, 3, 4, 5, 6]), type: 'image/webp', expectedSubmit: false },
  { id: 'VTO-REMOTE-TEXT-DECLARED', bytes: new TextEncoder().encode('<html>not an image</html>'), type: 'text/html', expectedSubmit: false },
  { id: 'VTO-REMOTE-VALID-BASELINE', bytes: validPng, type: 'image/png', expectedSubmit: true },
];
for (const fixture of cases) {
  Deno.test(fixture.id, async () => {
    let submitCount = 0;
    let submittedBytes: number | null = null;
    const provider = createAiLabToolsProvider({ apiKey: 'OFFLINE-NONSECRET', fetchImpl: async (url, init) => {
      if (url === garmentUrl) return new Response(fixture.bytes.slice(), { status: 200, headers: { 'content-type': fixture.type } });
      assert.equal(url, 'https://try-on-clothes-pro.p.rapidapi.com/portrait/editing/try-on-clothes-pro');
      assert.equal(init.method, 'POST');
      submitCount++;
      const garment = (init.body as FormData).get('top_garment') as Blob;
      assert.deepEqual(new Uint8Array(await garment.arrayBuffer()), fixture.bytes);
      submittedBytes = garment.size;
      return new Response(JSON.stringify({ message: 'OFFLINE simulated gateway denial' }), { status: 403, headers: { 'content-type': 'application/json' } });
    } });
    const outcome = await provider.generate({ personDataUri: `data:image/png;base64,${MOCK_VTO_RESULT_BASE64}`, garmentImageUrl: garmentUrl, slot: 'top', canonicalCategory: 'outerwear' }, { signal: new AbortController().signal });
    console.log(JSON.stringify({ id: fixture.id, boundary: 'actual handler/adapter with injected external effects', inputBytes: fixture.bytes.length, mime: fixture.type, submitCount, submittedBytes, outcome }));
    assert.equal(submitCount > 0, fixture.expectedSubmit, 'Invalid remote image must be rejected before paid-dispatch boundary');
  });
}

Deno.test('Container checks retain supported types without claiming pixel decoding', () => {
  assert.equal(hasRemoteGarmentImageContainer(validPng, 'image/png'), true);
  assert.equal(hasRemoteGarmentImageContainer(validPng.slice(0, -1), 'image/png'), false);
  assert.equal(hasRemoteGarmentImageContainer(validPng, 'image/jpeg'), false);
  assert.equal(hasRemoteGarmentImageContainer(validPng, 'image/gif'), false);

  // Header-only fixtures exercise the declared narrow container contract.
  // They are not presented as decodable images or vendor quality evidence.
  const jpeg = new Uint8Array(24);
  jpeg.set([0xff, 0xd8, 0xff]); jpeg.set([0xff, 0xd9], 22);
  assert.equal(hasRemoteGarmentImageContainer(jpeg, 'image/jpeg'), true);
  assert.equal(hasRemoteGarmentImageContainer(jpeg.slice(0, -1), 'image/jpeg'), false);
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode('RIFF')); webp.set(new TextEncoder().encode('WEBP'), 8);
  new DataView(webp.buffer).setUint32(4, 22, true);
  assert.equal(hasRemoteGarmentImageContainer(webp, 'image/webp'), true);
  assert.equal(hasRemoteGarmentImageContainer(webp.slice(0, -1), 'image/webp'), false);
  const avif = new Uint8Array(36);
  const avifView = new DataView(avif.buffer);
  avifView.setUint32(0, 24); avif.set(new TextEncoder().encode('ftypmif1'), 4);
  avif.set(new TextEncoder().encode('avif'), 16);
  assert.equal(hasRemoteGarmentImageContainer(avif, 'image/avif'), true);
  assert.equal(hasRemoteGarmentImageContainer(avif.slice(0, 24), 'image/avif'), false);
  avif.set(new TextEncoder().encode('mif1'), 16);
  avif.set(new TextEncoder().encode('avif'), 12);
  assert.equal(hasRemoteGarmentImageContainer(avif, 'image/avif'), false, 'minor version is not a compatible brand');
  avifView.setUint32(0, 4000);
  assert.equal(hasRemoteGarmentImageContainer(avif, 'image/avif'), false);
});
