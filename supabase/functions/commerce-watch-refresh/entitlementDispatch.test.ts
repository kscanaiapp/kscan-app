// End-to-end behavioral regression for the Watchlist provider-dispatch entitlement guard (#524) through
// the REAL commerce-watch-refresh entrypoint. Every network call is stubbed; nothing leaves the process.
// The "provider" is recognised by host (farfetch3.p.rapidapi.com).
//
// Why this exists: watchEntitlementGuard.test.ts proves the guard unit in isolation, but nothing exercised
// the call site in runRefreshCycle or the claim -> dispatch ordering. Mutants that bypass the guard, make
// the predicate always true, ignore the HTTP status, read the wrong user/key, or memoize across users all
// passed the unit tests. These tests assert the observable contract:
//   no valid K+ at dispatch time  =>  ZERO provider requests, no row write, no event, no push lookup.

type Handler = (req: Request) => Promise<Response> | Response;
type Recorded = { url: string; method: string; body: string };

const USER_A = '11111111-2222-4333-8444-55555555555a';
const USER_B = '11111111-2222-4333-8444-55555555555b';
const USER_C = '11111111-2222-4333-8444-55555555555c';
const WORKER_SECRET = 'test-worker-secret';

let handler: Handler | null = null;
Object.defineProperty(Deno, "serve", {
  configurable: true,
  writable: true,
  value: ((first: unknown, second?: unknown) => {
    handler = (typeof first === "function" ? first : second) as Handler;
    return { shutdown() {}, finished: Promise.resolve(), ref() {}, unref() {} };
  }) as unknown as typeof Deno.serve,
});

let recorded: Recorded[] = [];
let entitlementCalls = 0;
let claimRows: Record<string, unknown>[] = [];
let entitlementAnswer: (userId: string, entitlementKey: string, callNumber: number) => Response | 'throw' =
  () => Response.json(true);

function watchRow(id: string, userId: string) {
  return {
    id, user_id: userId, source: 'farfetch',
    canonical_url: 'https://www.farfetch.com/shopping/women/test-item-12345.aspx',
    currency: 'USD', current_price_amount: 100, target_price_amount: 90, watch_intent: 'buy_under',
    target_reached_at: null, last_status: 'available', consecutive_failures: 0,
    last_checked_at: '2026-10-08T00:00:00Z', status: 'active', display_title: 'Test item', push_enabled: true,
  };
}

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const body = typeof init?.body === 'string' ? init.body : '';
  recorded.push({ url, method, body });
  if (url.includes('/auth/v1/user')) {
    return Response.json({ id: USER_A, aud: 'authenticated', role: 'authenticated', email: 'a@example.test', is_anonymous: false });
  }
  if (url.includes('/rpc/kplus_has_active_entitlement')) {
    entitlementCalls += 1;
    const parsed = JSON.parse(body || '{}');
    const answer = entitlementAnswer(parsed.p_user_id, parsed.p_entitlement_key, entitlementCalls);
    if (answer === 'throw') throw new TypeError('network down');
    return answer;
  }
  if (url.includes('/rpc/claim_watchable_commerce_watches') || url.includes('/rpc/claim_user_commerce_watches_for_refresh')) {
    return Response.json(claimRows);
  }
  if (url.includes('/rest/v1/app_config')) return Response.json([{ value: { enabled: true } }]);
  if (url.includes('farfetch3.p.rapidapi.com')) return new Response('{"stub":"provider"}', { status: 500 });
  if (url.includes('/rpc/append_user_commerce_watch_event')) return Response.json(null);
  if (url.includes('/rest/v1/user_commerce_watches') && method === 'PATCH') return new Response(null, { status: 204 });
  if (url.includes('/rest/v1/')) return Response.json([]);
  return new Response('stub-unexpected', { status: 500 });
}) as typeof fetch;

Deno.env.set('SUPABASE_URL', 'https://stub.invalid');
Deno.env.set('SUPABASE_ANON_KEY', 'anon');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
Deno.env.set('WATCHLIST_WORKER_SECRET', WORKER_SECRET);
Deno.env.set('FARFETCH3_ENABLED', 'true');
Deno.env.set('RAPIDAPI_KEY', 'stub-key');

await import('./index.ts');
if (!handler) throw new Error('commerce-watch-refresh did not register a handler');
const worker = handler as Handler;

