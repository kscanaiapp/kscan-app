/**
 * The legacy try-on proxy stays retired.
 *
 * These are not decorative. The 2026-08-03 security pass deleted this function
 * from staging for enforcing no authentication, no K+, no kill switch and no
 * input bounds while spending the shared RAPIDAPI_KEY on every accepted
 * request; the 2026-08-29 staging backend rebuild silently redeployed it, and
 * a hostile VTO audit on 2026-08-30 proved it live and reachable with the
 * app's public anon key alone. The regression this defends against is
 * "somebody restores the proxy", so the assertions are about the SOURCE not
 * containing a provider call at all -- a behavioural test of a 410 would still
 * pass over a file that had a live proxy on another branch of its handler.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { handleRetiredTryOnRequest } from './retiredHandler.ts';

const SOURCE = await Deno.readTextFile(new URL('./retiredHandler.ts', import.meta.url));
const ENTRY = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

/** Source with comments removed: the module doc EXPLAINS the retired provider,
 *  so a naive substring search over the whole file would match its own
 *  explanation and never fail. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

Deno.test('retired proxy: the executable source reads no provider credential', () => {
  for (const forbidden of ['RAPIDAPI_KEY', 'Deno.env']) {
    assert(!CODE.includes(forbidden), `retired function must not reference ${forbidden}`);
    assert(!ENTRY.includes(forbidden), `the entry point must not reference ${forbidden}`);
  }
});

Deno.test('retired proxy: the executable source makes no upstream call', () => {
  for (const forbidden of ['fetch(', 'rapidapi.com', 'x-rapidapi-key', 'FormData', 'URLSearchParams']) {
    assert(!CODE.includes(forbidden), `retired function must not use ${forbidden}`);
    assert(!ENTRY.includes(forbidden), `the entry point must not use ${forbidden}`);
  }
});

Deno.test('retired proxy: a well-formed legacy request is refused with 410, not proxied', async () => {
  const response = await handleRetiredTryOnRequest(
    new Request('https://example.test/tryon-clothes-pro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        person_image: 'https://example.test/person.jpg',
        top_garment: 'https://example.test/garment.jpg',
      }),
    }),
  );
  assertEquals(response.status, 410);
  const body = await response.json();
  assertEquals(body.status, 'retired');
  assertEquals(body.error.code, 'endpoint_retired');
  assertEquals(body.error.supersededBy, 'vto-generate');
});

Deno.test('retired proxy: the refusal drains the request body', async () => {
  // Answering without consuming a streamed body is what produced this
  // project's 160s hang / 503 in other Edge Functions.
  const request = new Request('https://example.test/tryon-clothes-pro', {
    method: 'POST',
    body: 'x'.repeat(4096),
  });
  const response = await handleRetiredTryOnRequest(request);
  assertEquals(response.status, 410);
  assertEquals(request.bodyUsed, true, 'the body must be read before responding');
});

Deno.test('retired proxy: CORS preflight still answers', async () => {
  const response = await handleRetiredTryOnRequest(
    new Request('https://example.test/tryon-clothes-pro', { method: 'OPTIONS' }),
  );
  assertEquals(response.status, 200);
});
