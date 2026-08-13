/**
 * Edge entry point for account-deletion intake.
 *
 * The request logic lives in `handler.ts` so it can be driven directly by
 * `handler.test.ts` without binding a port. Importing a module that calls
 * `Deno.serve` at load time would start a listener inside the test process, so
 * the split is load-bearing, not stylistic.
 */
import { createHandler } from './handler.ts';

Deno.serve(createHandler());
