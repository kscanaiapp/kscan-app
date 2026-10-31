import assert from 'node:assert/strict';

Deno.test('actual image resolver rejects malformed signing JSON and preserves a valid signed URL', async () => {
  const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const saved = names.map((name) => Deno.env.get(name));
  const realFetch = globalThis.fetch;
  const serve = Object.getOwnPropertyDescriptor(Deno, 'serve')!;
  const origin = 'https://signing-fixture.invalid';
  const owner = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const item = '33333333-3333-4333-8333-333333333333';
  const signedPath = `/object/sign/style-library-images/${owner}/scans/fixture.jpg?token=synthetic`;
  let handler: ((request: Request) => Promise<Response>) | undefined;
  let providerValue: unknown;
  let signCalls = 0;
  try {
    Deno.env.set('SUPABASE_URL', origin);
    Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-server-key');
    Object.defineProperty(Deno, 'serve', { configurable: true, value: (callback: typeof handler) => {
      handler = callback;
      return { finished: Promise.resolve(), shutdown: async () => {} };
    } });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-server-key');
      if (url.pathname === '/rest/v1/room_shares') {
        assert.equal(url.searchParams.get('is_active'), 'eq.true');
        assert.equal(url.searchParams.get('revoked_at'), 'is.null');
        return Response.json([{ room_id: room, expires_at: null }]);
      }
      if (url.pathname === '/rest/v1/dressing_rooms') return Response.json([{ id: room, user_id: owner }]);
      if (url.pathname === '/rest/v1/dressing_room_items') {
        assert.equal(url.searchParams.get('dressing_room_id'), `eq.${room}`);
        return Response.json([{ id: item, storage_bucket: 'style-library-images', storage_path: `${owner}/scans/fixture.jpg` }]);
      }
      assert.equal(url.pathname, `/storage/v1/object/sign/style-library-images/${owner}/scans/fixture.jpg`);
      assert.equal(init?.method, 'POST');
      signCalls++;
      return Response.json({ signedURL: providerValue });
    };
    await import('./index.ts');
    assert.ok(handler);
    for (const value of [{ unexpected: 'object' }, [], 42, true, null, undefined,
      'https://foreign.invalid/object/sign/x?token=x', '/object/sign/x?token=', signedPath]) {
      providerValue = value;
      const response = await handler(new Request(origin, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareToken: 'synthetic-valid-share', itemIds: [item] }),
      }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.imageUrls[item], value === signedPath ? `${origin}/storage/v1${signedPath}` : null);
    }
    assert.equal(signCalls, 9, 'Every case must reach the real response validation boundary');
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(Deno, 'serve', serve);
    names.forEach((name, i) => saved[i] === undefined ? Deno.env.delete(name) : Deno.env.set(name, saved[i]!));
  }
});
