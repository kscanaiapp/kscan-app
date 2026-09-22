// Receipt & Purchase Intelligence V1 — Edge Function entry point.
// All orchestration lives in handler.ts so it can be exercised as a plain
// function in tests. See handler.ts for the fail-closed order.
import { handlePurchaseImportRequest } from './handler.ts';

Deno.serve((req) => handlePurchaseImportRequest(req));
