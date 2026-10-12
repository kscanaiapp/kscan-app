// Behavioral regression for SEC-B35-KPLUS-001 (K+ Early Access server hold) through the REAL
// kplus-activate entrypoint. All network is stubbed; nothing leaves the process.
//
// Why this exists: __tests__/kplusActivationCampaignHold.test.js asserts the guard by comparing source
// text positions, so three fail-open edits still pass it (`||` -> `&&`, dropping the `return` before
// `json(...)`, and `if (false && ...)`). This file drives the handler and asserts the observable
// contract: a closed campaign performs ZERO grant-RPC calls and ZERO RevenueCat/mirror calls.

type Handler = (req: Request) => Promise<Response> | Response;

const USER_ID = '11111111-2222-4333-8444-555555555555';
let handler: Handler | null = null;

// Capture the handler the module registers instead of opening a socket.
Object.defineProperty(Deno, "serve", {
  configurable: true,
  writable: true,
  value: ((first: unknown, second?: unknown) => {
    handler = (typeof first === "function" ? first : second) as Handler;
    return { shutdown() {}, finished: Promise.resolve(), ref() {}, unref() {} };
  }) as unknown as typeof Deno.serve,
});

const calls: string[] = [];
globalThis.fetch = (async (input: Request | URL | string) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  calls.push(url);
  if (url.includes('/auth/v1/user')) {
    return Response.json({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'a@example.test', is_anonymous: false });
  }
  if (url.includes('/rest/v1/profiles')) return Response.json([{ account_status: 'active', account_locked_at: null }]);
  if (url.includes('/rpc/grant_kplus_early_access')) {
    return Response.json([{
      entitlement_key: 'k_plus', status: 'active', grant_reason: 'complimentary_early_access', campaign_key: 'c',
      granted_at: '2026-10-08T00:00:00Z', expires_at: '2027-01-01T00:00:00Z', newly_granted: true,
    }]);
  }
  if (url.includes('/rpc/kplus_user_entitlement_row_is_active')) return Response.json(true);
  if (url.includes('/rpc/set_kplus_revenuecat_sync_status')) return Response.json(null);
  return new Response('stub-unexpected', { status: 500 });
}) as typeof fetch;

Deno.env.set('SUPABASE_URL', 'https://stub.invalid');
Deno.env.set('SUPABASE_ANON_KEY', 'anon');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
Deno.env.delete('REVENUECAT_SYNC_ENABLED');
Deno.env.delete('REVENUECAT_SECRET_API_KEY');

await import('./index.ts');
if (!handler) throw new Error('kplus-activate did not register a handler');
const activate = handler as Handler;

const CONTROLS = ['KPLUS_EARLY_ACCESS_ENABLED', 'KPLUS_EARLY_ACCESS_CAMPAIGN_ELIGIBILITY_CERTIFIED'] as const;

function setControls(first: string | undefined, second: string | undefined) {
  [first, second].forEach((value, index) => {
    if (value === undefined) Deno.env.delete(CONTROLS[index]);
    else Deno.env.set(CONTROLS[index], value);
  });
}

async function post(authenticated = true) {
  calls.length = 0;
  const response = await activate(new Request('https://edge.local/kplus-activate', {
    method: 'POST',
    headers: authenticated ? { Authorization: 'Bearer token' } : {},
    body: '{}',
  }));
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null, calls: [...calls] };
}

const grantCalls = (urls: string[]) => urls.filter((url) => url.includes('grant_kplus_early_access')).length;
const mirrorCalls = (urls: string[]) => urls.filter((url) => url.includes('revenuecat.com') || url.includes('set_kplus_revenuecat_sync_status')).length;

// Everything that is not EXACTLY the string "true" in BOTH controls must stay closed.
const CLOSED: Array<[string | undefined, string | undefined]> = [
  [undefined, undefined], ['true', undefined], [undefined, 'true'],
  ['TRUE', 'true'], ['true', 'TRUE'], ['True', 'true'], ['1', '1'], ['yes', 'true'], ['on', 'on'],
  [' true', 'true'], ['true ', 'true'], ['true', 'true '], ['true\n', 'true'], ['"true"', 'true'],
  ['false', 'true'], ['true', 'false'], ['', 'true'], ['true', ''],
];

Deno.test({ name: 'K+ hold: every non-exact-"true" control combination is closed with zero grant and zero mirror calls', sanitizeOps: false, sanitizeResources: false }, async () => {
  for (const [first, second] of CLOSED) {
    setControls(first, second);
    const result = await post();
    const label = JSON.stringify([first, second]);
    if (result.status !== 403 || result.body?.code !== 'CAMPAIGN_CLOSED') throw new Error(`${label}: status ${result.status} body ${JSON.stringify(result.body)}`);
    if (grantCalls(result.calls) !== 0) throw new Error(`${label}: the grant RPC was reached`);
    if (mirrorCalls(result.calls) !== 0) throw new Error(`${label}: RevenueCat or the mirror was reached`);
    if (result.body && ('entitlementKey' in result.body || 'expiresAt' in result.body)) throw new Error(`${label}: grant fields leaked`);
  }
});

Deno.test({ name: 'K+ hold: both controls exactly "true" reach the grant RPC (the guard is a gate, not a wall)', sanitizeOps: false, sanitizeResources: false }, async () => {
  setControls('true', 'true');
  const result = await post();
  if (result.status !== 200 || grantCalls(result.calls) !== 1) throw new Error(`open path: status ${result.status}, grant calls ${grantCalls(result.calls)}`);
  setControls(undefined, undefined);
});

Deno.test({ name: 'K+ hold: an unauthenticated request is rejected 401 before anything else', sanitizeOps: false, sanitizeResources: false }, async () => {
  setControls('true', 'true');
  const result = await post(false);
  if (result.status !== 401 || grantCalls(result.calls) !== 0) throw new Error(`unauthenticated: status ${result.status}`);
  setControls(undefined, undefined);
});
