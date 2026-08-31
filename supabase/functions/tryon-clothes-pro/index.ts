// Try-On Clothes Pro — RETIRED.
//
// REG-KPLUS-001 / GOV-KPLUS-002 (hostile-audit repair).
//
// This endpoint was the ORIGINAL virtual-try-on proxy. It accepted an
// unauthenticated POST, read the shared RAPIDAPI_KEY, and called the paid
// try-on provider directly. That is an anon-key bypass of every control VTO
// now has: no authentication, no K+ entitlement, no kill switch, no quota, no
// idempotency, and `Access-Control-Allow-Origin: *`. It was DELETED from the
// staging project for exactly that reason, and its replacement is the governed
// `vto-generate` function.
//
// The provider-capable source nonetheless survived into the Build 34 integration
// branch, so the deletion was one `supabase functions deploy` away from being
// undone. This file is now defence in depth: even if something deploys it, it
// cannot spend money.
//
// The retired handler:
//   - reads NO provider credential (RAPIDAPI_KEY is never referenced),
//   - makes NO outbound provider call,
//   - answers every request with 410 endpoint_retired.
//
// Do not reintroduce the proxy architecture here. Virtual try-on goes through
// `vto-generate`, which authenticates the caller, requires active K+ at the
// paid boundary, honours the feature kill switch, reserves quota, and validates
// the garment URL before any provider is contacted.

const RETIRED_HEADERS = {
  // No credentials are accepted or issued, and the body carries no data, so a
  // permissive origin here grants nothing. Kept only so a stale client receives
  // the explanatory 410 instead of an opaque CORS error.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

Deno.serve((req: Request): Response => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: RETIRED_HEADERS });
  }

  return new Response(
    JSON.stringify({
      error: 'endpoint_retired',
      code: 'endpoint_retired',
      message:
        'This endpoint has been retired. Virtual try-on is served by vto-generate, which requires an authenticated account with active K+.',
      replacement: 'vto-generate',
    }),
    { status: 410, headers: RETIRED_HEADERS },
  );
});
