// Try-On Clothes Pro — RETIRED.
//
// WHAT THIS WAS. A thin proxy that forwarded a caller-supplied person image
// and garment image to `try-on-clothes-pro.p.rapidapi.com` using the shared
// `RAPIDAPI_KEY`. It was the speculative first try-on experiment, written
// before Virtual Try-On had an authority chain.
//
// WHY IT IS RETIRED, AND WHY THIS IS NOT MERELY TIDYING. It enforced none of
// the controls the real VTO path enforces:
//
//   authentication   no requireUser -- the platform's verify_jwt gate is
//                    satisfied by the app's PUBLIC anon key, which ships in
//                    every mobile binary, so "authenticated" meant nothing
//   account guard    none
//   K+ entitlement   none, although try-on is a K+ capability
//   kill switch      none -- app_config.vto_generation.enabled did not reach it
//   eligibility      none: any category, any caller
//   person input     an arbitrary caller-supplied string
//   result           raw upstream JSON echoed back, task_id and all
//   telemetry        console.log only
//
// Each accepted request spent real money on the shared `RAPIDAPI_KEY` -- the
// same secret `nike-shoe-details` and `kickscrew-sneaker-description` depend
// on, so exhausting it degraded Commerce too. A security pass removed this
// function from staging on 2026-08-03 for exactly these reasons
// (docs/security/unintended-staging-deployments-2026-08-03.md); the 2026-08-29
// staging backend rebuild redeployed it unnoticed, and a hostile VTO audit on
// 2026-08-30 proved it live and reachable with the anon key alone.
//
// It is retired rather than hardened on purpose. `vto-generate` already owns
// the whole authority chain; giving this slug a second, parallel copy of that
// chain would create two places for try-on authorization to be true, which is
// one more than can be kept correct. It has no product caller --
// services/tryOnClothesPro.ts is imported by nothing.
//
// The slug is kept (and stays in config/edge-function-manifest.json) so the
// governed inventory still accounts for it and a redeploy from any branch
// lands this refusal rather than the proxy. Deleting the slug outright is an
// owner action.
//
// NOTHING BELOW READS RAPIDAPI_KEY OR CONTACTS ANY UPSTREAM.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Exported so the refusal is exercised as a function. A module whose only
 *  entry point is Deno.serve can be asserted about only by reading its own
 *  source text, and a source-text test is green over code that cannot run. */
export async function handleRetiredTryOnRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  // Drain the body before responding. This project's Edge Functions hang for
  // ~160s and then 503 when a handler answers without consuming a body that is
  // already being streamed to it, and a retirement notice that hangs is worse
  // than the endpoint it replaces.
  try {
    await req.text();
  } catch {
    // An unreadable body changes nothing about the answer.
  }

  return new Response(
    JSON.stringify({
      status: 'retired',
      error: {
        code: 'endpoint_retired',
        supersededBy: 'vto-generate',
        retryable: false,
      },
    }),
    {
      status: 410,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}
