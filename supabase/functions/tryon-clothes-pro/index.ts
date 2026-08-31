/**
 * Retired legacy try-on proxy (`tryon-clothes-pro`).
 *
 * The entry point only. The refusal itself lives in retiredHandler.ts so it
 * can be exercised as a function rather than only asserted about as source
 * text -- the same split `vto-generate` uses, and for the same reason: a
 * module whose only entry point is Deno.serve binds a port just to be
 * imported, which a test suite should never have to do.
 *
 * See retiredHandler.ts for why this endpoint is retired rather than hardened.
 */

import { handleRetiredTryOnRequest } from './retiredHandler.ts';

Deno.serve((req: Request) => handleRetiredTryOnRequest(req));
