/**
 * B35-C-015: execute the real StyleChat Edge handler with synthetic authenticated
 * authority. Invalid JSON top-level values must not escape as TypeError or
 * reach a provider/privileged write. No network permission is granted.
 *
 * Adapted from the hostile audit's executed authenticated-body probe; the
 * portable import path prevents dependence on a developer's local worktree.
 */
import assert from 'node:assert/strict';

Deno.test({
  name: 'B35-C-015: authenticated non-object JSON bodies fail with controlled 400 before side effects',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const actor = '00000000-0000-4000-8000-000000000031';
    const envNames = [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'GEMINI_API_KEY',
      'PURCHASE_IMPORT_EXTRACT_ENABLED',
    ];
    const savedEnv = envNames.map((name) => [name, Deno.env.get(name)] as const);
    const originalFetch = globalThis.fetch;
    const originalServe = Object.getOwnPropertyDescriptor(Deno, 'serve');
    assert.ok(originalServe, 'Deno.serve descriptor must be restorable');
    let handler: ((req: Request) => Promise<Response>) | undefined;
    let providerCalls = 0;
    let writes = 0;
    let authReads = 0;

    try {
      for (const name of envNames) {
        Deno.env.set(
          name,
          name === 'SUPABASE_URL'
            ? 'https://stylechat-body-fixture.invalid'
            : name === 'PURCHASE_IMPORT_EXTRACT_ENABLED' ? 'true' : 'synthetic-fixture-only',
        );
      }
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input
            : input instanceof URL ? input.href : input.url,
        );
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (url.origin !== 'https://stylechat-body-fixture.invalid') {
          providerCalls++;
          return Response.json({ error: 'external_call_denied' }, { status: 503 });
        }
        if (method !== 'GET') writes++;
        if (url.pathname === '/auth/v1/user') {
          authReads++;
          return Response.json({
            id: actor,
            aud: 'authenticated',
            role: 'authenticated',
            is_anonymous: false,
            app_metadata: { provider: 'email' },
          });
        }
        if (url.pathname === '/rest/v1/profiles') {
          return Response.json([{ id: actor, account_status: 'active', account_locked_at: null }]);
        }
        if (url.pathname === '/rest/v1/legal_acceptances') {
          return Response.json([{
            user_id: actor,
            acceptance_type: 'ai_processing',
            policy_version: 'v2_google_gemini',
          }]);
        }
        if (url.pathname === '/rest/v1/ai_processing_permissions') {
          return Response.json([{
            user_id: actor,
            policy_version: 'v2_google_gemini',
            granted: true,
          }]);
        }
        return Response.json({ error: 'unconfigured_fixture_boundary' }, { status: 503 });
      };
      Object.defineProperty(Deno, 'serve', {
        configurable: true,
        value: (a: unknown, b: unknown) => {
          handler = (typeof a === 'function' ? a : b) as typeof handler;
          return { finished: Promise.resolve(), shutdown: async () => {} };
        },
      });
      await import('./index.ts');
      assert.ok(handler, 'real Edge handler was captured');
      const invoke = handler!;

      for (const body of ['null', '[]', '17', '"text"', 'true', 'false']) {
        providerCalls = 0;
        writes = 0;
        authReads = 0;
        const response = await invoke(new Request(
          'https://stylechat-body-fixture.invalid/functions/v1/stylechat-generate',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer synthetic-verified-user',
              apikey: 'synthetic-fixture-only',
              'Content-Type': 'application/json',
            },
            body,
          },
        ));
        assert.equal(response.status, 400, `expected controlled 400 for ${body}`);
        assert.equal((await response.json()).error, 'Invalid request body', body);
        assert.equal(providerCalls, 0, `no provider for ${body}`);
        assert.equal(writes, 0, `no privileged writes for ${body}`);
        assert.ok(authReads > 0, `verified Auth boundary exercised for ${body}`);
      }

      // Preserve existing object and malformed-JSON request contracts.
      for (const [body, expectedError] of [
        ['{}', 'sessionId required'],
        ['{', 'Invalid JSON'],
        ['', 'Invalid JSON'],
      ]) {
        providerCalls = 0;
        writes = 0;
        const response = await invoke(new Request(
          'https://stylechat-body-fixture.invalid/functions/v1/stylechat-generate',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer synthetic-verified-user',
              apikey: 'synthetic-fixture-only',
              'Content-Type': 'application/json',
            },
            body,
          },
        ));
        assert.equal(response.status, 400, `object/parse contract for ${body}`);
        assert.equal((await response.json()).error, expectedError, body);
        assert.equal(providerCalls, 0);
        assert.equal(writes, 0);
      }
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(Deno, 'serve', originalServe);
      for (const [name, value] of savedEnv) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  },
});