const providerCalls = () => recorded.filter((r) => r.url.includes('farfetch3.p.rapidapi.com')).length;
const rowWrites = () => recorded.filter((r) => r.method === 'PATCH' && r.url.includes('user_commerce_watches')).length;
const eventAppends = () => recorded.filter((r) => r.url.includes('append_user_commerce_watch_event')).length;
const pushLookups = () => recorded.filter((r) => r.url.includes('user_device_push_tokens') || r.url.includes('exp.host')).length;
const unexpectedHosts = () => recorded.filter((r) => !r.url.startsWith('https://stub.invalid') && !r.url.includes('farfetch3.p.rapidapi.com')).map((r) => r.url);

type SweepBody = { claimed: number; results: Array<Record<string, unknown>> };
async function sweep() {
  recorded = [];
  entitlementCalls = 0;
  const response = await worker(new Request('https://edge.local/commerce-watch-refresh', {
    method: 'POST', headers: { 'x-watchlist-worker-secret': WORKER_SECRET }, body: '{}',
  }));
  return { status: response.status, body: (await response.json()) as SweepBody };
}

// Anything that is not the boolean `true` from the canonical RPC must deny.
const DENIALS: Array<[string, Response | 'throw']> = [
  ['false', Response.json(false)],
  ['null', Response.json(null)],
  ['"true" string', Response.json('true')],
  ['number 1', Response.json(1)],
  ['empty object', Response.json({})],
  ['[true]', Response.json([true])],
  ['[{has:true}]', Response.json([{ kplus_has_active_entitlement: true }])],
  ['http 500 with body true', new Response('true', { status: 500 })],
  ['http 404 with body true', new Response('true', { status: 404 })],
  ['http 401 with body true', new Response('true', { status: 401 })],
  ['http 200 non-json', new Response('<html>nope</html>', { status: 200 })],
  ['http 200 empty body', new Response('', { status: 200 })],
  ['http 200 truncated json', new Response('tr', { status: 200 })],
  ['network throw', 'throw'],
];

const OPTIONS = { sanitizeOps: false, sanitizeResources: false } as const;

Deno.test({ name: 'worker sweep: every non-true or unreadable entitlement answer yields ZERO provider fetches, writes, events and push lookups', ...OPTIONS }, async () => {
  for (const [label, answer] of DENIALS) {
    claimRows = [watchRow('aaaaaaaa-0000-4000-8000-000000000001', USER_A)];
    entitlementAnswer = () => (answer === 'throw' ? 'throw' : answer.clone());
    const result = await sweep();
    if (result.status !== 200 || result.body.claimed !== 1) throw new Error(`${label}: sweep status ${result.status}`);
    if (providerCalls() !== 0) throw new Error(`${label}: the provider was fetched ${providerCalls()}x`);
    if (rowWrites() !== 0 || eventAppends() !== 0 || pushLookups() !== 0) throw new Error(`${label}: a write, event or push lookup was reached`);
    if (unexpectedHosts().length) throw new Error(`${label}: unexpected hosts ${unexpectedHosts()}`);
    if (result.body.results[0].refreshStatus !== 'skipped_not_kplus') throw new Error(`${label}: refreshStatus ${result.body.results[0].refreshStatus}`);
  }
});

Deno.test({ name: 'worker sweep: an exact boolean true dispatches the provider (the guard is a gate, not a wall)', ...OPTIONS }, async () => {
  claimRows = [watchRow('aaaaaaaa-0000-4000-8000-000000000001', USER_A)];
  entitlementAnswer = () => Response.json(true);
  const result = await sweep();
  if (providerCalls() !== 1) throw new Error(`active user: provider calls ${providerCalls()}`);
  if (result.body.results[0].refreshStatus === 'skipped_not_kplus') throw new Error('an active user was skipped');
});

