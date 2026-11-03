// Actual serve handler; Auth, account, quota transport and providers are synthetic.
// No network permission, real JWT, customer mutation or paid dispatch is used.
import assert from 'node:assert/strict';

Deno.test({
  name: 'B35-B-004 actual Scanner body boundary and preserved authority/routing',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const actor = '00000000-0000-4000-8000-000000000031';
    const origin = 'https://scanner-body-fixture.invalid';
    const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
      'GEMINI_API_KEY', 'BACKEND_COMMERCE_FUNNEL_V127_ENABLED'];
    const saved = names.map(n => [n, Deno.env.get(n)] as const);
    const fetchSaved = globalThis.fetch;
    const serveSaved = Object.getOwnPropertyDescriptor(Deno, 'serve')!;
    let handler: ((r: Request) => Promise<Response>) | undefined;
    let active = true, authValid = true;
    let providerCalls = 0, postCalls = 0, authReads = 0, profileReads = 0, consentReads = 0;
    let quotas: Record<string, unknown>[] = [];
    try {
      for (const n of names) Deno.env.set(n, n === 'SUPABASE_URL' ? origin
        : n === 'BACKEND_COMMERCE_FUNNEL_V127_ENABLED' ? 'true' : 'synthetic-fixture-only');
      globalThis.fetch = async (input, init) => {
        const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (u.origin !== origin) {
          providerCalls++;
          return Response.json({ error: 'external_call_denied' }, { status: 503 });
        }
        if (method !== 'GET') postCalls++;
        if (u.pathname === '/auth/v1/user') {
          authReads++;
          return authValid
            ? Response.json({ id: actor, aud: 'authenticated', role: 'authenticated', is_anonymous: false })
            : Response.json({ message: 'invalid synthetic identity' }, { status: 401 });
        }
        if (u.pathname === '/rest/v1/profiles') {
          profileReads++;
          return Response.json([{ id: actor, account_status: active ? 'active' : 'inactive', account_locked_at: null }]);
        }
        if (u.pathname === '/rest/v1/rpc/check_and_increment_scan_identify_daily_usage') {
          quotas.push(JSON.parse(String(init?.body)));
          return Response.json({ error: 'synthetic_quota_unavailable' }, { status: 503 });
        }
        if (u.pathname === '/rest/v1/legal_acceptances') {
          consentReads++;
          return Response.json([{ user_id: actor, acceptance_type: 'ai_processing', policy_version: 'v2_google_gemini' }]);
        }
        if (u.pathname === '/rest/v1/ai_processing_permissions') {
          consentReads++;
          return Response.json([{ user_id: actor, policy_version: 'v2_google_gemini', granted: true }]);
        }
        return Response.json({ error: 'unconfigured_fixture_boundary' }, { status: 503 });
      };
      Object.defineProperty(Deno, 'serve', { configurable: true, value: (a: unknown, b: unknown) => {
        handler = (typeof a === 'function' ? a : b) as typeof handler;
        return { finished: Promise.resolve(), shutdown: async () => {} };
      } });
      await import('./index.ts');
      assert.ok(handler);
      async function probe(body: string, authorized = true, method = 'POST') {
        providerCalls = postCalls = authReads = profileReads = consentReads = 0; quotas = [];
        let status: number | string, result: Record<string, unknown> = {};
        try {
          const headers: Record<string, string> = { apikey: 'synthetic-fixture-only', 'Content-Type': 'application/json' };
          if (authorized) headers.Authorization = 'Bearer synthetic-verified-user';
          const response = await handler!(new Request(origin + '/functions/v1/scan-identify', {
            method, headers, ...(method === 'POST' ? { body } : {}),
          }));
          status = response.status;
          const text = await response.text();
          try { result = JSON.parse(text); } catch { result = { text }; }
        } catch (e) { status = e instanceof Error ? e.name : 'unhandled'; }
        const observed = { status, result, providerCalls, postCalls, authReads, profileReads, consentReads, quotas };
        console.log('B004_BODY_RESULT ' + JSON.stringify({ input: body, authorized, method, actual: observed }));
        return observed;
      }
      for (const body of ['null', '[]', '17', 'true', '"fixture"', '[{}]']) {
        await t.step('non-object JSON ' + body, async () => {
          const p = await probe(body);
          assert.equal(p.providerCalls, 0); assert.equal(p.postCalls, 0);
          assert.equal(p.status, 400);
          assert.equal(p.authReads, 1); assert.equal(p.profileReads, 1);
          assert.deepEqual(p.result, { status: 'failed', error: { code: 'MALFORMED_REQUEST', message: 'Malformed request.' } });
        });
      }
      for (const body of ['', '{']) await t.step('invalid JSON ' + JSON.stringify(body), async () => {
        const p = await probe(body); assert.equal(p.status, 400); assert.equal(p.result.error, 'Invalid JSON');
        assert.equal(p.providerCalls, 0); assert.equal(p.postCalls, 0);
      });
      await t.step('invalid identity rejects before null-body routing', async () => {
        authValid = false;
        try { const p = await probe('null'); assert.equal(p.status, 401); assert.equal(p.profileReads, 0); assert.equal(p.postCalls, 0); assert.equal(p.providerCalls, 0); }
        finally { authValid = true; }
      });
      await t.step('inactive identity rejects before null-body routing', async () => {
        active = false;
        try { const p = await probe('null'); assert.equal(p.status, 403); assert.equal(p.postCalls, 0); assert.equal(p.providerCalls, 0); }
        finally { active = true; }
      });
      await t.step('legacy object retains its existing no-image failure envelope', async () => {
        const p = await probe('{}'); assert.equal(p.status, 200); assert.equal(p.result.status, 'failed');
        assert.equal(p.providerCalls, 0); assert.equal(p.postCalls, 0); assert.ok(p.authReads > 1);
      });
      await t.step('unknown version remains rejected without legacy fallback', async () => {
        const p = await probe('{"contractVersion":"unsupported-fixture"}');
        assert.equal(p.status, 400); assert.equal((p.result.error as { code: string }).code, 'UNSUPPORTED_CONTRACT_VERSION');
        assert.equal(p.providerCalls, 0); assert.equal(p.postCalls, 0);
      });
      await t.step('V2 objects retain their specific validation error', async () => {
        const p = await probe('{"contractVersion":"fashion-identification-v2","requestId":"req-000000000001"}');
        assert.equal(p.status, 400); assert.equal((p.result.error as { code: string }).code, 'MISSING_INTENT');
        assert.equal(p.providerCalls, 0); assert.equal(p.postCalls, 0);
      });
      await t.step('anonymous commerce-only cannot bypass its authentication gate', async () => {
        const p = await probe('{"requestMode":"commerce_only"}', false);
        assert.equal(p.status, 401); assert.equal(p.result.error, 'commerce_only_auth_required');
        assert.equal(p.authReads, 0); assert.equal(p.postCalls, 0); assert.equal(p.providerCalls, 0);
      });
      await t.step('authenticated commerce-only preserves its durable quota and no-Gemini boundary', async () => {
        const p = await probe('{"requestMode":"commerce_only"}');
        assert.equal(p.status, 503); assert.equal(p.result.error, 'commerce_only_quota_unverified');
        assert.equal(p.postCalls, 1); assert.equal(p.quotas.length, 1);
        assert.equal(p.quotas[0].p_user_id, actor); assert.equal(p.quotas[0].p_mode, 'commerce_only');
        assert.equal(p.consentReads, 0); assert.equal(p.providerCalls, 0);
      });
      for (const [method, expected] of [['OPTIONS', 200], ['GET', 405]] as const) await t.step(method + ' precedes auth/body handling', async () => {
        const p = await probe('', true, method); assert.equal(p.status, expected);
        assert.equal(p.authReads, 0); assert.equal(p.postCalls, 0); assert.equal(p.providerCalls, 0);
      });
    } finally {
      globalThis.fetch = fetchSaved; Object.defineProperty(Deno, 'serve', serveSaved);
      for (const [n, v] of saved) v === undefined ? Deno.env.delete(n) : Deno.env.set(n, v);
    }
  },
});
