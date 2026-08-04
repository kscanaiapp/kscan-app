import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { authenticateRequest, extractBearerToken } from './context.ts';

Deno.env.set('SUPABASE_URL', 'https://fake-project.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'fake-anon-key');

// Minimal fake matching only the shape context.ts actually calls:
// client.auth.getUser() and client.from('profiles').select().eq().maybeSingle().
function fakeClient(opts: {
  user?: { id: string } | null;
  authError?: unknown;
  accountStatus?: string | null;
  profileError?: unknown;
}) {
  return {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: opts.user ?? null },
          error: opts.authError ?? null,
        }),
    },
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: () =>
            Promise.resolve({
              data: opts.accountStatus !== undefined && opts.accountStatus !== null
                ? { account_status: opts.accountStatus }
                : null,
              error: opts.profileError ?? null,
            }),
        }),
      }),
    }),
    // deno-lint-ignore no-explicit-any
  } as any;
}

function reqWithToken(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request('https://x.test', { headers });
}

Deno.test('extractBearerToken pulls the token out of a well-formed Authorization header', () => {
  assertEquals(extractBearerToken(reqWithToken('abc.def.ghi')), 'abc.def.ghi');
});

Deno.test('extractBearerToken returns null when the header is missing', () => {
  assertEquals(extractBearerToken(new Request('https://x.test')), null);
});

Deno.test('extractBearerToken returns null for a malformed (non-Bearer) header', () => {
  const req = new Request('https://x.test', { headers: { Authorization: 'Basic abc123' } });
  assertEquals(extractBearerToken(req), null);
});

Deno.test('authenticateRequest denies a request with no token as unauthorized', async () => {
  const result = await authenticateRequest(reqWithToken(null));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.category, 'unauthorized');
});

Deno.test('authenticateRequest denies an invalid/expired token as unauthorized', async () => {
  const result = await authenticateRequest(reqWithToken('bad-token'), {
    clientFactory: () => fakeClient({ user: null, authError: { message: 'invalid JWT' } }),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.category, 'unauthorized');
});

Deno.test('authenticateRequest allows a valid active-account user', async () => {
  const result = await authenticateRequest(reqWithToken('good-token'), {
    clientFactory: () => fakeClient({ user: { id: 'user-1' }, accountStatus: 'active' }),
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.context.userId, 'user-1');
    assertEquals(result.context.accountState, 'active');
    assertEquals(typeof result.context.requestId, 'string');
  }
});

Deno.test('authenticateRequest rejects a pending_deletion account as account_unavailable', async () => {
  const result = await authenticateRequest(reqWithToken('good-token'), {
    clientFactory: () => fakeClient({ user: { id: 'user-1' }, accountStatus: 'pending_deletion' }),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.category, 'account_unavailable');
});

Deno.test('authenticateRequest rejects a locked account as account_unavailable', async () => {
  const result = await authenticateRequest(reqWithToken('good-token'), {
    clientFactory: () => fakeClient({ user: { id: 'user-1' }, accountStatus: 'locked' }),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.category, 'account_unavailable');
});

Deno.test('authenticateRequest fails closed when the profile row is missing entirely', async () => {
  const result = await authenticateRequest(reqWithToken('good-token'), {
    clientFactory: () => fakeClient({ user: { id: 'user-1' }, accountStatus: null }),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.category, 'account_unavailable');
});

Deno.test('authenticateRequest fails closed when the account-state lookup errors', async () => {
  const result = await authenticateRequest(reqWithToken('good-token'), {
    clientFactory: () => fakeClient({ user: { id: 'user-1' }, accountStatus: 'active', profileError: { message: 'db down' } }),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.category, 'account_unavailable');
});

Deno.test('authenticateRequest respects a caller-supplied allowedAccountStates override', async () => {
  const result = await authenticateRequest(reqWithToken('good-token'), {
    allowedAccountStates: ['active', 'pending_deletion'],
    clientFactory: () => fakeClient({ user: { id: 'user-1' }, accountStatus: 'pending_deletion' }),
  });
  assertEquals(result.ok, true);
});

Deno.test('authenticateRequest never uses a client-supplied user ID — userId always comes from the verified session', async () => {
  const spoofedReq = new Request('https://x.test', {
    headers: { Authorization: 'Bearer good-token', 'X-User-Id': 'attacker-controlled-id' },
  });
  const result = await authenticateRequest(spoofedReq, {
    clientFactory: () => fakeClient({ user: { id: 'real-verified-id' }, accountStatus: 'active' }),
  });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.context.userId, 'real-verified-id');
});