Deno.test({ name: 'batch: the decision is per user and per row, with no cross-user caching', ...OPTIONS }, async () => {
  claimRows = [
    watchRow('aaaaaaaa-0000-4000-8000-000000000001', USER_A), watchRow('bbbbbbbb-0000-4000-8000-000000000002', USER_B),
    watchRow('cccccccc-0000-4000-8000-000000000003', USER_C), watchRow('aaaaaaaa-0000-4000-8000-000000000004', USER_A),
    watchRow('bbbbbbbb-0000-4000-8000-000000000005', USER_B), watchRow('aaaaaaaa-0000-4000-8000-000000000006', USER_A),
  ];
  entitlementAnswer = (userId, entitlementKey) => {
    if (entitlementKey !== 'k_plus') return Response.json(false); // asking for the wrong key must not pass
    if (userId === USER_A) return Response.json(true);
    if (userId === USER_C) return new Response('boom', { status: 503 });
    return Response.json(false);
  };
  const result = await sweep();
  const skipped = result.body.results.filter((r) => r.refreshStatus === 'skipped_not_kplus').length;
  if (providerCalls() !== 3) throw new Error(`provider calls ${providerCalls()} (want 3: only user A's rows)`);
  if (skipped !== 3) throw new Error(`skipped ${skipped} (want 3)`);
  if (entitlementCalls !== 6) throw new Error(`entitlement reads ${entitlementCalls} (want one per row = 6)`);
});

Deno.test({ name: 'a lapse between claim and dispatch dispatches nothing', ...OPTIONS }, async () => {
  // The claim RPC (SQL) returns the row because it "saw" K+; only the dispatch-time read is false.
  claimRows = [watchRow('aaaaaaaa-0000-4000-8000-000000000001', USER_A)];
  entitlementAnswer = () => Response.json(false);
  const result = await sweep();
  if (providerCalls() !== 0 || result.body.results[0].refreshStatus !== 'skipped_not_kplus') throw new Error('dispatched after a lapse');
});

Deno.test({ name: 'auth gate: a wrong or missing worker secret falls to the JWT path; with no JWT nothing is claimed or dispatched', ...OPTIONS }, async () => {
  claimRows = [watchRow('aaaaaaaa-0000-4000-8000-000000000001', USER_A)];
  entitlementAnswer = () => Response.json(true);
  const headerSets: HeadersInit[] = [{}, { 'x-watchlist-worker-secret': 'wrong' }, { 'x-watchlist-worker-secret': `${WORKER_SECRET}x` }, { 'x-watchlist-worker-secret': '' }, { 'x-worker-secret': WORKER_SECRET }];
  for (const headers of headerSets) {
    recorded = [];
    const response = await worker(new Request('https://edge.local/x', { method: 'POST', headers, body: '{}' }));
    if (response.status !== 401) throw new Error(`headers ${JSON.stringify(headers)} => ${response.status}`);
    if (providerCalls() !== 0 || recorded.some((r) => r.url.includes('/rpc/claim_'))) throw new Error('claimed or dispatched without authorization');
  }
});

Deno.test({ name: 'user refresh: a lapse AFTER the pre-claim K+ check (second read false) dispatches nothing', ...OPTIONS }, async () => {
  claimRows = [watchRow('aaaaaaaa-0000-4000-8000-000000000001', USER_A)];
  // Read 1 is handleRefresh's pre-claim check; read 2 is the dispatch-time guard.
  entitlementAnswer = (_userId, _key, callNumber) => Response.json(callNumber === 1);
  recorded = [];
  entitlementCalls = 0;
  const response = await worker(new Request('https://edge.local/x', {
    method: 'POST', headers: { Authorization: 'Bearer token' }, body: JSON.stringify({ action: 'refresh' }),
  }));
  const body = (await response.json()) as { refreshed?: Array<Record<string, unknown>> };
  if (response.status !== 200 || entitlementCalls !== 2) throw new Error(`status ${response.status}, entitlement reads ${entitlementCalls}`);
  if (providerCalls() !== 0 || body.refreshed?.[0]?.refreshStatus !== 'skipped_not_kplus') throw new Error('dispatched after a mid-request lapse');
});

Deno.test({ name: 'user refresh: a failed pre-claim K+ check returns 403 and claims nothing', ...OPTIONS }, async () => {
  entitlementAnswer = () => Response.json(false);
  recorded = [];
  const response = await worker(new Request('https://edge.local/x', {
    method: 'POST', headers: { Authorization: 'Bearer token' }, body: JSON.stringify({ action: 'refresh' }),
  }));
  if (response.status !== 403 || recorded.some((r) => r.url.includes('/rpc/claim_')) || providerCalls() !== 0) throw new Error('not blocked');
});
