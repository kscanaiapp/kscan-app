/**
 * VTO generation authority (`vto-generate`).
 *
 * The entry point only. The authority chain -- identity, account guard,
 * kill switch, K+ entitlement, eligibility, person-input bounds, provider
 * adapter and result validation -- lives in vtoHandler.ts so it can be
 * exercised as a function rather than only asserted about as source text.
 */

import { handleVtoRequest } from './vtoHandler.ts';

Deno.serve((req: Request) => handleVtoRequest(req));
