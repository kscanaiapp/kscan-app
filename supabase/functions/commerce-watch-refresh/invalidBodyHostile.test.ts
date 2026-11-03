// Actual Watchlist handler: identical before/after fixture; synthetic identity transport, no network.
import assert from 'node:assert/strict';
Deno.test({
  name: 'W2 actual Watchlist authenticated invalid-body boundary',
  sanitizeOps: false, sanitizeResources: false,
  fn: async (t) => {
    const origin = 'https://watch-body-fixture.invalid';
    const actor = '00000000-0000-4000-8000-000000000031';
    const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'WATCHLIST_WORKER_SECRET'];
    const saved = names.map(n => [n, Deno.env.get(n)] as const);
    const fetchSaved = globalThis.fetch, serveSaved = Object.getOwnPropertyDescriptor(Deno, 'serve')!;
    let handler: ((req: Request) => Promise<Response>) | undefined;
    let valid = true, eligible = true, authReads = 0, actorReads = 0, entitlementReads = 0, writes = 0, providerCalls = 0;
    try {
      for (const n of names) Deno.env.set(n, n === 'SUPABASE_URL' ? origin : n === 'WATCHLIST_WORKER_SECRET' ? 'separate-worker-fixture-secret' : 'synthetic-fixture-only');
      globalThis.fetch = async (input, init) => {
        const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (u.origin !== origin) { providerCalls++; return Response.json({ error: 'external_denied' }, { status: 503 }); }
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (u.pathname === '/auth/v1/user') {
          authReads++;
          return valid ? Response.json({ id: actor, aud: 'authenticated', role: 'authenticated', is_anonymous: false }) : Response.json({ message: 'invalid synthetic session' }, { status: 401 });
        }
        if (u.pathname === '/rest/v1/rpc/watchlist_actor_is_active') {
          actorReads++;
          return Response.json(eligible);
        }
        if (u.pathname === '/rest/v1/rpc/kplus_has_active_entitlement') {
          entitlementReads++;
          return Response.json(false);
        }
        if (method !== 'GET') writes++;
        return Response.json({ error: 'unconfigured_fixture_boundary' }, { status: 503 });
      };
      Object.defineProperty(Deno, 'serve', { configurable: true, value: (a: unknown, b: unknown) => {
        handler = (typeof a === 'function' ? a : b) as typeof handler;
        return { finished: Promise.resolve(), shutdown: async () => {} };
      } });
      await import('./index.ts');
      assert.ok(handler);
      async function probe(body: string, authenticated = true, forgedWorker = false, trustedWorker = false) {
        authReads = actorReads = entitlementReads = writes = providerCalls = 0;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (authenticated) headers.Authorization = 'Bearer synthetic-verified-user';
        if (forgedWorker) headers['x-watchlist-worker-secret'] = 'forged-worker-secret';
        if (trustedWorker) headers['x-watchlist-worker-secret'] = 'separate-worker-fixture-secret';
        let status: number | string, result: Record<string, unknown> = {};
        try { const r = await handler!(new Request(origin + '/functions/v1/commerce-watch-refresh', { method: 'POST', headers, body })); status = r.status; result = await r.json(); }
        catch (e) { status = e instanceof Error ? e.name : 'unhandled'; }
        const actual = { status, result, authReads, actorReads, entitlementReads, writes, providerCalls };
        console.log('W2_BODY_RESULT ' + JSON.stringify({ body, authenticated, forgedWorker, actual }));
        return actual;
      }
      for (const body of ['null', '[]', '["create"]', '17', 'true', 'false', '"fixture"']) await t.step('invalid body ' + body, async () => {
        const r = await probe(body); assert.equal(r.writes, 0); assert.equal(r.providerCalls, 0); assert.equal(r.authReads, 1);
        assert.equal(r.status, 400); assert.equal(r.result.code, 'invalid_body');
      });
      for (const body of ['', '{']) await t.step('invalid JSON ' + JSON.stringify(body), async () => {
        const r = await probe(body); assert.equal(r.status, 400); assert.equal(r.result.code, 'invalid_body'); assert.equal(r.writes, 0); assert.equal(r.providerCalls, 0);
      });
      await t.step('valid empty object keeps unknown-action response', async () => {
        const r = await probe('{}'); assert.equal(r.status, 400); assert.equal(r.result.code, 'unknown_action'); assert.equal(r.writes, 0); assert.equal(r.providerCalls, 0);
      });
      await t.step('valid action object retains active-account and canonical K+ checks', async () => {
        const r = await probe('{"action":"refresh","watchId":"invalid-fixture-id"}');
        assert.equal(r.status, 403); assert.equal(r.result.code, 'kplus_required');
        assert.equal(r.authReads, 1); assert.equal(r.actorReads, 1); assert.equal(r.entitlementReads, 1);
        assert.equal(r.writes, 0); assert.equal(r.providerCalls, 0);
      });
      await t.step('inactive account still cannot reach a valid action', async () => {
        eligible = false;
        try { const r = await probe('{"action":"refresh"}'); assert.equal(r.status, 403); assert.equal(r.result.code, 'account_not_eligible'); assert.equal(r.actorReads, 1); assert.equal(r.writes, 0); assert.equal(r.providerCalls, 0); }
        finally { eligible = true; }
      });
      await t.step('invalid identity rejects before null routing', async () => {
        valid = false;
        try { const r = await probe('null'); assert.equal(r.status, 401); assert.equal(r.writes, 0); assert.equal(r.providerCalls, 0); }
        finally { valid = true; }
      });
      await t.step('forged worker secret without a user does not authorize processing', async () => {
        const r = await probe('null', false, true); assert.equal(r.status, 401); assert.equal(r.authReads, 0); assert.equal(r.writes, 0); assert.equal(r.providerCalls, 0);
      });
      await t.step('trusted worker keeps body-independent, fail-closed disabled sweep', async () => {
        const r = await probe('null', false, false, true);
        assert.equal(r.status, 200); assert.equal(r.result.mode, 'sweep'); assert.equal(r.result.enabled, false);
        assert.equal(r.authReads, 0); assert.equal(r.writes, 0); assert.equal(r.providerCalls, 0);
      });
      for (const method of ['OPTIONS', 'GET']) await t.step(method + ' handling stays independent of body routing', async () => {
        authReads = actorReads = entitlementReads = writes = providerCalls = 0;
        const response = await handler!(new Request(origin + '/functions/v1/commerce-watch-refresh', { method }));
        assert.equal(response.status, method === 'OPTIONS' ? 200 : 405); await response.text();
        assert.equal(authReads, 0); assert.equal(writes, 0); assert.equal(providerCalls, 0);
      });
    } finally {
      globalThis.fetch = fetchSaved; Object.defineProperty(Deno, 'serve', serveSaved);
      for (const [n, v] of saved) v === undefined ? Deno.env.delete(n) : Deno.env.set(n, v);
    }
  },
});
